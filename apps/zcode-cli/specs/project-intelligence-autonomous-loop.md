# Project Intelligence Autonomous Completion Integration — Phase 4

## Goal

Let an existing session target continue through the existing target
continuation loop while a current Project Work item explicitly attributes the
work to a Project Task. The continuation boundary evaluates that task's
current Completion Contract after runtime effects and Automatic Evidence have
settled. A ready contract stops the autonomous target deterministically;
otherwise the existing turn and tool infrastructure remains responsible for
the next step.

Completion readiness ends autonomous continuation. It does not mark the
Project Task `done`; `ProjectStateUpdate` remains the only task-status
mutation path.

## Architecture and ownership

There is one autonomous loop:

```text
existing SessionGoal continuation loop
  -> current Project Work taskId gate
  -> fresh Project State + Completion Contract + Project Work reads
  -> existing deterministic Completion Contract evaluator
  -> ready: finish SessionGoal / no new turn
     not_ready: existing target verifier and executeTurnCommand
  -> existing tools and executor
  -> Automatic Evidence Capture
  -> next continuation boundary
```

`runActiveTargetContinuationLoop` remains the loop owner. Phase 4 adds a
decision gate inside `executeTargetContinuationCommand`; it does not add a
second model, tool, retry, or background loop. Project Intelligence remains
the owner of task/work/completion state. `AgentRuntime` owns only a bounded,
runtime-local no-progress observation for the active target.

For a governed task, the existing model completion verifier may still provide
next-action guidance, but it cannot complete the SessionGoal while the
Project Contract is not ready. When the contract is ready, the engine can
complete the SessionGoal without asking the verifier for magic completion
words.

## Activation and task attribution

Phase 4 activates only when all of the following are true:

1. the current target is an active `SessionGoal`;
2. a valid current Project Work item exists with an explicit `taskId`;
3. the current Completion Contract state parses and contains a contract for
   that task.

No task identity is inferred from target text, prompts, paths, filenames,
Repository Facts, or chat history. Missing Project Work, missing `taskId`, or
an absent contract preserves legacy continuation behavior. Child runtimes do
not acquire a Project Intelligence autonomous lifecycle; target continuation
ownership remains with the parent/main session that owns the active target.

## Continuation decision

At each continuation boundary the engine performs bounded reads of the
current Project Work, Completion Contract, and Project State, then calls the
existing `evaluateProjectCompletion` function. It does not scan Git,
refresh Repository Facts, run tests, parse source, or inspect the workspace.
The read is repeated after the existing model verifier when that verifier was
run, so a point-in-time result is not cached across the scheduling decision.

- No linked task or no contract: use the existing target verifier and
  continuation behavior.
- Linked contract `not_ready`: keep the target eligible, subject to the
  existing verifier, token/iteration/execution budgets, cancellation, and
  other runtime stops.
- Linked contract `ready`: set the SessionGoal to the existing `complete`
  status and emit a deterministic `project_completion_ready` stop reason;
  do not schedule another continuation turn.
- A governed task whose state cannot be evaluated safely: pause the
  SessionGoal using existing lifecycle semantics, emit a deterministic
  `project_intelligence_state_corrupt` reason, and do not treat the state as
  absent or ready.

The `no_open_project_work` criterion is evaluated using the same current work
state as Phase 3.5. Phase 4 does not close Project Work or change a Project
Task status.

## Model completion precedence

For a governed task, a model verifier result of `passed: true` does not
complete the SessionGoal while the fresh Contract evaluation is `not_ready`.
The target remains active and the existing continuation prompt is scheduled
after the normal gate. Conversely, a fresh `ready` evaluation completes the
SessionGoal even if the model verifier was not run or did not return a pass.

## Progress fingerprint and stagnation

For a governed not-ready task, the runtime computes a deterministic bounded
fingerprint from engine-owned metadata:

```text
taskId | Project State version | Completion State version |
Project Work version | observed mutation count |
evaluation status + criterion ids/statuses
```

It does not hash prompts, full tool output, source contents, or repository
scans. A changed fingerprint resets the no-progress count. The same
fingerprint on a later boundary increments it. The centralized threshold is
`3` unchanged governed boundaries; the first observation only establishes a
baseline, so one unchanged boundary never stops continuation. At the
threshold the target is paused with `project_continuation_stagnated`, and no
new turn is scheduled. A state/evidence/mutation version change resets the
counter.

The counter is runtime-local and bounded to one entry per target. It is
deliberately reset when a runtime is recreated or an active target is
restarted/resumed. Canonical Project Intelligence versions remain persisted,
so resume starts from a fresh current evaluation rather than trusting a stale
READY result. Existing target token/time budgets remain the durable bound
across resume; this small reset avoids adding a new persistence subsystem.

## Existing budget, cancellation, and lifecycle composition

Phase 4 never replaces target token budgets, turn/iteration limits, execution
limits, abort signals, permission stops, hook stops, tool failures, session
shutdown, or user stop/pause. The continuation command is still submitted to
the existing cancellable runtime command queue and every generated step still
uses `executeTurnCommand`.

Cancellation follows the existing target pause/abort path. It does not write
Project Intelligence, create evidence, resolve unknowns, or mark a task done.
Model failure and budget exhaustion retain their existing target statuses and
events. Phase 4 only adds the ready, stagnated, and corrupt governed stops.

## Corrupt state

If Project Work cannot be read well enough to establish an explicit `taskId`,
Phase 4 does not activate and legacy continuation is preserved. Once a valid
linked `taskId` is established, a corrupt/unsupported Completion Contract or
Project State read is a governed failure: the engine pauses the SessionGoal,
emits `project_intelligence_state_corrupt`, and never downgrades the failure
to “no contract”.

## Context and persistence

No autonomous history is added to model context. Existing bounded Project
Intelligence context remains the source for current task/contract criteria.
Only the current contract status and compact next-action reminder can appear
through the existing continuation prompt. The progress counter is not
persisted and is reset on runtime recreation/resume; Project State,
Completion State, Project Work, evidence, and target status keep their
existing persistence owners.

## Parent/child implications

The parent/main runtime owns the active SessionGoal and its continuation
command. A child may execute tools through the central executor and its
successful observations may feed Automatic Evidence Capture under the current
Project Work attribution, but a child cannot own or terminate the parent's
autonomous continuation lifecycle.

## Acceptance scenarios

1. No Project Work, unlinked Project Work, and linked work without a contract
   retain legacy continuation behavior.
2. A linked not-ready contract remains continuation-eligible.
3. A linked ready contract completes the SessionGoal without another turn.
4. A model “done”/verifier pass cannot complete a governed not-ready task.
5. A ready contract stops even when model self-completion is absent.
6. Successful Automatic Evidence changes the fresh evaluation from not-ready
   to ready, and the next boundary stops without an unnecessary turn.
7. One unchanged fingerprint does not stop; three unchanged governed
   boundaries stop deterministically as stagnated.
8. Project State, evidence, or observed mutation progress resets stagnation.
9. Corrupt governed state pauses safely and is not treated as no contract.
10. Existing budget and cancellation paths remain authoritative and do not
    fabricate task state or evidence.
11. A recreated/resumed runtime evaluates current persisted state and starts a
    fresh bounded stagnation observation.
12. Child execution cannot take autonomous lifecycle ownership.

## Non-goals

- a second autonomous agent/model/tool loop;
- automatic test or verification command execution;
- automatic Project Task `done` mutation;
- automatic unknown resolution or evidence fabrication;
- prompt-based progress scoring;
- repository watchers, full scans, event sourcing, or deterministic replay;
- a new permission, budget, scheduler, or child-agent lifecycle system.
