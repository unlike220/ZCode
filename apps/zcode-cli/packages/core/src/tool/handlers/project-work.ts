import {
  CoreErrorType,
  ProjectWorkReadInputJsonSchema,
  ProjectWorkReadInputSchema,
  ProjectWorkReadOutputJsonSchema,
  ProjectWorkReadOutputSchema,
  ProjectWorkUpdateInputJsonSchema,
  ProjectWorkUpdateInputSchema,
  ProjectWorkUpdateOutputJsonSchema,
  ProjectWorkUpdateOutputSchema,
  createCoreError,
  type ProjectWorkReadOutput,
  type ProjectWorkUpdateInput,
  type ProjectWorkUpdateOutput,
} from "@zcode/contracts";
import {
  applyProjectWorkUpdate,
  readProjectWorkState,
  writeProjectWorkState,
} from "../../project-intelligence/work-state.js";
import { readProjectIntelligenceState } from "../../project-intelligence/state.js";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const MAX_PROJECT_WORK_MODEL_BYTES = 100_000;

const projectWorkReadHandler: ToolHandler = async (input, context) => {
  ProjectWorkReadInputSchema.parse(input);
  const { fileSystemPort, projectIntelligenceRoot } = requireProjectIntelligence(context);
  const { state } = await readProjectWorkState(
    fileSystemPort,
    projectIntelligenceRoot,
    context.traceContext,
  );
  return state satisfies ProjectWorkReadOutput;
};

const projectWorkUpdateHandler: ToolHandler = async (input, context) => {
  const parsed = ProjectWorkUpdateInputSchema.parse(input) as ProjectWorkUpdateInput;
  const { fileSystemPort, projectIntelligenceRoot } = requireProjectIntelligence(context);

  if (parsed.operation === "begin" && parsed.work.taskId) {
    const { state } = await readProjectIntelligenceState(
      fileSystemPort,
      projectIntelligenceRoot,
      context.traceContext,
    );
    if (!state.tasks.some((task) => task.id === parsed.work.taskId)) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `Project Work references missing Project Task ${parsed.work.taskId}`,
        {
          context: {
            taskId: parsed.work.taskId,
            toolCallId: context.toolCallId,
            toolName: "ProjectWorkUpdate",
          },
          recoverable: true,
        },
      );
    }
  }

  const current = await readProjectWorkState(
    fileSystemPort,
    projectIntelligenceRoot,
    context.traceContext,
  );
  const mutation = applyProjectWorkUpdate(current.state, parsed);
  await writeProjectWorkState(fileSystemPort, projectIntelligenceRoot, mutation.state, {
    expectedRevision: current.revision,
    traceContext: context.traceContext,
    signal: context.abortSignal,
  });
  return mutation.output satisfies ProjectWorkUpdateOutput;
};

export const projectWorkReadToolEntry: ToolEntry = {
  capability: "Read the workspace-scoped controlled-coding work intent and mutation scope",
  metadata: {
    name: "ProjectWorkRead",
    description:
      "Read the current controlled-coding work intent, allowed mutation scope, and bounded observed structured mutation paths for this workspace.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_PROJECT_WORK_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: projectWorkReadHandler,
  inputSchema: ProjectWorkReadInputJsonSchema,
  outputSchema: ProjectWorkReadOutputJsonSchema,
  runtimeInputSchema: ProjectWorkReadInputSchema,
  runtimeOutputSchema: ProjectWorkReadOutputSchema,
  permission: {
    permission: "project-work.read",
    reason: "ProjectWorkRead only reads ZCode-owned workspace-scoped operational metadata",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_PROJECT_WORK_MODEL_BYTES,
    maxModelBytes: MAX_PROJECT_WORK_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_PROJECT_WORK_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: 30_000, maxMs: 30_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ProjectWorkRead was cancelled before work state was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const projectWorkUpdateToolEntry: ToolEntry = {
  capability:
    "Begin, revise, pause, resume, or close one workspace-scoped controlled-coding work intent",
  metadata: {
    name: "ProjectWorkUpdate",
    description:
      "Update controlled-coding work intent with optimistic concurrency. Scope limits supported structured repository mutations but never grants permission or proves completion.",
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_PROJECT_WORK_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: projectWorkUpdateHandler,
  inputSchema: ProjectWorkUpdateInputJsonSchema,
  outputSchema: ProjectWorkUpdateOutputJsonSchema,
  runtimeInputSchema: ProjectWorkUpdateInputSchema,
  runtimeOutputSchema: ProjectWorkUpdateOutputSchema,
  permission: {
    permission: "project-work.write",
    reason: "ProjectWorkUpdate only updates ZCode-owned workspace-scoped operational metadata",
    riskLevel: "low",
    sideEffectScope: "workspace",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_PROJECT_WORK_MODEL_BYTES,
    maxModelBytes: MAX_PROJECT_WORK_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_PROJECT_WORK_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: 30_000, maxMs: 30_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ProjectWorkUpdate was cancelled before work state was updated",
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
        context: {
          toolCallId: context.toolCallId,
          toolName: "ProjectWork",
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
