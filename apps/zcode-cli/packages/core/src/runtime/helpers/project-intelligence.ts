import type { AgentRuntimeConfig } from "../types.js";
import { resolveProjectIntelligenceRoot } from "../../project-intelligence/path.js";
import { buildProjectIntelligenceTurnContext } from "../../project-intelligence/context.js";
import { systemReminderAttachmentEntry } from "../../agent/message-history.js";
import { traceContextToLogContext } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "../methods/turn-loop-state.js";
import { appendTurnRequestEntries } from "../methods/turn-output-token-continuation.js";

export async function appendRuntimeProjectIntelligenceContext(
  runtime: Pick<AgentRuntimeInternal, "config" | "workspaceRoot" | "fileSystemPort" | "logger">,
  state: Pick<RegularTurnLoopState, "input" | "turnTraceContext" | "turnRequestState">,
): Promise<void> {
  if (!runtime.fileSystemPort) return;
  const rootDir = resolveRuntimeProjectIntelligenceRoot(runtime.config, runtime.workspaceRoot);
  if (!rootDir) return;
  const report = (kind: string, error: unknown) => {
    runtime.logger?.warn("Project Intelligence context skipped", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "project_intelligence.context.skipped",
      module: "core.runtime",
      kind,
      reason: error instanceof Error ? error.message : "unknown error",
    });
  };
  try {
    const context = await buildProjectIntelligenceTurnContext({
      fileSystemPort: runtime.fileSystemPort,
      rootDir,
      query: state.input,
      traceContext: state.turnTraceContext,
      onProjectionError: report,
    });
    // 只追加本轮请求视图；写入 messageHistory 会让旧索引跨轮残留。
    if (context)
      appendTurnRequestEntries(state.turnRequestState, [
        systemReminderAttachmentEntry("project_intelligence", context),
      ]);
  } catch (error) {
    report("combined", error);
  }
}

export function resolveRuntimeProjectIntelligenceRoot(
  config: AgentRuntimeConfig,
  workspacePath: string,
): string | undefined {
  const cliStorageRoot = config.memory?.cliStorageRoot;
  if (!cliStorageRoot) return undefined;

  return resolveProjectIntelligenceRoot({
    cliStorageRoot,
    workspacePath,
    workspaceIdentity:
      config.workspaceIdentity?.toString().trim() || config.memory?.workspaceIdentity?.trim(),
  });
}
