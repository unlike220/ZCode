# Dynamic Workflow Context Fix #2

## Behavior

Dynamic Workflow keeps the same ten provider-visible capabilities and the same
registration/enablement boundary. Their default descriptions contain only the
tool contract: purpose, routing, required input invariants, side effects,
validation, and result semantics. The compiler facade and extended authoring
reference are not embedded in the default tool corpus.

When an agent needs the detailed authoring surface, it loads the existing
`dynamic-workflows` Skill. The Skill response is the on-demand reference path
and includes the exact `FACADE_DTS` and `SNIPPET_FACADE_DTS` strings used by the
compiler. This keeps the reference discoverable without adding an eleventh
provider-visible tool or injecting the reference into the default context.

## Ownership and boundaries

- `apps/zcode-cli/packages/core/src/tool/handlers/*-workflow-description.ts`
  owns the concise provider-visible contracts for the workflow tools.
- `apps/zcode-cli/packages/core/src/tool/handlers/skill.ts` owns the existing
  Skill retrieval boundary. Only a loaded Dynamic Workflow Skill receives the
  compiler reference appendix.
- `apps/zcode-cli/packages/dynamic-workflow/src/facade/dts.ts` remains the
  single source of truth for compile-time facade declarations. No runtime
  behavior or facade content is duplicated in the tool descriptions.
- `apps/zcode-cli/packages/core/src/tool/handlers/index.ts` remains the owner
  of the ten-tool registration set and is not changed by this fix.

## Invariants

1. The ten Dynamic Workflow tool names and their registration conditions are
   unchanged.
2. CreateWorkflow, SaveWorkflow, and EvalWorkflowSnippet retain their
   essential invocation, validation, side-effect, and result guidance.
3. The full facade is absent from every default provider-visible workflow
   description and is not copied into an always-injected system or Skill
   metadata section.
4. Loading `dynamic-workflows` returns both exact facade variants on demand;
   loading another Skill does not.
5. The provider-visible serialized Dynamic Workflow corpus is at least 50%
   smaller than the measured pre-change corpus.
6. Context Fix #1 request budgeting and preflight code is outside this change.

## Retrieval event order

```text
default turn
  -> concise ten-tool contracts
  -> model needs authoring detail
  -> Skill("dynamic-workflows")
  -> Skill loader appends compiler facade reference
  -> model authors/corrects workflow
```

The reference is returned only after the explicit Skill call. There is no
second accepted queue, cache, or workflow state owner, and no provider request
is sent by the retrieval path.

## Migration boundary

This is a documentation and reference-delivery change only. It does not alter
workflow parsing, lowering, execution, persistence, tool selection, lazy
loading, enablement semantics, Context Fix #1 budgeting, MCP, Project
Intelligence, Repository Facts, compaction, or UI behavior.
