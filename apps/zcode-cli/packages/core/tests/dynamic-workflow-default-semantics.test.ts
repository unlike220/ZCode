import assert from "node:assert/strict";
import test from "node:test";
import {
  createDynamicWorkflowClientConfig,
  isDynamicWorkflowModeEnabled,
  resolveDynamicWorkflowClientConfig,
  resolveDynamicWorkflowEnabled,
} from "@zcode/shared";
import { createAgentToolEntry, createTaskToolEntry } from "../src/tool/handlers/agent.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { searchRegisteredTools } from "../src/tool/discovery.js";
import { resolveRuntimeDynamicWorkflowToolsIncluded } from "../src/runtime/helpers/tool-allowlist.js";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";

const DYNAMIC_WORKFLOW_TOOL_NAMES = [
  "CreateWorkflow",
  "AmendWorkflow",
  "SaveWorkflow",
  "EvalWorkflowSnippet",
  "ListWorkflowRuns",
  "GetWorkflowRun",
  "ResumeWorkflowRun",
  "ResolveWorkflowQuestion",
  "ListSavedWorkflows",
  "ListModels",
] as const;

test("Dynamic Workflow boolean normalization is fail-closed", () => {
  assert.equal(resolveDynamicWorkflowEnabled(true), true);
  assert.equal(resolveDynamicWorkflowEnabled(false), false);
  assert.equal(resolveDynamicWorkflowEnabled(undefined), false);

  assert.equal(
    resolveRuntimeDynamicWorkflowToolsIncluded({
      dynamicWorkflowEnabled: true,
    } as AgentRuntimeConfig),
    true,
  );
  assert.equal(
    resolveRuntimeDynamicWorkflowToolsIncluded({
      dynamicWorkflowEnabled: false,
    } as AgentRuntimeConfig),
    false,
  );
  assert.equal(resolveRuntimeDynamicWorkflowToolsIncluded({} as AgentRuntimeConfig), false);
});

test("built-in registration requires explicit Dynamic Workflow enablement", () => {
  const omitted = createToolRegistry();
  registerBuiltInTools(omitted);

  const disabled = createToolRegistry();
  registerBuiltInTools(disabled, { includeDynamicWorkflow: false });

  const enabled = createToolRegistry();
  registerBuiltInTools(enabled, { includeDynamicWorkflow: true });

  for (const name of DYNAMIC_WORKFLOW_TOOL_NAMES) {
    assert.equal(omitted.get(name), undefined, `${name} must be absent when the flag is omitted`);
    assert.equal(disabled.get(name), undefined, `${name} must be absent when explicitly disabled`);
    assert.ok(enabled.get(name), `${name} must be registered when explicitly enabled`);
  }
});

test("Agent and Task workflow routing guidance requires explicit enablement", () => {
  const marker = "CreateWorkflow tool is mandatory";
  assert.doesNotMatch(createAgentToolEntry().metadata.description ?? "", new RegExp(marker));
  assert.doesNotMatch(createTaskToolEntry().metadata.description ?? "", new RegExp(marker));
  assert.match(
    createAgentToolEntry({ dynamicWorkflowEnabled: true }).metadata.description ?? "",
    new RegExp(marker),
  );
  assert.match(
    createTaskToolEntry({ dynamicWorkflowEnabled: true }).metadata.description ?? "",
    new RegExp(marker),
  );
});

test("ToolSearch only discovers workflow tools when availability registered them", () => {
  const disabled = createToolRegistry();
  registerBuiltInTools(disabled);

  const enabled = createToolRegistry();
  registerBuiltInTools(enabled, { includeDynamicWorkflow: true });

  assert.deepEqual(searchRegisteredTools(disabled, "CreateWorkflow").matches, []);
  assert.equal(searchRegisteredTools(enabled, "CreateWorkflow").matches[0]?.name, "CreateWorkflow");
});

test("rollout modes and missing or invalid config preserve fail-closed semantics", () => {
  assert.equal(isDynamicWorkflowModeEnabled("disabled"), false);
  assert.equal(isDynamicWorkflowModeEnabled("onDemand"), true);
  assert.equal(isDynamicWorkflowModeEnabled("alwaysOn"), true);

  assert.equal(createDynamicWorkflowClientConfig("disabled", "remote").enabled, false);
  assert.equal(createDynamicWorkflowClientConfig("onDemand", "remote").enabled, true);
  assert.equal(createDynamicWorkflowClientConfig("alwaysOn", "remote").enabled, true);

  assert.deepEqual(resolveDynamicWorkflowClientConfig({ remote: undefined }), {
    enabled: false,
    mode: "disabled",
    source: "default",
  });
  assert.deepEqual(resolveDynamicWorkflowClientConfig({ remote: { mode: "bogus" } }), {
    enabled: false,
    mode: "disabled",
    source: "default",
  });
  assert.deepEqual(resolveDynamicWorkflowClientConfig({ remote: { mode: "onDemand" } }), {
    enabled: true,
    mode: "onDemand",
    source: "remote",
  });
  assert.deepEqual(
    resolveDynamicWorkflowClientConfig({
      remote: { mode: "disabled" },
      env: { ZCODE_DYNAMIC_WORKFLOW_MODE: "alwaysOn" },
    }),
    { enabled: true, mode: "alwaysOn", source: "override" },
  );
});
