import type { Model, ModelToolChoice, ModelToolContract } from "@zcode/contracts";
import type { ToolRegistry } from "./registry.js";
import type { ToolEntry } from "./types.js";

export const TOOL_SEARCH_NAME = "ToolSearch";
export const MAX_DISCOVERY_RESULTS = 5;
export const MAX_RECENT_EXPOSED_TOOLS = 8;

export interface ToolSearchMatch {
  name: string;
  purpose: string;
  capability?: string;
}

export interface ToolSearchOutput {
  matches: ToolSearchMatch[];
}

const BASELINE_NAMES = new Set([
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "Skill",
  "AskUserQuestion",
  "Agent",
  "Task",
  "TodoWrite",
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskOutput",
  "TaskStop",
  "SendMessage",
  TOOL_SEARCH_NAME,
]);

const CONTROL_NAMES = new Set(["RespondToCoordinator", "submit_result", "escalate"]);

/** Lexical lookup over live registry metadata; no schema or handler is copied into an index. */
export function searchRegisteredTools(
  registry: ToolRegistry,
  query: string,
  limit = MAX_DISCOVERY_RESULTS,
  eligibleNames?: ReadonlySet<string>,
): ToolSearchOutput {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return { matches: [] };
  const terms = tokenize(normalized).filter((term) => !QUERY_STOP_WORDS.has(term));
  if (terms.length === 0) return { matches: [] };
  const ranked = registry.list().flatMap((name, order) => {
    const entry = registry.get(name);
    if (
      !entry ||
      entry.metadata.providerVisible === false ||
      (eligibleNames !== undefined && !eligibleNames.has(name)) ||
      BASELINE_NAMES.has(name) ||
      CONTROL_NAMES.has(name)
    )
      return [];
    const score = rank(entry, normalized, terms);
    if (score === undefined) return [];
    return [{ entry, order, score }];
  });
  ranked.sort(
    (a, b) =>
      a.score - b.score ||
      a.order - b.order ||
      a.entry.metadata.name.localeCompare(b.entry.metadata.name),
  );
  return {
    matches: ranked
      .slice(0, Math.min(MAX_DISCOVERY_RESULTS, Math.max(1, limit)))
      .map(({ entry }) => ({
        name: entry.metadata.name,
        purpose: shorten(entry.metadata.description ?? entry.capability ?? "Registered tool", 120),
        ...(entry.capability ? { capability: shorten(entry.capability, 100) } : {}),
      })),
  };
}

function rank(entry: ToolEntry, query: string, terms: string[]): number | undefined {
  const name = entry.metadata.name.toLowerCase();
  if (name === query) return 0;
  const nameWords = tokenize(entry.metadata.name);
  if (
    name.startsWith(query) ||
    terms.every((term) => nameWords.some((word) => word.startsWith(term)))
  )
    return 1;
  const capability = (entry.capability ?? "").toLowerCase();
  if (terms.every((term) => capability.includes(term))) return 2;
  const capabilityWords = tokenize(capability);
  const firstCapabilityMatch = terms.findIndex((term) =>
    capabilityWords.some((word) => word.startsWith(term)),
  );
  if (firstCapabilityMatch >= 0) return 3 + firstCapabilityMatch / 10;
  const description = (entry.metadata.description ?? "").toLowerCase();
  if (terms.every((term) => description.includes(term))) return 4;
  // A multiword natural-language query can still identify tools by its most
  // specific words; common filler words must not hide registered capabilities.
  const searchableWords = new Set(
    tokenize(
      `${entry.metadata.name} ${entry.capability ?? ""} ${entry.metadata.description ?? ""}`,
    ),
  );
  const matchedTerms = terms.filter((term) => term.length >= 4 && searchableWords.has(term));
  if (matchedTerms.length >= Math.min(2, terms.length)) return 5;
  return undefined;
}

const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "capability",
  "does",
  "find",
  "for",
  "need",
  "not",
  "that",
  "the",
  "tool",
  "tools",
  "to",
  "use",
]);

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function shorten(value: string, max: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, max);
}

export function createToolSearchEntry(
  registry: ToolRegistry,
  getEligibleNames?: (model?: Model) => ReadonlySet<string>,
): ToolEntry {
  return {
    capability: "Find additional registered tools by name or purpose",
    metadata: {
      name: TOOL_SEARCH_NAME,
      description:
        "Find registered tools not currently shown. Search by capability; matching tool schemas become available in the next model step.",
      admissionPriority: "mandatory",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      timeoutMs: 30000,
      maxOutputBytes: 4096,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 160, description: "Capability or tool name to find" },
        limit: { type: "integer", minimum: 1, maximum: MAX_DISCOVERY_RESULTS },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { matches: { type: "array" } },
      required: ["matches"],
    },
    handler: async (input, context) => {
      const request = input as { query: string; limit?: number };
      return searchRegisteredTools(
        registry,
        request.query,
        request.limit,
        getEligibleNames?.(context.model),
      );
    },
    permission: {
      permission: "tool.search",
      reason: "Searches registered tool metadata without executing a matched tool",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: 4096,
      maxModelBytes: 4096,
      strategy: "truncate",
      preview: { maxBytes: 4096, direction: "head" },
    },
    timeout: { defaultMs: 30000, maxMs: 30000, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "Tool search was cancelled",
    },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}

export function exposeToolsForModelStep(input: {
  candidates: readonly ModelToolContract[];
  recentNames: readonly string[];
  toolChoice?: ModelToolChoice;
  complete?: boolean;
}): ModelToolContract[] {
  if (input.complete) return [...input.candidates];
  const selected = getPermanentlyExposedToolNames(input);
  for (const name of input.recentNames) selected.add(name);
  return input.candidates.filter((candidate) => selected.has(candidate.name));
}

export function getPermanentlyExposedToolNames(input: {
  candidates: readonly ModelToolContract[];
  toolChoice?: ModelToolChoice;
  complete?: boolean;
}): Set<string> {
  const requestedName =
    typeof input.toolChoice === "object" && input.toolChoice.type === "tool"
      ? input.toolChoice.toolName
      : undefined;
  if (input.complete) return new Set(input.candidates.map((candidate) => candidate.name));
  const selected = new Set([...BASELINE_NAMES, ...CONTROL_NAMES]);
  if (requestedName) selected.add(requestedName);
  return new Set(
    input.candidates
      .filter((candidate) => selected.has(candidate.name))
      .map((candidate) => candidate.name),
  );
}

export function recordDiscoveredTools(
  recentNames: readonly string[],
  output: unknown,
  registry: ToolRegistry,
  permanentlyExposedNames: ReadonlySet<string>,
): string[] {
  const next: string[] = [];
  for (const name of recentNames) {
    const previous = next.indexOf(name);
    if (previous >= 0) next.splice(previous, 1);
    next.push(name);
  }
  if (next.length > MAX_RECENT_EXPOSED_TOOLS) {
    next.splice(0, next.length - MAX_RECENT_EXPOSED_TOOLS);
  }
  if (
    !output ||
    typeof output !== "object" ||
    !("matches" in output) ||
    !Array.isArray(output.matches)
  )
    return next;
  for (const match of output.matches.slice(0, MAX_DISCOVERY_RESULTS)) {
    if (!match || typeof match !== "object" || typeof match.name !== "string") continue;
    const entry = registry.get(match.name);
    if (
      !entry ||
      entry.metadata.providerVisible === false ||
      permanentlyExposedNames.has(entry.metadata.name)
    )
      continue;
    const previous = next.indexOf(entry.metadata.name);
    if (previous >= 0) next.splice(previous, 1);
    next.push(entry.metadata.name);
    if (next.length > MAX_RECENT_EXPOSED_TOOLS) next.shift();
  }
  return next;
}
