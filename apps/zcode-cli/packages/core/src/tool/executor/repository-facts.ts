import {
  isWorkspaceMutatingToolCall,
  traceContextToLogContext,
  type TraceContext,
} from "@zcode/contracts";
import { invalidateRepositoryFacts } from "../../project-intelligence/repository-store.js";
import type { ToolEntry } from "../types.js";
import { resolveToolCallCapabilityFlags } from "./permission-capability.js";
import type { ToolExecutorDeps } from "./types.js";

export async function invalidateFactsForTool(
  deps: ToolExecutorDeps,
  entry: ToolEntry,
  input: unknown,
  traceContext: TraceContext,
): Promise<void> {
  try {
    if (
      [
        "RepositoryFactsRefresh",
        "ProjectStateUpdate",
        "ProjectWorkUpdate",
        "ProjectCompletionUpdate",
      ].includes(entry.metadata.name) ||
      !isWorkspaceMutatingToolCall(resolveToolCallCapabilityFlags(deps, entry, input))
    )
      return;
    const rootDir = deps.getProjectIntelligenceRoot?.();
    if (!rootDir || !deps.fileSystemPort) return;
    await invalidateRepositoryFacts({ rootDir, fileSystemPort: deps.fileSystemPort, traceContext });
  } catch (error) {
    // 索引只是提示；失效标记写入失败不能阻断原工具，读取仍不宣称 fresh。
    deps.logger?.warn("Repository Facts invalidation failed", {
      ...traceContextToLogContext(traceContext),
      event: "repository_facts.invalidation.failed",
      module: "core.tool.executor",
      reason: error instanceof Error ? error.message : "unknown error",
    });
  }
}
