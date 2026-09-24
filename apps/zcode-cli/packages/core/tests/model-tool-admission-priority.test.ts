import assert from "node:assert/strict";
import test from "node:test";
import { resolveToolAdmissionPriority } from "../src/tool/admission-priority.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry, ToolMetadata } from "../src/tool/types.js";

test("built-in admission priorities preserve core execution before optional feature tools", () => {
  assert.equal(resolveToolAdmissionPriority(metadata("Read")), "mandatory");
  assert.equal(resolveToolAdmissionPriority(metadata("Bash")), "mandatory");
  assert.equal(resolveToolAdmissionPriority(metadata("ExitPlanMode")), "mandatory");
  assert.equal(resolveToolAdmissionPriority(metadata("submit_result")), "mandatory");

  assert.equal(resolveToolAdmissionPriority(metadata("Glob")), "high");
  assert.equal(resolveToolAdmissionPriority(metadata("Skill")), "high");
  assert.equal(resolveToolAdmissionPriority(metadata("AskUserQuestion")), "high");
  assert.equal(resolveToolAdmissionPriority(metadata("CreateWorkflow")), "high");

  assert.equal(resolveToolAdmissionPriority(metadata("ProjectStateRead")), "normal");
  assert.equal(resolveToolAdmissionPriority(metadata("Agent")), "normal");

  assert.equal(resolveToolAdmissionPriority(metadata("AmendWorkflow")), "optional");
  assert.equal(resolveToolAdmissionPriority(metadata("CronCreate")), "optional");
  assert.equal(resolveToolAdmissionPriority(metadata("OffPeakCreate")), "optional");
  assert.equal(resolveToolAdmissionPriority(metadata("WebSearch")), "optional");
  assert.equal(resolveToolAdmissionPriority(metadata("js")), "optional");
});

test("MCP-discovered tools are optional without hard-coded server or tool names", () => {
  const result = resolveToolAdmissionPriority(
    metadata("totally_arbitrary_external_name", {
      mcpPresentation: {
        serverName: "third-party-server",
        toolName: "arbitrary-tool",
      },
    }),
  );
  assert.equal(result, "optional");
});

test("explicit tool metadata overrides the built-in default policy", () => {
  assert.equal(
    resolveToolAdmissionPriority(
      metadata("external-critical-control", { admissionPriority: "mandatory" }),
    ),
    "mandatory",
  );
  assert.equal(
    resolveToolAdmissionPriority(metadata("Read", { admissionPriority: "optional" })),
    "optional",
  );
});

test("registry projects admission priority into runtime contracts", () => {
  const registry = createToolRegistry();
  registry.register({
    capability: "fixture",
    handler: async () => "ok",
    inputSchema: { type: "object", properties: {} },
    metadata: metadata("Read"),
  } as ToolEntry);

  const [contract] = registry.toContracts();
  assert.ok(contract);
  assert.equal(contract.name, "Read");
  assert.equal(contract.admissionPriority, "mandatory");
});

function metadata(name: string, overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    concurrentSafe: true,
    destructive: false,
    name,
    needsApproval: false,
    readOnly: true,
    riskLevel: "low",
    sideEffectScope: "none",
    ...overrides,
  } as ToolMetadata;
}
