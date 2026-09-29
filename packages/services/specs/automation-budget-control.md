# Automation budget control (per-automation token budget with dispatch-time hard stop)

## Scope

This spec adds an optional spend budget to scheduled automations. It covers the
budget configuration surface (shared types, protocol, repository, service), the
dispatch-time hard stop in the cron scheduler, the manual-run gate in
`AutomationService.runNow`, and best-effort post-run spend recording in the
desktop host.

It does not change: off-peak tasks (independent domain; out of scope for v1),
in-flight run cancellation (a run dispatched while within budget always runs to
completion), CLI turn-level enforcement, host/scheduler message protocol, and
the existing `maxRuns` / `endAt` semantics.

## Product rule

An automation may declare a budget `{ limitTokens, window }`:

- `limitTokens`: positive integer, measured with the CLI usage store's
  `computedTotalTokens` semantics (incremental input + output + reasoning; the
  same aggregation the task usage view uses).
- `window`: `"day" | "month" | "lifetime"`. `day` and `month` are UTC calendar
  buckets (`YYYY-MM-DD` / `YYYY-MM`); `lifetime` is one bucket for the whole
  automation lifetime.

Spend accumulates per automation run. A scheduled automation prompt is sent
with `traceId = runId`, and one run maps to one `automation_runs` row; the
ledger therefore keys spend rows by `run_id` (idempotent upsert).

Gate rule — `observed spend in the current window bucket >= limitTokens`
blocks. Equality blocks. Two admission points enforce it:

1. **Scheduled runs** — the scheduler evaluates the gate right after
   `claimDue` claims the automation, before building the dispatch request.
2. **Manual runs** — `AutomationService.runNow` evaluates the gate before
   claiming the manual run; a blocked attempt throws the typed error
   `AUTOMATION_BUDGET_EXHAUSTED` (message carries the code, same convention as
   `AUTOMATION_CREATE_LIMIT_REACHED`) and creates no run row.

Hard stop semantics on gate breach for scheduled runs: the automation is
paused (`lifecycleStatus = "paused"`, `enabled = 0`, claim released,
`lastError` set to the budget message), and the due run is recorded as
`skipped` with reason `budget_exhausted`. No dispatch request is sent, no
retry/backoff state is touched, and a `paused`/`completed`/`failed` automation
is never re-classified by this path.

Recovery is a user action only: re-enabling, or raising the budget and then
re-enabling. Raising the budget does **not** auto-resume in v1. A run admitted
before the breach completes normally and its spend is recorded.

## State owner and authoritative boundary

- `AutomationRepo` (tasks-index.sqlite) is the single owner of budget
  configuration (new `automations` columns) and the spend ledger (new
  `automation_spend` table, one row per run, unique by `run_id`).
- The CLI usage store remains the only source of raw per-request usage; the
  host reads it read-only through the existing `usage/stats` /
  `conversation/usage` protocol family with a new optional `traceId` filter
  (additive; filtered rows recompute the incremental-input baseline within the
  filtered set).
- The scheduler owns the claim-time gate; `AutomationService` owns the manual
  gate; the host owns post-terminal spend recording. No other component writes
  budget state.

## Event order

Scheduled path:

```text
claimDue (running 0→1)
  -> gate: budget? sum(spend in current bucket)
       within budget -> upsertRunClaimed -> dispatch request -> existing path
                        terminal outcome -> host records spend (upsert by run_id)
       exhausted     -> pauseForBudgetExhaustion (paused, enabled=0, claim released)
                      -> recordSkippedRun(reason="budget_exhausted")
                      -> no dispatch request, no dispatch-failure accounting
```

Manual path:

```text
runAutomationNow (RPC) -> runNow gate
  within budget -> claim manual run -> host dispatch (existing)
  exhausted     -> throw AUTOMATION_BUDGET_EXHAUSTED; no run row, no claim
```

Spend recording (best-effort, after terminal outcome):

```text
terminal outcome -> host queries usage (sessionId + traceId=runId)
  -> repo.recordRunSpend(automationId, runId, bucket(now), totalTokens)
  failure -> warn log only; under-count is safe, over-count never happens
```

Gate evaluation and spend recording are separated in time by design: a run may
push spend past the limit; the next claim observes it and pauses.

## Failure semantics

- A budget block is not a dispatch failure: no attempts increment, no backoff,
  no `failed` lifecycle, no scheduler dispatch-result round trip.
- Spend query failures (agent unavailable, remote host on an older CLI without
  the `traceId` param, protocol error) degrade to an under-count with a warn
  log. The gate must never fabricate spend.
- Automations created before this feature have no budget (`NULL` columns) and
  are never gated; clearing a budget (`budget: null`) un-gates immediately.
- The `automation_spend` ledger has no pruning in v1 (one row per run);
  `lifetime` windows require full history.

## Acceptance scenarios

1. An automation without a budget is never gated and records no ledger rows;
   adding a budget later starts counting from zero.
2. Scheduled claim with spend strictly below the limit dispatches normally.
3. Scheduled claim with spend equal to the limit pauses the automation,
   records a `skipped` run with reason `budget_exhausted`, and dispatches
   nothing.
4. The paused-by-budget state preserves `next_run_at`; re-enabling resumes
   scheduling from the recomputed next occurrence.
5. Manual run on an exhausted automation throws `AUTOMATION_BUDGET_EXHAUSTED`
   and creates no run row; the automation state is unchanged.
6. Recording the same run twice (late settlement replay) keeps the ledger
   idempotent: the row is keyed by `run_id` and replaced, not accumulated.
7. Day/month windows only count spend inside the current UTC bucket;
   `lifetime` counts every recorded run.
8. Spend recording failure (usage query rejects) logs a warning and leaves the
   ledger unchanged; the next gate evaluation sees the lower sum.
9. Raising `limitTokens` while paused does not resume; the automation stays
   paused until an explicit enable.
10. Budget fields round-trip through create/update protocol and appear on the
    automation projection; `budget: null` clears the budget.

## Remediation invariants

- The gate reads budget and spend from the same SQLite connection inside one
  `BEGIN IMMEDIATE` transaction only where an atomic claim decision is needed;
  the scheduler gate runs after the claim, so a plain consistent read pair is
  sufficient and no new lock ordering is introduced.
- The budget gate must not consume the `dispatch_attempts` / `retry_at`
  machinery; a paused-by-budget automation that is re-enabled restarts clean.
- The trace-filtered usage query must remain additive: absent `traceId`
  preserves the exact existing per-session aggregation, and the result schema
  is unchanged.
