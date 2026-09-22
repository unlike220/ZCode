import assert from "node:assert/strict";
import test from "node:test";
import { FACADE_DTS, SNIPPET_FACADE_DTS } from "@zcode/dynamic-workflow";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { appendDynamicWorkflowReference } from "../src/tool/handlers/skill.js";
import { ToolRegistryImpl } from "../src/tool/registry.js";

const WORKFLOW_TOOL_NAMES = [
  "CreateWorkflow",
  "SaveWorkflow",
  "EvalWorkflowSnippet",
  "AmendWorkflow",
  "ListWorkflowRuns",
  "GetWorkflowRun",
  "ResumeWorkflowRun",
  "ResolveWorkflowQuestion",
  "ListSavedWorkflows",
  "ListModels",
] as const;

// Context Fix #2 的 pre-change measurement: 10 tool contracts, 88,805 UTF-16 chars in
// JSON.stringify({ name, description, inputSchema }). Keep this as a reviewable regression
// boundary; it catches a future reintroduction of the 19K facade into the default corpus.
const PREVIOUS_PROVIDER_VISIBLE_CHARS = 88_805;
const WORKFLOW_PROVIDER_VISIBLE_CHAR_CEILING = 40_000;

function workflowContracts() {
  const registry = new ToolRegistryImpl();
  registerBuiltInTools(registry, { includeDynamicWorkflow: true });
  const contracts = registry
    .toContracts()
    .filter((contract) => (WORKFLOW_TOOL_NAMES as readonly string[]).includes(contract.name));
  return { contracts, registry };
}

function providerVisibleShape(contract: {
  name: string;
  description?: string;
  inputSchema: unknown;
}) {
  return JSON.stringify({
    name: contract.name,
    description: contract.description,
    inputSchema: contract.inputSchema,
  });
}

test("Dynamic Workflow provider-visible corpus stays below the context ceiling", () => {
  const { contracts } = workflowContracts();
  const serializedChars = contracts.reduce(
    (total, contract) => total + providerVisibleShape(contract).length,
    0,
  );

  assert.equal(contracts.length, WORKFLOW_TOOL_NAMES.length);
  assert.ok(serializedChars <= WORKFLOW_PROVIDER_VISIBLE_CHAR_CEILING);
  assert.ok(serializedChars <= PREVIOUS_PROVIDER_VISIBLE_CHARS / 2);
});

test("workflow descriptions do not duplicate the full facade reference", () => {
  const { contracts } = workflowContracts();
  const descriptions = contracts.map((contract) => contract.description ?? "");

  assert.equal(descriptions.filter((description) => description.includes(FACADE_DTS)).length, 0);
  assert.equal(
    descriptions.filter((description) => description.includes(SNIPPET_FACADE_DTS)).length,
    0,
  );
});

test("CreateWorkflow keeps essential authoring and execution guidance", () => {
  const create = workflowContracts().contracts.find(
    (contract) => contract.name === "CreateWorkflow",
  );
  const description = create?.description ?? "";

  for (const marker of [
    "exactly one",
    "typechecked",
    "confirmation",
    "background",
    "saved",
    "path",
    "phase",
    "world.run",
    "dynamic-workflows",
  ]) {
    assert.match(description, new RegExp(marker, "i"));
  }
});

test("SaveWorkflow keeps persistence and validation guidance", () => {
  const save = workflowContracts().contracts.find((contract) => contract.name === "SaveWorkflow");
  const description = save?.description ?? "";

  for (const marker of [
    "scope",
    "project",
    "global",
    "user agrees",
    "script_path",
    "description",
    "REPLACES",
    "typechecked",
    "CreateWorkflow",
  ]) {
    assert.match(description, new RegExp(marker, "i"));
  }
});

test("EvalWorkflowSnippet keeps sandbox and evaluation guidance", () => {
  const evalTool = workflowContracts().contracts.find(
    (contract) => contract.name === "EvalWorkflowSnippet",
  );
  const description = evalTool?.description ?? "";

  for (const marker of [
    "synchronously",
    "code",
    "path",
    "world.run",
    "confirmation",
    "Nothing is persisted",
    "60 seconds",
    "dynamic-workflows",
  ]) {
    assert.match(description, new RegExp(marker, "i"));
  }
});

test("all ten Dynamic Workflow capabilities remain registered when enabled", () => {
  const { contracts, registry } = workflowContracts();
  assert.deepEqual(
    new Set(contracts.map((contract) => contract.name)),
    new Set(WORKFLOW_TOOL_NAMES),
  );
  assert.deepEqual(
    new Set(WORKFLOW_TOOL_NAMES.filter((name) => registry.has(name))),
    new Set(WORKFLOW_TOOL_NAMES),
  );
});

test("the detailed facade remains reachable only through the on-demand Skill path", () => {
  const plain = appendDynamicWorkflowReference("other-skill", "skill body");
  const dynamic = appendDynamicWorkflowReference("zcode-guide:dynamic-workflows", "skill body");

  assert.equal(plain, "skill body");
  assert.match(dynamic, /Dynamic Workflow compiler reference/);
  assert.ok(dynamic.includes(FACADE_DTS.trim()));
  assert.ok(dynamic.includes(SNIPPET_FACADE_DTS.trim()));
});
