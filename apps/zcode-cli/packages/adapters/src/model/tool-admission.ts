import type {
  ModelToolAdmissionPriority,
  ModelToolChoice,
  ModelToolContract,
} from "@zcode/contracts";
import type { ToolSet } from "ai";
import {
  calculateModelRequestBudget,
  estimateProviderVisibleToolsTokens,
  type ModelRequestBudget,
} from "./request-budget.js";

const PRIORITY_RANK: Record<ModelToolAdmissionPriority, number> = {
  mandatory: 0,
  high: 1,
  normal: 2,
  optional: 3,
};

interface AdmissionCandidate {
  name: string;
  tool: ToolSet[string];
  priority: ModelToolAdmissionPriority;
  originalIndex: number;
  estimatedToolTokens: number;
}

export interface ProviderToolAdmissionResult {
  tools: ToolSet | undefined;
  candidateBudget: ModelRequestBudget | undefined;
  admittedBudget: ModelRequestBudget | undefined;
  candidateToolCount: number;
  admittedToolCount: number;
  omittedToolCount: number;
  omittedToolNames: readonly string[];
}

export function admitProviderFacingTools(input: {
  candidateTools: ToolSet | undefined;
  contextWindow: number | undefined;
  messages: readonly unknown[];
  requestedOutputTokens: number | undefined;
  toolChoice?: ModelToolChoice;
  toolContracts?: readonly ModelToolContract[];
}): ProviderToolAdmissionResult {
  const candidateEntries = Object.entries(input.candidateTools ?? {}) as Array<
    [string, ToolSet[string]]
  >;
  const candidateBudget = calculateModelRequestBudget({
    contextWindow: input.contextWindow,
    messages: input.messages,
    requestedOutputTokens: input.requestedOutputTokens,
    tools: input.candidateTools,
  });

  if (candidateEntries.length === 0 || !candidateBudget || candidateBudget.fits) {
    return {
      admittedBudget: candidateBudget,
      admittedToolCount: candidateEntries.length,
      candidateBudget,
      candidateToolCount: candidateEntries.length,
      omittedToolCount: 0,
      omittedToolNames: [],
      tools: input.candidateTools,
    };
  }

  const priorityByName = new Map(
    (input.toolContracts ?? []).map((contract) => [
      contract.name,
      contract.admissionPriority ?? "normal",
    ]),
  );
  const requestMandatoryNames = collectRequestMandatoryToolNames(input.toolChoice);
  const candidates: AdmissionCandidate[] = candidateEntries.map(([name, tool], originalIndex) => ({
    estimatedToolTokens: estimateProviderVisibleToolsTokens({ [name]: tool }),
    name,
    originalIndex,
    priority: requestMandatoryNames.has(name)
      ? "mandatory"
      : (priorityByName.get(name) ?? "normal"),
    tool,
  }));

  const admittedNames = new Set(
    candidates
      .filter((candidate) => candidate.priority === "mandatory")
      .map((candidate) => candidate.name),
  );
  let admittedTools = selectTools(candidateEntries, admittedNames);
  let admittedBudget = calculateModelRequestBudget({
    contextWindow: input.contextWindow,
    messages: input.messages,
    requestedOutputTokens: input.requestedOutputTokens,
    tools: admittedTools,
  });

  // Mandatory means mandatory: if core/request control requirements alone overflow,
  // keep them intact and let Context Fix #1 reject the physical request.
  if (!admittedBudget?.fits) {
    return buildAdmissionResult(candidateEntries, admittedNames, candidateBudget, admittedBudget);
  }

  const remaining = candidates
    .filter((candidate) => candidate.priority !== "mandatory")
    .sort(compareAdmissionCandidates);

  for (const candidate of remaining) {
    const trialNames = new Set(admittedNames);
    trialNames.add(candidate.name);
    const trialTools = selectTools(candidateEntries, trialNames);
    const trialBudget = calculateModelRequestBudget({
      contextWindow: input.contextWindow,
      messages: input.messages,
      requestedOutputTokens: input.requestedOutputTokens,
      tools: trialTools,
    });
    if (!trialBudget?.fits) continue;
    admittedNames.add(candidate.name);
    admittedTools = trialTools;
    admittedBudget = trialBudget;
  }

  if (input.toolChoice === "required" && admittedNames.size === 0 && candidateEntries.length > 0) {
    // Never emit an invalid required-without-tools request. If no candidate can
    // fit, retain the best deterministic candidate and let hard preflight fail.
    const fallback = [...candidates].sort(compareAdmissionCandidates)[0];
    if (fallback) {
      admittedNames.add(fallback.name);
      admittedTools = selectTools(candidateEntries, admittedNames);
      admittedBudget = calculateModelRequestBudget({
        contextWindow: input.contextWindow,
        messages: input.messages,
        requestedOutputTokens: input.requestedOutputTokens,
        tools: admittedTools,
      });
    }
  }

  return buildAdmissionResult(candidateEntries, admittedNames, candidateBudget, admittedBudget);
}

function compareAdmissionCandidates(a: AdmissionCandidate, b: AdmissionCandidate): number {
  const priorityDelta = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priorityDelta !== 0) return priorityDelta;
  const sizeDelta = a.estimatedToolTokens - b.estimatedToolTokens;
  if (sizeDelta !== 0) return sizeDelta;
  return a.originalIndex - b.originalIndex;
}

function collectRequestMandatoryToolNames(toolChoice: ModelToolChoice | undefined): Set<string> {
  const names = new Set<string>();
  if (toolChoice && typeof toolChoice === "object" && toolChoice.type === "tool") {
    names.add(toolChoice.toolName);
  }
  return names;
}

function selectTools(
  candidateEntries: Array<[string, ToolSet[string]]>,
  admittedNames: ReadonlySet<string>,
): ToolSet | undefined {
  const entries = candidateEntries.filter(([name]) => admittedNames.has(name));
  return entries.length > 0 ? (Object.fromEntries(entries) as ToolSet) : undefined;
}

function buildAdmissionResult(
  candidateEntries: Array<[string, ToolSet[string]]>,
  admittedNames: ReadonlySet<string>,
  candidateBudget: ModelRequestBudget | undefined,
  admittedBudget: ModelRequestBudget | undefined,
): ProviderToolAdmissionResult {
  const tools = selectTools(candidateEntries, admittedNames);
  const omittedToolNames = candidateEntries
    .filter(([name]) => !admittedNames.has(name))
    .map(([name]) => name);
  return {
    admittedBudget,
    admittedToolCount: admittedNames.size,
    candidateBudget,
    candidateToolCount: candidateEntries.length,
    omittedToolCount: omittedToolNames.length,
    omittedToolNames,
    tools,
  };
}
