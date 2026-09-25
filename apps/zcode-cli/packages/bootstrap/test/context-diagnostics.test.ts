import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType } from "@zcode/contracts";
import { zcodeContextDiagnosticsSchema } from "@zcode/shared";
import { resolveSessionContextUsage } from "../src/zcode-protocol/session-mapper.js";

const diagnostics = {
  eligibleToolCount: 40,
  exposedToolCount: 15,
  candidateToolCount: 15,
  admittedToolCount: 15,
  omittedToolCount: 0,
  contextWindow: 32_768,
  requestedOutputTokens: 8_192,
  safetyMarginTokens: 1_000,
  allowedInputTokens: 23_576,
  estimatedMessageTokens: 7_000,
  estimatedToolTokens: 10_000,
  estimatedFramingTokens: 500,
  estimatedInputTokens: 17_500,
  remainingInputTokens: 6_076,
  fits: true,
} as const;

test("context diagnostics schema is scalar-only and rejects tool-name payloads", () => {
  const parsed = zcodeContextDiagnosticsSchema.safeParse(diagnostics);
  assert.equal(parsed.success, true);

  const unbounded = zcodeContextDiagnosticsSchema.safeParse({
    ...diagnostics,
    omittedToolNames: ["CreateWorkflow"],
  });
  assert.equal(unbounded.success, false);
});

test("cold restore carries matching main-turn context diagnostics", () => {
  const usage = resolveSessionContextUsage({
    messages: [],
    projection: { contextUsed: 123, contextWindow: 1_000 } as never,
    persistedContextUsageBreakdownEvents: [
      {
        type: SessionEventType.ModelComplete,
        payload: {
          querySource: "main_turn",
          contextWindow: 1_000,
          contextDiagnostics: diagnostics,
          usage: { inputTokens: 120, outputTokens: 3 },
        },
      } as never,
    ],
  });

  assert.equal(usage?.used, 123);
  assert.equal(usage?.size, 1_000);
  assert.deepEqual(usage?.diagnostics, diagnostics);
});

test("cold restore rejects diagnostics from a stale usage snapshot", () => {
  const usage = resolveSessionContextUsage({
    messages: [],
    projection: { contextUsed: 123, contextWindow: 1_000 } as never,
    persistedContextUsageBreakdownEvents: [
      {
        type: SessionEventType.ModelComplete,
        payload: {
          querySource: "main_turn",
          contextWindow: 1_000,
          contextDiagnostics: diagnostics,
          usage: { inputTokens: 118, outputTokens: 3 },
        },
      } as never,
    ],
  });

  assert.equal(usage?.used, 123);
  assert.equal(usage?.diagnostics, undefined);
});
