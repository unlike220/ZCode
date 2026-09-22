import type {
  FileSystemPort,
  ProjectIntelligenceState,
  ProjectWorkState,
  TraceContext,
} from "@zcode/contracts";
import {
  evaluateProjectCompletion,
  findProjectCompletionContract,
  readProjectCompletionState,
} from "./completion-state.js";
import { readProjectIntelligenceState } from "./state.js";
import { readProjectWorkState } from "./work-state.js";

const MAX_PROJECT_COMPLETION_CONTEXT_CHARS = 1_600;
const MAX_CONTEXT_CRITERIA = 12;

export async function buildRelevantProjectCompletionTurnContext(input: {
  fileSystemPort: FileSystemPort;
  rootDir: string;
  traceContext?: TraceContext;
}): Promise<string | null> {
  // Project Work and Project State have their own independent context projections/error
  // channels. If either cannot be read, skip completion projection rather than reporting
  // the same upstream corruption again as a completion failure.
  let work;
  try {
    work = await readProjectWorkState(input.fileSystemPort, input.rootDir, input.traceContext);
  } catch {
    return null;
  }
  const taskId = work.state.work?.taskId;
  if (!taskId) return null;
  let project;
  try {
    project = await readProjectIntelligenceState(
      input.fileSystemPort,
      input.rootDir,
      input.traceContext,
    );
  } catch {
    return null;
  }
  return buildProjectCompletionTurnContext({
    ...input,
    taskId,
    projectState: project.state,
    workState: work.state,
  });
}

export async function buildProjectCompletionTurnContext(input: {
  fileSystemPort: FileSystemPort;
  rootDir: string;
  taskId: string;
  projectState: ProjectIntelligenceState;
  workState: ProjectWorkState;
  traceContext?: TraceContext;
}): Promise<string | null> {
  const { state } = await readProjectCompletionState(
    input.fileSystemPort,
    input.rootDir,
    input.traceContext,
  );
  const contract = findProjectCompletionContract(state, input.taskId);
  if (!contract) return null;

  const evaluation = evaluateProjectCompletion(contract, input.projectState, input.workState);
  const lines = [
    "# Completion Contract",
    `Task ${contract.taskId}: ${evaluation.status === "ready" ? "READY" : "NOT READY"}`,
    "This is a point-in-time engine evaluation. task_evidence criteria currently verify structured evidence presence/linkage; automatic execution provenance is deferred to the Evidence Capture phase.",
  ];
  for (const criterion of evaluation.criteria.slice(0, MAX_CONTEXT_CRITERIA)) {
    lines.push(
      `- [${criterion.status === "pass" ? "PASS" : "FAIL"}] ${criterion.id}: ${compact(criterion.summary)}`,
    );
  }
  if (evaluation.criteria.length > MAX_CONTEXT_CRITERIA) {
    lines.push(`- … ${evaluation.criteria.length - MAX_CONTEXT_CRITERIA} more criteria`);
  }
  return truncate(lines.join("\n"), MAX_PROJECT_COMPLETION_CONTEXT_CHARS);
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const suffix = "\n… Completion projection truncated";
  return `${value.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}
