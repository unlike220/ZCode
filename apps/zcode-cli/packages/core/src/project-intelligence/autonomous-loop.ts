import type {
  FileSystemPort,
  ProjectCompletionEvaluation,
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

export const PROJECT_INTELLIGENCE_STAGNATION_THRESHOLD = 3 as const;

export type ProjectIntelligenceContinuationStopReason =
  | "project_completion_ready"
  | "project_continuation_stagnated"
  | "project_intelligence_state_corrupt";

export type ProjectIntelligenceContinuationAssessment =
  | {
      kind: "legacy";
      reason: "no_linked_project_task" | "no_completion_contract";
    }
  | {
      kind: "governed";
      taskId: string;
      status: "ready" | "not_ready";
      evaluation: ProjectCompletionEvaluation;
      fingerprint: string;
    }
  | {
      kind: "blocked";
      taskId?: string;
      reason: ProjectIntelligenceContinuationStopReason;
      detail: string;
    };

export interface ProjectIntelligenceProgressState {
  fingerprint: string;
  noProgressCount: number;
}

export interface ProjectIntelligenceProgressUpdate {
  state: ProjectIntelligenceProgressState;
  stagnated: boolean;
}

export async function assessProjectIntelligenceContinuation(input: {
  fileSystemPort: FileSystemPort;
  rootDir: string;
  traceContext?: TraceContext;
}): Promise<ProjectIntelligenceContinuationAssessment> {
  let work;
  try {
    work = await readProjectWorkState(input.fileSystemPort, input.rootDir, input.traceContext);
  } catch {
    // 没有可靠的 taskId 就不能把目标归属到 Project Intelligence；保留旧续跑语义，避免猜测归属。
    return { kind: "legacy", reason: "no_linked_project_task" };
  }

  const taskId = work.state.work?.taskId;
  if (!taskId) return { kind: "legacy", reason: "no_linked_project_task" };

  let completion;
  try {
    completion = await readProjectCompletionState(
      input.fileSystemPort,
      input.rootDir,
      input.traceContext,
    );
  } catch (error) {
    return blockedAssessment(taskId, error);
  }

  const contract = findProjectCompletionContract(completion.state, taskId);
  if (!contract) return { kind: "legacy", reason: "no_completion_contract" };

  let project;
  try {
    project = await readProjectIntelligenceState(
      input.fileSystemPort,
      input.rootDir,
      input.traceContext,
    );
  } catch (error) {
    return blockedAssessment(taskId, error);
  }

  if (!project.exists || !project.state.tasks.some((task) => task.id === taskId)) {
    return blockedAssessment(
      taskId,
      new Error(`Project Task ${taskId} is missing from Project State`),
    );
  }

  let evaluation: ProjectCompletionEvaluation;
  try {
    evaluation = evaluateProjectCompletion(contract, project.state, work.state);
  } catch (error) {
    return blockedAssessment(taskId, error);
  }

  return {
    kind: "governed",
    taskId,
    status: evaluation.status === "ready" ? "ready" : "not_ready",
    evaluation,
    fingerprint: createProjectIntelligenceProgressFingerprint({
      completionVersion: completion.state.version,
      evaluation,
      projectState: project.state,
      taskId,
      workState: work.state,
    }),
  };
}

export function updateProjectIntelligenceProgress(
  previous: ProjectIntelligenceProgressState | undefined,
  fingerprint: string,
): ProjectIntelligenceProgressUpdate {
  if (!previous || previous.fingerprint !== fingerprint) {
    return {
      state: { fingerprint, noProgressCount: 0 },
      stagnated: false,
    };
  }

  const noProgressCount = previous.noProgressCount + 1;
  return {
    state: { fingerprint, noProgressCount },
    stagnated: noProgressCount >= PROJECT_INTELLIGENCE_STAGNATION_THRESHOLD,
  };
}

function createProjectIntelligenceProgressFingerprint(input: {
  completionVersion: number;
  evaluation: ProjectCompletionEvaluation;
  projectState: ProjectIntelligenceState;
  taskId: string;
  workState: ProjectWorkState;
}): string {
  const criterionStatuses = input.evaluation.criteria
    .map((criterion) => `${criterion.id}:${criterion.status}`)
    .join(",");
  return [
    input.taskId,
    `project:${input.projectState.version}`,
    `completion:${input.completionVersion}`,
    `work:${input.workState.version}`,
    `mutations:${input.workState.work?.observedMutationCount ?? 0}`,
    `evaluation:${input.evaluation.status}`,
    `criteria:${criterionStatuses}`,
  ].join("|");
}

function blockedAssessment(
  taskId: string,
  error: unknown,
): Extract<ProjectIntelligenceContinuationAssessment, { kind: "blocked" }> {
  return {
    kind: "blocked",
    taskId,
    reason: "project_intelligence_state_corrupt",
    detail:
      error instanceof Error ? error.message : "Project Intelligence state could not be evaluated",
  };
}
