# Project Intelligence Foundation

Status: Phase 1 implementation spec

## Goal

Give the coding agent a workspace-scoped, structured project model that survives sessions without replaying chat history. The model stores durable task/decision/unknown/evidence state, exposes explicit read/update tools, and injects only a bounded relevant projection into the current turn.

This is not a replacement for session history, project memory, Git, tests, or Dynamic Workflow. Those remain separate sources of truth.

## Ownership

Project Intelligence owns only the structured state declared in this spec.

- Repository files, Git, compiler/test output, and runtime observations remain external truth.
- Session todo state remains session-owned.
- Project Memory remains non-authoritative long-lived memory.
- Project Intelligence state is workspace-scoped and is not owned by any single session.
- The ProjectStateUpdate tool is the only model-facing mutation path in Phase 1.
- The persisted state file is an implementation detail and is not exposed as a model-editable path.

Workspace identity uses the existing rule: trimmed workspace identity when present, otherwise the normalized workspace path. On Windows, path identity is case-insensitive.

## Persistence boundary

State is stored under the ZCode CLI storage root, outside the checked-out repository:

```text
<cli-storage>/
  project-intelligence/
    projects/
      <workspace-slug>-<identity-hash>/
        state.json
```

Phase 1 deliberately does not add tables to the session SQLite store because the state lifetime is workspace-scoped rather than session-scoped. A later migration may replace the file adapter behind the same state semantics.

Writes are atomic and use the FileSystemPort revision when one exists. The logical `version` is also checked by ProjectStateUpdate so stale model actions fail instead of silently overwriting newer state.

## State model

```text
ProjectIntelligenceState
├── schemaVersion = 1
├── version
├── updatedAt
├── tasks[]
├── decisions[]
├── unknowns[]
└── evidence[]
```

Task statuses:

```text
planned -> in_progress -> done
             |
             -> blocked
```

The tool may explicitly move a task between supported statuses; the engine does not infer task completion from prose.

Decision statuses are `proposed | accepted | superseded`.

Unknown statuses are `open | investigating | resolved | invalidated`. A resolved unknown may carry an answer.

Evidence kinds are `source | test | command | runtime | git | external`. Evidence records point to a task, decision, unknown, or repository-level fact. Evidence is supporting material, not a replacement for the source itself.

## Model-facing tools

### ProjectStateRead

Read-only. Returns the current logical version and a bounded projection.

Inputs:

- optional query
- optional result limit
- optional evidence inclusion

When a query is present, lexical relevance is computed over ids, titles/questions/statements, summaries, tags, related paths, and evidence references. Active/blocked work and unresolved unknowns receive a recency/status bias so important open state remains visible even with weak lexical overlap.

### ProjectStateUpdate

Workspace-scoped mutation. Every request contains `expectedVersion`.

Phase 1 operations:

- `upsert_task`
- `upsert_decision`
- `upsert_unknown`
- `upsert_evidence`

A successful mutation increments the project state version exactly once and returns the new version. A stale `expectedVersion` fails without writing.

There is no model-facing bulk replace or delete operation in Phase 1.

## Turn context projection

For a normal main-agent turn:

```text
user input
   ↓
read current Project Intelligence state
   ↓
rank relevant task/decision/unknown/evidence records
   ↓
bounded Project Intelligence reminder
   ↓
current turn request only
   ↓
model
```

The reminder is not appended to durable chat history. A later turn re-reads current state and builds a fresh projection. This prevents stale project-state snapshots from accumulating in the transcript.

The projection has a hard character budget. Missing/empty state produces no reminder.

Subagent and workflow-child mutation ownership is intentionally not expanded in Phase 1. Main interactive/fork/workflow-parent sessions own ProjectStateUpdate. Child agents can continue to report evidence/results to their parent through existing channels.

## Failure semantics

- Missing state file: treat as an empty version-0 state.
- Invalid/corrupt state: ProjectStateRead/Update fail clearly; normal chat continues without injected Project Intelligence context and logs the skip.
- Unsupported schemaVersion: fail closed; do not rewrite.
- Stale logical version: reject update.
- Stale filesystem revision: reject update and require a fresh read.
- File-system permission/I/O failure: propagate through the existing tool failure path.
- Context projection failure must not fail an otherwise valid coding turn.

## Event order and concurrency

```text
ProjectStateUpdate
  -> read state + filesystem revision
  -> validate expectedVersion
  -> apply one typed mutation
  -> increment logical version
  -> atomic write with expected revision
  -> return new version
```

Within one runtime, the update tool is non-concurrent. Cross-runtime races are detected by filesystem revision where the adapter supplies one. The logical version remains the model-visible optimistic concurrency token.

## Context and token policy

Project Intelligence is a retrieval layer, not a prompt dump.

- Never inject the complete state merely because it exists.
- Prefer open/active items and lexical matches to the current user request.
- Include compact evidence references rather than full command/test output.
- Source code and logs remain in their original stores and are read only when needed.

## Phase 1 acceptance scenarios

1. A workspace with no state file behaves exactly as before, except the new tools are available on eligible main sessions.
2. ProjectStateRead on an empty workspace returns schemaVersion 1, version 0, and empty collections.
3. Updating a task at expectedVersion 0 writes state and returns version 1.
4. Reusing expectedVersion 0 after that update is rejected without modifying state.
5. A new session for the same workspace reads the previously written state.
6. Another workspace resolves to a different state location.
7. A user turn mentioning a stored task/decision/unknown receives a bounded relevant reminder.
8. The reminder is turn-local and is rebuilt from current state on the next turn.
9. Corrupt or unsupported persisted state never gets silently overwritten.
10. Existing Memory, Todo, Dynamic Workflow, session storage, and normal repository behavior remain unchanged.

## Out of scope for Phase 1

- automatic repository symbol/dependency indexing
- automatic conversion of every tool result into evidence
- semantic/vector retrieval
- confidence-weighted hypotheses
- automatic completion policy
- UI for browsing project state
- cross-device direct editing of Project Intelligence state
