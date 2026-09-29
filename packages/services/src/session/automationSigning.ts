import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AUTOMATION_INTENT_SIGNATURE_MISMATCH_ERROR_CODE,
  type ZCodeAutomation,
} from "@zcode/shared";
import { getAutomationSigningKeyPath } from "#src/paths.js";

/**
 * automation 执行意图的 HMAC 完整性（见 packages/services/specs/automation-execution-integrity.md）。
 * 签名覆盖决定「执行什么、何时执行」的字段元组（automation-execution-intent-v1）：
 * prompt / cronExpr / scheduleRule / maxRuns / endAt。展示与派送参数类字段
 * （title、modelSelection、mode、targetTaskId、enabled、budget）不进签名。
 * 序列化是冻结契约：任何字段/顺序变化都必须换新 tag，不能原地改 v1。
 */
export const AUTOMATION_EXECUTION_INTENT_TAG = "automation-execution-intent-v1";

/**
 * 派发前签名校验失败。host 据此映射 permanent 派发失败（run 不执行、automation 转
 * failed 可 restart）；错误码在 message 中跨进程保留供 UI/日志识别。
 */
export class AutomationIntentSignatureMismatchError extends Error {
  readonly code = AUTOMATION_INTENT_SIGNATURE_MISMATCH_ERROR_CODE;

  constructor(detail: string) {
    super(
      `[${AUTOMATION_INTENT_SIGNATURE_MISMATCH_ERROR_CODE}] Automation execution intent signature verification failed: ${detail}`,
    );
    this.name = "AutomationIntentSignatureMismatchError";
  }
}

export interface AutomationExecutionIntent {
  automationId: string;
  prompt: string;
  cronExpr: string;
  scheduleRule?: ZCodeAutomation["scheduleRule"];
  maxRuns?: number;
  endAt?: number;
}

/** 从持久化行提取被签名的意图字段。 */
export function automationIntentFromAutomation(
  automation: Pick<
    ZCodeAutomation,
    "automationId" | "prompt" | "cronExpr" | "scheduleRule" | "maxRuns" | "endAt"
  >,
): AutomationExecutionIntent {
  return {
    automationId: automation.automationId,
    prompt: automation.prompt,
    cronExpr: automation.cronExpr,
    ...(automation.scheduleRule ? { scheduleRule: automation.scheduleRule } : {}),
    ...(automation.maxRuns !== undefined ? { maxRuns: automation.maxRuns } : {}),
    ...(automation.endAt !== undefined ? { endAt: automation.endAt } : {}),
  };
}

/**
 * 规范化序列化：显式字段顺序 + JSON.stringify，保证同一意图永远产出同一字节串。
 * scheduleRule 用固定键序重建，避免历史行可选键顺序差异造成假阳性。
 */
export function serializeAutomationExecutionIntent(intent: AutomationExecutionIntent): string {
  const rule = intent.scheduleRule
    ? {
        unit: intent.scheduleRule.unit,
        interval: intent.scheduleRule.interval,
        hour: intent.scheduleRule.hour,
        minute: intent.scheduleRule.minute,
        anchorAt: intent.scheduleRule.anchorAt,
        ...(intent.scheduleRule.weekdays ? { weekdays: intent.scheduleRule.weekdays } : {}),
        ...(intent.scheduleRule.monthDays ? { monthDays: intent.scheduleRule.monthDays } : {}),
        ...(intent.scheduleRule.months ? { months: intent.scheduleRule.months } : {}),
        ...(intent.scheduleRule.monthlyMode
          ? { monthlyMode: intent.scheduleRule.monthlyMode }
          : {}),
      }
    : null;
  return JSON.stringify([
    AUTOMATION_EXECUTION_INTENT_TAG,
    intent.automationId,
    intent.prompt,
    intent.cronExpr,
    rule,
    intent.maxRuns ?? null,
    intent.endAt ?? null,
  ]);
}

export function computeAutomationExecutionSignature(
  intent: AutomationExecutionIntent,
  key: Buffer,
): string {
  return createHmac("sha256", key).update(serializeAutomationExecutionIntent(intent)).digest("hex");
}

/** 恒时比较；损坏/缺省签名一律返回 false，不抛异常（调用方据此阻断）。 */
export function verifyAutomationExecutionSignature(
  intent: AutomationExecutionIntent,
  signature: string | null | undefined,
  key: Buffer,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(computeAutomationExecutionSignature(intent, key), "hex");
  const actual = Buffer.from(signature, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export interface AutomationSigningKeyProvider {
  getKey(): Promise<Buffer>;
}

/** 测试/注入用固定密钥。 */
export function createStaticAutomationSigningKeyProvider(
  key: Buffer,
): AutomationSigningKeyProvider {
  return {
    async getKey() {
      return key;
    },
  };
}

export interface AutomationSigningKeyFileStore {
  read(): Promise<Buffer | null>;
  write(key: Buffer): Promise<void>;
}

/**
 * 文件密钥库：懒创建一次（0600），读后缓存。文件是单机秘密：
 * 不入库、不上报、不随 export/import 走；丢失即旧签名全部失效（fail-closed）。
 */
export function createFileAutomationSigningKeyStore(
  keyPath: string,
): AutomationSigningKeyFileStore {
  return {
    async read() {
      try {
        const raw = await readFile(keyPath);
        return raw.length === 32 ? raw : null;
      } catch {
        return null;
      }
    },
    async write(key: Buffer) {
      await mkdir(dirname(keyPath), { recursive: true });
      await writeFile(keyPath, key, { mode: 0o600 });
      // writeFile 的 mode 只作用于新建文件；已存在文件（例如历史误建 0644）需显式收紧。
      await chmod(keyPath, 0o600).catch(() => {});
    },
  };
}

/** 默认密钥提供者：读文件，缺失时创建新密钥并写回。 */
export function createFileAutomationSigningKeyProvider(
  store: AutomationSigningKeyFileStore,
): AutomationSigningKeyProvider {
  let cached: Buffer | null = null;
  return {
    async getKey() {
      if (cached) return cached;
      const existing = await store.read();
      if (existing) {
        cached = existing;
        return cached;
      }
      const created = randomBytes(32);
      await store.write(created);
      cached = created;
      return cached;
    },
  };
}

/** 生产默认：本机密钥文件（~/.zcode/v2/automation-signing.key，懒创建、0600）。 */
export function createDefaultAutomationSigningKeyProvider(): AutomationSigningKeyProvider {
  return createFileAutomationSigningKeyProvider(
    createFileAutomationSigningKeyStore(getAutomationSigningKeyPath()),
  );
}

/**
 * 只读密钥提供者（校验侧专用）：绝不创建密钥文件。
 * 密钥缺失/损坏即抛错（fail-closed）——若由校验侧创建新密钥，与写密钥侧并发时
 * 可能互相覆盖，导致刚写入的签名永久无法通过校验；修复手段是重新保存 automation。
 */
export function createReadOnlyAutomationSigningKeyProvider(
  store: AutomationSigningKeyFileStore,
): AutomationSigningKeyProvider {
  let cached: Buffer | null = null;
  return {
    async getKey() {
      if (cached) return cached;
      const existing = await store.read();
      if (!existing) {
        throw new Error(
          "Automation signing key is missing or corrupt; re-save the automation to re-sign it under a new key",
        );
      }
      cached = existing;
      return cached;
    },
  };
}

/** 校验侧默认：只读本机密钥文件。 */
export function createDefaultReadOnlyAutomationSigningKeyProvider(): AutomationSigningKeyProvider {
  return createReadOnlyAutomationSigningKeyProvider(
    createFileAutomationSigningKeyStore(getAutomationSigningKeyPath()),
  );
}
