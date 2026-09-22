# Model request budget preflight

## Scope

This spec adds the first local-context protection for model requests. It does
not change tool registration or selection, Dynamic Workflow descriptions,
MCP initialization, Project Intelligence, Repository Facts, compaction policy,
or provider context-error handling.

## Product rule

Every physical model attempt must estimate the complete provider-facing input
after message and tool transformations. The estimate includes provider-facing
messages, provider-visible tool definitions, and request framing overhead.
When the model context window is known, a request fits only when:

```text
estimatedInputTokens <=
  contextWindow - requestedOutputTokens - safetyMarginTokens
```

Equality fits. If the right-hand side is zero or negative, the request does
not fit. Unknown context windows remain on the existing provider-bound path.

The estimator is a conservative character-based heuristic, not an exact
tokenizer. It estimates only the serialized provider-facing shape; execution
handlers and internal tool metadata are excluded.

## State owner and authoritative boundary

The adapters model runner owns the physical provider-attempt boundary. After
the final provider-facing AI SDK messages/tools are constructed and the
actual requested output amount is known, the shared
`assertProviderFacingRequestBudget` boundary in `runner-options.ts` invokes
one request-budget calculation before either runtime provider call. The
resulting `ModelRequestBudget` is the sole hard preflight decision and is also
the source for local diagnostics.

Core may continue its existing output-cap calculation for compatibility; it is
not a second acceptance boundary. The adapter preflight is authoritative.

## Failure semantics

An oversized known request throws the typed local code
`MODEL_CONTEXT_BUDGET_EXCEEDED` (adapter code
`model_context_budget_exceeded`) before the provider runtime is invoked. The
error context contains model identity and numeric budget breakdown only:
context window, message/tool/framing/input estimates, requested output,
safety margin, allowed/remaining input, and tool count. It never contains
message text, tool descriptions, schemas, arguments, or credentials.

Provider-originated `MODEL_CONTEXT_EXCEEDED` remains unchanged and continues
to be handled as the fallback for tokenizer/provider discrepancies.

## Event order

```text
optional conversation compaction
  -> final core messages/tools
  -> existing physical-attempt admission
  -> provider-facing AI SDK projection
  -> calculate ModelRequestBudget
  -> fits? --no--> local typed error; provider not invoked
          \--yes--> existing admission/status/retry/provider path
```

The budget is recomputed per physical attempt so provider-specific request
projection remains the measured representation.

## Acceptance scenarios

1. A small messages-only request fits.
2. Adding a large provider-visible tool increases the estimate.
3. A tool-heavy request whose messages alone fit is rejected locally.
4. Output reservation and the safety margin reduce the allowed input budget.
5. Equality at the allowed boundary fits.
6. A valid request still reaches the model runtime.
7. Local diagnostics expose numeric fields without request content.
8. Generic external/MCP-shaped tools contribute to the tool estimate.

## Remediation invariants

The logical requested output reservation is passed independently to the local
preflight. It must not be added to the generic AI SDK options; the existing
provider option-map remains the sole authority for the wire-level output-token
field.

`LocalContextBudgetExceeded` is terminal for workflow retry policy, including
`ModelRetryBudget.Unbounded`. It uses the existing `context_exceeded` consumer
path so the typed local failure remains the cause without provider retry or
provider-stop classification.

Regression coverage must exercise both generate and stream runner boundaries,
prove the stream provider is not invoked on overflow, and cover both exact
budget equality and one token over the allowed input.
