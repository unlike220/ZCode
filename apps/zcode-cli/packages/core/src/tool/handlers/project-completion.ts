import {
  CoreErrorType,
  ProjectCompletionEvaluateInputJsonSchema,
  ProjectCompletionEvaluateInputSchema,
  ProjectCompletionEvaluateOutputJsonSchema,
  ProjectCompletionEvaluateOutputSchema,
  ProjectCompletionReadInputJsonSchema,
  ProjectCompletionReadInputSchema,
  ProjectCompletionReadOutputJsonSchema,
  ProjectCompletionReadOutputSchema,
  ProjectCompletionUpdateInputJsonSchema,
  ProjectCompletionUpdateInputSchema,
  ProjectCompletionUpdateOutputJsonSchema,
  ProjectCompletionUpdateOutputSchema,
  createCoreError,
  type ProjectCompletionEvaluateInput,
  type ProjectCompletionEvaluateOutput,
  type ProjectCompletionReadInput,
  type ProjectCompletionReadOutput,
  type ProjectCompletionUpdateInput,
  type ProjectCompletionUpdateOutput,
} from "@zcode/contracts";
import {
  applyProjectCompletionUpdate,
  createNotConfiguredCompletionEvaluation,
  evaluateProjectCompletion,
  findProjectCompletionContract,
  readProjectCompletionState,
  writeProjectCompletionState,
} from "../../project-intelligence/completion-state.js";
import { readProjectIntelligenceState } from "../../project-intelligence/state.js";
import { readProjectWorkState } from "../../project-intelligence/work-state.js";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const MAX_PROJECT_COMPLETION_MODEL_BYTES = 100_000;

const projectCompletionReadHandler: ToolHandler = async (input, context) => {
  const parsed = ProjectCompletionReadInputSchema.parse(input) as ProjectCompletionReadInput;
  const { fileSystemPort, projectIntelligenceRoot } = requireProjectIntelligence(context);
  const { state } = await readProjectCompletionState(
    fileSystemPort,
    projectIntelligenceRoot,
    context.traceContext,
  );

  const contracts = parsed.taskId
    ? state.contracts.filter((contract) => contract.taskId === parsed.taskId)
    : state.contracts;
  let evaluation: ProjectCompletionReadOutput["evaluation"];
  if (parsed.taskId && parsed.includeEvaluation) {
    evaluation = await evaluateTask(parsed.taskId, state, context);
  }

  return {
    schemaVersion: state.schemaVersion,
    version: state.version,
    updatedAt: state.updatedAt,
    contracts,
    ...(evaluation ? { evaluation } : {}),
  } satisfies ProjectCompletionReadOutput;
};

const projectCompletionUpdateHandler: ToolHandler = async (input, context) => {
  const parsed = ProjectCompletionUpdateInputSchema.parse(input) as ProjectCompletionUpdateInput;
  const { fileSystemPort, projectIntelligenceRoot } = requireProjectIntelligence(context);

  const taskId = parsed.operation === "upsert_contract" ? parsed.contract.taskId : parsed.taskId;
  const project = await readProjectIntelligenceState(
    fileSystemPort,
    projectIntelligenceRoot,
    context.traceContext,
  );
  if (!project.state.tasks.some((task) => task.id === taskId)) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `Project Completion references missing Project Task ${taskId}`,
      {
        context: { taskId, toolCallId: context.toolCallId, toolName: "ProjectCompletionUpdate" },
        recoverable: true,
      },
    );
  }

  const current = await readProjectCompletionState(
    fileSystemPort,
    projectIntelligenceRoot,
    context.traceContext,
  );
  const mutation = applyProjectCompletionUpdate(current.state, parsed);
  await writeProjectCompletionState(fileSystemPort, projectIntelligenceRoot, mutation.state, {
    expectedRevision: current.revision,
    traceContext: context.traceContext,
    signal: context.abortSignal,
  });
  return mutation.output satisfies ProjectCompletionUpdateOutput;
};

const projectCompletionEvaluateHandler: ToolHandler = async (input, context) => {
  const parsed = ProjectCompletionEvaluateInputSchema.parse(
    input,
  ) as ProjectCompletionEvaluateInput;
  const { fileSystemPort, projectIntelligenceRoot } = requireProjectIntelligence(context);
  const project = await readProjectIntelligenceState(
    fileSystemPort,
    projectIntelligenceRoot,
    context.traceContext,
  );
  if (!project.state.tasks.some((task) => task.id === parsed.taskId)) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `Project Completion cannot evaluate missing Project Task ${parsed.taskId}`,
      {
        context: {
          taskId: parsed.taskId,
          toolCallId: context.toolCallId,
          toolName: "ProjectCompletionEvaluate",
        },
        recoverable: true,
      },
    );
  }
  const completion = await readProjectCompletionState(
    fileSystemPort,
    projectIntelligenceRoot,
    context.traceContext,
  );
  const work = await readProjectWorkState(
    fileSystemPort,
    projectIntelligenceRoot,
    context.traceContext,
  );
  const contract = findProjectCompletionContract(completion.state, parsed.taskId);
  return (
    contract
      ? evaluateProjectCompletion(contract, project.state, work.state)
      : createNotConfiguredCompletionEvaluation(parsed.taskId)
  ) satisfies ProjectCompletionEvaluateOutput;
};

async function evaluateTask(
  taskId: string,
  completionState: Awaited<ReturnType<typeof readProjectCompletionState>>["state"],
  context: ToolExecutionContext,
): Promise<ProjectCompletionEvaluateOutput> {
  const { fileSystemPort, projectIntelligenceRoot } = requireProjectIntelligence(context);
  const project = await readProjectIntelligenceState(
    fileSystemPort,
    projectIntelligenceRoot,
    context.traceContext,
  );
  if (!project.state.tasks.some((task) => task.id === taskId)) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `Project Completion cannot evaluate missing Project Task ${taskId}`,
      {
        context: { taskId, toolCallId: context.toolCallId, toolName: "ProjectCompletionRead" },
        recoverable: true,
      },
    );
  }
  const contract = findProjectCompletionContract(completionState, taskId);
  if (!contract) return createNotConfiguredCompletionEvaluation(taskId);
  const work = await readProjectWorkState(
    fileSystemPort,
    projectIntelligenceRoot,
    context.traceContext,
  );
  return evaluateProjectCompletion(contract, project.state, work.state);
}

export const projectCompletionReadToolEntry: ToolEntry = {
  capability: "Read workspace-scoped Project Completion contracts and optional current evaluation",
  metadata: {
    name: "ProjectCompletionRead",
    description:
      "Read Completion Contracts. A contract defines engine-evaluated criteria for a Project Task; evaluation is point-in-time and does not run commands.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_PROJECT_COMPLETION_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: projectCompletionReadHandler,
  inputSchema: ProjectCompletionReadInputJsonSchema,
  outputSchema: ProjectCompletionReadOutputJsonSchema,
  runtimeInputSchema: ProjectCompletionReadInputSchema,
  runtimeOutputSchema: ProjectCompletionReadOutputSchema,
  permission: {
    permission: "project-completion.read",
    reason: "ProjectCompletionRead only reads workspace-scoped completion metadata",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_PROJECT_COMPLETION_MODEL_BYTES,
    maxModelBytes: MAX_PROJECT_COMPLETION_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_PROJECT_COMPLETION_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: 30_000, maxMs: 30_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ProjectCompletionRead was cancelled before completion state was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const projectCompletionUpdateToolEntry: ToolEntry = {
  capability: "Upsert or remove one workspace-scoped Project Completion contract",
  metadata: {
    name: "ProjectCompletionUpdate",
    description:
      "Update a task Completion Contract using optimistic concurrency. Contract changes never mark tasks done.",
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_PROJECT_COMPLETION_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: projectCompletionUpdateHandler,
  inputSchema: ProjectCompletionUpdateInputJsonSchema,
  outputSchema: ProjectCompletionUpdateOutputJsonSchema,
  runtimeInputSchema: ProjectCompletionUpdateInputSchema,
  runtimeOutputSchema: ProjectCompletionUpdateOutputSchema,
  permission: {
    permission: "project-completion.write",
    reason: "ProjectCompletionUpdate only updates ZCode-owned completion policy metadata",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    alwaysAsk: true,
    askOptions: { allowAlways: false },
  },
  resultBudget: {
    maxInlineBytes: MAX_PROJECT_COMPLETION_MODEL_BYTES,
    maxModelBytes: MAX_PROJECT_COMPLETION_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_PROJECT_COMPLETION_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: 30_000, maxMs: 30_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ProjectCompletionUpdate was cancelled before completion state was updated",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const projectCompletionEvaluateToolEntry: ToolEntry = {
  capability: "Evaluate one Project Task against its current Completion Contract",
  metadata: {
    name: "ProjectCompletionEvaluate",
    description:
      "Evaluate current Completion Contract criteria for one task without running commands or mutating task state.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_PROJECT_COMPLETION_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: projectCompletionEvaluateHandler,
  inputSchema: ProjectCompletionEvaluateInputJsonSchema,
  outputSchema: ProjectCompletionEvaluateOutputJsonSchema,
  runtimeInputSchema: ProjectCompletionEvaluateInputSchema,
  runtimeOutputSchema: ProjectCompletionEvaluateOutputSchema,
  permission: {
    permission: "project-completion.evaluate",
    reason:
      "ProjectCompletionEvaluate only reads project metadata and computes a point-in-time result",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_PROJECT_COMPLETION_MODEL_BYTES,
    maxModelBytes: MAX_PROJECT_COMPLETION_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_PROJECT_COMPLETION_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: 30_000, maxMs: 30_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage:
      "ProjectCompletionEvaluate was cancelled before completion criteria were evaluated",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function requireProjectIntelligence(context: ToolExecutionContext) {
  if (!context.fileSystemPort || !context.projectIntelligenceRoot) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Project Intelligence storage is not configured",
      {
        context: { toolCallId: context.toolCallId, toolName: "ProjectCompletion" },
        recoverable: false,
      },
    );
  }
  return {
    fileSystemPort: context.fileSystemPort,
    projectIntelligenceRoot: context.projectIntelligenceRoot,
  };
}
