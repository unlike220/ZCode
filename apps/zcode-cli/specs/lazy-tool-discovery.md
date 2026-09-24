# Lazy provider tool discovery (Context Fix #4)

## Product rule

Registration and provider exposure are separate. The runtime registry remains the
complete source of executable tools and permission policy. Ordinary interactive
model steps advertise a compact coding baseline plus `ToolSearch`. The model can
call `ToolSearch` with a lexical query; its concise results select up to five
currently registered tools for exposure on the next model step. The selected
contracts go through the existing Context Fix #3 admission and Context Fix #1
hard preflight before reaching the provider.

No natural-language classification of the user request chooses a baseline.
Registration flags, MCP startup, Dynamic Workflow rollout, output reservation,
safety margin, model tokenizer, and secondary fixed-tool model calls are unchanged.

## Owner and interfaces

`RegularTurnLoopState` owns the bounded, turn-local recent exposure names. It is
created empty for each product turn and discarded at turn end. The registry owns
tool metadata, schema, handler, and permission policy. `ToolSearch` reads the
registry and returns only name, short purpose, and capability. The turn loop
projects registry contracts using permanent baseline/control names plus recent
discoveries. The
existing executor resolves every eventual call through the same registry.

The provider adapter remains stateless: it receives the selected contracts,
performs admission, then hard preflight. A current specific `toolChoice` is
included in exposure before admission. Historical calls do not affect exposure.
An explicit runtime fixed/complete-tool context continues to pass its own
catalog without the interactive projection.

## Event order and bounds

```text
registry -> baseline + ToolSearch -> Fix #3 -> Fix #1 -> provider step N
model ToolSearch(query) -> existing executor/permission path -> concise result
successful result -> turn state records returned registered names (recent max 8)
registry -> baseline + recent -> Fix #3 -> Fix #1 -> provider step N+1
model selected tool -> existing registry/executor/permission path
```

One search returns at most five results. The recent discovery set is LRU: finding
an already discovered hidden tool moves it to the newest position; a new name
evicts the least recently discovered name above eight. Baseline/control names
and a specific current `toolChoice` do not consume recent slots. Missing tools
are filtered again at projection time. A failed or empty search changes no
exposure. Multiple calls in one model response are handled by the existing
batch; the union of successful results is visible in the following step.
No separate agent loop or execution registry exists.

## Deterministic discovery

The search index is derived from current registry metadata on each call; it
does not cache large descriptions. Runtime eligibility filters out capabilities
the active model cannot expose. Rank exact name, name prefix/token, capability,
then description lexical matches, with registration order and name as ties.
Search uses only bounded local lexical work. No match returns an empty result.
Results contain no JSON schema, full description, handler, or configuration.

## Baseline and contextual control

The default baseline keeps common file/shell/search tools, Skill, user questions,
subagent entry when registered, and mode/control tools only when the current
runtime state requires them. Automation, Off-Peak, secondary Dynamic Workflow,
and arbitrary MCP/external schemas remain registered and searchable. Workflow
actor terminal controls and coordinator response controls remain immediately
available in their explicit runtime contexts. Current tool disallowlists still
filter advertised schemas and the executor keeps its own enforcement.

## Acceptance

- A fresh normal step is substantially smaller than the complete registry.
- A hidden workflow, automation, saved-workflow, web, or arbitrary external tool
  can be found and is exposed as a real schema in the next model request.
- Execution uses registry lookup and the existing permission path.
- Repeated searches remain deterministic and bounded; previous turns and
  historical tool calls do not accumulate exposure.
- Generate and stream share the same selected contracts and existing admission
  and hard preflight implementation.
- Context Fix #1 formula and error contract, Fix #2 Skill/facade strategy, and
  Fix #3 admission semantics remain unchanged.
