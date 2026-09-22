import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRootTraceContext,
  type ProjectIntelligenceState,
  type SessionGoal,
  type SessionStorePort,
  type TraceContext,
} from "@zcode/contracts";
import { NodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { executeTargetContinuationCommand } from "../src/runtime/methods/target.js";
import { runActiveTargetContinuationLoop } from "../src/runtime/methods/target-continuation-loop.js";
import { shouldApplyTargetCompletionVerification } from "../src/runtime/methods/target-completion-verification.js";
import {
  applyProjectCompletionUpdate,
  applyProjectWorkUpdate,
  createEmptyProjectCompletionState,
  createEmptyProjectIntelligenceState,
  createEmptyProjectWorkState,
  readProjectIntelligenceState,
  resolveProjectIntelligenceRoot,
  writeProjectCompletionState,
  writeProjectIntelligenceState,
  writeProjectWorkState,
} from "../src/project-intelligence/index.js";

const NOW = "2026-09-22T00:00:00.000Z";

function target(): SessionGoal {
  return {
    sessionID: "session" as SessionGoal["sessionID"],
    targetID: "target-p4",
    objective: "Finish the linked Project Intelligence task",
    summaryTitle: null,
    status: "active",
    tokenBudget: 100,
    tokensUsed: 1,
    timeUsedSeconds: 1,
    time: { created: 1, updated: 1 },
  };
}

async function writeFixture(input: { baseDir: string; ready: boolean; corrupt?: boolean }) {
  const fileSystemPort = new NodeFileSystemAdapter();
  const rootDir = resolveProjectIntelligenceRoot({
    cliStorageRoot: input.baseDir,
    workspacePath: "workspace",
  });
  const project: ProjectIntelligenceState = {
    ...createEmptyProjectIntelligenceState(NOW),
    version: input.ready ? 1 : 2,
    tasks: [
      {
        id: "P4",
        title: "Autonomous completion",
        status: "in_progress",
        tags: [],
        relatedPaths: [],
        updatedAt: NOW,
      },
    ],
    ...(input.ready
      ? {}
      : {
          unknowns: [
            {
              id: "U1",
              question: "Still unresolved",
              status: "open" as const,
              blocks: ["P4"],
              tags: [],
              relatedPaths: [],
              updatedAt: NOW,
            },
          ],
        }),
  };
  await writeProjectIntelligenceState(fileSystemPort, rootDir, project);
  const work = applyProjectWorkUpdate(createEmptyProjectWorkState(NOW), {
    expectedVersion: 0,
    operation: "begin",
    work: {
      id: "phase-4",
      taskId: "P4",
      objective: "Integrate autonomous completion",
      scope: [{ path: "apps/zcode-cli", recursive: true }],
    },
  }).state;
  await writeProjectWorkState(fileSystemPort, rootDir, work);
  const completion = applyProjectCompletionUpdate(createEmptyProjectCompletionState(NOW), {
    expectedVersion: 0,
    operation: "upsert_contract",
    contract: {
      taskId: "P4",
      criteria: [{ id: "blockers", kind: "blocking_unknowns_resolved" }],
    },
  }).state;
  await writeProjectCompletionState(fileSystemPort, rootDir, completion);
  if (input.corrupt) await writeFile(join(rootDir, "completion-contracts.json"), "not-json");
  return { fileSystemPort, rootDir };
}

function runtimeFixture(input: {
  baseDir: string;
  fileSystemPort: NodeFileSystemAdapter;
  currentTarget: SessionGoal;
}) {
  let currentTarget = input.currentTarget;
  let turnCalls = 0;
  const stopReasons: string[] = [];
  const traceContext = createRootTraceContext({ sessionId: currentTarget.sessionID });
  const sessionStore = {
    updateTargetStatus: async (update: { sessionID: string; status: SessionGoal["status"] }) => {
      currentTarget = { ...currentTarget, status: update.status };
      return currentTarget;
    },
  } as unknown as SessionStorePort;
  const runtime = {
    activeTurn: undefined,
    activeTurnStartReservation: undefined,
    config: { memory: { cliStorageRoot: input.baseDir } },
    executeTurnCommand: async () => {
      turnCalls += 1;
      return null;
    },
    fileSystemPort: input.fileSystemPort,
    getPlanEnabled: () => false,
    projectIntelligenceContinuationProgress: new Map(),
    readSessionTargetForContext: async () => currentTarget,
    recordTargetChanged: async (event: { continuationStopReason?: string }) => {
      if (event.continuationStopReason) stopReasons.push(event.continuationStopReason);
    },
    runtimeTaskRegistry: new InMemoryRuntimeTaskRegistry(),
    sessionId: currentTarget.sessionID,
    sessionPersisted: true,
    sessionStore,
    workspaceRoot: "workspace",
  } as unknown as AgentRuntimeInternal;
  return {
    get currentTarget() {
      return currentTarget;
    },
    get turnCalls() {
      return turnCalls;
    },
    runtime,
    stopReasons,
    traceContext: traceContext as TraceContext,
  };
}

test("ready Completion Contract completes the existing target without a new turn", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "zcode-target-ready-"));
  const fixture = await writeFixture({ baseDir, ready: true });
  const runtime = runtimeFixture({
    baseDir,
    fileSystemPort: fixture.fileSystemPort,
    currentTarget: target(),
  });

  await executeTargetContinuationCommand.call(runtime.runtime, {
    traceContext: runtime.traceContext,
    verifyBeforeContinue: false,
  });

  assert.equal(runtime.turnCalls, 0);
  assert.equal(runtime.currentTarget.status, "complete");
  assert.deepEqual(runtime.stopReasons, ["project_completion_ready"]);
  const projectState = await readProjectIntelligenceState(fixture.fileSystemPort, fixture.rootDir);
  assert.equal(projectState.state.tasks[0]?.status, "in_progress");
});

test("a verifier pass cannot finish a governed target while its contract is not ready", () => {
  assert.equal(
    shouldApplyTargetCompletionVerification({ allowTargetCompletion: false, passed: true }),
    false,
  );
  assert.equal(shouldApplyTargetCompletionVerification({ passed: true }), true);
});

test("not-ready governed state keeps the existing turn path eligible", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "zcode-target-not-ready-"));
  const fixture = await writeFixture({ baseDir, ready: false });
  const runtime = runtimeFixture({
    baseDir,
    fileSystemPort: fixture.fileSystemPort,
    currentTarget: target(),
  });

  await executeTargetContinuationCommand.call(runtime.runtime, {
    traceContext: runtime.traceContext,
    verifyBeforeContinue: false,
  });

  assert.equal(runtime.turnCalls, 1);
  assert.equal(runtime.currentTarget.status, "active");
  assert.deepEqual(runtime.stopReasons, []);
});

test("repeated unchanged governed state pauses the target at the stagnation threshold", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "zcode-target-stagnated-"));
  const fixture = await writeFixture({ baseDir, ready: false });
  const runtime = runtimeFixture({
    baseDir,
    fileSystemPort: fixture.fileSystemPort,
    currentTarget: target(),
  });

  for (let iteration = 0; iteration < 4; iteration += 1) {
    await executeTargetContinuationCommand.call(runtime.runtime, {
      traceContext: runtime.traceContext,
      verifyBeforeContinue: false,
    });
  }

  assert.equal(runtime.turnCalls, 3);
  assert.equal(runtime.currentTarget.status, "paused");
  assert.deepEqual(runtime.stopReasons, ["project_continuation_stagnated"]);
});

test("corrupt linked completion state pauses the target instead of preserving legacy continuation", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "zcode-target-corrupt-"));
  const fixture = await writeFixture({ baseDir, ready: false, corrupt: true });
  const runtime = runtimeFixture({
    baseDir,
    fileSystemPort: fixture.fileSystemPort,
    currentTarget: target(),
  });

  await executeTargetContinuationCommand.call(runtime.runtime, {
    traceContext: runtime.traceContext,
    verifyBeforeContinue: false,
  });

  assert.equal(runtime.turnCalls, 0);
  assert.equal(runtime.currentTarget.status, "paused");
  assert.deepEqual(runtime.stopReasons, ["project_intelligence_state_corrupt"]);
});

test("cancellation stops the existing continuation loop without changing Project Intelligence", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "zcode-target-cancelled-"));
  const fixture = await writeFixture({ baseDir, ready: false });
  const runtime = runtimeFixture({
    baseDir,
    fileSystemPort: fixture.fileSystemPort,
    currentTarget: target(),
  });

  await runActiveTargetContinuationLoop.call(runtime.runtime, {
    abortSignal: AbortSignal.abort(),
    traceContext: runtime.traceContext,
    trigger: "user-prompt",
    yieldBeforeFirstContinue: false,
  });

  assert.equal(runtime.turnCalls, 0);
  assert.equal(runtime.currentTarget.status, "active");
  assert.deepEqual(runtime.stopReasons, []);
});
