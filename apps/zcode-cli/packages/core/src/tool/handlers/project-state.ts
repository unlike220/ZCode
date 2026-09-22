// ============================================================
// Project State Tool Handlers
// ============================================================

import {
  CoreErrorType,
  ProjectStateReadInputJsonSchema,
  ProjectStateReadInputSchema,
  ProjectStateReadOutputJsonSchema,
  ProjectStateReadOutputSchema,
  ProjectStateUpdateInputJsonSchema,
  ProjectStateUpdateInputSchema,
  ProjectStateUpdateOutputJsonSchema,
  ProjectStateUpdateOutputSchema,
  createCoreError,
  type ProjectStateReadInput,
  type ProjectStateReadOutput,
  type ProjectStateUpdateInput,
  type ProjectStateUpdateOutput,
} from "@zcode/contracts";
import {
  applyProjectStateUpdate,
  readProjectIntelligenceState,
  selectProjectIntelligenceState,
  createEmptyProjectWorkState,
  evaluateProjectCompletion,
  findProjectCompletionContract,
  readProjectCompletionState,
  readProjectWorkState,
  writeProjectIntelligenceState,
} from "../../project-intelligence/index.js";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const MAX_PROJECT_STATE_MODEL_BYTES = 100_000;

const projectStateReadHandler: ToolHandler = async (input, context) => {
  const parsed = ProjectStateReadInputSchema.parse(input) as ProjectStateReadInput;
  const { fileSystemPort, projectIntelligenceRoot } = requireProjectIntelligence(context);
  const { state } = await readProjectIntelligenceState(
    fileSystemPort,
    projectIntelligenceRoot,
    context.traceContext,
  );
  return selectProjectIntelligenceState(state, parsed) satisfies ProjectStateReadOutput;
};

const projectStateUpdateHandler: ToolHandler = async (input, context) => {
  const parsed = ProjectStateUpdateInputSchema.parse(input) as ProjectStateUpdateInput;
  const { fileSystemPort, projectIntelligenceRoot } = requireProjectIntelligence(context);
  const current = await readProjectIntelligenceState(
    fileSystemPort,
    projectIntelligenceRoot,
    context.traceContext,
  );
  await assertCompletionReadyForDoneTransition(parsed, current.state, context);
  const mutation = applyProjectStateUpdate(current.state, parsed);
  await writeProjectIntelligenceState(fileSystemPort, projectIntelligenceRoot, mutation.state, {
    expectedRevision: current.revision,
    traceContext: context.traceContext,
  });
  return mutation.output satisfies ProjectStateUpdateOutput;
};

export const projectStateReadToolEntry: ToolEntry = {
  capability: "Read workspace-scoped structured project tasks, decisions, unknowns, and evidence",
  metadata: {
    name: "ProjectStateRead",
    description:
      "Read relevant structured Project Intelligence for this workspace. Use this before relying on remembered project tasks, decisions, unresolved questions, or evidence.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_PROJECT_STATE_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: projectStateReadHandler,
  inputSchema: ProjectStateReadInputJsonSchema,
  outputSchema: ProjectStateReadOutputJsonSchema,
  runtimeInputSchema: ProjectStateReadInputSchema,
  runtimeOutputSchema: ProjectStateReadOutputSchema,
  permission: {
    permission: "project-state.read",
    reason: "ProjectStateRead only reads ZCode workspace-scoped project metadata",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_PROJECT_STATE_MODEL_BYTES,
    maxModelBytes: MAX_PROJECT_STATE_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_PROJECT_STATE_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30_000,
    maxMs: 30_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ProjectStateRead was cancelled before project state was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const projectStateUpdateToolEntry: ToolEntry = {
  capability:
    "Update one workspace-scoped structured project state record with optimistic concurrency",
  metadata: {
    name: "ProjectStateUpdate",
    description:
      "Create or update one Project Intelligence task, decision, unknown, or evidence record. Read current state first and pass its version as expectedVersion. Stale updates are rejected.",
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_PROJECT_STATE_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: projectStateUpdateHandler,
  inputSchema: ProjectStateUpdateInputJsonSchema,
  outputSchema: ProjectStateUpdateOutputJsonSchema,
  runtimeInputSchema: ProjectStateUpdateInputSchema,
  runtimeOutputSchema: ProjectStateUpdateOutputSchema,
  permission: {
    permission: "project-state.write",
    reason: "ProjectStateUpdate only updates ZCode-owned workspace-scoped project metadata",
    riskLevel: "low",
    sideEffectScope: "workspace",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_PROJECT_STATE_MODEL_BYTES,
    maxModelBytes: MAX_PROJECT_STATE_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_PROJECT_STATE_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30_000,
    maxMs: 30_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ProjectStateUpdate was cancelled before project state was updated",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

async function assertCompletionReadyForDoneTransition(
  input: ProjectStateUpdateInput,
  state: Awaited<ReturnType<typeof readProjectIntelligenceState>>["state"],
  context: ToolExecutionContext,
): Promise<void> {
  if (input.operation !== "upsert_task" || input.task.status !== "done") return;
  const existing = state.tasks.find((task) => task.id === input.task.id);
  if (existing?.status === "done") return;

  const { fileSystemPort, projectIntelligenceRoot } = requireProjectIntelligence(context);
  let completion;
  try {
    completion = await readProjectCompletionState(
      fileSystemPort,
      projectIntelligenceRoot,
      context.traceContext,
    );
  } catch (cause) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `Cannot verify Project Completion state for task ${input.task.id}; done transition blocked`,
      {
        cause: cause instanceof Error ? cause : undefined,
        context: {
          taskId: input.task.id,
          toolCallId: context.toolCallId,
          toolName: "ProjectStateUpdate",
        },
        recoverable: true,
      },
    );
  }
  const contract = findProjectCompletionContract(completion.state, input.task.id);
  if (!contract) return;

  let workState = createEmptyProjectWorkState();
  if (contract.criteria.some((criterion) => criterion.kind === "no_open_project_work")) {
    try {
      workState = (
        await readProjectWorkState(fileSystemPort, projectIntelligenceRoot, context.traceContext)
      ).state;
    } catch (cause) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `Cannot evaluate Project Work criterion for task ${input.task.id}; done transition blocked`,
        {
          cause: cause instanceof Error ? cause : undefined,
          context: {
            taskId: input.task.id,
            toolCallId: context.toolCallId,
            toolName: "ProjectStateUpdate",
          },
          recoverable: true,
        },
      );
    }
  }

  const evaluation = evaluateProjectCompletion(contract, state, workState);
  if (evaluation.status === "ready") return;
  const failed = evaluation.criteria
    .filter((criterion) => criterion.status === "fail")
    .map((criterion) => criterion.id)
    .join(", ");
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `Completion Contract for task ${input.task.id} is not ready${failed ? `; failed criteria: ${failed}` : ""}`,
    {
      context: {
        taskId: input.task.id,
        failedCriteria: failed,
        toolCallId: context.toolCallId,
        toolName: "ProjectStateUpdate",
      },
      recoverable: true,
    },
  );
}

function requireProjectIntelligence(context: ToolExecutionContext) {
  if (!context.fileSystemPort || !context.projectIntelligenceRoot) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Project Intelligence storage is not configured",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "ProjectState",
        },
        recoverable: false,
      },
    );
  }
  return {
    fileSystemPort: context.fileSystemPort,
    projectIntelligenceRoot: context.projectIntelligenceRoot,
  };
}
