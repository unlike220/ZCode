import type { FileSystemPort, TraceContext } from "@zcode/contracts";
import { readProjectIntelligenceState } from "./state.js";
import { selectProjectIntelligenceState } from "./relevance.js";
import { buildRepositoryFactsTurnContext } from "./repository-context.js";
import { buildProjectWorkTurnContext } from "./work-context.js";

const DEFAULT_PROJECT_CONTEXT_CHAR_BUDGET = 6_000;

interface ProjectContextInput {
  fileSystemPort: FileSystemPort;
  query: string;
  rootDir: string;
  traceContext?: TraceContext;
  maxChars?: number;
  onProjectionError?: (kind: "state" | "repository" | "work", error: unknown) => void;
}

export async function buildProjectIntelligenceTurnContext(
  input: ProjectContextInput,
): Promise<string | null> {
  // Preserve the established Phase 1 -> Phase 2 projection/error order. Project Work is
  // independently read between them, then prioritized in the final bounded projection.
  const project = await buildProjectStateContext(input).catch((error: unknown) => {
    input.onProjectionError?.("state", error);
    return null;
  });
  const work = await buildProjectWorkTurnContext(input).catch((error: unknown) => {
    input.onProjectionError?.("work", error);
    return null;
  });
  const facts = await buildRepositoryFactsTurnContext(input).catch((error: unknown) => {
    input.onProjectionError?.("repository", error);
    return null;
  });
  if (!work && !project && !facts) return null;

  const budget = normalizeBudget(input.maxChars);
  const reservedChars = (work?.length ?? 0) + (facts?.length ?? 0) + (work && facts ? 4 : 0);
  const stateBudget = Math.max(1_000, budget - reservedChars);
  // Current controlled work is highest-priority operational context. The final hard budget
  // remains authoritative when callers request an unusually small projection.
  return truncateContext(
    [work, project ? truncateContext(project, stateBudget) : null, facts]
      .filter(Boolean)
      .join("\n\n"),
    budget,
  );
}

async function buildProjectStateContext(input: ProjectContextInput): Promise<string | null> {
  const { state } = await readProjectIntelligenceState(
    input.fileSystemPort,
    input.rootDir,
    input.traceContext,
  );
  if (
    state.tasks.length === 0 &&
    state.decisions.length === 0 &&
    state.unknowns.length === 0 &&
    state.evidence.length === 0
  ) {
    return null;
  }

  const selected = selectProjectIntelligenceState(state, {
    query: input.query,
    limit: 10,
    includeEvidence: true,
  });
  const lines = [
    "# Project Intelligence",
    "",
    `Workspace state version: ${selected.version}`,
    "Treat this as structured project state, not repository truth. Verify source/runtime facts with their original evidence before changing code.",
  ];

  if (selected.tasks.length > 0) {
    lines.push("", "## Relevant tasks");
    for (const task of selected.tasks) {
      lines.push(
        `- [${task.status}] ${task.id}: ${task.title}${task.summary ? ` — ${compact(task.summary)}` : ""}`,
      );
    }
  }

  if (selected.decisions.length > 0) {
    lines.push("", "## Relevant decisions");
    for (const decision of selected.decisions) {
      lines.push(
        `- [${decision.status}] ${decision.id}: ${decision.title} — ${compact(decision.statement)}`,
      );
    }
  }

  if (selected.unknowns.length > 0) {
    lines.push("", "## Relevant unknowns");
    for (const unknown of selected.unknowns) {
      lines.push(
        `- [${unknown.status}] ${unknown.id}: ${compact(unknown.question)}${unknown.answer ? ` — answer: ${compact(unknown.answer)}` : ""}`,
      );
    }
  }

  if (selected.evidence.length > 0) {
    lines.push("", "## Evidence pointers");
    for (const evidence of selected.evidence) {
      const subject =
        evidence.subjectType === "repository"
          ? "repository"
          : `${evidence.subjectType}:${evidence.subjectId ?? "?"}`;
      lines.push(
        `- ${evidence.id} [${evidence.kind}] ${subject}: ${compact(evidence.reference)}${evidence.summary ? ` — ${compact(evidence.summary)}` : ""}`,
      );
    }
  }

  const budget = normalizeBudget(input.maxChars);
  return truncateContext(lines.join("\n"), budget);
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PROJECT_CONTEXT_CHAR_BUDGET;
  return Math.max(1_000, Math.min(20_000, Math.trunc(value)));
}

function truncateContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const suffix = "\n… Project Intelligence projection truncated";
  return `${value.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}
