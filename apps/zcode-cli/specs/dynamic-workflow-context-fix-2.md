# Dynamic Workflow Context Fix #2

## Behavior

Dynamic Workflow keeps the same ten provider-visible capabilities and the same
registration/enablement boundary. Their default descriptions contain the
purpose, routing, and Skill-loading requirement needed before a tool call. The
compiler facade and extended authoring reference are not embedded in the
default tool corpus.

Before submitting an authored workflow script, the agent loads the bundled
`dynamic-workflows` Skill. Upstream supplies the full authoring contract and
compiler facade in that Skill. The fork's former Skill-handler appendix is
redundant and would overflow the result budget after this integration. Running
a saved workflow by name and retuning a run without changing its script remain
available without loading the Skill.

## Ownership and boundaries

- `apps/zcode-cli/packages/core/src/tool/handlers/*-workflow-description.ts`
  owns the concise provider-visible contracts for the workflow tools.
- `apps/zcode-cli/packages/core/src/tool/handlers/skill.ts` owns the existing
  Skill retrieval boundary. It returns the bundled Skill without duplicating
  its facade. The bundled Skill owns detailed writing rules and facade text.
- Runtime message history owns the loaded-Skill fact. The runtime executor
  supplies a history-derived probe to the four authoring tools; compaction and
  resume change the answer with the provider-visible history. Sessions without
  a Skill port omit the probe.
- `apps/zcode-cli/packages/dynamic-workflow/src/facade/dts.ts` remains the
  source of truth for compile-time facade declarations. The bundled Skill's
  embedded full facade must match it; neither facade is in tool descriptions.
- `apps/zcode-cli/packages/core/src/tool/handlers/index.ts` remains the owner
  of the ten-tool registration set and is not changed by this fix.

## Invariants

1. The ten Dynamic Workflow tool names and their registration conditions are
   unchanged.
2. CreateWorkflow, AmendWorkflow, SaveWorkflow, and EvalWorkflowSnippet advertise
   their routing and Skill-loading requirements. The on-demand Skill contains
   the full input, validation, side-effect, and result guidance.
3. The full facade is absent from every default provider-visible workflow
   description and is not copied into an always-injected system or Skill
   metadata section.
4. Loading `dynamic-workflows` returns the full compiler facade and identifies
   the snippet subset on demand; loading another Skill does not.
5. The provider-visible serialized Dynamic Workflow corpus is at least 50%
   smaller than the measured pre-change corpus.
6. Context Fix #1 request budgeting and preflight code is outside this change.
7. An authored script is refused before a confirmation or execution if its
   session history has no successful Dynamic Workflow Skill result. After
   compaction removes that result, the agent must load the Skill again. The
   saved-name and settings-only exceptions above remain usable.

## Retrieval event order

```text
default turn
  -> concise ten-tool contracts
  -> model chooses an authoring tool
  -> Skill("dynamic-workflows")
  -> Skill loader returns bundled rules and compiler facade reference
  -> successful Skill result enters provider-visible message history
  -> model authors/corrects workflow
  -> resolveInput checks that history before confirmation or execution
```

The reference is returned only after the explicit Skill call. A failed Skill
result does not open the gate; compaction closes it when the successful result
leaves the visible history. There is no second accepted queue, cache, or
workflow state owner, and no provider request is sent by the retrieval path.

## Migration boundary

Upstream's Skill gate supersedes the local description-only recommendation to
load the Skill. It changes authoring admission and bundles a distributable
reference; it does not change workflow parsing, lowering, execution,
persistence, the ten-tool enablement boundary, Context Fix #1 budgeting, MCP,
Project Intelligence, Repository Facts, or UI behavior.
