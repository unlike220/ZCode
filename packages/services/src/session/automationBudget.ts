import {
  AUTOMATION_BUDGET_EXHAUSTED_ERROR_CODE,
  type ZCodeAutomation,
  type ZCodeAutomationBudget,
} from "@zcode/shared";
import type { ZCodeAutomationTrigger } from "@zcode/shared";

/**
 * automation token 预算的纯领域逻辑：窗口分桶、耗尽判定、门控文案。
 * 本文件不做 IO；spend 聚合与暂停写库由 AutomationRepo 承担，
 * scheduler / service 只通过本模块做决策（见 packages/services/specs/automation-budget-control.md）。
 */

/** 当前时间落进的窗口桶键：lifetime 恒定；day=UTC 日历日；month=UTC 日历月。 */
export function automationBudgetWindowBucket(
  window: ZCodeAutomationBudget["window"],
  atMs: number,
): string {
  if (window === "lifetime") return "lifetime";
  const at = new Date(atMs);
  const year = at.getUTCFullYear();
  const month = `${at.getUTCMonth() + 1}`.padStart(2, "0");
  if (window === "month") return `m:${year}-${month}`;
  const day = `${at.getUTCDate()}`.padStart(2, "0");
  return `d:${year}-${month}-${day}`;
}

/** 耗尽即阻断；等值也算耗尽（>= limit）。 */
export function evaluateAutomationBudget(params: {
  budget: ZCodeAutomationBudget;
  observedTokens: number;
}): { ok: true } | { ok: false; message: string } {
  if (params.observedTokens >= params.budget.limitTokens) {
    return {
      ok: false,
      message: formatAutomationBudgetExhaustedMessage(params.budget, params.observedTokens),
    };
  }
  return { ok: true };
}

export function formatAutomationBudgetExhaustedMessage(
  budget: ZCodeAutomationBudget,
  observedTokens: number,
): string {
  return `[${AUTOMATION_BUDGET_EXHAUSTED_ERROR_CODE}] Automation budget exhausted: ${observedTokens}/${budget.limitTokens} tokens in this ${budget.window} window. Re-enable the automation after raising the budget.`;
}

/** 手动运行撞上预算耗尽时抛出；UI 通过 message 中的错误码识别。 */
export class AutomationBudgetExhaustedError extends Error {
  readonly code = AUTOMATION_BUDGET_EXHAUSTED_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "AutomationBudgetExhaustedError";
  }
}

/** 门控所需的 repo 面；AutomationRepo 结构化满足，测试可注入假实现。 */
export interface AutomationBudgetGateRepo {
  get(automationId: string): Promise<ZCodeAutomation | null>;
  sumSpend(automationId: string, bucket: string): Promise<number>;
  pauseForBudgetExhaustion(automationId: string, message: string): Promise<void>;
  recordSkippedRun(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
    reason: string;
  }): Promise<void>;
}

export interface AutomationBudgetGateLog {
  info(message: string): void;
}

/**
 * scheduler 认领后的预算门控：耗尽即暂停 automation 并落 skipped run，
 * 返回 true 表示已阻断（调用方不得再派发）。未配置预算时恒放行。
 * 门控与 spend 读取之间没有事务边界：spend 由 run 终态后回写，
 * 本轮放行最多超支一条 run 的用量，下一个窗口桶/下一次认领会看到新累计。
 */
export async function enforceAutomationBudgetAtClaim(params: {
  repo: AutomationBudgetGateRepo;
  automation: ZCodeAutomation;
  now: number;
  runId: string;
  log: AutomationBudgetGateLog;
}): Promise<boolean> {
  const budget = params.automation.budget;
  if (!budget) return false;
  const bucket = automationBudgetWindowBucket(budget.window, params.now);
  const observed = await params.repo.sumSpend(params.automation.automationId, bucket);
  const decision = evaluateAutomationBudget({ budget, observedTokens: observed });
  if (decision.ok) return false;
  await params.repo.pauseForBudgetExhaustion(params.automation.automationId, decision.message);
  await params.repo.recordSkippedRun({
    runId: params.runId,
    automationId: params.automation.automationId,
    workspaceKey: params.automation.workspaceKey,
    scheduledAt: params.automation.nextRunAt ?? params.automation.retryAt ?? null,
    trigger: "schedule",
    reason: "budget_exhausted",
  });
  params.log.info(
    `automation budget exhausted automation=${params.automation.automationId} window=${budget.window} used=${observed} limit=${budget.limitTokens}`,
  );
  return true;
}

/** 服务层校验：budget 为 undefined/null 放行；对象必须是正整数 limit + 合法窗口。 */
export function assertValidAutomationBudget(
  budget: ZCodeAutomationBudget | null | undefined,
): void {
  if (budget === undefined || budget === null) return;
  if (!Number.isSafeInteger(budget.limitTokens) || budget.limitTokens <= 0) {
    throw new Error("budget.limitTokens 必须是正整数");
  }
  if (budget.window !== "day" && budget.window !== "month" && budget.window !== "lifetime") {
    throw new Error(`budget.window 不受支持：${String(budget.window)}`);
  }
}

/**
 * 手动运行前的预算门控：未配置预算直接放行；耗尽抛 AutomationBudgetExhaustedError。
 * 与 scheduler 认领门控共用同一 spend 口径（当前窗口桶累计）。
 */
export async function enforceAutomationBudgetForManualRun(params: {
  repo: Pick<AutomationBudgetGateRepo, "sumSpend">;
  automation: Pick<ZCodeAutomation, "budget" | "automationId">;
  now: number;
}): Promise<void> {
  const budget = params.automation.budget;
  if (!budget) return;
  const observed = await params.repo.sumSpend(
    params.automation.automationId,
    automationBudgetWindowBucket(budget.window, params.now),
  );
  const decision = evaluateAutomationBudget({ budget, observedTokens: observed });
  if (!decision.ok) {
    throw new AutomationBudgetExhaustedError(decision.message);
  }
}
