import type { AgentRuntimeConfig } from "../types.js";
import { resolveProjectIntelligenceRoot } from "../../project-intelligence/path.js";

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
