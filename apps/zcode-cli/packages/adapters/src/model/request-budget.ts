import { ESTIMATED_TOKEN_CHAR_DIVISOR, MODEL_REQUEST_SAFETY_MARGIN_TOKENS } from "@zcode/shared";
import { ModelErrorCode } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";

const REQUEST_FRAMING_TOKENS = 32;
const MESSAGE_FRAMING_TOKENS = 4;
const TOOL_FRAMING_TOKENS = 8;

const TOOL_INTERNAL_KEYS = new Set([
  "execute",
  "needsApproval",
  "toModelOutput",
  "experimental_toToolResultContent",
  "capability",
  "admissionPriority",
  "executionMode",
  "providerNative",
  "readOnly",
  "destructive",
  "concurrentSafe",
  "requiresUserInteraction",
  "maxOutputBytes",
  "timeoutMs",
  "permission",
  "resultBudget",
  "sideEffectScope",
]);

export interface ModelRequestBudget {
  contextWindow: number;
  estimatedMessageTokens: number;
  estimatedToolTokens: number;
  estimatedFramingTokens: number;
  estimatedInputTokens: number;
  requestedOutputTokens: number;
  safetyMarginTokens: number;
  allowedInputTokens: number;
  remainingInputTokens: number;
  fits: boolean;
  toolCount: number;
}

export interface ModelRequestBudgetInput {
  contextWindow: number | undefined;
  messages: readonly unknown[];
  requestedOutputTokens: number | undefined;
  tools?: Record<string, unknown>;
}

export function calculateModelRequestBudget(
  input: ModelRequestBudgetInput,
): ModelRequestBudget | undefined {
  if (
    !isPositiveFiniteInteger(input.contextWindow) ||
    !isPositiveFiniteInteger(input.requestedOutputTokens)
  ) {
    return undefined;
  }

  const toolEntries = Object.entries(input.tools ?? {});
  const estimatedMessageTokens = estimateSerializedTokens(input.messages);
  const estimatedToolTokens = estimateProviderVisibleToolsTokens(input.tools);
  const estimatedFramingTokens =
    REQUEST_FRAMING_TOKENS +
    input.messages.length * MESSAGE_FRAMING_TOKENS +
    toolEntries.length * TOOL_FRAMING_TOKENS;
  const estimatedInputTokens =
    estimatedMessageTokens + estimatedToolTokens + estimatedFramingTokens;
  const allowedInputTokens = Math.max(
    0,
    input.contextWindow - input.requestedOutputTokens - MODEL_REQUEST_SAFETY_MARGIN_TOKENS,
  );

  return {
    allowedInputTokens,
    contextWindow: input.contextWindow,
    estimatedFramingTokens,
    estimatedInputTokens,
    estimatedMessageTokens,
    estimatedToolTokens,
    fits: estimatedInputTokens <= allowedInputTokens,
    remainingInputTokens: allowedInputTokens - estimatedInputTokens,
    requestedOutputTokens: input.requestedOutputTokens,
    safetyMarginTokens: MODEL_REQUEST_SAFETY_MARGIN_TOKENS,
    toolCount: toolEntries.length,
  };
}

export function assertModelRequestBudget(input: {
  budget: ModelRequestBudget | undefined;
  model: { modelId: string; providerId: string };
}): void {
  const budget = input.budget;
  if (!budget || budget.fits) return;

  // 这里必须在 AI SDK runtime 调用前失败：工具 schema 可能比消息正文大很多，
  // 仅用 message estimate 会让本地预算误判并把已知超窗请求交给 provider。
  throw new AiSdkModelAdapterError(
    ModelErrorCode.ModelContextBudgetExceeded,
    `Model request exceeds the local context budget for ${input.model.providerId}/${input.model.modelId}`,
    {
      context: {
        allowedInputTokens: budget.allowedInputTokens,
        contextWindow: budget.contextWindow,
        estimatedFramingTokens: budget.estimatedFramingTokens,
        estimatedInputTokens: budget.estimatedInputTokens,
        estimatedMessageTokens: budget.estimatedMessageTokens,
        estimatedToolTokens: budget.estimatedToolTokens,
        model: input.model.modelId,
        providerId: input.model.providerId,
        remainingInputTokens: budget.remainingInputTokens,
        requestedOutputTokens: budget.requestedOutputTokens,
        safetyMarginTokens: budget.safetyMarginTokens,
        toolCount: budget.toolCount,
      },
    },
  );
}

export function estimateProviderVisibleToolsTokens(tools?: Record<string, unknown>): number {
  return Object.entries(tools ?? {}).reduce(
    (total, [name, toolDefinition]) =>
      total + estimateSerializedTokens({ name, ...providerVisibleToolShape(toolDefinition) }),
    0,
  );
}

function estimateSerializedTokens(value: unknown): number {
  const serialized = safeJsonStringify(value);
  return Math.ceil(serialized.length / ESTIMATED_TOKEN_CHAR_DIVISOR);
}

function providerVisibleToolShape(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      if (TOOL_INTERNAL_KEYS.has(key) || typeof child === "function") return [];
      return [[key, child]];
    }),
  );
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // Provider-facing AI SDK values should be JSON-safe. Keep the estimator
    // deterministic if a future adapter introduces an unexpected cyclic value.
    return "[unserializable-provider-value]";
  }
}

function isPositiveFiniteInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0 && Number.isFinite(value);
}
