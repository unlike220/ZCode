import type { FileSystemPort, TraceContext } from "@zcode/contracts";
import { readProjectWorkState } from "./work-state.js";

const MAX_PROJECT_WORK_CONTEXT_CHARS = 1_600;
const MAX_CONTEXT_SCOPE_ENTRIES = 12;
const MAX_CONTEXT_OBSERVED_PATHS = 12;

export async function buildProjectWorkTurnContext(input: {
  fileSystemPort: FileSystemPort;
  rootDir: string;
  traceContext?: TraceContext;
}): Promise<string | null> {
  const { state } = await readProjectWorkState(
    input.fileSystemPort,
    input.rootDir,
    input.traceContext,
  );
  const work = state.work;
  if (!work) return null;

  const lines = [
    "# Project Work",
    `Work state version: ${state.version}; [${work.status}] ${work.id}`,
    `Objective: ${compact(work.objective)}`,
    ...(work.taskId ? [`Linked task: ${work.taskId}`] : []),
    "This is operational mutation scope, not repository truth or completion proof. Existing permissions and sandbox rules still apply. Scope enforcement covers supported structured mutations; arbitrary command effects are not statically scope-enforced.",
    "",
    "## Allowed mutation scope",
  ];

  for (const scope of work.scope.slice(0, MAX_CONTEXT_SCOPE_ENTRIES)) {
    lines.push(`- ${JSON.stringify(scope.path)}${scope.recursive ? "/**" : ""}`);
  }
  if (work.scope.length > MAX_CONTEXT_SCOPE_ENTRIES) {
    lines.push(`- … ${work.scope.length - MAX_CONTEXT_SCOPE_ENTRIES} more scope entries`);
  }

  if (work.observedMutationCount > 0) {
    lines.push(
      "",
      `## Observed structured mutation paths (${work.observedMutationCount} observations)`,
    );
    for (const path of work.observedMutationPaths.slice(0, MAX_CONTEXT_OBSERVED_PATHS)) {
      lines.push(`- ${JSON.stringify(path)}`);
    }
    if (
      work.observedMutationPaths.length > MAX_CONTEXT_OBSERVED_PATHS ||
      work.observedMutationPathsTruncated
    ) {
      lines.push("- … observed path list is bounded");
    }
  }

  return truncate(lines.join("\n"), MAX_PROJECT_WORK_CONTEXT_CHARS);
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const suffix = "\n… Project Work projection truncated";
  return `${value.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}
