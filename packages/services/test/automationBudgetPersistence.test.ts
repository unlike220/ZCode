import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeAutomationBudget } from "@zcode/shared";
import { AutomationRepo } from "../src/session/automationRepo.js";
import { AutomationService } from "../src/session/automationService.js";
import {
  automationBudgetWindowBucket,
  AutomationBudgetExhaustedError,
} from "../src/session/automationBudget.js";
import {
  createStaticAutomationSigningKeyProvider,
  verifyAutomationExecutionSignature,
} from "../src/session/automationSigning.js";

const signingKey = Buffer.alloc(32, 11);
const dayBucket = automationBudgetWindowBucket("day", Date.UTC(2026, 8, 29, 10, 0, 0));

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-budget-"));
  const repo = new AutomationRepo(
    join(dir, "tasks-index.sqlite"),
    5000,
    createStaticAutomationSigningKeyProvider(signingKey),
  );
  const service = new AutomationService(repo);
  return { dir, repo, service };
}

function createParams(overrides?: Record<string, unknown>) {
  return {
    title: "budgeted task",
    cronExpr: "0 9 * * *",
    prompt: "do the work",
    workspacePath: "/workspace",
    recurring: true,
    ...overrides,
  } as Parameters<AutomationService["create"]>[0];
}

test("budget round-trips through create/update and clears with null", async () => {
  const { dir, repo, service } = await setup();
  try {
    const budget: ZCodeAutomationBudget = { limitTokens: 1000, window: "month" };
    const created = await service.create(createParams({ budget }));
    assert.deepEqual(created.budget, budget);

    const updated = await service.update(created.automationId, {
      budget: { limitTokens: 2000, window: "day" },
    });
    assert.deepEqual(updated?.budget, { limitTokens: 2000, window: "day" });

    const cleared = await service.update(created.automationId, { budget: null });
    assert.equal(cleared?.budget, undefined);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid budget configs are rejected at the service boundary", async () => {
  const { dir, repo, service } = await setup();
  try {
    await assert.rejects(
      service.create(createParams({ budget: { limitTokens: 0, window: "day" } })),
      /limitTokens/,
    );
    await assert.rejects(
      service.create(createParams({ budget: { limitTokens: 10, window: "week" as never } })),
      /window/,
    );
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("spend ledger is idempotent per run and sums per bucket", async () => {
  const { dir, repo, service } = await setup();
  try {
    const created = await service.create(
      createParams({ budget: { limitTokens: 1000, window: "day" } }),
    );
    await repo.recordRunSpend({
      automationId: created.automationId,
      runId: `${created.automationId}:1000`,
      bucket: dayBucket,
      totalTokens: 300,
      recordedAt: Date.now(),
    });
    // 迟到/重放结算：同 run_id 替换而非累加。
    await repo.recordRunSpend({
      automationId: created.automationId,
      runId: `${created.automationId}:1000`,
      bucket: dayBucket,
      totalTokens: 450,
      recordedAt: Date.now(),
    });
    await repo.recordRunSpend({
      automationId: created.automationId,
      runId: `${created.automationId}:2000`,
      bucket: dayBucket,
      totalTokens: 100,
      recordedAt: Date.now(),
    });
    assert.equal(await repo.sumSpend(created.automationId, dayBucket), 550);

    // 别的日历桶（昨天）不计入今天的 day 桶。
    await repo.recordRunSpend({
      automationId: created.automationId,
      runId: `${created.automationId}:3000`,
      bucket: automationBudgetWindowBucket("day", Date.UTC(2026, 8, 28, 10, 0, 0)),
      totalTokens: 5000,
      recordedAt: Date.now(),
    });
    assert.equal(await repo.sumSpend(created.automationId, dayBucket), 550);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual runNow is rejected once spend reaches the limit", async () => {
  const { dir, repo, service } = await setup();
  try {
    const created = await service.create(
      createParams({ budget: { limitTokens: 500, window: "day" } }),
    );
    // 未超限时正常认领。
    const claimed = await service.runNow(created.automationId, {
      workspacePath: "/workspace",
    });
    assert.ok(claimed?.run.runId.includes(":manual:"));

    await repo.recordRunSpend({
      automationId: created.automationId,
      runId: `${created.automationId}:manual:x`,
      bucket: dayBucket,
      totalTokens: 500,
      recordedAt: Date.now(),
    });
    await assert.rejects(
      service.runNow(created.automationId, { workspacePath: "/workspace" }),
      (error: unknown) => {
        assert.ok(error instanceof AutomationBudgetExhaustedError);
        assert.match(error.message, /AUTOMATION_BUDGET_EXHAUSTED/);
        return true;
      },
    );
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("pauseForBudgetExhaustion only pauses active automations", async () => {
  const { dir, repo, service } = await setup();
  try {
    const created = await service.create(
      createParams({ budget: { limitTokens: 500, window: "day" } }),
    );
    await repo.pauseForBudgetExhaustion(created.automationId, "[AUTOMATION_BUDGET_EXHAUSTED] test");
    const paused = await service.get(created.automationId);
    assert.equal(paused?.lifecycleStatus, "paused");
    assert.equal(paused?.enabled, false);
    assert.match(paused?.lastError ?? "", /AUTOMATION_BUDGET_EXHAUSTED/);

    // completed/failed 状态不被预算路径改写（仅 active 会被暂停）。
    const done = await service.create(
      createParams({
        title: "done task",
        // endAt 已过：创建即 completed（ended before first run）。
        endAt: 1,
        recurring: false,
      }),
    );
    assert.equal(done.lifecycleStatus, "completed");
    await repo.pauseForBudgetExhaustion(done.automationId, "[AUTOMATION_BUDGET_EXHAUSTED] test");
    const stillCompleted = await service.get(done.automationId);
    assert.equal(stillCompleted?.lifecycleStatus, "completed");
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("execution intent is signed on write and detects out-of-band tampering", async () => {
  const { dir, repo, service } = await setup();
  try {
    const created = await service.create(createParams());
    const intent = await repo.getExecutionIntent(created.automationId);
    assert.ok(intent?.executionSignature);
    assert.equal(
      verifyAutomationExecutionSignature(intent!, intent.executionSignature!, signingKey),
      true,
    );

    // 编辑 prompt 后重签：旧签名失效，新签名有效。
    const updated = await service.update(created.automationId, { prompt: "changed work" });
    assert.equal(updated?.prompt, "changed work");
    const nextIntent = await repo.getExecutionIntent(created.automationId);
    assert.notEqual(nextIntent?.executionSignature, intent?.executionSignature);
    assert.equal(
      verifyAutomationExecutionSignature(nextIntent!, nextIntent!.executionSignature!, signingKey),
      true,
    );
    assert.equal(
      verifyAutomationExecutionSignature(nextIntent!, intent!.executionSignature!, signingKey),
      false,
    );

    // 库外直改 prompt（模拟篡改）：签名校验必须失败。
    const { DatabaseSync } = (await import("node:sqlite")) as {
      DatabaseSync: new (path: string) => { exec: (sql: string) => void; close: () => void };
    };
    const tamperDb = new DatabaseSync(join(dir, "tasks-index.sqlite"));
    tamperDb.exec(
      `UPDATE automations SET prompt = 'tampered' WHERE automation_id = '${created.automationId}'`,
    );
    tamperDb.close();
    const tampered = await repo.getExecutionIntent(created.automationId);
    assert.equal(tampered?.prompt, "tampered");
    assert.equal(
      verifyAutomationExecutionSignature(tampered!, tampered!.executionSignature!, signingKey),
      false,
      "out-of-band prompt edits must break the signature",
    );
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
