import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeAutomation, ZCodeAutomationBudget } from "@zcode/shared";
import {
  automationBudgetWindowBucket,
  AutomationBudgetExhaustedError,
  enforceAutomationBudgetAtClaim,
  evaluateAutomationBudget,
} from "../src/session/automationBudget.js";

function fakeAutomation(overrides?: Partial<ZCodeAutomation>): ZCodeAutomation {
  return {
    automationId: "automation-test",
    title: "test",
    cronExpr: "0 9 * * *",
    prompt: "hello",
    workspaceKey: "/workspace",
    workspacePath: "/workspace",
    locationKind: "local",
    recurring: true,
    runCount: 0,
    enabled: true,
    lifecycleStatus: "active",
    dispatchStatus: "idle",
    dispatchAttempts: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function fakeGateRepo(spendByBucket: Record<string, number>) {
  const calls: {
    paused?: { automationId: string; message: string };
    skipped?: { runId: string; reason: string };
  } = {};
  return {
    calls,
    async get(automationId: string) {
      return fakeAutomation({ automationId });
    },
    async sumSpend(_automationId: string, bucket: string) {
      return spendByBucket[bucket] ?? 0;
    },
    async pauseForBudgetExhaustion(automationId: string, message: string) {
      calls.paused = { automationId, message };
    },
    async recordSkippedRun(params: { runId: string; reason: string }) {
      calls.skipped = { runId: params.runId, reason: params.reason };
    },
  };
}

test("budget window buckets use UTC calendar boundaries", () => {
  // 2026-09-29T23:59:59Z 与 2026-09-30T00:00:00Z 分属不同 day 桶，但同属 9 月桶。
  const before = Date.UTC(2026, 8, 29, 23, 59, 59);
  const after = Date.UTC(2026, 8, 30, 0, 0, 0);
  assert.equal(automationBudgetWindowBucket("day", before), "d:2026-09-29");
  assert.equal(automationBudgetWindowBucket("day", after), "d:2026-09-30");
  assert.equal(automationBudgetWindowBucket("month", before), "m:2026-09");
  assert.equal(automationBudgetWindowBucket("month", after), "m:2026-09");
  assert.equal(automationBudgetWindowBucket("lifetime", before), "lifetime");
  assert.equal(automationBudgetWindowBucket("lifetime", after), "lifetime");
});

test("budget evaluation blocks at equality", () => {
  const budget: ZCodeAutomationBudget = { limitTokens: 1000, window: "day" };
  assert.deepEqual(evaluateAutomationBudget({ budget, observedTokens: 999 }), { ok: true });
  assert.equal(
    evaluateAutomationBudget({ budget, observedTokens: 1000 }).ok,
    false,
    "equality must block (>= limit)",
  );
  const blocked = evaluateAutomationBudget({ budget, observedTokens: 1500 });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.ok(blocked.message.includes("AUTOMATION_BUDGET_EXHAUSTED"));
    assert.ok(blocked.message.includes("1500/1000"));
  }
});

test("claim gate passes automations without a budget", async () => {
  const repo = fakeGateRepo({ "d:2026-09-29": 999_999 });
  const blocked = await enforceAutomationBudgetAtClaim({
    repo,
    automation: fakeAutomation(),
    now: Date.UTC(2026, 8, 29, 10, 0, 0),
    runId: "automation-test:1727604000000",
    log: { info: () => {} },
  });
  assert.equal(blocked, false);
  assert.equal(repo.calls.paused, undefined);
  assert.equal(repo.calls.skipped, undefined);
});

test("claim gate within budget dispatches and records nothing", async () => {
  const budget: ZCodeAutomationBudget = { limitTokens: 1000, window: "day" };
  const repo = fakeGateRepo({ "d:2026-09-29": 500 });
  const blocked = await enforceAutomationBudgetAtClaim({
    repo,
    automation: fakeAutomation({ budget }),
    now: Date.UTC(2026, 8, 29, 10, 0, 0),
    runId: "automation-test:1727604000000",
    log: { info: () => {} },
  });
  assert.equal(blocked, false);
  assert.equal(repo.calls.paused, undefined);
  assert.equal(repo.calls.skipped, undefined);
});

test("claim gate on exhausted budget pauses and skips without dispatch", async () => {
  const budget: ZCodeAutomationBudget = { limitTokens: 1000, window: "day" };
  const repo = fakeGateRepo({ "d:2026-09-29": 1200 });
  const blocked = await enforceAutomationBudgetAtClaim({
    repo,
    automation: fakeAutomation({ budget }),
    now: Date.UTC(2026, 8, 29, 10, 0, 0),
    runId: "automation-test:1727604000000",
    log: { info: () => {} },
  });
  assert.equal(blocked, true);
  assert.ok(repo.calls.paused);
  assert.equal(repo.calls.paused?.automationId, "automation-test");
  assert.ok(repo.calls.paused?.message.includes("AUTOMATION_BUDGET_EXHAUSTED"));
  assert.equal(repo.calls.skipped?.runId, "automation-test:1727604000000");
  assert.equal(repo.calls.skipped?.reason, "budget_exhausted");
});

test("claim gate only sums the current window bucket", async () => {
  const budget: ZCodeAutomationBudget = { limitTokens: 1000, window: "day" };
  // 昨天的 spend 不应计入今天的 day 桶。
  const repo = fakeGateRepo({ "d:2026-09-28": 5000, "d:2026-09-29": 10 });
  const blocked = await enforceAutomationBudgetAtClaim({
    repo,
    automation: fakeAutomation({ budget }),
    now: Date.UTC(2026, 8, 29, 10, 0, 0),
    runId: "automation-test:1727604000000",
    log: { info: () => {} },
  });
  assert.equal(blocked, false);
});

test("manual run gate error carries the typed code", () => {
  const error = new AutomationBudgetExhaustedError(
    "[AUTOMATION_BUDGET_EXHAUSTED] Automation budget exhausted: 1000/1000 tokens",
  );
  assert.equal(error.code, "AUTOMATION_BUDGET_EXHAUSTED");
  assert.match(error.message, /AUTOMATION_BUDGET_EXHAUSTED/);
});
