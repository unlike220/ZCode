# Context Fix #6 — Context UI / Diagnostics

## Scope

Context Fix #6 extends the existing context-usage observability path so the UI can explain both:

1. what currently consumes context; and
2. what Context Fixes #3 and #4 did to the tool catalog before the provider request.

It does not change provider prompts, provider-visible tools, admission decisions, request-budget math,
Dynamic Workflow availability, ToolSearch behavior, compaction, or model selection.

## Existing foundation

ZCode already emits and renders a category-level context breakdown:

- system prompt
- meta-user context
- skills
- tool prompt
- system tool schemas
- MCP tool schemas
- messages

The existing UI is useful for composition, but it cannot currently answer:

- how many tools were eligible before lazy exposure;
- how many schemas Fix #4 exposed;
- how many schemas Fix #3 admitted or omitted;
- what the local hard-preflight estimated;
- how much input headroom remained after output reserve and safety margin.

The adapter already computes these facts; Fix #6 carries them through the existing model-complete /
usage-update projection instead of recomputing them in UI.

## Ownership

### Core turn loop

Owns Fix #4 exposure facts for the current model step:

```text
eligible tools -> lazy exposed tools
```

It supplies only counts to the model-request diagnostics path.

### Model adapter

Owns provider-facing serialization, Fix #3 admission, and Fix #1 budget calculation.

It emits a runtime-only diagnostics snapshot after admission and before provider invocation. The
snapshot is observational only and cannot affect admission or preflight.

### Session event / protocol projection

`ModelComplete` persists the latest successful main-turn diagnostics beside the existing
context-usage breakdown. Legacy/V4 projection transports the same bounded scalar object.

### UI

The existing context panel renders the diagnostics. It never estimates request budget itself.

## Runtime-only adapter diagnostics

Add a runtime-only callback on `ModelTextRequest`. It is not part of serialized provider requests.

The adapter reports:

- candidate tool count (Fix #4/provider-compatible candidate set)
- admitted tool count
- omitted tool count
- candidate estimated input tokens when a local budget is known
- final estimated message/tool/framing/input tokens
- context window
- requested output reserve
- safety margin
- allowed input
- remaining input headroom
- fit status

No prompt text, tool schemas, tool inputs, credentials, or full omitted-tool-name arrays are carried
to UI.

## Tool exposure diagnostics

The core turn loop records:

- `eligibleToolCount`: model-eligible tools after turn-level allow/deny filters but before Fix #4
- `exposedToolCount`: schemas selected by Fix #4 for this model step

The adapter then adds:

- `candidateToolCount`: provider-compatible tools entering Fix #3
- `admittedToolCount`: schemas actually sent to the provider
- `omittedToolCount`: candidate schemas dropped by Fix #3

This distinguishes:

```text
eligible -> Fix #4 exposed -> provider candidate -> Fix #3 admitted -> provider
```

## UI behavior

The existing context usage popover remains the entry point.

When diagnostics are available, add a compact diagnostic section below the category breakdown:

```text
Local preflight     17.5K / 23.6K
Headroom             6.1K
Tools                15 exposed / 40 eligible
Admission            15 admitted / 0 omitted
Output reserve        8.2K
Safety margin         1.0K
```

The wording must make clear that local-preflight token values are estimates and are not the same
quantity as provider-reported context usage at the top of the panel.

Do not show the section for old sessions/events that do not carry diagnostics.

## Persistence / replay

Diagnostics are optional for backward compatibility.

They travel with the same latest main-turn context-usage fact used by the current meter and must
survive:

- live desktop continuous delivery;
- persisted ModelComplete replay;
- V4 snapshot/cold restore;
- task service usage_update mapping.

Old events without diagnostics continue to work unchanged.

## Boundedness

The diagnostics object contains scalar counts and token numbers only. Its serialized size is
bounded independently of:

- number of registered tools;
- tool schema size;
- message content;
- MCP server count.

No full tool-name list is persisted.

## Safety invariants

1. The diagnostics callback is runtime-only and never provider-visible.
2. Diagnostics are emitted from the same authoritative Fix #1/#3 calculations; UI does not
   reimplement budget math.
3. Fix #4 exposure counts are observational only.
4. Missing diagnostics never block a model request.
5. Diagnostics failures must not change provider request semantics.
6. No additional system prompt, meta-user message, tool description, or tool schema is injected.
7. Existing Context Fix #1–#5 behavior remains unchanged.

## Acceptance

1. Existing category breakdown remains intact.
2. Main-turn ModelComplete may carry optional diagnostics.
3. Live and restored task usage preserve diagnostics.
4. UI shows local budget/headroom and tool-pipeline counts when available.
5. Old usage data without diagnostics renders exactly as before.
6. Adapter generate and stream report equivalent diagnostics.
7. Candidate/final budget metrics match Fix #1/#3 calculations.
8. Fix #4 eligible/exposed counts are correct.
9. Diagnostic transport is bounded and contains no prompt/schema payloads.
10. Context Fix #1–#5 regression tests and architecture checks remain passing.
