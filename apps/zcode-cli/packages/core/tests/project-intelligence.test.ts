import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProjectStateUpdate,
  createEmptyProjectIntelligenceState,
  selectProjectIntelligenceState,
} from "../src/project-intelligence/index.js";

test("project state starts empty at version zero", () => {
  const state = createEmptyProjectIntelligenceState("2026-09-21T00:00:00.000Z");

  assert.equal(state.schemaVersion, 1);
  assert.equal(state.version, 0);
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.decisions, []);
  assert.deepEqual(state.unknowns, []);
  assert.deepEqual(state.evidence, []);
});

test("upsert increments version and stale expectedVersion is rejected", () => {
  const initial = createEmptyProjectIntelligenceState("2026-09-21T00:00:00.000Z");
  const first = applyProjectStateUpdate(
    initial,
    {
      expectedVersion: 0,
      operation: "upsert_task",
      task: {
        id: "P1",
        title: "Build Project Intelligence",
        status: "in_progress",
        tags: ["agent"],
        relatedPaths: ["apps/zcode-cli"],
      },
    },
    "2026-09-21T00:01:00.000Z",
  );

  assert.equal(first.state.version, 1);
  assert.equal(first.output.previousVersion, 0);
  assert.equal(first.output.version, 1);
  assert.equal(first.output.created, true);
  assert.equal(first.state.tasks[0]?.id, "P1");

  assert.throws(
    () =>
      applyProjectStateUpdate(
        first.state,
        {
          expectedVersion: 0,
          operation: "upsert_task",
          task: {
            id: "P1",
            title: "Stale update",
            status: "done",
            tags: [],
            relatedPaths: [],
          },
        },
        "2026-09-21T00:02:00.000Z",
      ),
    /version conflict/,
  );
});

test("evidence cannot reference a missing structured subject", () => {
  const initial = createEmptyProjectIntelligenceState("2026-09-21T00:00:00.000Z");

  assert.throws(
    () =>
      applyProjectStateUpdate(
        initial,
        {
          expectedVersion: 0,
          operation: "upsert_evidence",
          evidence: {
            id: "E1",
            subjectType: "task",
            subjectId: "missing",
            kind: "test",
            reference: "pnpm test",
          },
        },
        "2026-09-21T00:01:00.000Z",
      ),
    /references missing task/,
  );
});

test("relevance favors active work and matching records", () => {
  const initial = createEmptyProjectIntelligenceState("2026-09-21T00:00:00.000Z");
  const withActive = applyProjectStateUpdate(
    initial,
    {
      expectedVersion: 0,
      operation: "upsert_task",
      task: {
        id: "P1",
        title: "Project Intelligence context injection",
        status: "in_progress",
        summary: "Inject relevant workspace state into the coding turn",
        tags: ["context"],
        relatedPaths: ["apps/zcode-cli/packages/core"],
      },
    },
    "2026-09-21T00:01:00.000Z",
  ).state;
  const withDecision = applyProjectStateUpdate(
    withActive,
    {
      expectedVersion: 1,
      operation: "upsert_decision",
      decision: {
        id: "ADR-1",
        title: "Keep state outside session storage",
        status: "accepted",
        statement: "Project state is workspace-scoped, not session-scoped.",
        tags: ["storage"],
        relatedPaths: [],
      },
    },
    "2026-09-21T00:02:00.000Z",
  ).state;

  const selected = selectProjectIntelligenceState(withDecision, {
    query: "context injection",
    limit: 10,
    includeEvidence: false,
  });

  assert.deepEqual(
    selected.tasks.map((task) => task.id),
    ["P1"],
  );
  assert.deepEqual(selected.decisions, []);
  assert.equal(selected.summary.activeTasks, 1);
});
