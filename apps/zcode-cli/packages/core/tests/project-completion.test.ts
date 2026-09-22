import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import {
  ProjectCompletionUpdateInputSchema,
  type ProjectIntelligenceState,
  type ProjectWorkState,
} from "@zcode/contracts";
import {
  applyProjectCompletionUpdate,
  createEmptyProjectCompletionState,
  evaluateProjectCompletion,
  readProjectCompletionState,
  writeProjectCompletionState,
} from "../src/project-intelligence/completion-state.js";
import { buildProjectCompletionTurnContext } from "../src/project-intelligence/completion-context.js";

function baseProjectState(): ProjectIntelligenceState {
  return {
    schemaVersion: 1,
    version: 1,
    updatedAt: "2026-09-22T00:00:00.000Z",
    tasks: [
      {
        id: "P3.5",
        title: "Completion contracts",
        status: "in_progress",
        tags: [],
        relatedPaths: [],
        updatedAt: "2026-09-22T00:00:00.000Z",
      },
    ],
    decisions: [],
    unknowns: [],
    evidence: [],
  };
}

function noWork(): ProjectWorkState {
  return {
    schemaVersion: 1,
    version: 0,
    updatedAt: "2026-09-22T00:00:00.000Z",
  };
}

test("completion state starts empty, persists separately, and rejects stale versions", async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-completion-state-"));
  const rootA = join(base, "a");
  const rootB = join(base, "b");
  const fs = new NodeFileSystemAdapter();

  const empty = await readProjectCompletionState(fs, rootA);
  assert.equal(empty.exists, false);
  assert.equal(empty.state.version, 0);
  assert.deepEqual(empty.state.contracts, []);

  const mutation = applyProjectCompletionUpdate(empty.state, {
    expectedVersion: 0,
    operation: "upsert_contract",
    contract: {
      taskId: "P3.5",
      criteria: [{ id: "blockers", kind: "blocking_unknowns_resolved" }],
    },
  });
  await writeProjectCompletionState(fs, rootA, mutation.state);

  assert.equal((await readProjectCompletionState(fs, rootA)).state.contracts.length, 1);
  assert.equal((await readProjectCompletionState(fs, rootB)).state.contracts.length, 0);

  assert.throws(
    () =>
      applyProjectCompletionUpdate(mutation.state, {
        expectedVersion: 0,
        operation: "remove_contract",
        taskId: "P3.5",
      }),
    /version conflict/,
  );
});

test("completion contract rejects duplicate criterion ids and invalid bounded inputs", () => {
  assert.throws(() =>
    ProjectCompletionUpdateInputSchema.parse({
      expectedVersion: 0,
      operation: "upsert_contract",
      contract: {
        taskId: "P3.5",
        criteria: [
          { id: "same", kind: "blocking_unknowns_resolved" },
          {
            id: "same",
            kind: "task_evidence",
            evidenceKinds: ["test"],
            minimumCount: 1,
          },
        ],
      },
    }),
  );

  assert.throws(() =>
    ProjectCompletionUpdateInputSchema.parse({
      expectedVersion: 0,
      operation: "upsert_contract",
      contract: {
        taskId: "P3.5",
        criteria: [
          {
            id: "tests",
            kind: "task_evidence",
            evidenceKinds: [],
            minimumCount: 1,
          },
        ],
      },
    }),
  );
});

test("blocking and explicit unknown criteria evaluate current Project State", () => {
  const project = baseProjectState();
  project.unknowns.push(
    {
      id: "U1",
      question: "Blocking question",
      status: "open",
      blocks: ["P3.5"],
      tags: [],
      relatedPaths: [],
      updatedAt: project.updatedAt,
    },
    {
      id: "U2",
      question: "Explicit question",
      status: "resolved",
      answer: "Resolved",
      blocks: [],
      tags: [],
      relatedPaths: [],
      updatedAt: project.updatedAt,
    },
  );

  const contract = {
    taskId: "P3.5",
    criteria: [
      { id: "blockers", kind: "blocking_unknowns_resolved" as const },
      {
        id: "required",
        kind: "required_unknowns_resolved" as const,
        unknownIds: ["U2", "missing"],
      },
    ],
    createdAt: project.updatedAt,
    updatedAt: project.updatedAt,
  };

  const evaluation = evaluateProjectCompletion(contract, project, noWork(), project.updatedAt);
  assert.equal(evaluation.status, "not_ready");
  assert.equal(evaluation.failed, 2);
  assert.match(evaluation.criteria[0]!.summary, /U1/);
  assert.match(evaluation.criteria[1]!.summary, /missing/);

  project.unknowns[0] = { ...project.unknowns[0]!, status: "resolved", answer: "Done" };
  project.unknowns.push({
    id: "missing",
    question: "Previously missing",
    status: "invalidated",
    blocks: [],
    tags: [],
    relatedPaths: [],
    updatedAt: project.updatedAt,
  });
  const ready = evaluateProjectCompletion(contract, project, noWork(), project.updatedAt);
  assert.equal(ready.status, "ready");
  assert.equal(ready.passed, 2);
});

test("task evidence criterion filters by task linkage, kind, and count", () => {
  const project = baseProjectState();
  project.evidence.push(
    {
      id: "E1",
      subjectType: "task",
      subjectId: "P3.5",
      kind: "test",
      reference: "focused tests",
      observedAt: project.updatedAt,
    },
    {
      id: "E2",
      subjectType: "task",
      subjectId: "P3.5",
      kind: "command",
      reference: "typecheck",
      observedAt: project.updatedAt,
    },
    {
      id: "E3",
      subjectType: "repository",
      kind: "test",
      reference: "unrelated repository evidence",
      observedAt: project.updatedAt,
    },
  );

  const contract = {
    taskId: "P3.5",
    criteria: [
      {
        id: "tests",
        kind: "task_evidence" as const,
        evidenceKinds: ["test" as const],
        minimumCount: 2,
      },
    ],
    createdAt: project.updatedAt,
    updatedAt: project.updatedAt,
  };

  const notReady = evaluateProjectCompletion(contract, project, noWork(), project.updatedAt);
  assert.equal(notReady.status, "not_ready");
  assert.match(notReady.criteria[0]!.summary, /1\/2/);

  project.evidence.push({
    id: "E4",
    subjectType: "task",
    subjectId: "P3.5",
    kind: "test",
    reference: "integration tests",
    observedAt: project.updatedAt,
  });
  const ready = evaluateProjectCompletion(contract, project, noWork(), project.updatedAt);
  assert.equal(ready.status, "ready");
});

test("no-open-project-work fails for active or paused work linked to the task", () => {
  const project = baseProjectState();
  const contract = {
    taskId: "P3.5",
    criteria: [{ id: "work", kind: "no_open_project_work" as const }],
    createdAt: project.updatedAt,
    updatedAt: project.updatedAt,
  };
  const linked: ProjectWorkState = {
    schemaVersion: 1,
    version: 1,
    updatedAt: project.updatedAt,
    work: {
      id: "work",
      taskId: "P3.5",
      objective: "Still editing",
      status: "active",
      scope: [{ path: "src", recursive: true }],
      startedAt: project.updatedAt,
      updatedAt: project.updatedAt,
      observedMutationPaths: [],
      observedMutationCount: 0,
      observedMutationPathsTruncated: false,
    },
  };

  assert.equal(
    evaluateProjectCompletion(contract, project, linked, project.updatedAt).status,
    "not_ready",
  );
  linked.work = { ...linked.work!, status: "paused" };
  assert.equal(
    evaluateProjectCompletion(contract, project, linked, project.updatedAt).status,
    "not_ready",
  );
  linked.work = { ...linked.work!, taskId: undefined };
  assert.equal(
    evaluateProjectCompletion(contract, project, linked, project.updatedAt).status,
    "ready",
  );
});

test("completion context is bounded, task-focused, and degrades safely on corrupt completion state", async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-completion-context-"));
  const rootDir = join(base, "metadata");
  const fs = new NodeFileSystemAdapter();

  const completion = applyProjectCompletionUpdate(createEmptyProjectCompletionState(), {
    expectedVersion: 0,
    operation: "upsert_contract",
    contract: {
      taskId: "P3.5",
      criteria: [
        { id: "blockers", kind: "blocking_unknowns_resolved" },
        {
          id: "tests",
          kind: "task_evidence",
          evidenceKinds: ["test"],
          minimumCount: 1,
        },
      ],
    },
  }).state;
  await writeProjectCompletionState(fs, rootDir, completion);

  const project = baseProjectState();
  const context = await buildProjectCompletionTurnContext({
    fileSystemPort: fs,
    rootDir,
    taskId: "P3.5",
    projectState: project,
    workState: noWork(),
  });
  assert.match(context!, /Completion Contract/);
  assert.match(context!, /NOT READY/);
  assert.match(context!, /source=automatic/i);
  assert.ok(context!.length <= 1600);

  await writeFile(join(rootDir, "completion-contracts.json"), "broken");
  await assert.rejects(
    buildProjectCompletionTurnContext({
      fileSystemPort: fs,
      rootDir,
      taskId: "P3.5",
      projectState: project,
      workState: noWork(),
    }),
    /Invalid Project Completion JSON/,
  );
});
