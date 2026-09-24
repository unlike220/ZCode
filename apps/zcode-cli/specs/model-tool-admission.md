# Model tool admission (Context Fix #3)

## Scope

This spec adds deterministic, per-request provider tool admission before the
Context Fix #1 hard request-budget preflight. It does not unregister tools,
change feature enablement, initialize or stop MCP servers, interpret user text,
change the token estimator, reduce the output reserve or safety margin, or
implement lazy tool discovery.

Tool registration remains the source of feature availability. Admission only
controls which already-enabled tool schemas are exposed to one physical model
request.

## Product rule

For every model attempt with a known local request budget:

1. Build the normal complete candidate tool catalog.
2. Project messages and tools to the provider-facing AI SDK representation.
3. If the complete catalog fits Context Fix #1, expose it unchanged.
4. If it does not fit, retain mandatory tools and admit remaining tools
   deterministically by admission priority and provider-visible cost.
5. Run the existing Context Fix #1 whole-request preflight over the final
   admitted provider-facing request.

The final authority remains:

```text
estimatedInputTokens <=
  contextWindow - requestedOutputTokens - safetyMarginTokens
```

Admission never changes this formula. If messages plus mandatory tools still do
not fit, mandatory tools remain present and Context Fix #1 rejects the request
locally.

When the context window or requested output budget is unknown, admission does
not prune: the complete candidate catalog continues to the existing provider
fallback path.

## Ownership and boundary

The adapters model request builder owns physical provider exposure because it
is the first shared boundary that has all of:

- final provider-facing messages,
- final provider-visible tool definitions,
- model context-window metadata,
- the logical requested output reservation,
- both generate and stream request paths.

Core continues to own tool registration and tool semantics. Core projects an
internal admission-priority hint with each `ModelToolContract`; the hint is
runtime metadata and must never be serialized as part of the provider-visible
schema.

```text
core registry (feature availability)
  -> complete ModelToolContract candidates
  -> provider-facing message/tool projection
  -> adapters tool admission
  -> Context Fix #1 hard preflight
  -> provider runtime
```

There is no second registry, tool cache, or execution path. Admitted tools keep
their original handlers and permission checks.

## Priority policy

Admission priorities are:

- `mandatory`: ordinary execution/control capabilities that must not be
  silently removed under pressure.
- `high`: broadly useful support capabilities that should survive before
  normal or optional tools.
- `normal`: default for enabled tools without a stronger policy.
- `optional`: feature-specific or externally discovered capabilities that
  may be omitted from a constrained request without disabling the feature.

The initial built-in policy keeps core file/shell mutation and terminal
workflow/plan control mandatory; search, Skill, user-interaction, background
task control, coordinator messaging, and the primary `CreateWorkflow`
entrypoint are high; general tools are normal; and secondary Dynamic Workflow
management/reference tools, Automation/Off-Peak, web utilities, node REPL and
MCP-discovered tools are optional unless a tool declares an explicit override.
Keeping the primary workflow entrypoint above its secondary family avoids
turning an enabled Dynamic Workflow feature into an unreachable feature solely
because the request is under budget pressure.

A tool explicitly selected by the current `toolChoice` is promoted to
mandatory for that request. Historical tool calls/results do not force the
same schema to remain exposed: AI SDK/provider message conversion carries
their tool name, call id and result directly in history, while the current
`tools` list independently describes what the model may call next. Avoiding
history-based promotion prevents once-used optional tools from becoming
permanent context cost for the remainder of a long session.

## Deterministic admission

When pruning is required:

1. Admit all mandatory and request-promoted tools.
2. If that set alone exceeds the budget, stop admission and let Context Fix #1
   reject; never delete mandatory tools to manufacture a fit.
3. Consider remaining tools by priority: high, normal, optional.
4. Within one priority, consider smaller provider-visible definitions first;
   use original candidate order and tool name as stable tie-breakers.
5. A candidate is admitted only when the complete trial request still fits.
   An oversized candidate is skipped and later smaller candidates are still
   considered.
6. Return admitted tools in original candidate order.

For `toolChoice: "required"`, at least one candidate must remain. If no tool
can fit, the highest-priority deterministic candidate remains and the hard
preflight rejects rather than sending an invalid required-without-tools
request.

## Compatibility invariants

1. If the complete catalog fits, admitted tools equal candidate tools exactly.
2. Registration, execution handlers, permissions and feature flags are
   unchanged.
3. Generate and stream use the same admission implementation.
4. Context Fix #1 remains the sole hard acceptance/rejection boundary.
5. Dynamic Workflow rollout/default semantics are unchanged.
6. MCP startup/discovery is unchanged; MCP schemas merely participate as
   optional request candidates.
7. Project Intelligence, Repository Facts and compaction are unchanged.
8. No user-text keyword matching or semantic classifier is introduced.
9. Admission metadata is never provider-visible.

## Diagnostics

The admission result may expose safe structural metrics to tests/callers:
candidate/admitted/omitted tool counts and candidate/admitted budget estimates.
Prompt content, tool descriptions, schemas, arguments and credentials are not
logged by admission.

## Acceptance scenarios

1. A large-context request keeps the complete candidate catalog.
2. Under pressure, optional tools are omitted while mandatory tools remain.
3. The final admitted request passes Context Fix #1 when a valid subset exists.
4. Mandatory-only overflow remains a local Context Fix #1 failure.
5. Repeated identical inputs produce the same admitted set and ordering.
6. One oversized optional tool does not block smaller same/lower-stage
   candidates that fit.
7. Generic MCP/external tools participate without server-name hardcoding.
8. Explicit current tool choice is retained; historical tool messages remain valid without forcing current schema exposure.
9. Generate and stream expose the same admitted set for equivalent requests.
10. Existing request-budget and Dynamic Workflow context tests remain passing.

## Migration boundary and future work

Context Fix #3 is admission, not discovery. A constrained model can still lose
optional capabilities on a turn because there is not yet an on-demand schema
search/retrieval path. Context Fix #4 will address dynamic/lazy tool discovery.
This fix intentionally does not weaken the conservative estimator to compensate
for that limitation.
