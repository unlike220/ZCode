import assert from "node:assert/strict";
import test from "node:test";
import { createSessionId } from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor/impl.js";
import { recordToolSearchResults } from "../src/runtime/methods/turn-tool-discovery.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { ToolRegistryImpl } from "../src/tool/registry.js";
import {
  createToolSearchEntry,
  exposeToolsForModelStep,
  getPermanentlyExposedToolNames,
  MAX_DISCOVERY_RESULTS,
  MAX_RECENT_EXPOSED_TOOLS,
  recordDiscoveredTools,
  searchRegisteredTools,
  TOOL_SEARCH_NAME,
  type ToolSearchOutput,
} from "../src/tool/discovery.js";
import type { ToolEntry } from "../src/tool/types.js";
import { toAiSdkTools } from "../../adapters/src/model/tool-transform.js";
import { admitProviderFacingTools } from "../../adapters/src/model/tool-admission.js";

function registryFixture(): ToolRegistryImpl {
  const registry = new ToolRegistryImpl();
  registerBuiltInTools(registry, {
    includeAgent: true,
    includeAutomation: true,
    includeDynamicWorkflow: true,
    includeOffPeak: true,
    includeSkill: true,
  });
  registry.register(createToolSearchEntry(registry));
  return registry;
}

test("fresh coding step keeps core tools and hides feature families", () => {
  const registry = registryFixture();
  const full = registry.toContracts();
  const exposed = exposeToolsForModelStep({ candidates: full, recentNames: [] });
  const fullBytes = Buffer.byteLength(
    JSON.stringify(toAiSdkTools(full, { providerKind: "openai-compatible" })),
  );
  const exposedBytes = Buffer.byteLength(
    JSON.stringify(toAiSdkTools(exposed, { providerKind: "openai-compatible" })),
  );
  assert.ok(exposedBytes <= fullBytes * 0.65, `${exposedBytes} / ${fullBytes} provider bytes`);
  const names = new Set(exposed.map((tool) => tool.name));
  assert.ok(exposed.length <= 20, `${exposed.length} exposed tools`);
  assert.ok(exposed.length < full.length);
  for (const name of [
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Glob",
    "Grep",
    "Skill",
    "Agent",
    TOOL_SEARCH_NAME,
  ]) {
    assert.ok(names.has(name), `${name} must be exposed`);
  }
  for (const name of [
    "CronCreate",
    "OffPeakCreate",
    "AmendWorkflow",
    "ListSavedWorkflows",
    "WebFetch",
  ]) {
    assert.ok(!names.has(name), `${name} must be hidden`);
  }
  assert.equal(
    full.filter((tool) =>
      [
        "CreateWorkflow",
        "AmendWorkflow",
        "SaveWorkflow",
        "EvalWorkflowSnippet",
        "ListWorkflowRuns",
        "GetWorkflowRun",
        "ResumeWorkflowRun",
        "ListSavedWorkflows",
        "ResolveWorkflowQuestion",
        "ListModels",
      ].includes(tool.name),
    ).length,
    10,
  );
});

test("registry discovery is deterministic, exact-first, bounded and schema-free", () => {
  const registry = registryFixture();
  const external = fixtureTool(
    "third_party_invoice_bridge",
    "Fetch invoices from an external accounting service",
  );
  registry.register(external);
  assert.equal(searchRegisteredTools(registry, "CronCreate").matches[0]?.name, "CronCreate");
  assert.equal(
    searchRegisteredTools(registry, "schedule recurring task").matches[0]?.name,
    "CronCreate",
  );
  assert.deepEqual(
    searchRegisteredTools(registry, "web", 5, new Set(["WebFetch"])).matches.map(
      (match) => match.name,
    ),
    ["WebFetch"],
  );
  for (const [query, expected] of [
    ["workflow", "CreateWorkflow"],
    ["scheduled automation", "CronCreate"],
    ["schedule recurring task", "CronCreate"],
    ["saved workflow", "ListSavedWorkflows"],
    ["web", "WebFetch"],
    ["invoice", external.metadata.name],
  ]) {
    assert.ok(
      searchRegisteredTools(registry, query).matches.some((match) => match.name === expected),
      query,
    );
  }
  const first = searchRegisteredTools(registry, "workflow", 999);
  assert.deepEqual(first, searchRegisteredTools(registry, "workflow", 999));
  assert.ok(first.matches.length <= MAX_DISCOVERY_RESULTS);
  assert.deepEqual(searchRegisteredTools(registry, "zzzzunregistered"), {
    matches: [],
  });
  assert.ok(!JSON.stringify(first).includes("inputSchema"));
  assert.ok(!JSON.stringify(first).includes("modelInstructions"));
  assert.ok(first.matches.every((match) => match.purpose.length <= 120));
});

test("discovery round trip exposes a real schema and execution still uses registry permissions", async () => {
  const registry = registryFixture();
  const target = fixtureTool(
    "ExternalLedgerLookup",
    "Find ledger balances in external accounting data",
  );
  registry.register(target);
  const full = registry.toContracts();
  const firstStep = exposeToolsForModelStep({ candidates: full, recentNames: [] });
  assert.ok(!firstStep.some((tool) => tool.name === target.metadata.name));
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService({
      ...defaultPermissionConfig,
      allowedTools: new Set([TOOL_SEARCH_NAME, target.metadata.name]),
    }),
    sessionId: createSessionId(),
    mode: "build",
    workingDirectory: ".",
    workspaceRoot: ".",
    emitEvent: async () => {},
  });
  const search = await executor.execute({
    id: "search",
    name: TOOL_SEARCH_NAME,
    input: { query: "ledger" },
  });
  assert.equal(search.success, true, search.error?.message);
  const output = search.output as ToolSearchOutput;
  assert.ok(output.matches.some((match) => match.name === target.metadata.name));
  const turnState = { model: {}, recentExposedToolNames: [] as string[] };
  recordToolSearchResults(
    { registry, getTools: () => registry.toContracts() } as never,
    turnState as never,
    [search],
  );
  const recent = turnState.recentExposedToolNames;
  const nextStep = exposeToolsForModelStep({
    candidates: registry.toContracts(),
    recentNames: recent,
  });
  assert.ok(
    nextStep.some(
      (tool) => tool.name === target.metadata.name && tool.inputSchema === target.inputSchema,
    ),
  );
  const executed = await executor.execute({ id: "target", name: target.metadata.name, input: {} });
  assert.equal(executed.success, true, executed.error?.message);
  assert.deepEqual(executed.output, { ok: true });
  const deniedExecutor = createToolExecutor({
    registry,
    permissionService: new PermissionService({
      ...defaultPermissionConfig,
      disallowedTools: new Set([target.metadata.name]),
    }),
    sessionId: createSessionId(),
    mode: "build",
    workingDirectory: ".",
    workspaceRoot: ".",
    emitEvent: async () => {},
  });
  const denied = await deniedExecutor.execute({
    id: "denied",
    name: target.metadata.name,
    input: {},
  });
  assert.equal(denied.success, false);
  assert.deepEqual(
    recordDiscoveredTools(
      recent,
      output,
      registry,
      getPermanentlyExposedToolNames({ candidates: registry.toContracts() }),
    ),
    recent,
  );
  registry.unregister(target.metadata.name);
  assert.ok(
    !exposeToolsForModelStep({ candidates: registry.toContracts(), recentNames: recent }).some(
      (tool) => tool.name === target.metadata.name,
    ),
  );
});

test("rediscovering a hidden tool refreshes its recent position without duplicates", () => {
  const registry = registryFixture();
  for (const name of ["A", "B", "C"])
    registry.register(fixtureTool(name, `${name} fixture capability`));
  const permanent = getPermanentlyExposedToolNames({ candidates: registry.toContracts() });
  const recent = recordDiscoveredTools(
    ["A", "B", "C"],
    { matches: [{ name: "B" }, { name: "B" }] },
    registry,
    permanent,
  );
  assert.deepEqual(recent, ["A", "C", "B"]);
  assert.equal(recent.length, new Set(recent).size);
  assert.ok(recent.length <= MAX_RECENT_EXPOSED_TOOLS);
});

test("rediscovery refreshes the oldest entry before LRU eviction", () => {
  const registry = registryFixture();
  const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
  for (const name of names) registry.register(fixtureTool(name, `${name} fixture capability`));
  const permanent = getPermanentlyExposedToolNames({ candidates: registry.toContracts() });
  const refreshed = recordDiscoveredTools(
    names.slice(0, MAX_RECENT_EXPOSED_TOOLS),
    { matches: [{ name: "A" }] },
    registry,
    permanent,
  );
  assert.deepEqual(refreshed, ["B", "C", "D", "E", "F", "G", "H", "A"]);
  const afterNewDiscovery = recordDiscoveredTools(
    refreshed,
    { matches: [{ name: "I" }] },
    registry,
    permanent,
  );
  assert.deepEqual(afterNewDiscovery, ["C", "D", "E", "F", "G", "H", "A", "I"]);
  assert.ok(afterNewDiscovery.includes("A"));
  assert.equal(afterNewDiscovery.length, MAX_RECENT_EXPOSED_TOOLS);
});

test("baseline and explicit toolChoice exposure do not consume recent slots", () => {
  const registry = registryFixture();
  registry.register(fixtureTool("ExplicitChoice", "An explicitly selected capability"));
  const candidates = registry.toContracts();
  const permanent = getPermanentlyExposedToolNames({
    candidates,
    toolChoice: { type: "tool", toolName: "ExplicitChoice" },
  });
  const recent = recordDiscoveredTools(
    [],
    { matches: [{ name: "Read" }, { name: "ExplicitChoice" }] },
    registry,
    permanent,
  );
  assert.deepEqual(recent, []);
  assert.ok(recent.length <= MAX_RECENT_EXPOSED_TOOLS);
});

test("lazy candidate catalog still flows through budget admission", () => {
  const registry = registryFixture();
  const giant = fixtureTool("GiantExternal", "Unusually large external capability");
  giant.metadata.description = "external details ".repeat(10_000);
  giant.metadata.admissionPriority = "optional";
  registry.register(giant);
  const candidates = exposeToolsForModelStep({
    candidates: registry.toContracts(),
    recentNames: [giant.metadata.name],
  });
  const tools = toAiSdkTools(candidates, { providerKind: "openai-compatible" });
  const admission = admitProviderFacingTools({
    candidateTools: tools,
    contextWindow: 32_768,
    messages: [{ role: "user", content: "test" }],
    requestedOutputTokens: 8192,
    toolContracts: candidates,
  });
  assert.ok(admission.omittedToolNames.includes(giant.metadata.name));
  assert.equal(admission.admittedBudget?.fits, true);
  const unknownBudget = admitProviderFacingTools({
    candidateTools: tools,
    contextWindow: undefined,
    messages: [],
    requestedOutputTokens: undefined,
    toolContracts: candidates,
  });
  assert.equal(unknownBudget.tools, tools);
  assert.equal(unknownBudget.admittedToolCount, candidates.length);
});

test("recent exposure is turn-local, bounded and explicit choice can force a hidden tool", () => {
  const registry = registryFixture();
  for (let index = 0; index < 12; index++)
    registry.register(fixtureTool(`External${index}`, `External ${index} capability`));
  const permanent = getPermanentlyExposedToolNames({ candidates: registry.toContracts() });
  let recent: string[] = [];
  for (let index = 0; index < 12; index++) {
    recent = recordDiscoveredTools(
      recent,
      { matches: [{ name: `External${index}`, purpose: "fixture" }] },
      registry,
      permanent,
    );
    assert.ok(recent.length <= MAX_RECENT_EXPOSED_TOOLS);
  }
  assert.equal(recent.length, MAX_RECENT_EXPOSED_TOOLS);
  assert.ok(!recent.includes("External0"));
  assert.ok(
    !exposeToolsForModelStep({ candidates: registry.toContracts(), recentNames: [] }).some(
      (tool) => tool.name === "External11",
    ),
  );
  assert.ok(
    exposeToolsForModelStep({
      candidates: registry.toContracts(),
      recentNames: [],
      toolChoice: { type: "tool", toolName: "External11" },
    }).some((tool) => tool.name === "External11"),
  );
  assert.equal(
    exposeToolsForModelStep({ candidates: registry.toContracts(), recentNames: [], complete: true })
      .length,
    registry.toContracts().length,
  );
});

function fixtureTool(name: string, capability: string): ToolEntry {
  return {
    capability,
    metadata: {
      name,
      description: capability,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: async () => ({ ok: true }),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  };
}
