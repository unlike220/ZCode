import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelErrorCode,
  ModelFailureReason,
  ModelRetryBudget,
} from "@zcode/contracts";
import {
  assertModelRequestBudget,
  calculateModelRequestBudget,
} from "../src/model/request-budget.js";
import { runGenerateText } from "../src/model/runner-generate.js";
import { runStreamText } from "../src/model/runner-stream.js";
import {
  createGenerateTextOptions,
  createStreamTextOptions,
} from "../src/model/runner-options.js";
import {
  resolveWorkflowModelFailurePolicy,
  retryAllowedByFailurePolicy,
} from "../src/model/workflow-model-failure-policy.js";

const MODEL = { modelId: "bonsai2-27b", providerId: "local" };

test("messages-only request fits its reserved output budget", () => {
  const budget = calculateModelRequestBudget({
    contextWindow: 32_768,
    messages: [{ role: "user", content: "hello" }],
    requestedOutputTokens: 8_192,
  });

  assert.ok(budget);
  assert.equal(budget.toolCount, 0);
  assert.equal(budget.estimatedToolTokens, 0);
  assert.equal(budget.fits, true);
});

test("provider-visible tool definitions materially increase the estimate", () => {
  const messages = [{ role: "user", content: "hello" }];
  const withoutTools = calculateModelRequestBudget({
    contextWindow: 32_768,
    messages,
    requestedOutputTokens: 8_192,
  });
  const withTools = calculateModelRequestBudget({
    contextWindow: 32_768,
    messages,
    requestedOutputTokens: 8_192,
    tools: {
      external_lookup: {
        description: "lookup details ".repeat(2_000),
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    },
  });

  assert.ok(withoutTools && withTools);
  assert.equal(withTools.toolCount, 1);
  assert.ok(withTools.estimatedToolTokens > 1_000);
  assert.ok(withTools.estimatedInputTokens > withoutTools.estimatedInputTokens);
});

test("tool-driven overflow is rejected locally before the model runtime", async () => {
  let runtimeInvoked = false;
  let error: unknown;
  try {
    await runGenerateText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: {
        maxOutputTokens: 8_192,
        messages: [{ role: "user", content: "test" }],
        tools: [
          {
            name: "workflow_catalog",
            description: "workflow detail ".repeat(25_000),
            inputSchema: { type: "object", properties: { input: { type: "string" } } },
          },
        ],
      } as never,
      resolveModel: () => modelResolution(),
      resolved: modelResolution(),
      retry: { maxAttempts: 1, baseDelayMs: 0, backoffFactor: 1, maxDelayMs: 0, jitter: false },
      runtime: {
        generateText: async () => {
          runtimeInvoked = true;
          throw new Error("provider must not be called");
        },
        streamText: () => {
          throw new Error("stream provider must not be called");
        },
      },
    });
  } catch (caught) {
    error = caught;
  }

  assert.equal(runtimeInvoked, false);
  assert.ok(error);
  assert.equal((error as { code?: string }).code, ModelErrorCode.ModelContextBudgetExceeded);
});

test("stream overflow is rejected before the stream provider runtime", async () => {
  let runtimeInvocations = 0;
  const stream = runStreamText({
    env: {},
    modelIoFullRetentionEnabled: false,
    request: {
      maxOutputTokens: 8_192,
      messages: [{ role: "user", content: "test" }],
      tools: [
        {
          name: "workflow_catalog",
          description: "workflow detail ".repeat(25_000),
          inputSchema: { type: "object", properties: { input: { type: "string" } } },
        },
      ],
    } as never,
    resolveModel: () => modelResolution(),
    resolved: modelResolution(),
    retry: { maxAttempts: 1, baseDelayMs: 0, backoffFactor: 1, maxDelayMs: 0, jitter: false },
    runtime: {
      generateText: async () => {
        throw new Error("generate provider must not be called");
      },
      streamText: () => {
        runtimeInvocations += 1;
        throw new Error("stream provider must not be called");
      },
    },
    streamIdleTimeoutMs: 1_000,
  });

  await assert.rejects(
    async () => {
      for await (const _event of stream) {
        // Consume the real runner boundary so preflight happens before streamText.
      }
    },
    (error: unknown) =>
      (error as { code?: string }).code === ModelErrorCode.ModelContextBudgetExceeded,
  );
  assert.equal(runtimeInvocations, 0);
});

test("requested output reserves budget without adding a generic AI SDK option", () => {
  const resolved = modelResolution(1_100);
  const request = {
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "small request" }],
  } as never;

  assert.throws(
    () =>
      createGenerateTextOptions({
        includeModelIO: false,
        request,
        resolved,
        statusContext: statusContext(),
      }),
    (error: unknown) =>
      (error as { code?: string }).code === ModelErrorCode.ModelContextBudgetExceeded,
  );

  const generateOptions = createGenerateTextOptions({
    includeModelIO: false,
    request: { ...request, maxOutputTokens: 100 } as never,
    resolved: modelResolution(),
    statusContext: statusContext(),
  });
  assert.equal("maxOutputTokens" in generateOptions, false);

  const options = createStreamTextOptions({
    includeModelIO: false,
    request: { ...request, maxOutputTokens: 100 } as never,
    resolved: modelResolution(),
    statusContext: statusContext(),
  });
  assert.equal("maxOutputTokens" in options, false);
});

test("unbounded workflow retry stops on a local context-budget failure", () => {
  const failure = {
    code: ModelErrorCode.ModelContextBudgetExceeded,
    reason: ModelFailureReason.LocalContextBudgetExceeded,
    retryable: false,
  } as never;

  assert.deepEqual(resolveWorkflowModelFailurePolicy(failure, undefined), {
    decision: "context_exceeded",
  });
  assert.equal(
    retryAllowedByFailurePolicy(failure, ModelRetryBudget.Unbounded, undefined),
    false,
  );
});

test("reserved output and safety margin can reject input below the raw context window", () => {
  const budget = calculateModelRequestBudget({
    contextWindow: 2_000,
    messages: [{ role: "user", content: "x".repeat(1_200) }],
    requestedOutputTokens: 700,
  });

  assert.ok(budget);
  assert.ok(budget.estimatedInputTokens < budget.contextWindow);
  assert.ok(budget.estimatedInputTokens > budget.allowedInputTokens);
  assert.equal(budget.fits, false);
});

test("equality at the allowed input boundary fits", () => {
  const probe = calculateModelRequestBudget({
    contextWindow: 10_000,
    messages: [{ role: "user", content: "boundary" }],
    requestedOutputTokens: 100,
  });
  assert.ok(probe);

  const budget = calculateModelRequestBudget({
    contextWindow:
      probe.estimatedInputTokens + probe.requestedOutputTokens + probe.safetyMarginTokens,
    messages: [{ role: "user", content: "boundary" }],
    requestedOutputTokens: probe.requestedOutputTokens,
  });

  assert.ok(budget);
  assert.equal(budget.estimatedInputTokens, budget.allowedInputTokens);
  assert.equal(budget.fits, true);
});

test("one token over the allowed input boundary is rejected", () => {
  const probe = calculateModelRequestBudget({
    contextWindow: 10_000,
    messages: [{ role: "user", content: "boundary" }],
    requestedOutputTokens: 100,
  });
  assert.ok(probe);

  const budget = calculateModelRequestBudget({
    contextWindow:
      probe.estimatedInputTokens + probe.requestedOutputTokens + probe.safetyMarginTokens - 1,
    messages: [{ role: "user", content: "boundary" }],
    requestedOutputTokens: probe.requestedOutputTokens,
  });

  assert.ok(budget);
  assert.equal(budget.estimatedInputTokens, budget.allowedInputTokens + 1);
  assert.equal(budget.fits, false);
});

test("a fitting request still invokes the model runtime", async () => {
  let runtimeInvoked = false;
  const result = await runGenerateText({
    env: {},
    modelIoFullRetentionEnabled: false,
    request: {
      maxOutputTokens: 100,
      messages: [{ role: "user", content: "test" }],
    } as never,
    resolveModel: () => modelResolution(),
    resolved: modelResolution(),
    retry: { maxAttempts: 1, baseDelayMs: 0, backoffFactor: 1, maxDelayMs: 0, jitter: false },
    runtime: {
      generateText: async () => {
        runtimeInvoked = true;
        return {
          text: "ok",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        } as never;
      },
      streamText: () => {
        throw new Error("not used");
      },
    },
  });

  assert.equal(runtimeInvoked, true);
  assert.equal(result.text, "ok");
});

test("local budget diagnostics contain numeric breakdown without request content", () => {
  const budget = calculateModelRequestBudget({
    contextWindow: 32_768,
    messages: [{ role: "user", content: "private prompt marker" }],
    requestedOutputTokens: 8_192,
    tools: {
      mcp_tool: {
        description: "private tool description marker ".repeat(4_000),
        inputSchema: { type: "object", properties: { secret: { type: "string" } } },
      },
    },
  });
  assert.ok(budget);

  assert.throws(
    () => assertModelRequestBudget({ budget: { ...budget, fits: false }, model: MODEL }),
    (error: unknown) => {
      const record = error as { code: string; context?: Record<string, unknown>; message: string };
      assert.equal(record.code, ModelErrorCode.ModelContextBudgetExceeded);
      assert.equal(typeof record.context?.estimatedInputTokens, "number");
      assert.equal(typeof record.context?.estimatedToolTokens, "number");
      assert.equal(typeof record.context?.allowedInputTokens, "number");
      assert.equal(record.message.includes("private prompt marker"), false);
      assert.equal(
        JSON.stringify(record.context).includes("private tool description marker"),
        false,
      );
      return true;
    },
  );
});

test("generic externally registered tool shapes are counted without execution handlers", () => {
  const budget = calculateModelRequestBudget({
    contextWindow: 32_768,
    messages: [{ role: "user", content: "hello" }],
    requestedOutputTokens: 8_192,
    tools: {
      mcp_server_lookup: {
        description: "an externally registered tool",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        permission: { internalOnly: true },
        execute: () => "must not be serialized into the estimate",
      },
    },
  });

  assert.ok(budget);
  assert.equal(budget.toolCount, 1);
  assert.ok(budget.estimatedToolTokens > 0);
});

function modelResolution(contextWindow = 32_768) {
  return {
    model: {},
    modelId: MODEL.modelId,
    providerId: MODEL.providerId,
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
    providerId: MODEL.providerId,
    modelId: MODEL.modelId,
  } as never;
}
