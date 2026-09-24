import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelInputMessage,
  ModelToolAdmissionPriority,
  ModelToolContract,
} from "@zcode/contracts";
import type { ToolSet } from "ai";
import { calculateModelRequestBudget } from "../src/model/request-budget.js";
import { createGenerateTextOptions, createStreamTextOptions } from "../src/model/runner-options.js";
import { admitProviderFacingTools } from "../src/model/tool-admission.js";

const REQUESTED_OUTPUT = 100;
const MESSAGES = [{ role: "user", content: "test" }] as const;
const REQUEST_MESSAGES = [{ role: "user", content: "test" }] as ModelInputMessage[];

test("complete provider tool catalog is preserved unchanged when it fits", () => {
  const candidateTools = {
    Read: providerTool("read"),
    Skill: providerTool("skill"),
    External: providerTool("external"),
  } as ToolSet;
  const result = admitProviderFacingTools({
    candidateTools,
    contextWindow: 50_000,
    messages: MESSAGES,
    requestedOutputTokens: REQUESTED_OUTPUT,
    toolContracts: [
      contract("Read", "mandatory"),
      contract("Skill", "high"),
      contract("External", "normal"),
    ],
  });

  assert.equal(result.tools, candidateTools);
  assert.equal(result.candidateToolCount, 3);
  assert.equal(result.admittedToolCount, 3);
  assert.equal(result.omittedToolCount, 0);
  assert.equal(result.candidateBudget?.fits, true);
});

test("budget pressure omits optional tools while retaining mandatory tools", () => {
  const mandatoryTools = { Read: providerTool("read") } as ToolSet;
  const candidateTools = {
    ...mandatoryTools,
    CreateWorkflow: providerTool("workflow ".repeat(8_000)),
  } as ToolSet;
  const result = admitProviderFacingTools({
    candidateTools,
    contextWindow: contextFor(mandatoryTools, 50),
    messages: MESSAGES,
    requestedOutputTokens: REQUESTED_OUTPUT,
    toolContracts: [contract("Read", "mandatory"), contract("CreateWorkflow", "optional")],
  });

  assert.deepEqual(Object.keys(result.tools ?? {}), ["Read"]);
  assert.deepEqual(result.omittedToolNames, ["CreateWorkflow"]);
  assert.equal(result.admittedBudget?.fits, true);
});

test("mandatory tools are never deleted merely to manufacture a fit", () => {
  const mandatoryTools = { Read: providerTool("required ".repeat(500)) } as ToolSet;
  const exactContext = contextFor(mandatoryTools, 0);
  const result = admitProviderFacingTools({
    candidateTools: {
      ...mandatoryTools,
      Optional: providerTool("optional"),
    } as ToolSet,
    contextWindow: exactContext - 1,
    messages: MESSAGES,
    requestedOutputTokens: REQUESTED_OUTPUT,
    toolContracts: [contract("Read", "mandatory"), contract("Optional", "optional")],
  });

  assert.deepEqual(Object.keys(result.tools ?? {}), ["Read"]);
  assert.equal(result.admittedBudget?.fits, false);
});

test("one oversized optional tool does not block a smaller optional tool", () => {
  const mandatoryAndSmall = {
    Read: providerTool("read"),
    SmallOptional: providerTool("small optional"),
  } as ToolSet;
  const candidateTools = {
    Read: mandatoryAndSmall.Read,
    GiantOptional: providerTool("giant ".repeat(10_000)),
    SmallOptional: mandatoryAndSmall.SmallOptional,
  } as ToolSet;
  const input = {
    candidateTools,
    contextWindow: contextFor(mandatoryAndSmall, 50),
    messages: MESSAGES,
    requestedOutputTokens: REQUESTED_OUTPUT,
    toolContracts: [
      contract("Read", "mandatory"),
      contract("GiantOptional", "optional"),
      contract("SmallOptional", "optional"),
    ],
  } as const;

  const first = admitProviderFacingTools(input);
  const second = admitProviderFacingTools(input);

  assert.deepEqual(Object.keys(first.tools ?? {}), ["Read", "SmallOptional"]);
  assert.deepEqual(first.omittedToolNames, ["GiantOptional"]);
  assert.deepEqual(Object.keys(second.tools ?? {}), Object.keys(first.tools ?? {}));
  assert.deepEqual(second.omittedToolNames, first.omittedToolNames);
  assert.equal(first.admittedBudget?.fits, true);
});

test("generic external tools participate without provider or server-name hardcoding", () => {
  const coreOnly = { Read: providerTool("read") } as ToolSet;
  const result = admitProviderFacingTools({
    candidateTools: {
      ...coreOnly,
      arbitrary_external_capability: providerTool("external ".repeat(8_000)),
    } as ToolSet,
    contextWindow: contextFor(coreOnly, 50),
    messages: MESSAGES,
    requestedOutputTokens: REQUESTED_OUTPUT,
    toolContracts: [
      contract("Read", "mandatory"),
      contract("arbitrary_external_capability", "optional"),
    ],
  });

  assert.deepEqual(Object.keys(result.tools ?? {}), ["Read"]);
  assert.deepEqual(result.omittedToolNames, ["arbitrary_external_capability"]);
});

test("historical tool messages remain valid without forcing current schema exposure", () => {
  const requestMessages: ModelInputMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "HistoryTool", input: {} }],
    },
    {
      role: "tool",
      content: "done",
      toolCallId: "call-1",
      toolName: "HistoryTool",
    },
    { role: "user", content: "continue" },
  ];
  const options = createGenerateTextOptions({
    includeModelIO: false,
    request: {
      maxOutputTokens: REQUESTED_OUTPUT,
      messages: requestMessages,
      tools: [
        { ...contract("Read", "mandatory"), description: "read" },
        {
          ...contract("HistoryTool", "optional"),
          description: "history schema ".repeat(8_000),
        },
      ],
    } as never,
    resolved: modelResolution(2_500),
    statusContext: statusContext(),
  });

  assert.deepEqual(Object.keys(options.tools ?? {}), ["Read"]);
  assert.equal(
    options.messages.some((message) => message.role === "tool"),
    true,
  );
});

test("an explicitly selected tool is promoted to mandatory", () => {
  const selectedOnly = { SelectedTool: providerTool("selected") } as ToolSet;
  const result = admitProviderFacingTools({
    candidateTools: {
      SelectedTool: selectedOnly.SelectedTool,
      OtherOptional: providerTool("other ".repeat(8_000)),
    } as ToolSet,
    contextWindow: contextFor(selectedOnly, 50),
    messages: MESSAGES,
    requestedOutputTokens: REQUESTED_OUTPUT,
    toolChoice: { type: "tool", toolName: "SelectedTool" },
    toolContracts: [contract("SelectedTool", "optional"), contract("OtherOptional", "optional")],
  });

  assert.deepEqual(Object.keys(result.tools ?? {}), ["SelectedTool"]);
});

test("unknown local budget preserves the complete catalog", () => {
  const candidateTools = {
    Read: providerTool("read"),
    HugeOptional: providerTool("huge ".repeat(8_000)),
  } as ToolSet;
  const result = admitProviderFacingTools({
    candidateTools,
    contextWindow: undefined,
    messages: MESSAGES,
    requestedOutputTokens: REQUESTED_OUTPUT,
    toolContracts: [contract("Read", "mandatory"), contract("HugeOptional", "optional")],
  });

  assert.equal(result.tools, candidateTools);
  assert.equal(result.omittedToolCount, 0);
  assert.equal(result.candidateBudget, undefined);
});

test("required tool choice never becomes a provider request with zero tools", () => {
  const onlyTool = { GiantOptional: providerTool("giant ".repeat(10_000)) } as ToolSet;
  const messagesOnly = contextFor(undefined, 50);
  const result = admitProviderFacingTools({
    candidateTools: onlyTool,
    contextWindow: messagesOnly,
    messages: MESSAGES,
    requestedOutputTokens: REQUESTED_OUTPUT,
    toolChoice: "required",
    toolContracts: [contract("GiantOptional", "optional")],
  });

  assert.deepEqual(Object.keys(result.tools ?? {}), ["GiantOptional"]);
  assert.equal(result.admittedBudget?.fits, false);
});

test("generate and stream requests use the same admission policy", () => {
  const request = {
    maxOutputTokens: REQUESTED_OUTPUT,
    messages: REQUEST_MESSAGES,
    tools: [
      {
        ...contract("Read", "mandatory"),
        description: "read",
      },
      {
        ...contract("CreateWorkflow", "optional"),
        description: "workflow ".repeat(8_000),
      },
    ],
  } as never;
  const resolved = modelResolution(2_500);
  const generate = createGenerateTextOptions({
    includeModelIO: false,
    request,
    resolved,
    statusContext: statusContext(),
  });
  const stream = createStreamTextOptions({
    includeModelIO: false,
    request,
    resolved,
    statusContext: statusContext(),
  });

  assert.deepEqual(Object.keys(generate.tools ?? {}), ["Read"]);
  assert.deepEqual(Object.keys(stream.tools ?? {}), ["Read"]);
});

function contextFor(tools: ToolSet | undefined, headroom: number): number {
  const probe = calculateModelRequestBudget({
    contextWindow: 100_000,
    messages: MESSAGES,
    requestedOutputTokens: REQUESTED_OUTPUT,
    tools,
  });
  assert.ok(probe);
  return (
    probe.estimatedInputTokens + probe.requestedOutputTokens + probe.safetyMarginTokens + headroom
  );
}

function providerTool(description: string) {
  return {
    description,
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: { input: { type: "string" } },
      },
    },
  } as never;
}

function contract(name: string, admissionPriority: ModelToolAdmissionPriority): ModelToolContract {
  return {
    admissionPriority,
    description: name,
    inputSchema: { type: "object", properties: {} },
    name,
  };
}

function modelResolution(contextWindow: number) {
  return {
    model: {},
    modelId: "admission-test-model",
    providerId: "local",
    providerKind: "openai-compatible",
    properties: {
      contextWindow,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      requiresMfjsToolSchema: false,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
      supportsToolCall: true,
      outputFormat: { supportsText: true },
    },
  } as never;
}

function statusContext() {
  return {
    requestId: "test-request",
    traceId: "test-trace",
    modelRequestSessionType: "other",
    providerId: "local",
    modelId: "admission-test-model",
  } as never;
}
