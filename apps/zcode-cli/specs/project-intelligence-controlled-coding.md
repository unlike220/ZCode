# Controlled Coding — Project Intelligence Phase 3

## Goal

Phase 3 adds an opt-in, workspace-scoped controlled-coding layer. A main project session can declare one current work intent and the repository paths that structured coding tools may mutate. The central tool executor enforces that declared scope before supported deterministic mutations reach their handlers.

This phase does not decide whether the task is complete. It does not create Project Evidence automatically and it does not add an autonomous retry/iteration loop.

## Ownership and truth

Project Work is operational state owned by Project Intelligence for the workspace.

- Filesystem, Git, compiler, tests, and runtime observations remain canonical truth.
- Phase 1 Project State continues to own tasks, decisions, unknowns, and evidence.
- Phase 2 Repository Facts remain derived, disposable navigation hints.
- Project Work owns only current controlled-work intent, mutation scope, and bounded observed mutation paths.
- Session history and Project Memory remain separate.
- The engine evaluates scope. The model may propose a scope but cannot self-authorize an out-of-scope mutation.

Workspace identity and storage root reuse the existing Project Intelligence resolver. No new workspace identity algorithm is introduced.

## Persistence and schema

Project Work uses an independently versioned file beside the existing Phase 1 and Phase 2 files:

```text
<cli-storage>/project-intelligence/projects/<existing-workspace-key>/
  state.json
  repository-facts.json
  repository-facts-invalidation.json
  work-state.json
```

`work-state.json` schema version 1 contains:

```text
ProjectWorkState
├── schemaVersion = 1
├── version
├── updatedAt
└── work?
    ├── id
    ├── taskId?
    ├── objective
    ├── status = active | paused
    ├── scope[]
    │   ├── path       # normalized workspace-relative POSIX path
    │   └── recursive
    ├── startedAt
    ├── updatedAt
    ├── observedMutationPaths[]
    ├── observedMutationCount
    └── observedMutationPathsTruncated
```

Bounds:

- at most 100 scope entries;
- at most 100 unique observed mutation paths are retained;
- `observedMutationCount` continues to count successful structured target observations even when the retained unique set is full;
- source contents, diffs, prompts, secrets, and complete tool outputs are never stored.

Missing work state means version 0 with no work item and preserves legacy mutation behavior.

Writes are atomic. Model-facing updates carry `expectedVersion`; stale versions fail instead of overwriting newer state. File-system revisions remain a second best-effort stale-write barrier where supported by the adapter.

## Scope representation and path rules

A scope entry is either one exact file/path or one recursive directory:

```json
{ "path": "apps/zcode-cli/packages/core/src/tool/types.ts", "recursive": false }
{ "path": "apps/zcode-cli/packages/core/src/project-intelligence", "recursive": true }
```

Persisted scope paths:

- are non-empty;
- are workspace-relative;
- use POSIX `/` separators;
- contain no `.` or `..` path segment;
- contain no absolute path, drive prefix, NUL, or backslash.

Mutation targets are resolved using the existing tool workspace path semantics and then converted to a workspace-relative path. A target that resolves outside the workspace is out of scope.

Matching is segment-aware:

- exact entries match only the exact persisted path;
- recursive entries match the directory itself or descendants using `path + "/"`;
- `src/foo` never matches `src/foobar`.

Scope comparison is case-insensitive on Windows and exact on other platforms, matching the existing Project Intelligence convention that special-cases Windows path identity. Persisted forms remain normalized POSIX relative paths.

This lexical scope guard is not a new filesystem sandbox. Symlink/reparse-point containment continues to belong to the existing filesystem/permission/sandbox boundary; Phase 3 does not claim that lexical scope matching alone prevents those mechanisms from reaching external files.

## Work lifecycle and tool surface

### ProjectWorkRead

Read-only and available anywhere the normal built-in read surface is available. Returns current schema/version/state.

### ProjectWorkUpdate

Main project sessions only, following the same registration ownership gate as `ProjectStateUpdate` and `RepositoryFactsRefresh`.

Operations:

- `begin`: create the only current work item. Fails if one already exists.
- `revise_scope`: replace the scope of the current work item.
- `pause`: keep the work item but block supported structured mutations until resumed.
- `resume`: reactivate a paused work item.
- `close`: remove the current work item. Closing means controlled editing ended; it is not task completion.

All operations require `expectedVersion`. `begin` may reference an existing Phase 1 task by `taskId`; when supplied, the tool validates that the task exists. No operation marks a Project Task done or creates Project Evidence.

At most one current work item exists per workspace.

## Concurrency

Logical `version` plus adapter revision checks prevent stale Project Work updates from silently overwriting a newer state. Automatic observed-mutation bookkeeping re-reads the latest state after the handler and only updates the same work id; it never recreates a closed/replaced work item.

Phase 3 does not introduce a cross-process lease spanning scope-check through filesystem mutation. The executor performs a final scope read immediately before execution, but another process can still revise/close work after that check while a handler is in flight. This bounded TOCTOU limitation is explicit; solving it would require a broader workspace mutation transaction/lease that is outside Phase 3.

## Structured mutation descriptors

Phase 3 adds a narrow, core-only descriptor seam on tool registrations. A mutation-capable tool may describe deterministic workspace targets after model input normalization.

Conceptually:

```text
structured_paths:
  - path: <tool path input>
    operation: write | edit | delete | rename_source | rename_destination | other

opaque:
  target paths cannot be determined reliably
```

Descriptors are execution facts, not permissions.

Phase 3 initial enforcement covers built-in structured file mutations whose target paths are deterministic. In the current ZCode tool surface this includes `Write` and `Edit`. If later structured multi-file, delete, rename, or move tools use the same descriptor seam, all declared targets must pass; rename/move must describe both source and destination.

Read-only tools are unaffected.

## Central enforcement and event order

The existing executor remains the single execution path.

```text
model tool input
  -> schema/tool validation
  -> resolveInput normalization
  -> PreToolUse hook (+ hook input rewrite validation)
  -> Project Work pre-permission scope check
  -> existing permission / approval flow
  -> Project Work final execution-input scope check
  -> Repository Facts invalidation / ToolCallStarted
  -> existing handler
  -> validate/serialize/PostToolUse
  -> bounded observed-mutation bookkeeping
```

The first scope check avoids asking users to approve a deterministically out-of-scope request. The final check ensures a permission/approval path cannot change execution input to a different target after the first check.

If no `work-state.json` exists or it contains no current work item, the guard is inactive and existing ZCode behavior is unchanged.

If a current work item is paused, supported structured mutations are rejected until it is resumed.

If current work state is corrupt or has an unsupported schema, structured mutations fail closed because the executor cannot safely determine whether a controlled scope exists. Normal chat/context projection still degrades safely.

## Scope, permissions, and sandbox are separate

Project Work scope answers: “Is this deterministic target part of the declared coding work?”

The existing permission system answers: “May this tool/action execute?”

The existing execution/sandbox boundary answers: “What can the process actually access?”

An in-scope target never grants permission and never bypasses approval or sandbox rules. Permission approval never expands Project Work scope.

## Shell and opaque execution limitation

Phase 3 does not add a shell parser or claim complete path enforcement for arbitrary command execution. Existing Bash command classification, permission, and execution safety continue unchanged.

Commands such as shell scripts, package scripts, compiler hooks, or arbitrary processes may mutate repository files without exposing deterministic target paths to the Phase 3 descriptor seam. Those paths are therefore not Project Work scope-enforced in Phase 3.

This is an explicit enforcement limitation, not a security guarantee. A later phase may add reliable command-level mutation evidence or enforcement only if it can do so without heuristic parsing.

## Observed mutation bookkeeping

After a supported structured mutation handler succeeds, the executor records its normalized target paths on the same active work item that passed the guard.

Rules:

- only successful handler execution is recorded;
- all recorded paths are normalized workspace-relative POSIX paths;
- retained paths are unique and bounded;
- total observations remain counted when the retained unique set is full;
- bookkeeping failure after a real mutation is logged and does not falsely convert the already-executed filesystem mutation into a rollback;
- if the work item was closed/replaced before bookkeeping, the old work item is not recreated.

Observed mutation paths are operational bookkeeping, not Project Evidence and not proof of correctness or completion.

## Parent / child ownership

Main interactive, fork, and workflow-parent sessions may mutate Project Work state, matching the existing Project State ownership rule.

Child/subagent sessions may read current work state and receive it through Project Intelligence context, but they do not receive `ProjectWorkUpdate`. Structured tools executed by a child still pass through the central executor and therefore inherit the same workspace work-state guard rather than creating another scope owner.

No new multi-agent orchestration is introduced.

## Context integration

The existing first-model-step Project Intelligence reminder gains a bounded Project Work section when a work item exists. It includes:

- id/status and objective;
- optional linked task id;
- bounded allowed scope;
- bounded observed mutation paths/count;
- an explicit reminder that scope is operational state, not repository truth or completion proof.

The work snapshot is never appended to durable conversation history. Missing work adds no section. Work projection failure is reported independently and must not fail an otherwise valid model turn.

The combined Project Intelligence reminder remains under its existing total character budget.

## Failure semantics

- Missing work-state: empty version-0 state; legacy behavior.
- Corrupt/unsupported work-state read via tool: clear failure; never silently rewritten.
- Corrupt/unsupported work-state during a structured mutation: fail closed before handler execution.
- Invalid/escaping scope: reject before persistence.
- Stale `expectedVersion`: reject without writing.
- Begin while a current work item exists: reject.
- Revise/pause/resume/close without current work: reject.
- Resume active or pause paused: reject as invalid state transition.
- Out-of-scope structured mutation: reject before permission/handler execution.
- Multi-target descriptor: every target must be in scope.
- Mutation handler failure: do not record successful mutation paths.
- Post-mutation bookkeeping failure: warn; do not claim rollback.
- Context projection failure: log/skip only the work projection.
- Cancellation and existing permission failures retain existing executor semantics.

## Performance and boundedness

Scope evaluation is a small metadata-file read plus bounded path comparisons. It performs no repository scan, Git command, Repository Facts refresh, or source parsing.

No full refresh runs per mutation or model turn.

## Acceptance scenarios

1. No work-state preserves legacy structured mutation behavior.
2. Begin persists versioned workspace-scoped work state.
3. A stale `expectedVersion` is rejected.
4. Existing work prevents a second begin.
5. Different Project Intelligence roots isolate work state.
6. Invalid/escaping scope paths are rejected.
7. Exact-file scope accepts only that path.
8. Recursive scope accepts descendants but not sibling-prefix paths.
9. In-scope structured mutation reaches the existing handler.
10. Out-of-scope structured mutation is rejected before the handler runs.
11. Multi-target structured mutation requires every path to be allowed.
12. Rename/move-style descriptors must include and validate source and destination.
13. Read-only tools are unaffected.
14. Failed mutations are not recorded.
15. Successful structured mutation records normalized observed paths.
16. Observed path retention is bounded while the total count continues.
17. Closing work does not alter Phase 1 task status or create evidence.
18. Child registration includes ProjectWorkRead but excludes ProjectWorkUpdate.
19. Active work appears only in bounded turn-local context.
20. No work item adds no Project Work context.
21. Corrupt/unsupported work state fails closed for supported structured mutations and degrades safely for context.
22. Existing Phase 1 Project State and Phase 2 Repository Facts behavior remains compatible.

## Non-goals

- Definition of Done / Completion Contract
- automatic Project Evidence capture
- autonomous action/observe/retry loop
- automatic commit or push
- a new permission engine or sandbox
- complete shell-command mutation parsing/enforcement
- repository watchers
- rollback/event-sourcing framework
- multi-agent lock or scheduler
- vector retrieval
- UI
