import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  BashInputSchema,
  isFileSystemPortError,
  traceContextToLogContext,
  type ProjectEvidence,
  type ProjectEvidenceKind,
  type TraceContext,
} from "@zcode/contracts";
import {
  applyAutomaticProjectEvidence,
  readProjectIntelligenceState,
  writeProjectIntelligenceState,
} from "../../project-intelligence/state.js";
import { readProjectWorkState } from "../../project-intelligence/work-state.js";
import { analyzeBashCommand } from "../handlers/bash-command-parser.js";
import { readToolExecutionTelemetry } from "../handlers/tool-perf.js";
import type { ToolEntry } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";

const AUTOMATIC_EVIDENCE_STALE_WRITE_RETRIES = 3;

export async function recordAutomaticProjectEvidence(
  deps: ToolExecutorDeps,
  entry: ToolEntry,
  toolCallId: string,
  executionInput: unknown,
  output: unknown,
  traceContext: TraceContext,
): Promise<void> {
  const fileSystemPort = deps.fileSystemPort;
  const rootDir = deps.getProjectIntelligenceRoot?.();
  if (!fileSystemPort || !rootDir) return;

  const observation = resolveAutomaticCommandObservation(
    entry,
    toolCallId,
    executionInput,
    output,
    traceContext,
  );
  if (!observation) return;

  let taskId: string | undefined;
  try {
    const work = await readProjectWorkState(fileSystemPort, rootDir, traceContext);
    taskId = work.state.work?.taskId;
  } catch (error) {
    logCaptureFailure(deps, traceContext, toolCallId, entry.metadata.name, error, "work_read");
    return;
  }
  if (!taskId) return;

  for (let attempt = 0; attempt < AUTOMATIC_EVIDENCE_STALE_WRITE_RETRIES; attempt += 1) {
    let current;
    try {
      current = await readProjectIntelligenceState(fileSystemPort, rootDir, traceContext);
    } catch (error) {
      logCaptureFailure(deps, traceContext, toolCallId, entry.metadata.name, error, "state_read");
      return;
    }

    if (!current.state.tasks.some((task) => task.id === taskId)) {
      deps.logger?.warn("Automatic Project Evidence skipped because linked task is missing", {
        ...traceContextToLogContext(traceContext),
        event: "project_evidence.automatic.skipped",
        module: "core.tool.executor",
        reason: "missing_task",
        taskId,
        toolCallId,
        toolName: entry.metadata.name,
      });
      return;
    }

    const evidence = buildAutomaticProjectEvidence(taskId, observation);
    let mutation;
    try {
      mutation = applyAutomaticProjectEvidence(current.state, evidence, evidence.observedAt);
    } catch (error) {
      logCaptureFailure(deps, traceContext, toolCallId, entry.metadata.name, error, "state_apply");
      return;
    }
    if (!mutation.changed) return;

    try {
      await writeProjectIntelligenceState(fileSystemPort, rootDir, mutation.state, {
        expectedRevision: current.revision,
        traceContext,
      });
      return;
    } catch (error) {
      if (
        isFileSystemPortError(error) &&
        error.code === "stale_write" &&
        attempt + 1 < AUTOMATIC_EVIDENCE_STALE_WRITE_RETRIES
      ) {
        continue;
      }
      logCaptureFailure(deps, traceContext, toolCallId, entry.metadata.name, error, "state_write");
      return;
    }
  }
}

interface AutomaticCommandObservation {
  toolName: string;
  toolCallId: string;
  traceId?: string;
  category: "test" | "git" | "build" | "package" | "network" | "search" | "other";
  evidenceKind: ProjectEvidenceKind;
  safeName?: string;
  hash?: string;
  exitCode?: number;
  observedAt: string;
}

export function resolveAutomaticCommandObservation(
  entry: ToolEntry,
  toolCallId: string,
  executionInput: unknown,
  output: unknown,
  traceContext: TraceContext,
  now = new Date().toISOString(),
): AutomaticCommandObservation | undefined {
  const perf = readToolExecutionTelemetry(output);
  if (perf?.detail?.kind !== "command") return undefined;
  const command = perf.detail.command;
  if (command.status !== "completed") return undefined;
  if (command.exitCode !== undefined && command.exitCode !== 0) return undefined;

  const telemetryCategory = normalizeEvidenceCommandCategory(command.category);
  if (!telemetryCategory) return undefined;
  const evidenceKind = resolveEvidenceKind(entry, executionInput);
  const category = trustedObservationCategory(telemetryCategory, evidenceKind);

  return {
    toolName: entry.metadata.name,
    toolCallId,
    traceId: traceContext.traceId,
    category,
    evidenceKind,
    ...(command.name && command.name !== "empty" ? { safeName: command.name } : {}),
    ...(command.hash ? { hash: command.hash } : {}),
    ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}),
    observedAt: now,
  };
}

function buildAutomaticProjectEvidence(
  taskId: string,
  observation: AutomaticCommandObservation,
): ProjectEvidence {
  const idHash = createHash("sha256")
    .update(taskId)
    .update("\0")
    .update(observation.toolName)
    .update("\0")
    .update(observation.toolCallId)
    .digest("hex")
    .slice(0, 32);
  const kind = observation.evidenceKind;
  const safeIdentity = observation.safeName ? ` via ${observation.safeName}` : "";
  const exit = observation.exitCode !== undefined ? `, exit ${observation.exitCode}` : "";

  return {
    id: `auto-${idHash}`,
    subjectType: "task",
    subjectId: taskId,
    kind,
    reference: `tool-call:${observation.toolCallId}`,
    summary: `Observed successful ${observation.category} command${safeIdentity}${exit}`,
    observedAt: observation.observedAt,
    provenance: {
      source: "automatic_tool",
      toolName: observation.toolName,
      toolCallId: observation.toolCallId,
      ...(observation.traceId ? { traceId: observation.traceId } : {}),
      outcome: "success",
      command: {
        category: observation.category,
        ...(observation.safeName ? { safeName: observation.safeName } : {}),
        ...(observation.hash ? { hash: observation.hash } : {}),
        ...(observation.exitCode !== undefined ? { exitCode: observation.exitCode } : {}),
        status: "completed",
      },
    },
  };
}

function resolveEvidenceKind(entry: ToolEntry, executionInput: unknown): ProjectEvidenceKind {
  if (entry.metadata.name !== "Bash") return "command";
  const parsed = BashInputSchema.safeParse(executionInput);
  if (!parsed.success) return "command";
  const analysis = analyzeBashCommand(parsed.data.command);
  if (
    analysis.hasParseErrors ||
    analysis.hasUnsupportedSyntax ||
    analysis.hasDynamicWords ||
    analysis.commands.length === 0 ||
    analysis.commands.some(
      (command) => command.operatorBefore !== undefined && command.operatorBefore !== "&&",
    )
  ) {
    return "command";
  }
  if (analysis.commands.some((command) => isTrustedTestInvocation(command.name, command.argv))) {
    return "test";
  }
  if (
    analysis.commands.some(
      (command) =>
        basename(command.name).toLowerCase() === "git" && !isHelpOrVersionInvocation(command.argv),
    )
  ) {
    return "git";
  }
  return "command";
}

function isTrustedTestInvocation(name: string, argv: readonly string[]): boolean {
  const executable = basename(name).toLowerCase();
  const args = argv.slice(1).map((value) => value.toLowerCase());
  if (isHelpOrVersionInvocation(argv)) return false;
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    if (args[0] === "test") return true;
    if (args[0] === "run" && args[1] === "test") return true;
    if (args[0] === "exec" && ["vitest", "jest", "pytest"].includes(args[1] ?? "")) return true;
    if (args[0] === "exec" && args[1] === "tsx" && args.includes("--test")) return true;
    return false;
  }
  if (executable === "npx") return ["vitest", "jest", "pytest"].includes(args[0] ?? "");
  if (["vitest", "jest", "pytest"].includes(executable)) return true;
  if (["python", "python3", "py"].includes(executable)) {
    return args[0] === "-m" && ["pytest", "unittest"].includes(args[1] ?? "");
  }
  if (executable === "cargo") return args[0] === "test";
  if (executable === "go") return args[0] === "test";
  if (executable === "dotnet") return args[0] === "test";
  if (["mvn", "mvnw"].includes(executable)) return args.includes("test");
  if (["gradle", "gradlew"].includes(executable)) return args.includes("test");
  if (executable === "make") return args.includes("test");
  if (executable === "node") return args.includes("--test");
  return false;
}

function isHelpOrVersionInvocation(argv: readonly string[]): boolean {
  const args = argv.slice(1).map((value) => value.toLowerCase());
  return args.some((value) => ["--help", "-h", "--version"].includes(value));
}

function trustedObservationCategory(
  telemetryCategory: AutomaticCommandObservation["category"],
  evidenceKind: ProjectEvidenceKind,
): AutomaticCommandObservation["category"] {
  if (evidenceKind === "test") return "test";
  if (evidenceKind === "git") return "git";
  return telemetryCategory === "test" || telemetryCategory === "git" ? "other" : telemetryCategory;
}

function normalizeEvidenceCommandCategory(
  category: string | undefined,
): AutomaticCommandObservation["category"] | undefined {
  switch (category) {
    case "test":
    case "git":
    case "build":
    case "package":
    case "network":
    case "search":
    case "other":
      return category;
    case "empty":
    case undefined:
      return undefined;
    default:
      return "other";
  }
}

function logCaptureFailure(
  deps: ToolExecutorDeps,
  traceContext: TraceContext,
  toolCallId: string,
  toolName: string,
  error: unknown,
  stage: string,
): void {
  deps.logger?.warn("Automatic Project Evidence capture failed after tool observation", {
    ...traceContextToLogContext(traceContext),
    event: "project_evidence.automatic.failed",
    module: "core.tool.executor",
    reason: error instanceof Error ? error.message : "unknown error",
    stage,
    toolCallId,
    toolName,
  });
}
