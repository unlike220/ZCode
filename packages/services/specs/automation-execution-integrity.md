# Automation execution integrity (HMAC-signed execution intent)

## Scope

This spec makes an automation's unattended execution intent tamper-evident.
Every write through `AutomationRepo` that changes the intent persists an HMAC
signature, and the desktop host verifies the signature before the automation's
prompt is submitted to a session.

It does not change: what an automation may do once dispatched, model/permission
selection integrity (not part of the signed intent), key rotation tooling, or
an audit trail of past intents (the signature column is current-state, not a
history).

## Product rule

The signed execution intent is the tuple that determines what executes and
when:

```text
automationId, prompt, cronExpr, scheduleRule, maxRuns, endAt
```

Fields that do not change what executes (title, modelSelection, mode,
targetTaskId, enabled, budget) are intentionally excluded.

- On every `create` and `update` through `AutomationRepo`, the final merged row
  is signed with HMAC-SHA256 over a canonical serialization tagged
  `automation-execution-intent-v1`, and stored in a new
  `execution_signature` column. The repository is the single write boundary, so
  the signature is always derived from the row as persisted (no drift between a
  service-computed value and the merged row).
- The signing key is a per-installation 32-byte secret at
  `{dataBaseDir}/.zcode/v2/automation-signing.key` (0600, created lazily on
  first signing write). It never leaves the machine and is never logged.
- At dispatch (`dispatchCronRun` in the desktop host, covering scheduled and
  manual runs) the host verifies: (a) the stored intent matches its stored
  signature, and (b) the dispatched request prompt equals the stored prompt.
  - Stored row signature invalid, missing key, or corrupt signature -> the
    dispatch is blocked with the typed error code
    `AUTOMATION_INTENT_SIGNATURE_MISMATCH` before any task is created or
    resumed; the host maps it to a `permanent` dispatch failure (existing
    `markDispatchFailed(kind: "permanent")` semantics: `lifecycleStatus =
"failed"`, `enabled = 0`, recoverable via the existing restart action).
  - Stored row verifies but the request prompt differs -> the intent changed
    between claim and dispatch (benign user-edit race): a plain transient
    failure, retried with a fresh claim that reads the new signed intent. The
    stale prompt is never executed.
- Rows persisted before this feature have no signature and fail open with a
  warn log; the next management write re-signs them. A row with a signature
  must always verify.

## State owner and authoritative boundary

- The key file is owned by a lazy file-based key provider (create-once, read
  after); the repository holds a provider instance and signs inside its write
  transactions.
- `execution_signature` is owned by `AutomationRepo`; only the repo writes it.
- Verification lives in the host's `dispatchCronRun`; the scheduler and main
  never execute or verify intents.

## Event order

```text
management write (create/update)
  -> repo merges final row -> sign(canonical intent, key) -> persist row + signature

scheduled / manual dispatch
  -> host resolves target services
  -> read stored intent + signature -> verify HMAC; request.prompt === stored prompt
       ok        -> existing dispatch path
       mismatch  -> typed error -> CronRunResult ok:false (permanent)
                   -> scheduler marks run failed_to_dispatch, automation failed
```

## Failure semantics

- Missing or unreadable key at signing time fails the write (fail-closed: no
  unsigned rows are produced while a provider is configured).
- The verification-side key provider is read-only: it never creates the key
  file. A missing or unreadable key at verification time blocks dispatch
  (fail-closed) with an actionable error: re-saving the automation re-signs
  under the current key. Deleting the key file does not silently re-enable
  anything, and verification never races the write-side key creation.
- Verification uses a constant-time comparison of the HMAC digests.
- Signature comparison covers the exact serialized bytes; any canonicalization
  change requires a new serialization tag, never an in-place edit of
  `automation-execution-intent-v1`.

## Acceptance scenarios

1. A created automation has a signature that verifies against its row.
2. Updating prompt / cronExpr / scheduleRule / maxRuns / endAt re-signs; the
   new signature verifies and the old one does not.
3. Updating a non-intent field (title, mode, budget) keeps the signature valid
   (row intent unchanged → same signature bytes).
4. Toggling enabled, restart, and scheduler claim/settlement writes do not
   re-sign or invalidate the signature.
5. Out-of-band edit of `prompt` (or any signed field) in the SQLite file is
   detected at dispatch: the run is blocked, never executed, and the
   automation transitions to `failed` with the typed error.
6. A dispatched request whose prompt differs from the signed stored prompt is
   blocked even though the stored row verifies.
7. A legacy row without a signature dispatches with a warn log (upgrade
   compatibility); after any management edit it is signed like a new row.
8. A corrupted signature (not hex, wrong length, wrong value) blocks dispatch.
9. Verification failure produces a `permanent` scheduler settlement, not a
   retry loop.

## Remediation invariants

- The signature is a derived invariant of the stored row: it must be computed
  inside the repository write path (after merge, before persist) so it can
  never describe a different row than the one persisted.
- The scheduler's `claimDue` / settlement writes must never clear or overwrite
  `execution_signature`.
- The signing key provider must be injectable; tests use a fixed in-memory key.
