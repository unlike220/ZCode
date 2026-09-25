# Context Fix #5 — Dynamic Workflow Default Semantics

## Scope

This change normalizes Dynamic Workflow availability semantics across ZCode runtimes.

It does not change provider-tool exposure, schema size, request budgeting, workflow rollout
modes, workflow execution behavior, MCP behavior, Project Intelligence, compaction, or UI.

Context Fix #4 remains responsible for lazy provider exposure. This fix only decides whether
Dynamic Workflow capability is registered/available at all.

## Canonical semantic rule

Dynamic Workflow runtime availability is an explicit boolean.

```text
explicit true       -> enabled
explicit false      -> disabled
missing / undefined -> disabled
```

Missing state is therefore fail-closed. No downstream runtime layer may reinterpret an omitted
boolean as enabled.

The canonical boolean normalization is shared and must be reused by runtime/config consumers.

## Rollout modes

The existing remote/client rollout contract remains authoritative:

| mode                              | effective availability |
| --------------------------------- | ---------------------- |
| `disabled`                        | disabled               |
| `onDemand`                        | enabled                |
| `alwaysOn`                        | enabled                |
| missing / invalid / fetch failure | disabled               |

`onDemand` and `alwaysOn` currently have the same registration semantics. Provider exposure is
separate: when enabled, Context Fix #4 keeps Dynamic Workflow tools lazy/discoverable instead of
eagerly exposing all ten schemas.

## Runtime ownership and boundaries

```text
remote/env rollout
    -> DynamicWorkflowClientConfig.enabled
    -> session/runtime boundary emits explicit boolean
    -> AgentRuntime stores normalized explicit boolean
    -> tool registration / Skill / slash command consume the same boolean
    -> Context Fix #4 controls provider exposure
```

The shared Dynamic Workflow feature contract owns boolean normalization. AgentRuntime also
normalizes constructor input so direct internal construction cannot recreate the historical
`undefined -> enabled` behavior.

### Desktop / protocol

Desktop Host remains rollout authority. Its resolver keeps the existing precedence:

```text
valid local override (where product allows it)
    > valid remote mode
    > default disabled
```

Production packaged Desktop still strips inherited local overrides. Preview still forces
`alwaysOn`. Protocol app runtime preferences still start at explicit `false` and only become
enabled after Host policy synchronization. Session create/resume input has presence-based
precedence over that workspace fallback: explicit `true` enables, explicit `false` disables,
and omission inherits the Host workspace decision. V4 forwarding preserves both boolean values
rather than dropping `false`.

### Headless CLI

Headless remains disabled by default and passes an explicit boolean:

```text
--enable-workflow -> true
flag absent       -> false
```

### TUI

TUI intentionally preserves its existing product behavior, but no longer obtains that behavior
from an ambiguous core default. TUI explicitly opts in with:

```text
dynamicWorkflowEnabled: true
```

Thus TUI enablement is an explicit surface policy, not an interpretation of missing configuration.

### Subagents and workflow children

Child runtimes inherit the parent's normalized explicit boolean. They do not obtain independent
default semantics.

Existing workflow-child structural tool restrictions remain unchanged.

## Registration versus exposure

Dynamic Workflow availability and provider exposure are separate:

```text
availability enabled
    -> workflow tools registered
    -> ToolSearch can discover them
    -> normal fresh turn still exposes only the Fix #4 baseline

availability disabled
    -> workflow tools not registered
    -> ToolSearch cannot discover them
    -> /workflow and the dynamic-workflows Skill are unavailable
```

Fix #5 must not restore eager Dynamic Workflow provider schemas.

## Compatibility

The optional `dynamicWorkflowEnabled` field may remain optional at protocol/config type boundaries
for compatibility with older senders and persisted data. Omission normalizes to disabled exactly
once at the receiving runtime/config boundary.

Low-level built-in registration and prompt/catalog helpers also treat omission as disabled so
direct internal/test callers cannot revive the old implicit-enabled default.

## Acceptance scenarios

1. Explicit true registers Dynamic Workflow tools.
2. Explicit false does not register Dynamic Workflow tools.
3. Missing runtime value does not register Dynamic Workflow tools.
4. Direct AgentRuntime construction stores an explicit false for a missing value.
5. Headless without `--enable-workflow` remains disabled.
6. Headless with `--enable-workflow` remains enabled.
7. TUI remains enabled through an explicit true input.
8. Protocol default remains disabled until Host policy enables it.
9. `disabled` rollout is disabled; `onDemand` and `alwaysOn` are enabled.
10. Missing/invalid/failing rollout remains disabled.
11. Subagent/workflow child inherits the parent's normalized boolean.
12. Disabled workflow tools are absent from ToolSearch results.
13. Enabled workflow tools remain registered but lazy under Context Fix #4.
14. Context Fixes #1–#4 remain unchanged and passing.
