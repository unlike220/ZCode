import type {
  ProjectDecision,
  ProjectEvidence,
  ProjectIntelligenceState,
  ProjectStateReadOutput,
  ProjectTask,
  ProjectUnknown,
} from "@zcode/contracts";

interface ProjectStateSelectionOptions {
  includeEvidence?: boolean;
  limit?: number;
  query?: string;
}

type PrimaryCandidate =
  | { kind: "task"; item: ProjectTask; score: number }
  | { kind: "decision"; item: ProjectDecision; score: number }
  | { kind: "unknown"; item: ProjectUnknown; score: number };

export function selectProjectIntelligenceState(
  state: ProjectIntelligenceState,
  options: ProjectStateSelectionOptions = {},
): ProjectStateReadOutput {
  const limit = clampLimit(options.limit ?? 12);
  const query = options.query?.trim() ?? "";
  const terms = tokenize(query);

  const candidates: PrimaryCandidate[] = [
    ...state.tasks.map((item) => ({
      kind: "task" as const,
      item,
      score: scoreTask(item, query, terms),
    })),
    ...state.decisions.map((item) => ({
      kind: "decision" as const,
      item,
      score: scoreDecision(item, query, terms),
    })),
    ...state.unknowns.map((item) => ({
      kind: "unknown" as const,
      item,
      score: scoreUnknown(item, query, terms),
    })),
  ];

  const selected = candidates
    .filter((candidate) => query.length === 0 || candidate.score > 0)
    .sort(compareCandidates)
    .slice(0, limit);

  const taskIds = new Set(
    selected.filter((candidate) => candidate.kind === "task").map((candidate) => candidate.item.id),
  );
  const decisionIds = new Set(
    selected
      .filter((candidate) => candidate.kind === "decision")
      .map((candidate) => candidate.item.id),
  );
  const unknownIds = new Set(
    selected
      .filter((candidate) => candidate.kind === "unknown")
      .map((candidate) => candidate.item.id),
  );

  const evidence =
    options.includeEvidence === false
      ? []
      : selectEvidence(state.evidence, {
          decisionIds,
          limit,
          query,
          taskIds,
          terms,
          unknownIds,
        });

  return {
    schemaVersion: state.schemaVersion,
    version: state.version,
    updatedAt: state.updatedAt,
    tasks: selected
      .filter(
        (candidate): candidate is Extract<PrimaryCandidate, { kind: "task" }> =>
          candidate.kind === "task",
      )
      .map((candidate) => candidate.item),
    decisions: selected
      .filter(
        (candidate): candidate is Extract<PrimaryCandidate, { kind: "decision" }> =>
          candidate.kind === "decision",
      )
      .map((candidate) => candidate.item),
    unknowns: selected
      .filter(
        (candidate): candidate is Extract<PrimaryCandidate, { kind: "unknown" }> =>
          candidate.kind === "unknown",
      )
      .map((candidate) => candidate.item),
    evidence,
    summary: {
      tasks: state.tasks.length,
      activeTasks: state.tasks.filter(
        (task) => task.status === "in_progress" || task.status === "blocked",
      ).length,
      decisions: state.decisions.length,
      openUnknowns: state.unknowns.filter(
        (unknown) => unknown.status === "open" || unknown.status === "investigating",
      ).length,
      evidence: state.evidence.length,
    },
  };
}

function scoreTask(item: ProjectTask, query: string, terms: readonly string[]): number {
  const text = searchable([
    item.id,
    item.title,
    item.summary,
    item.tags.join(" "),
    item.relatedPaths.join(" "),
  ]);
  let score = lexicalScore(text, query, terms);
  if (item.status === "in_progress") score += 7;
  if (item.status === "blocked") score += 6;
  if (!query && item.status === "planned") score += 2;
  return score;
}

function scoreDecision(item: ProjectDecision, query: string, terms: readonly string[]): number {
  const text = searchable([
    item.id,
    item.title,
    item.statement,
    item.rationale,
    item.tags.join(" "),
    item.relatedPaths.join(" "),
  ]);
  let score = lexicalScore(text, query, terms);
  if (!query) {
    if (item.status === "accepted") score += 3;
    if (item.status === "proposed") score += 2;
  } else if (score > 0 && item.status === "accepted") {
    score += 1;
  }
  return score;
}

function scoreUnknown(item: ProjectUnknown, query: string, terms: readonly string[]): number {
  const text = searchable([
    item.id,
    item.question,
    item.answer,
    item.blocks.join(" "),
    item.tags.join(" "),
    item.relatedPaths.join(" "),
  ]);
  let score = lexicalScore(text, query, terms);
  if (item.status === "investigating") score += 7;
  if (item.status === "open") score += 6;
  return score;
}

function selectEvidence(
  evidence: readonly ProjectEvidence[],
  input: {
    decisionIds: ReadonlySet<string>;
    limit: number;
    query: string;
    taskIds: ReadonlySet<string>;
    terms: readonly string[];
    unknownIds: ReadonlySet<string>;
  },
): ProjectEvidence[] {
  return evidence
    .map((item) => {
      const selectedSubject =
        (item.subjectType === "repository" && input.query.length === 0) ||
        (item.subjectType === "task" && input.taskIds.has(item.subjectId ?? "")) ||
        (item.subjectType === "decision" && input.decisionIds.has(item.subjectId ?? "")) ||
        (item.subjectType === "unknown" && input.unknownIds.has(item.subjectId ?? ""));
      const text = searchable([item.id, item.reference, item.summary, item.subjectId]);
      const score =
        lexicalScore(text, input.query, input.terms) +
        (selectedSubject ? 8 : 0) +
        (item.kind === "test" || item.kind === "runtime" ? 1 : 0);
      return { item, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || right.item.observedAt.localeCompare(left.item.observedAt),
    )
    .slice(0, input.limit)
    .map((candidate) => candidate.item);
}

function lexicalScore(text: string, query: string, terms: readonly string[]): number {
  if (!query) return 0;
  const normalizedQuery = query.toLocaleLowerCase();
  let score = text.includes(normalizedQuery) ? 12 : 0;
  for (const term of terms) {
    if (text.includes(term)) score += term.length > 5 ? 3 : 2;
  }
  return score;
}

function searchable(values: ReadonlyArray<string | undefined>): string {
  return values.filter(Boolean).join(" ").toLocaleLowerCase();
}

function tokenize(value: string): string[] {
  const matches = value.toLocaleLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
  return [...new Set(matches.filter((term) => term.length > 1))];
}

function compareCandidates(left: PrimaryCandidate, right: PrimaryCandidate): number {
  if (right.score !== left.score) return right.score - left.score;
  return right.item.updatedAt.localeCompare(left.item.updatedAt);
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return 12;
  return Math.max(1, Math.min(50, Math.trunc(value)));
}
