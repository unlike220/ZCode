export {
  applyAutomaticProjectEvidence,
  applyProjectStateUpdate,
  createEmptyProjectIntelligenceState,
  readProjectIntelligenceState,
  writeProjectIntelligenceState,
  type ProjectIntelligenceReadResult,
} from "./state.js";
export { selectProjectIntelligenceState } from "./relevance.js";
export { buildProjectIntelligenceTurnContext } from "./context.js";
export {
  buildProjectCompletionTurnContext,
  buildRelevantProjectCompletionTurnContext,
} from "./completion-context.js";
export {
  applyProjectCompletionUpdate,
  createEmptyProjectCompletionState,
  createNotConfiguredCompletionEvaluation,
  evaluateProjectCompletion,
  findProjectCompletionContract,
  readProjectCompletionState,
  resolveProjectCompletionStatePath,
  writeProjectCompletionState,
  type ProjectCompletionReadResult,
} from "./completion-state.js";
export { buildProjectWorkTurnContext } from "./work-context.js";
export {
  applyProjectWorkUpdate,
  createEmptyProjectWorkState,
  readProjectWorkState,
  recordObservedProjectWorkMutation,
  resolveProjectWorkStatePath,
  writeProjectWorkState,
  type ProjectWorkReadResult,
} from "./work-state.js";
export { isProjectWorkPathAllowed, resolveProjectWorkMutationPath } from "./work-scope.js";
export { resolveProjectIntelligenceRoot, resolveProjectIntelligenceStatePath } from "./path.js";
export {
  assessProjectIntelligenceContinuation,
  PROJECT_INTELLIGENCE_STAGNATION_THRESHOLD,
  updateProjectIntelligenceProgress,
  type ProjectIntelligenceContinuationAssessment,
  type ProjectIntelligenceContinuationStopReason,
  type ProjectIntelligenceProgressState,
  type ProjectIntelligenceProgressUpdate,
} from "./autonomous-loop.js";
