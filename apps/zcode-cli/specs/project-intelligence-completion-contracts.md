# Completion Contracts — Project Intelligence Phase 3.5

## Goal

Phase 3.5 adds workspace-scoped Completion Contracts so task completion is evaluated by deterministic engine rules instead of an LLM merely declaring that work is done.

A Completion Contract belongs to one existing Phase 1 Project Task and defines explicit criteria. The engine evaluates those criteria against current Project Intelligence state and Project Work state. When a task has a Completion Contract, a transition from a non-done status to `done` is rejected unless the contract currently evaluates to `ready`.

This phase does not automatically run tests/commands or automatically create Project Evidence. Automatic Evidence Capture remains the next phase.

## Ownership and truth

Completion Contracts are durable project policy, separate from:

- canonical repository truth (filesystem, Git, compiler/tests, runtime);
- Phase 1 Project State (tasks, decisions, unknowns, evidence);
- Phase 2 Repository Facts (derived navigation metadata);
- Phase 3 Project Work (operational controlled-coding state);
- session history and Project Memory.

The model may propose/update a contract, but only the engine computes its evaluation result.

An evaluation is a point-in-time projection and is not persisted as canonical truth.

## Persistence

Completion Contracts use an independently versioned file under the existing Project Intelligence root:

```text
<project-intelligence-root>/
  state.json
  repository-facts.json
  repository-facts-invalidation.json
  work-state.json
  completion-contracts.json
```

The existing workspace identity/root resolver is reused. No new identity algorithm is introduced.

Conceptual schema:

```text
ProjectCompletionState
├── schemaVersion = 1
├── version
├── updatedAt
└── contracts[]
    ├── taskId
    ├── title?
    ├── criteria[]
    ├── createdAt
    └── updatedAt
```

There is at most one contract per task.

Writes are atomic and model-facing mutations require `expectedVersion`.

## Criteria

Phase 3.5 intentionally supports a small deterministic vocabulary.

### blocking_unknowns_resolved

Passes when every Phase 1 unknown whose `blocks` includes the contract task id is no longer `open` or `investigating`.

This criterion is dynamic: newly added blocking unknowns become part of the next evaluation automatically.

### required_unknowns_resolved

Contains explicit unknown ids. Passes only when every id exists and its status is `resolved` or `invalidated`.

A missing required unknown fails the criterion rather than being silently ignored.

### task_evidence

Requires a minimum number of Phase 1 Project Evidence records attached to the task, filtered by one or more allowed evidence kinds.

Example:

```json
{
  "id": "tests",
  "kind": "task_evidence",
  "evidenceKinds": ["test"],
  "minimumCount": 1
}
```

Phase 3.5 verifies structured evidence presence and linkage only. It does not claim that a free-form evidence record proves the underlying command actually ran. The following Automatic Evidence Capture phase is expected to create evidence from observed executor/test/Git/runtime results and strengthen provenance. This limitation must remain explicit.

### no_open_project_work

Passes when there is no current Phase 3 Project Work item linked to this task. Both active and paused linked work items count as open.

A Project Work item without `taskId` is not assumed to belong to this task.

## Contract rules

- A contract must contain at least one criterion and at most 50 criteria.
- Criterion ids are unique within a contract.
- `task_evidence.evidenceKinds` is non-empty and unique.
- `task_evidence.minimumCount` is bounded.
- `required_unknowns_resolved.unknownIds` is non-empty, bounded, and unique.
- Contract creation/update validates that the target Project Task exists.
- Removing a contract does not mutate the task.
- Contracts do not auto-mark tasks done.

## Evaluation

Evaluation reads:

- current Phase 1 Project State;
- current Phase 3 Project Work state when required by a criterion;
- the current Completion Contract.

No repository scan, Git command, test run, shell command, Repository Facts refresh, or source parse occurs during evaluation.

Conceptual result:

```text
ProjectCompletionEvaluation
├── taskId
├── configured
├── status = ready | not_ready | not_configured
├── evaluatedAt
├── criteria[]
│   ├── id
│   ├── kind
│   ├── status = pass | fail
│   └── summary
└── passed / failed counts
```

A configured contract is `ready` only when every criterion passes.

An empty/missing completion state is `not_configured`, not implicitly ready.

## Done transition gate

The existing `ProjectStateUpdate` tool remains the owner of task state mutation.

For `upsert_task`:

- if the task is not transitioning to `done`, existing behavior is unchanged;
- if the existing task is already `done`, editing other task fields does not re-run the gate;
- if the task transitions from non-done (or is newly created directly) to `done`:
  - read Completion Contracts;
  - if no contract exists for that task, preserve Phase 1 legacy behavior;
  - if a contract exists, evaluate it;
  - reject the transition unless evaluation is `ready`.

This makes Completion Contracts opt-in and backward-compatible.

If completion state is corrupt or unsupported, a task transition to `done` fails closed because the engine cannot prove whether a contract governs the task. Other Project State updates continue to use their existing behavior.

A successful evaluation does not itself mutate Project Task status; the caller still performs the explicit `ProjectStateUpdate`.

## Tools

### ProjectCompletionRead

Read-only. Returns bounded contract state and, optionally, current evaluation for one task.

### ProjectCompletionUpdate

Main project sessions only. Uses optimistic concurrency.

Changing completion policy requires explicit approval on every call, including modes that otherwise auto-approve workspace actions. A model must not be able to weaken/remove its own Definition of Done silently in order to pass the done-transition gate. Persistent “always allow” is not offered for this tool.

Operations:

- `upsert_contract`
- `remove_contract`

Contract updates validate the referenced task exists.

### ProjectCompletionEvaluate

Read-only. Evaluates one task against the current contract and current states. It never runs commands or mutates task state.

Child/subagent sessions may read/evaluate Completion Contracts but may not update workspace-level contracts.

## Context integration

The first-model-step Project Intelligence context gains a bounded Completion section for relevant current work/task state when a contract exists.

Prefer the task linked by current Project Work. If there is no linked current work, do not dump all contracts into context.

The section contains:

- task id;
- ready/not-ready status;
- compact per-criterion pass/fail information;
- reminder that evaluation is point-in-time and evidence-presence criteria do not yet provide automatic execution provenance.

Completion state is never appended to durable chat history.

Projection failure degrades safely and does not suppress Phase 1, Repository Facts, or Project Work context.

## Failure semantics

- Missing completion file: version 0, no contracts.
- Corrupt/unsupported completion file: read/evaluate tools return a clear failure; never silently rewrite.
- Stale `expectedVersion`: reject update.
- Contract references missing task: reject update.
- Duplicate criterion id: reject before persistence.
- Missing explicit required unknown: criterion fails with explanation.
- Corrupt Project Work state while evaluating a `no_open_project_work` criterion: evaluation fails rather than guessing.
- Corrupt completion state during a governed task transition to done: fail closed.
- Contract not configured: evaluation returns `not_configured`.
- Removing a contract restores legacy done-transition behavior for that task.

## Concurrency

Completion Contract writes use logical version plus filesystem revision checks, following the existing Project Intelligence pattern.

Evaluation is a point-in-time read across independent files and does not provide a cross-file transaction snapshot. A concurrent Project State/Project Work update may make the result stale immediately after evaluation.

Therefore the done-transition gate performs its own fresh evaluation immediately before applying/writing the task update. Phase 3.5 does not introduce cross-file locking.

## Boundedness

- at most 100 contracts per workspace;
- at most 50 criteria per contract;
- explicit unknown lists and evidence-kind lists are bounded;
- serialized completion state is capped before write so a successful write cannot create a file that the reader would immediately reject as oversized;
- evaluation output is bounded;
- turn-local context projection is bounded;
- no source contents, diffs, command output, prompts, or secrets are stored.

## Acceptance scenarios

1. Missing completion state reads as version 0 with no contracts.
2. Contract upsert requires an existing task.
3. Contract writes use stale-version rejection.
4. Different Project Intelligence roots isolate contracts.
5. Duplicate criterion ids are rejected.
6. Blocking-unknown criterion passes/fails from current task blockers.
7. Explicit unknown criterion fails when an id is missing or unresolved.
8. Task-evidence criterion filters by task linkage and required kinds/count.
9. No-open-work criterion fails for active or paused work linked to the task.
10. Evaluation is ready only when every criterion passes.
11. Evaluation without a contract is not_configured.
12. A task without a contract preserves legacy transition-to-done behavior.
13. A governed task cannot transition to done while its contract is not ready.
14. A governed task can transition to done when the contract is ready.
15. Failed completion gate leaves Project State unchanged.
16. Updating an already-done task does not unexpectedly re-gate legacy edits.
17. Contract update/removal never marks a task done.
18. Child registration includes read/evaluate but excludes update.
19. Relevant completion evaluation appears in bounded turn-local context.
20. Corrupt completion state fails closed for a governed done transition and degrades safely for context.
21. Phase 1, Phase 2, and Phase 3 tests remain compatible.

## Non-goals

- automatic command/test/Git/runtime evidence capture;
- automatically running verification commands during evaluation;
- automatically marking tasks done;
- autonomous retry/planning loop;
- multi-agent orchestration;
- event sourcing;
- cross-file transactional snapshot/lease;
- repository watcher;
- UI;
- vector retrieval.
