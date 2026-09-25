import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskContextUsageFromUsageUpdate } from "../src/lib/zcodeTaskUsageFallback.js";

const diagnostics = {
  candidateToolCount: 15,
  admittedToolCount: 15,
  omittedToolCount: 0,
  eligibleToolCount: 40,
  exposedToolCount: 15,
  estimatedInputTokens: 17_500,
  allowedInputTokens: 23_576,
  remainingInputTokens: 6_076,
} as const;

test("same-snapshot usage updates retain context diagnostics", () => {
  const currentUsage = {
    used: 17_700,
    size: 32_768,
    diagnostics,
  };

  const next = buildTaskContextUsageFromUsageUpdate({
    currentUsage,
    incomingUsage: {
      used: 17_700,
      size: 32_768,
    },
  });

  assert.deepEqual(next.diagnostics, diagnostics);
});

test("new usage snapshot does not retain stale context diagnostics", () => {
  const currentUsage = {
    used: 17_700,
    size: 32_768,
    diagnostics,
  };

  const next = buildTaskContextUsageFromUsageUpdate({
    currentUsage,
    incomingUsage: {
      used: 18_100,
      size: 32_768,
    },
  });

  assert.equal(next.diagnostics, undefined);
});
