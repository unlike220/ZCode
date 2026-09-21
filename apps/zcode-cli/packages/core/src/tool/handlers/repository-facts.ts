import {
  RepositoryFactsReadInputSchema,
  RepositoryFactsReadInputJsonSchema,
  RepositoryFactsReadOutputSchema,
  RepositoryFactsReadOutputJsonSchema,
  RepositoryFactsRefreshInputSchema,
  RepositoryFactsRefreshInputJsonSchema,
  RepositoryFactsRefreshOutputSchema,
  RepositoryFactsRefreshOutputJsonSchema,
} from "@zcode/contracts";
import {
  readRepositoryFacts,
  refreshRepositoryFacts,
} from "../../project-intelligence/repository-store.js";
import { selectRepositoryFacts } from "../../project-intelligence/repository-query.js";
import type { ToolEntry, ToolExecutionContext } from "../types.js";

function storage(context: ToolExecutionContext) {
  if (!context.fileSystemPort || !context.projectIntelligenceRoot)
    throw new Error("Repository Facts storage is not configured");
  return {
    rootDir: context.projectIntelligenceRoot,
    fileSystemPort: context.fileSystemPort,
    traceContext: context.traceContext,
    signal: context.abortSignal,
  };
}

const MAX_MODEL_BYTES = 30000;
function policy(
  name: string,
  refresh: boolean,
): Omit<ToolEntry, "handler" | "inputSchema" | "outputSchema"> {
  const timeoutMs = refresh ? 120000 : 30000;
  const description = refresh
    ? "Rebuild disposable workspace Repository Facts from canonical files and Git. Writes only ZCode metadata; never source. No freshness guarantee against external edits."
    : "Read bounded repository file, symbol, dependency and test navigation hints. Filter by query/path/kind. Facts may be stale; read canonical source before editing.";
  return {
    capability: description,
    metadata: {
      name,
      description,
      readOnly: !refresh,
      destructive: false,
      concurrentSafe: !refresh,
      timeoutMs,
      maxOutputBytes: MAX_MODEL_BYTES,
      sideEffectScope: refresh ? "workspace" : "none",
      riskLevel: "low",
      needsApproval: false,
    },
    permission: {
      permission: refresh ? "repository-facts.refresh" : "repository-facts.read",
      reason: description,
      riskLevel: "low",
      sideEffectScope: refresh ? "workspace" : "none",
      needsApproval: false,
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: MAX_MODEL_BYTES,
      maxModelBytes: MAX_MODEL_BYTES,
      strategy: "truncate",
      preview: { maxBytes: MAX_MODEL_BYTES, direction: "head" },
    },
    timeout: { defaultMs: timeoutMs, maxMs: timeoutMs, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "bestEffort",
      userVisibleMessage: `${name} cancelled`,
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}

export const repositoryFactsReadToolEntry: ToolEntry = {
  ...policy("RepositoryFactsRead", false),
  inputSchema: RepositoryFactsReadInputJsonSchema,
  outputSchema: RepositoryFactsReadOutputJsonSchema,
  runtimeInputSchema: RepositoryFactsReadInputSchema,
  runtimeOutputSchema: RepositoryFactsReadOutputSchema,
  handler: async (input, context) =>
    selectRepositoryFacts(
      await readRepositoryFacts(storage(context)),
      RepositoryFactsReadInputSchema.parse(input),
    ),
};

export const repositoryFactsRefreshToolEntry: ToolEntry = {
  ...policy("RepositoryFactsRefresh", true),
  inputSchema: RepositoryFactsRefreshInputJsonSchema,
  outputSchema: RepositoryFactsRefreshOutputJsonSchema,
  runtimeInputSchema: RepositoryFactsRefreshInputSchema,
  runtimeOutputSchema: RepositoryFactsRefreshOutputSchema,
  handler: async (input, context) => {
    RepositoryFactsRefreshInputSchema.parse(input);
    if (context.runtimeScope === "subagent")
      throw new Error("Repository Facts refresh is owned by main project sessions");
    await refreshRepositoryFacts({
      ...storage(context),
      workspaceRoot: context.workspaceRoot,
      executionPort: context.executionPort,
    });
    const selected = selectRepositoryFacts(await readRepositoryFacts(storage(context)), {
      limit: 1,
    });
    return {
      freshness: selected.freshness,
      generation: selected.generation,
      indexedAt: selected.indexedAt,
      provenance: selected.provenance,
      summary: selected.summary,
    };
  },
};
