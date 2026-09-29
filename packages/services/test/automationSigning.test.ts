import assert from "node:assert/strict";
import test from "node:test";
import {
  automationIntentFromAutomation,
  computeAutomationExecutionSignature,
  createFileAutomationSigningKeyProvider,
  createFileAutomationSigningKeyStore,
  createStaticAutomationSigningKeyProvider,
  serializeAutomationExecutionIntent,
  verifyAutomationExecutionSignature,
  type AutomationExecutionIntent,
} from "../src/session/automationSigning.js";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const key = Buffer.alloc(32, 7);

function intent(overrides?: Partial<AutomationExecutionIntent>): AutomationExecutionIntent {
  return {
    automationId: "automation-1",
    prompt: "run tests",
    cronExpr: "0 9 * * *",
    ...overrides,
  };
}

test("signature round-trips and rejects tampered intent", () => {
  const signature = computeAutomationExecutionSignature(intent(), key);
  assert.ok(verifyAutomationExecutionSignature(intent(), signature, key));
  assert.equal(
    verifyAutomationExecutionSignature(intent({ prompt: "evil" }), signature, key),
    false,
  );
  assert.equal(
    verifyAutomationExecutionSignature(intent({ cronExpr: "* * * * *" }), signature, key),
    false,
  );
  assert.equal(verifyAutomationExecutionSignature(intent({ maxRuns: 3 }), signature, key), false);
  assert.equal(verifyAutomationExecutionSignature(intent({ endAt: 123 }), signature, key), false);
});

test("signature is stable across key order in scheduleRule and covers scheduleRule", () => {
  const base = intent({
    scheduleRule: { unit: "daily", interval: 1, hour: 9, minute: 0, anchorAt: 1000 },
  });
  const reordered = intent({
    scheduleRule: { anchorAt: 1000, minute: 0, hour: 9, interval: 1, unit: "daily" },
  });
  assert.equal(
    serializeAutomationExecutionIntent(base),
    serializeAutomationExecutionIntent(reordered),
  );
  const signature = computeAutomationExecutionSignature(base, key);
  assert.ok(verifyAutomationExecutionSignature(reordered, signature, key));
  assert.equal(
    verifyAutomationExecutionSignature(
      intent({ scheduleRule: { unit: "daily", interval: 2, hour: 9, minute: 0, anchorAt: 1000 } }),
      signature,
      key,
    ),
    false,
    "changing the schedule must invalidate the signature",
  );
});

test("malformed or missing signatures fail closed without throwing", () => {
  assert.equal(verifyAutomationExecutionSignature(intent(), undefined, key), false);
  assert.equal(verifyAutomationExecutionSignature(intent(), null, key), false);
  assert.equal(verifyAutomationExecutionSignature(intent(), "", key), false);
  assert.equal(verifyAutomationExecutionSignature(intent(), "not-hex", key), false);
  assert.equal(verifyAutomationExecutionSignature(intent(), "abcd", key), false);
});

test("intent extraction only picks signed fields", () => {
  const extracted = automationIntentFromAutomation({
    automationId: "automation-1",
    prompt: "run tests",
    cronExpr: "0 9 * * *",
    scheduleRule: undefined,
    maxRuns: undefined,
    endAt: undefined,
  });
  assert.deepEqual(extracted, intent());
  // title / modelSelection / mode / budget 等展示字段不参与序列化。
  const serialized = serializeAutomationExecutionIntent(intent());
  assert.ok(!serialized.includes("title"));
  assert.ok(!serialized.includes("modelSelection"));
});

test("static key provider returns the injected key", async () => {
  const provider = createStaticAutomationSigningKeyProvider(key);
  assert.equal(await provider.getKey(), key);
});

test("file key store creates a 0600 key once and reuses it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-signing-"));
  try {
    const keyPath = join(dir, "nested", "automation-signing.key");
    const provider = createFileAutomationSigningKeyProvider(
      createFileAutomationSigningKeyStore(keyPath),
    );
    const first = await provider.getKey();
    assert.equal(first.length, 32);
    const info = await stat(keyPath);
    assert.equal(info.mode & 0o777, 0o600, "key file must be 0600");
    // 第二次读取复用同一密钥；新 provider 实例从文件读回同一密钥。
    assert.equal(await provider.getKey(), first);
    const reopened = createFileAutomationSigningKeyProvider(
      createFileAutomationSigningKeyStore(keyPath),
    );
    assert.deepEqual(await reopened.getKey(), first);
    const raw = await readFile(keyPath);
    assert.deepEqual(raw, first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
