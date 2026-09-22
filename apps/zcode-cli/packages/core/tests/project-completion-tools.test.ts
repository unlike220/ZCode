import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionId } from "@zcode/contracts";
import { NodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import {
  applyProjectCompletionUpdate,
  createEmptyProjectCompletionState,
  readProjectCompletionState,
  writeProjectCompletionState,
} from "../src/project-intelligence/completion-state.js";
import { buildProjectIntelligenceTurnContext } from "../src/project-intelligence/context.js";
import {
  applyProjectStateUpdate,
  createEmptyProjectIntelligenceState,
  readProjectIntelligenceState,
  writeProjectIntelligenceState,
} from "../src/project-intelligence/state.js";
import {
  applyProjectWorkUpdate,
  createEmptyProjectWorkState,
  writeProjectWorkState,
} from "../src/project-intelligence/work-state.js";
import { createToolExecutor } from "../src/tool/executor/impl.js";
import {
  projectCompletionEvaluateToolEntry,
  projectCompletionReadToolEntry,
  projectCompletionUpdateToolEntry,
} from "../src/tool/handlers/project-completion.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import {
  projectStateReadToolEntry,
  projectStateUpdateToolEntry,
} from "../src/tool/handlers/project-state.js";
import { ToolRegistryImpl } from "../src/tool/registry.js";

async function completionExecutorFixture() {
  const base = await mkdtemp(join(tmpdir(), "zcode-completion-tools-"));
  const workspaceRoot = join(base, "repo");
  const rootDir = join(base, "metadata");
  await mkdir(workspaceRoot);
  const fileSystemPort = new NodeFileSystemAdapter();
  const registry = new ToolRegistryImpl();
  for (const entry of [
    projectStateReadToolEntry,
    projectStateUpdateToolEntry,
    projectCompletionReadToolEntry,
    projectCompletionUpdateToolEntry,
    projectCompletionEvaluateToolEntry,
  ]) {
    registry.register(entry);
  }
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService({
      ...defaultPermissionConfig,
      allowedTools: new Set([
        "ProjectStateRead",
        "ProjectStateUpdate",
        "ProjectCompletionRead",
        "ProjectCompletionUpdate",
        "ProjectCompletionEvaluate",
      ]),
    }),
    permissionBroker: {
      requestPermission: async () => ({ decision: "allow" }),
    },
    sessionId: createSessionId(),
    mode: "build",
    workingDirectory: workspaceRoot,
    workspaceRoot,
    fileSystemPort,
    getProjectIntelligenceRoot: () => rootDir,
    emitEvent: async () => {},
  });
  return { workspaceRoot, rootDir, fileSystemPort, executor };
}

test("completion update validates task existence and evaluate reports not_configured", async () => {
  const fixture = await completionExecutorFixture();

  const missing = await fixture.executor.execute({
    id: "missing",
    name: "ProjectCompletionUpdate",
    input: {
      expectedVersion: 0,
      operation: "upsert_contract",
      contract: {
        taskId: "P1",
        criteria: [{ id: "blockers", kind: "blocking_unknowns_resolved" }],
      },
    },
  });
  assert.equal(missing.success, false);
  assert.match(missing.error!.message, /missing Project Task P1/);

  const task = await fixture.executor.execute({
    id: "task",
    name: "ProjectStateUpdate",
    input: {
      expectedVersion: 0,
      operation: "upsert_task",
      task: {
        id: "P1",
        title: "Completion task",
        status: "in_progress",
        tags: [],
        relatedPaths: [],
      },
    },
  });
  assert.equal(task.success, true, task.error?.message);

  const evaluation = await fixture.executor.execute({
    id: "eval",
    name: "ProjectCompletionEvaluate",
    input: { taskId: "P1" },
  });
  assert.equal(evaluation.success, true, evaluation.error?.message);
  assert.deepEqual(evaluation.output, {
    taskId: "P1",
    configured: false,
    status: "not_configured",
    evaluatedAt: (evaluation.output as { evaluatedAt: string }).evaluatedAt,
    criteria: [],
    passed: 0,
    failed: 0,
  });
});

test("configured completion contract gates transition to done until criteria pass", async () => {
  const fixture = await completionExecutorFixture();

  const task = await fixture.executor.execute({
    id: "task",
    name: "ProjectStateUpdate",
    input: {
      expectedVersion: 0,
      operation: "upsert_task",
      task: {
        id: "P1",
        title: "Completion task",
        status: "in_progress",
        tags: [],
        relatedPaths: [],
      },
    },
  });
  assert.equal(task.success, true, task.error?.message);

  const contract = await fixture.executor.execute({
    id: "contract",
    name: "ProjectCompletionUpdate",
    input: {
      expectedVersion: 0,
      operation: "upsert_contract",
      contract: {
        taskId: "P1",
        criteria: [
          {
            id: "tests",
            kind: "task_evidence",
            evidenceKinds: ["test"],
            minimumCount: 1,
          },
          { id: "blockers", kind: "blocking_unknowns_resolved" },
        ],
      },
    },
  });
  assert.equal(contract.success, true, contract.error?.message);

  const blocked = await fixture.executor.execute({
    id: "blocked-done",
    name: "ProjectStateUpdate",
    input: {
      expectedVersion: 1,
      operation: "upsert_task",
      task: {
        id: "P1",
        title: "Completion task",
        status: "done",
        tags: [],
        relatedPaths: [],
      },
    },
  });
  assert.equal(blocked.success, false);
  assert.match(blocked.error!.message, /Completion Contract.*not ready/);
  assert.equal(
    (await readProjectIntelligenceState(fixture.fileSystemPort, fixture.rootDir)).state.tasks[0]!
      .status,
    "in_progress",
  );

  const evidence = await fixture.executor.execute({
    id: "evidence",
    name: "ProjectStateUpdate",
    input: {
      expectedVersion: 1,
      operation: "upsert_evidence",
      evidence: {
        id: "E1",
        subjectType: "task",
        subjectId: "P1",
        kind: "test",
        reference: "focused test suite passed",
      },
    },
  });
  assert.equal(evidence.success, true, evidence.error?.message);

  const ready = await fixture.executor.execute({
    id: "ready",
    name: "ProjectCompletionEvaluate",
    input: { taskId: "P1" },
  });
  assert.equal(ready.success, true, ready.error?.message);
  assert.equal((ready.output as { status: string }).status, "ready");

  const done = await fixture.executor.execute({
    id: "done",
    name: "ProjectStateUpdate",
    input: {
      expectedVersion: 2,
      operation: "upsert_task",
      task: {
        id: "P1",
        title: "Completion task",
        status: "done",
        tags: [],
        relatedPaths: [],
      },
    },
  });
  assert.equal(done.success, true, done.error?.message);
  assert.equal(
    (await readProjectIntelligenceState(fixture.fileSystemPort, fixture.rootDir)).state.tasks[0]!
      .status,
    "done",
  );
});

test("task without a completion contract preserves legacy done behavior", async () => {
  const fixture = await completionExecutorFixture();
  const created = await fixture.executor.execute({
    id: "task",
    name: "ProjectStateUpdate",
    input: {
      expectedVersion: 0,
      operation: "upsert_task",
      task: {
        id: "legacy",
        title: "Legacy task",
        status: "in_progress",
        tags: [],
        relatedPaths: [],
      },
    },
  });
  assert.equal(created.success, true, created.error?.message);

  const done = await fixture.executor.execute({
    id: "done",
    name: "ProjectStateUpdate",
    input: {
      expectedVersion: 1,
      operation: "upsert_task",
      task: {
        id: "legacy",
        title: "Legacy task",
        status: "done",
        tags: [],
        relatedPaths: [],
      },
    },
  });
  assert.equal(done.success, true, done.error?.message);
});

test("removing a completion contract restores legacy done transition behavior", async () => {
  const fixture = await completionExecutorFixture();
  const project = applyProjectStateUpdate(createEmptyProjectIntelligenceState(), {
    expectedVersion: 0,
    operation: "upsert_task",
    task: {
      id: "P1",
      title: "Completion task",
      status: "in_progress",
      tags: [],
      relatedPaths: [],
    },
  }).state;
  await writeProjectIntelligenceState(fixture.fileSystemPort, fixture.rootDir, project);
  const completion = applyProjectCompletionUpdate(createEmptyProjectCompletionState(), {
    expectedVersion: 0,
    operation: "upsert_contract",
    contract: {
      taskId: "P1",
      criteria: [{ id: "tests", kind: "task_evidence", evidenceKinds: ["test"], minimumCount: 1 }],
    },
  }).state;
  await writeProjectCompletionState(fixture.fileSystemPort, fixture.rootDir, completion);

  const removed = await fixture.executor.execute({
    id: "remove",
    name: "ProjectCompletionUpdate",
    input: { expectedVersion: 1, operation: "remove_contract", taskId: "P1" },
  });
  assert.equal(removed.success, true, removed.error?.message);
  assert.equal(
    (await readProjectCompletionState(fixture.fileSystemPort, fixture.rootDir)).state.contracts
      .length,
    0,
  );

  const done = await fixture.executor.execute({
    id: "done",
    name: "ProjectStateUpdate",
    input: {
      expectedVersion: 1,
      operation: "upsert_task",
      task: {
        id: "P1",
        title: "Completion task",
        status: "done",
        tags: [],
        relatedPaths: [],
      },
    },
  });
  assert.equal(done.success, true, done.error?.message);
});

test("already-done task metadata updates are not re-gated by a later failing contract", async () => {
  const fixture = await completionExecutorFixture();
  let project = applyProjectStateUpdate(createEmptyProjectIntelligenceState(), {
    expectedVersion: 0,
    operation: "upsert_task",
    task: {
      id: "P1",
      title: "Already complete",
      status: "done",
      tags: [],
      relatedPaths: [],
    },
  }).state;
  await writeProjectIntelligenceState(fixture.fileSystemPort, fixture.rootDir, project);
  const completion = applyProjectCompletionUpdate(createEmptyProjectCompletionState(), {
    expectedVersion: 0,
    operation: "upsert_contract",
    contract: {
      taskId: "P1",
      criteria: [{ id: "tests", kind: "task_evidence", evidenceKinds: ["test"], minimumCount: 1 }],
    },
  }).state;
  await writeProjectCompletionState(fixture.fileSystemPort, fixture.rootDir, completion);

  const updated = await fixture.executor.execute({
    id: "update-done",
    name: "ProjectStateUpdate",
    input: {
      expectedVersion: 1,
      operation: "upsert_task",
      task: {
        id: "P1",
        title: "Already complete (renamed)",
        status: "done",
        tags: [],
        relatedPaths: [],
      },
    },
  });
  assert.equal(updated.success, true, updated.error?.message);
  project = (await readProjectIntelligenceState(fixture.fileSystemPort, fixture.rootDir)).state;
  assert.equal(project.tasks[0]!.title, "Already complete (renamed)");
});

test("corrupt completion state fails closed only for done transition and does not mutate Project State", async () => {
  const fixture = await completionExecutorFixture();
  const state = applyProjectStateUpdate(createEmptyProjectIntelligenceState(), {
    expectedVersion: 0,
    operation: "upsert_task",
    task: {
      id: "P1",
      title: "Completion task",
      status: "in_progress",
      tags: [],
      relatedPaths: [],
    },
  }).state;
  await writeProjectIntelligenceState(fixture.fileSystemPort, fixture.rootDir, state);
  await writeFile(join(fixture.rootDir, "completion-contracts.json"), "broken");

  const ordinary = await fixture.executor.execute({
    id: "ordinary",
    name: "ProjectStateUpdate",
    input: {
      expectedVersion: 1,
      operation: "upsert_task",
      task: {
        id: "P1",
        title: "Completion task updated",
        status: "in_progress",
        tags: [],
        relatedPaths: [],
      },
    },
  });
  assert.equal(ordinary.success, true, ordinary.error?.message);

  const blocked = await fixture.executor.execute({
    id: "done",
    name: "ProjectStateUpdate",
    input: {
      expectedVersion: 2,
      operation: "upsert_task",
      task: {
        id: "P1",
        title: "Completion task updated",
        status: "done",
        tags: [],
        relatedPaths: [],
      },
    },
  });
  assert.equal(blocked.success, false);
  assert.match(blocked.error!.message, /Cannot verify Project Completion state/);
  assert.equal(
    (await readProjectIntelligenceState(fixture.fileSystemPort, fixture.rootDir)).state.tasks[0]!
      .status,
    "in_progress",
  );
});

test("linked open Project Work blocks no-open-work completion criterion", async () => {
  const fixture = await completionExecutorFixture();
  const project = applyProjectStateUpdate(createEmptyProjectIntelligenceState(), {
    expectedVersion: 0,
    operation: "upsert_task",
    task: {
      id: "P1",
      title: "Completion task",
      status: "in_progress",
      tags: [],
      relatedPaths: [],
    },
  }).state;
  await writeProjectIntelligenceState(fixture.fileSystemPort, fixture.rootDir, project);
  const completion = applyProjectCompletionUpdate(createEmptyProjectCompletionState(), {
    expectedVersion: 0,
    operation: "upsert_contract",
    contract: {
      taskId: "P1",
      criteria: [{ id: "work", kind: "no_open_project_work" }],
    },
  }).state;
  await writeProjectCompletionState(fixture.fileSystemPort, fixture.rootDir, completion);
  const work = applyProjectWorkUpdate(createEmptyProjectWorkState(), {
    expectedVersion: 0,
    operation: "begin",
    work: {
      id: "work-1",
      taskId: "P1",
      objective: "Still editing",
      scope: [{ path: "src", recursive: true }],
    },
  }).state;
  await writeProjectWorkState(fixture.fileSystemPort, fixture.rootDir, work);

  const evaluation = await fixture.executor.execute({
    id: "eval",
    name: "ProjectCompletionEvaluate",
    input: { taskId: "P1" },
  });
  assert.equal(evaluation.success, true, evaluation.error?.message);
  assert.equal((evaluation.output as { status: string }).status, "not_ready");

  const done = await fixture.executor.execute({
    id: "done",
    name: "ProjectStateUpdate",
    input: {
      expectedVersion: 1,
      operation: "upsert_task",
      task: {
        id: "P1",
        title: "Completion task",
        status: "done",
        tags: [],
        relatedPaths: [],
      },
    },
  });
  assert.equal(done.success, false);
  assert.match(done.error!.message, /failed criteria: work/);
});

test("combined Project Intelligence context includes relevant completion and degrades independently", async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-completion-projection-"));
  const rootDir = join(base, "metadata");
  const fs = new NodeFileSystemAdapter();

  const project = applyProjectStateUpdate(createEmptyProjectIntelligenceState(), {
    expectedVersion: 0,
    operation: "upsert_task",
    task: {
      id: "P1",
      title: "Completion task",
      status: "in_progress",
      tags: [],
      relatedPaths: [],
    },
  }).state;
  await writeProjectIntelligenceState(fs, rootDir, project);
  const completion = applyProjectCompletionUpdate(createEmptyProjectCompletionState(), {
    expectedVersion: 0,
    operation: "upsert_contract",
    contract: {
      taskId: "P1",
      criteria: [{ id: "blockers", kind: "blocking_unknowns_resolved" }],
    },
  }).state;
  await writeProjectCompletionState(fs, rootDir, completion);
  const work = applyProjectWorkUpdate(createEmptyProjectWorkState(), {
    expectedVersion: 0,
    operation: "begin",
    work: {
      id: "work-1",
      taskId: "P1",
      objective: "Finish completion contracts",
      scope: [{ path: "apps/zcode-cli", recursive: true }],
    },
  }).state;
  await writeProjectWorkState(fs, rootDir, work);

  const context = await buildProjectIntelligenceTurnContext({
    fileSystemPort: fs,
    rootDir,
    query: "completion contracts",
  });
  assert.match(context!, /# Project Work/);
  assert.match(context!, /# Completion Contract/);
  assert.match(context!, /Task P1: READY/);
  assert.ok(context!.length <= 6000);

  await writeFile(join(rootDir, "completion-contracts.json"), "broken");
  const errors: string[] = [];
  const degraded = await buildProjectIntelligenceTurnContext({
    fileSystemPort: fs,
    rootDir,
    query: "completion contracts",
    onProjectionError: (kind) => errors.push(kind),
  });
  assert.ok(degraded);
  assert.match(degraded!, /# Project Work/);
  assert.match(degraded!, /# Project Intelligence/);
  assert.doesNotMatch(degraded!, /# Completion Contract/);
  assert.deepEqual(errors, ["completion"]);
});

test("completion policy mutation always requires explicit non-persistent approval", () => {
  assert.equal(projectCompletionUpdateToolEntry.metadata.needsApproval, true);
  assert.equal(projectCompletionUpdateToolEntry.metadata.riskLevel, "medium");
  assert.equal(projectCompletionUpdateToolEntry.permission.alwaysAsk, true);
  assert.deepEqual(projectCompletionUpdateToolEntry.permission.askOptions, { allowAlways: false });
});

test("child registration can read/evaluate completion but cannot update contracts", () => {
  const main: string[] = [];
  const child: string[] = [];
  registerBuiltInTools(
    { register: (entry) => main.push(entry.metadata.name) },
    { includeProjectStateUpdate: true },
  );
  registerBuiltInTools({ register: (entry) => child.push(entry.metadata.name) });

  assert.ok(main.includes("ProjectCompletionRead"));
  assert.ok(main.includes("ProjectCompletionEvaluate"));
  assert.ok(main.includes("ProjectCompletionUpdate"));
  assert.ok(child.includes("ProjectCompletionRead"));
  assert.ok(child.includes("ProjectCompletionEvaluate"));
  assert.equal(child.includes("ProjectCompletionUpdate"), false);
});
