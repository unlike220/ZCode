import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import {
  applyAutomaticProjectEvidence,
  applyProjectCompletionUpdate,
  applyProjectStateUpdate,
  applyProjectWorkUpdate,
  assessProjectIntelligenceContinuation,
  createEmptyProjectCompletionState,
  createEmptyProjectIntelligenceState,
  createEmptyProjectWorkState,
  PROJECT_INTELLIGENCE_STAGNATION_THRESHOLD,
  updateProjectIntelligenceProgress,
  writeProjectCompletionState,
  writeProjectIntelligenceState,
  writeProjectWorkState,
} from "../src/project-intelligence/index.js";
import type { ProjectIntelligenceState, ProjectWorkState } from "@zcode/contracts";

const NOW = "2026-09-22T00:00:00.000Z";

function projectState(): ProjectIntelligenceState {
  return applyProjectStateUpdate(
    createEmptyProjectIntelligenceState(NOW),
    {
      expectedVersion: 0,
      operation: "upsert_task",
      task: {
        id: "P4",
        title: "Autonomous completion",
        status: "in_progress",
        tags: [],
        relatedPaths: [],
      },
    },
    NOW,
  ).state;
}

function projectWork(): ProjectWorkState {
  return applyProjectWorkUpdate(
    createEmptyProjectWorkState(NOW),
    {
      expectedVersion: 0,
      operation: "begin",
      work: {
        id: "phase-4",
        taskId: "P4",
        objective: "Integrate autonomous completion",
        scope: [{ path: "apps/zcode-cli", recursive: true }],
      },
    },
    NOW,
  ).state;
}

async function writeLinkedFixture(rootDir: string, criterion = "evidence") {
  const fileSystemPort = new NodeFileSystemAdapter();
  await writeProjectIntelligenceState(fileSystemPort, rootDir, projectState());
  await writeProjectWorkState(fileSystemPort, rootDir, projectWork());
  const completion = applyProjectCompletionUpdate(
    createEmptyProjectCompletionState(NOW),
    {
      expectedVersion: 0,
      operation: "upsert_contract",
      contract: {
        taskId: "P4",
        criteria:
          criterion === "evidence"
            ? [
                {
                  id: "tests",
                  kind: "task_evidence",
                  evidenceKinds: ["test"],
                  evidenceSource: "automatic",
                  minimumCount: 1,
                },
              ]
            : [{ id: "unknowns", kind: "blocking_unknowns_resolved" }],
      },
    },
    NOW,
  ).state;
  await writeProjectCompletionState(fileSystemPort, rootDir, completion);
  return fileSystemPort;
}

test("unlinked or unconfigured Project Intelligence preserves legacy continuation", async () => {
  const fileSystemPort = new NodeFileSystemAdapter();
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-autonomous-legacy-"));

  assert.deepEqual(await assessProjectIntelligenceContinuation({ fileSystemPort, rootDir }), {
    kind: "legacy",
    reason: "no_linked_project_task",
  });

  await writeProjectWorkState(fileSystemPort, rootDir, {
    ...createEmptyProjectWorkState(NOW),
    work: {
      ...projectWork().work!,
      taskId: undefined,
    },
  });
  assert.deepEqual(await assessProjectIntelligenceContinuation({ fileSystemPort, rootDir }), {
    kind: "legacy",
    reason: "no_linked_project_task",
  });

  await writeProjectWorkState(fileSystemPort, rootDir, projectWork());
  await writeProjectIntelligenceState(fileSystemPort, rootDir, projectState());
  const noContract = await assessProjectIntelligenceContinuation({ fileSystemPort, rootDir });
  assert.deepEqual(noContract, { kind: "legacy", reason: "no_completion_contract" });
});

test("automatic evidence changes a fresh governed evaluation from not-ready to ready", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-autonomous-evidence-"));
  const fileSystemPort = await writeLinkedFixture(rootDir);
  const before = await assessProjectIntelligenceContinuation({ fileSystemPort, rootDir });
  assert.equal(before.kind, "governed");
  assert.equal(before.status, "not_ready");

  const current = await import("../src/project-intelligence/state.js");
  const stored = await current.readProjectIntelligenceState(fileSystemPort, rootDir);
  const evidence = {
    id: "automatic-test-1",
    subjectType: "task" as const,
    subjectId: "P4",
    kind: "test" as const,
    reference: "tool:Bash:test-1",
    summary: "Successful test command observed by the executor",
    observedAt: NOW,
    provenance: {
      source: "automatic_tool" as const,
      toolName: "Bash",
      toolCallId: "test-1",
      outcome: "success" as const,
      command: { category: "test" as const, status: "completed" as const },
    },
  };
  const captured = applyAutomaticProjectEvidence(stored.state, evidence, NOW);
  await writeProjectIntelligenceState(fileSystemPort, rootDir, captured.state, {
    expectedRevision: stored.revision,
  });

  const after = await assessProjectIntelligenceContinuation({ fileSystemPort, rootDir });
  assert.equal(after.kind, "governed");
  assert.equal(after.status, "ready");
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test("corrupt governed state blocks instead of becoming an absent contract", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-autonomous-corrupt-"));
  const fileSystemPort = await writeLinkedFixture(rootDir);
  await writeFile(join(rootDir, "completion-contracts.json"), '{"schemaVersion":999}');

  const decision = await assessProjectIntelligenceContinuation({ fileSystemPort, rootDir });
  assert.equal(decision.kind, "blocked");
  assert.equal(decision.taskId, "P4");
  assert.equal(decision.reason, "project_intelligence_state_corrupt");
});

test("stagnation permits small no-progress window and stops at the centralized threshold", () => {
  const fingerprint =
    "P4|project:1|completion:1|work:1|mutations:0|evaluation:not_ready|criteria:tests:fail";
  let progress = updateProjectIntelligenceProgress(undefined, fingerprint);
  assert.equal(progress.stagnated, false);
  assert.equal(progress.state.noProgressCount, 0);

  for (let count = 1; count < PROJECT_INTELLIGENCE_STAGNATION_THRESHOLD; count += 1) {
    progress = updateProjectIntelligenceProgress(progress.state, fingerprint);
    assert.equal(progress.stagnated, false);
    assert.equal(progress.state.noProgressCount, count);
  }

  progress = updateProjectIntelligenceProgress(progress.state, fingerprint);
  assert.equal(progress.stagnated, true);
  assert.equal(progress.state.noProgressCount, PROJECT_INTELLIGENCE_STAGNATION_THRESHOLD);

  const changed = updateProjectIntelligenceProgress(progress.state, `${fingerprint}|project:2`);
  assert.equal(changed.stagnated, false);
  assert.equal(changed.state.noProgressCount, 0);
});

test("a resumed runtime can restart its bounded counter from current canonical state", () => {
  const first = updateProjectIntelligenceProgress(undefined, "current-state");
  const restarted = updateProjectIntelligenceProgress(undefined, first.state.fingerprint);
  assert.equal(first.state.noProgressCount, 0);
  assert.equal(restarted.state.noProgressCount, 0);
  assert.equal(restarted.stagnated, false);
});
