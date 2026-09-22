import {
  CoreErrorType,
  createCoreError,
  traceContextToLogContext,
  type TraceContext,
} from "@zcode/contracts";
import {
  readProjectWorkState,
  recordObservedProjectWorkMutation,
  writeProjectWorkState,
} from "../../project-intelligence/work-state.js";
import {
  isProjectWorkPathAllowed,
  resolveProjectWorkMutationPath,
} from "../../project-intelligence/work-scope.js";
import type { ToolEntry } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";

export interface ProjectWorkMutationGuard {
  workId: string;
  paths: string[];
}

export async function enforceProjectWorkMutationScope(
  deps: ToolExecutorDeps,
  entry: ToolEntry,
  input: unknown,
  traceContext: TraceContext,
): Promise<ProjectWorkMutationGuard | undefined> {
  if (!entry.resolveWorkspaceMutation) return undefined;

  const descriptor = entry.resolveWorkspaceMutation(input, {
    workingDirectory: deps.getWorkingDirectory(),
    workspaceRoot: deps.getWorkspaceRoot(),
  });
  if (!descriptor || descriptor.kind === "opaque") return undefined;
  if (descriptor.targets.length === 0) {
    throw scopeError(entry, "Structured workspace mutation declared no target paths");
  }

  const rootDir = deps.getProjectIntelligenceRoot?.();
  const fileSystemPort = deps.fileSystemPort;
  if (!rootDir || !fileSystemPort) return undefined;

  let current;
  try {
    current = await readProjectWorkState(fileSystemPort, rootDir, traceContext);
  } catch (cause) {
    throw scopeError(
      entry,
      "Project Work state cannot be read safely; structured mutation blocked",
      {
        cause,
      },
    );
  }

  const work = current.state.work;
  if (!work) return undefined;
  if (work.status !== "active") {
    throw scopeError(entry, `Project Work ${work.id} is paused; structured mutation blocked`, {
      workId: work.id,
    });
  }

  const paths = descriptor.targets.map((target) => {
    let path: string;
    try {
      path = resolveProjectWorkMutationPath({
        inputPath: target.path,
        workingDirectory: deps.getWorkingDirectory(),
        workspaceRoot: deps.getWorkspaceRoot(),
      });
    } catch (cause) {
      throw scopeError(
        entry,
        "Structured mutation target is outside the active Project Work scope",
        {
          cause,
          targetPath: target.path,
          workId: work.id,
        },
      );
    }
    if (!isProjectWorkPathAllowed(path, work.scope)) {
      throw scopeError(
        entry,
        `Structured mutation target is outside the active Project Work scope: ${path}`,
        {
          operation: target.operation,
          targetPath: path,
          workId: work.id,
        },
      );
    }
    return path;
  });

  return { workId: work.id, paths };
}

export async function recordSuccessfulProjectWorkMutation(
  deps: ToolExecutorDeps,
  guard: ProjectWorkMutationGuard | undefined,
  traceContext: TraceContext,
): Promise<void> {
  if (!guard || guard.paths.length === 0) return;
  const rootDir = deps.getProjectIntelligenceRoot?.();
  const fileSystemPort = deps.fileSystemPort;
  if (!rootDir || !fileSystemPort) return;

  try {
    const current = await readProjectWorkState(fileSystemPort, rootDir, traceContext);
    const mutation = recordObservedProjectWorkMutation(current.state, guard.workId, guard.paths);
    if (!mutation.changed) return;
    await writeProjectWorkState(fileSystemPort, rootDir, mutation.state, {
      expectedRevision: current.revision,
      traceContext,
    });
  } catch (error) {
    // The repository mutation has already succeeded. Operational bookkeeping must never
    // pretend to roll it back; leave the failure observable and continue with the real result.
    deps.logger?.warn("Project Work mutation bookkeeping failed", {
      ...traceContextToLogContext(traceContext),
      event: "project_work.mutation_bookkeeping.failed",
      module: "core.tool.executor",
      reason: error instanceof Error ? error.message : "unknown error",
      workId: guard.workId,
    });
  }
}

function scopeError(
  entry: ToolEntry,
  message: string,
  details: { cause?: unknown; targetPath?: string; operation?: string; workId?: string } = {},
) {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, {
    context: {
      code: "project_work_scope_blocked",
      toolName: entry.metadata.name,
      ...(details.targetPath ? { targetPath: details.targetPath } : {}),
      ...(details.operation ? { operation: details.operation } : {}),
      ...(details.workId ? { workId: details.workId } : {}),
    },
    recoverable: true,
    ...(details.cause instanceof Error ? { cause: details.cause } : {}),
  });
}
