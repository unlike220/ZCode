# Automatic Evidence Capture — Project Intelligence Phase 3.6

## Goal

Phase 3.6 captures trustworthy Project Evidence automatically from successful runtime observations instead of requiring the model to restate verification results as prose.

The initial capture surface is deliberately narrow: successful foreground command observations emitted by normal tool execution telemetry. The engine links those observations to the task referenced by current Project Work.

Automatic evidence strengthens Completion Contracts without replacing canonical truth. The command/process result remains the original observation; Project Evidence stores only a bounded structured reference and safe summary.

## Ownership and truth

- Filesystem, Git, compiler/tests, process exit status, and runtime results remain canonical observations.
- Phase 1 Project Evidence is epistemic state derived from those observations.
- Automatic evidence is engine-authored. Model-facing ProjectStateUpdate cannot forge its provenance.
- Phase 3 Project Work provides task attribution only; it does not prove success.
- Phase 3.5 Completion Contracts may require automatic evidence explicitly.
- Session/tool events remain the original execution observation. Automatic evidence points back using tool/trace identifiers and never copies raw command output.

## Persisted evidence provenance

Phase 1 evidence schema remains version 1 and gains an optional additive provenance field. Existing state files remain valid.

Conceptually:

```text
ProjectEvidence
├── id
├── subjectType
├── subjectId?
├── kind
├── reference
├── summary?
├── observedAt
└── provenance?
    ├── source = automatic_tool
    ├── toolName
    ├── toolCallId
    ├── traceId?
    ├── outcome = success
    └── command?
        ├── category
        ├── safeName?
        ├── hash?
        ├── exitCode?
        └── status = completed
```

Raw command text, stdout, stderr, source content, prompts, environment variables, and secrets are not persisted in evidence.

The model-facing `upsert_evidence` mutation does not accept `provenance`. Existing engine-authored automatic evidence cannot be overwritten through ProjectStateUpdate.

## Capture admission

The central executor may capture evidence only after a tool call has returned successfully, its output has passed runtime output validation, serialization has succeeded, PostToolUse hooks have completed, and final model-content validation has passed.

An observation is eligible when:

1. normal execution telemetry contains `detail.kind = command`;
2. command status is `completed`;
3. it is not backgrounded, timed out, cancelled, or failed;
4. current Project Work exists and has a `taskId`;
5. that task still exists in current Project State.

Initial command kind mapping is conservative:

- successful command telemetry is eligible for automatic command evidence;
- `test` and `git` Project Evidence kinds are promoted only when the executed Bash input can be parsed deterministically and the actual invocation matches a trusted test/Git shape;
- dynamic/unsupported/parse-error shell input is downgraded to `command`;
- shell operators that can mask an earlier failure (`||`, sequence, pipelines) prevent test/Git promotion; a pure `&&` chain may retain promotion because overall success implies each preceding command succeeded;
- heuristic telemetry alone never promotes `echo pnpm test` or similar text into test evidence;
- other successful command categories remain Project Evidence kind `command`.

This intentionally captures successful build/package/shell verification as command evidence while reserving test and Git evidence kinds for stronger execution semantics.

A command whose process exit/status is not successful is not inserted as completion evidence in Phase 3.6. Failure observations remain available through normal tool/session events; a future event ledger may retain them separately without making failed verification satisfy Completion Contracts.

## Background commands

A `backgrounded` Bash result is not completion evidence because the process has not finished yet.

Phase 3.6 does not infer completion from the act of launching a background task. Capturing detached/background task completion requires a reliable terminal completion observation seam and is deferred rather than guessed.

## Task attribution

Automatic evidence is task-scoped only when current Project Work has an explicit `taskId`.

No linked Project Work means no automatic task evidence. The engine does not guess the task from prompts, paths, tool names, or model text.

Child/subagent command execution may produce automatic evidence when it runs through the same central executor and the workspace Project Work links the task. This is engine capture, not child ownership of ProjectStateUpdate.

## Identity and idempotency

Automatic evidence IDs are deterministic hashes of stable execution identity including task/tool-call identity. Reprocessing the same observation is idempotent.

Engine capture may replace the same engine-authored record for the same observation but does not rewrite unrelated manual evidence.

## Concurrency

Automatic capture performs a fresh Project State read and an atomic expected-revision write.

If a concurrent Project State update wins first, automatic capture retries a small bounded number of times after re-reading current state. It never performs an unbounded retry loop.

If evidence bookkeeping still fails after the underlying command has succeeded, the tool result remains successful. The failure is logged because bookkeeping cannot truthfully roll back the command.

## Boundedness

Automatic evidence is bounded per task. The newest automatic evidence is retained and the oldest automatic records for that task may be pruned when the per-task cap is exceeded. Manual evidence is never pruned by automatic capture.

Project State serialization is size-checked before write so automatic capture cannot create a state file that its reader would immediately reject as oversized.

This store is not an append-only event ledger.

## Completion Contract integration

`task_evidence` gains an optional source filter:

```text
evidenceSource = any | automatic
```

Absent means `any` for backward compatibility.

- `any`: preserves Phase 3.5 behavior and may count manual or automatic matching evidence.
- `automatic`: counts only matching evidence with engine-authored `automatic_tool` provenance and successful outcome.

This lets user-approved Completion Contracts require runtime-observed verification without breaking existing contracts.

Automatic evidence proves that the recorded command invocation completed successfully under the runtime semantics above. It does not by itself prove test adequacy, coverage, assertion quality, or that a chosen test target was the correct Definition of Done. Completion Contracts should combine evidence with other criteria; richer verification identities/counts can be added later without treating model prose as proof.

ProjectCompletionUpdate remains always-ask, so the model cannot silently weaken `automatic` back to `any`.

## Context

Existing Project Intelligence evidence projection may display automatic evidence like ordinary evidence. Completion context must describe whether a task-evidence criterion requires automatic evidence.

No raw command/output is injected through the new provenance.

## Failure semantics

- no Project Intelligence root / filesystem port: skip capture;
- missing Project Work: skip capture;
- work without taskId: skip capture;
- task missing: skip and log diagnostic rather than inventing a subject;
- non-command telemetry: skip;
- failed/timed-out/cancelled/backgrounded command: skip;
- corrupt Project Work or Project State: capture fails safely and logs; successful command is not converted into a failed tool call;
- stale Project State write: bounded retry;
- oversized resulting state: capture fails/logs without corrupting state;
- manual attempt to overwrite engine-authored evidence through ProjectStateUpdate: reject.

## Acceptance scenarios

1. Existing Project State without provenance still parses.
2. Model-facing upsert_evidence rejects a provenance field.
3. Manual upsert cannot overwrite existing automatic evidence.
4. Successful command observation under linked Project Work creates task evidence automatically.
5. Captured evidence contains no raw command/stdout/stderr.
6. Test command telemetry maps to evidence kind test.
7. Git command telemetry maps to evidence kind git.
8. Other successful command telemetry maps to command.
9. Failed command does not create completion evidence.
10. Timed-out/cancelled/backgrounded command does not create evidence.
11. No Project Work produces no task evidence.
12. Unlinked Project Work produces no task evidence.
13. Same tool observation is idempotent.
14. Concurrent stale write is retried boundedly.
15. Automatic evidence retention is bounded without deleting manual evidence.
16. task_evidence with evidenceSource automatic ignores manual evidence.
17. task_evidence with absent/any source preserves Phase 3.5 behavior.
18. ProjectCompletionUpdate approval semantics remain unchanged.
19. Child runtimes cannot call ProjectStateUpdate but central automatic capture still uses workspace task attribution.
20. Phase 1-3.5 regression tests remain compatible.

## Non-goals

- automatic evidence from arbitrary prose;
- claiming failed commands as successful verification;
- background-task completion inference;
- full event ledger/event sourcing;
- automatic test execution;
- automatic task completion;
- autonomous retry/planning loop;
- storing raw command/output;
- semantic interpretation of test logs;
- Git diff/source snapshot storage;
- new permission system or agent loop.
