import {
  getPermanentlyExposedToolNames,
  recordDiscoveredTools,
  TOOL_SEARCH_NAME,
} from "../../tool/discovery.js";
import type { ToolExecutionResult } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

export function recordToolSearchResults(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  results: readonly ToolExecutionResult[],
): void {
  for (const result of results) {
    if (!result.success || result.toolName !== TOOL_SEARCH_NAME) continue;
    // 只排除永久基线/控制暴露；近期发现的工具即使当前已可见，也必须刷新 LRU 位置。
    const candidates = runtime.getTools(state.model);
    state.recentExposedToolNames = recordDiscoveredTools(
      state.recentExposedToolNames ?? [],
      result.output,
      runtime.registry,
      getPermanentlyExposedToolNames({ candidates }),
    );
  }
}
