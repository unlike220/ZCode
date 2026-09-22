import {
  ProjectIntelligenceStateSchema,
  type FileSystemPort,
  type FileSystemRevision,
  type ProjectEvidence,
  type ProjectIntelligenceState,
  type ProjectStateUpdateInput,
  type ProjectStateUpdateOutput,
  type TraceContext,
  isFileSystemPortError,
} from "@zcode/contracts";
import { resolveProjectIntelligenceStatePath } from "./path.js";

const PROJECT_STATE_MAX_BYTES = 1024 * 1024;
export const PROJECT_AUTOMATIC_EVIDENCE_MAX_PER_TASK = 100 as const;

export interface ProjectIntelligenceReadResult {
  exists: boolean;
  revision?: FileSystemRevision;
  state: ProjectIntelligenceState;
}

export function createEmptyProjectIntelligenceState(
  now = new Date().toISOString(),
): ProjectIntelligenceState {
  return {
    schemaVersion: 1,
    version: 0,
    updatedAt: now,
    tasks: [],
    decisions: [],
    unknowns: [],
    evidence: [],
  };
}

export async function readProjectIntelligenceState(
  fileSystemPort: FileSystemPort,
  rootDir: string,
  traceContext?: TraceContext,
): Promise<ProjectIntelligenceReadResult> {
  const path = resolveProjectIntelligenceStatePath(rootDir);
  try {
    const read = await fileSystemPort.readTextFile({
      path,
      maxBytes: PROJECT_STATE_MAX_BYTES,
      trace: traceContext,
    });
    if (read.truncated) {
      throw new Error(`Project Intelligence state exceeds ${PROJECT_STATE_MAX_BYTES} bytes`);
    }
    const parsed = parseProjectIntelligenceState(read.content, path);
    return {
      exists: true,
      revision: read.revision,
      state: parsed,
    };
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") {
      return {
        exists: false,
        state: createEmptyProjectIntelligenceState(),
      };
    }
    throw error;
  }
}

export async function writeProjectIntelligenceState(
  fileSystemPort: FileSystemPort,
  rootDir: string,
  state: ProjectIntelligenceState,
  options: {
    expectedRevision?: FileSystemRevision;
    traceContext?: TraceContext;
  } = {},
): Promise<void> {
  const path = resolveProjectIntelligenceStatePath(rootDir);
  const validated = ProjectIntelligenceStateSchema.parse(state);
  assertUniqueIds(validated);
  const content = `${JSON.stringify(validated, null, 2)}\n`;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > PROJECT_STATE_MAX_BYTES) {
    throw new Error(
      `Project Intelligence state would exceed ${PROJECT_STATE_MAX_BYTES} bytes (${bytes})`,
    );
  }
  await fileSystemPort.writeTextFile({
    path,
    content,
    createParents: true,
    atomic: true,
    expectedRevision: options.expectedRevision,
    trace: options.traceContext,
  });
}

export function applyProjectStateUpdate(
  state: ProjectIntelligenceState,
  input: ProjectStateUpdateInput,
  now = new Date().toISOString(),
): { state: ProjectIntelligenceState; output: ProjectStateUpdateOutput } {
  if (input.expectedVersion !== state.version) {
    throw new Error(
      `Project Intelligence version conflict: expected ${input.expectedVersion}, current ${state.version}. Read current state and retry.`,
    );
  }

  const next: ProjectIntelligenceState = {
    ...state,
    version: state.version + 1,
    updatedAt: now,
    tasks: [...state.tasks],
    decisions: [...state.decisions],
    unknowns: [...state.unknowns],
    evidence: [...state.evidence],
  };

  const mutation = (() => {
    switch (input.operation) {
      case "upsert_task": {
        const result = upsertById(next.tasks, { ...input.task, updatedAt: now });
        next.tasks = result.items;
        return { recordId: input.task.id, created: result.created };
      }
      case "upsert_decision": {
        const result = upsertById(next.decisions, { ...input.decision, updatedAt: now });
        next.decisions = result.items;
        return { recordId: input.decision.id, created: result.created };
      }
      case "upsert_unknown": {
        const result = upsertById(next.unknowns, { ...input.unknown, updatedAt: now });
        next.unknowns = result.items;
        return { recordId: input.unknown.id, created: result.created };
      }
      case "upsert_evidence": {
        assertEvidenceSubjectExists(next, input.evidence);
        const existing = next.evidence.find((item) => item.id === input.evidence.id);
        if (existing?.provenance?.source === "automatic_tool") {
          throw new Error(
            `Project Intelligence evidence ${input.evidence.id} is engine-authored automatic evidence and cannot be overwritten through ProjectStateUpdate`,
          );
        }
        const result = upsertById(next.evidence, { ...input.evidence, observedAt: now });
        next.evidence = result.items;
        return { recordId: input.evidence.id, created: result.created };
      }
    }
  })();

  ProjectIntelligenceStateSchema.parse(next);

  return {
    state: next,
    output: {
      previousVersion: state.version,
      version: next.version,
      updatedAt: now,
      operation: input.operation,
      recordId: mutation.recordId,
      created: mutation.created,
    },
  };
}

export function applyAutomaticProjectEvidence(
  state: ProjectIntelligenceState,
  evidence: ProjectEvidence,
  now = new Date().toISOString(),
): { state: ProjectIntelligenceState; changed: boolean } {
  if (evidence.provenance?.source !== "automatic_tool") {
    throw new Error("Automatic Project Evidence requires automatic_tool provenance");
  }
  if (evidence.subjectType !== "task" || !evidence.subjectId) {
    throw new Error("Automatic Project Evidence currently requires a task subject");
  }
  assertEvidenceSubjectExists(state, evidence);

  const existing = state.evidence.find((item) => item.id === evidence.id);
  if (existing) {
    if (
      existing.provenance?.source === "automatic_tool" &&
      existing.provenance.toolCallId === evidence.provenance.toolCallId
    ) {
      return { state, changed: false };
    }
    throw new Error(`Automatic Project Evidence id collision: ${evidence.id}`);
  }

  const sameTaskAutomatic = state.evidence
    .filter(
      (item) =>
        item.subjectType === "task" &&
        item.subjectId === evidence.subjectId &&
        item.provenance?.source === "automatic_tool",
    )
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  const pruneCount = Math.max(
    0,
    sameTaskAutomatic.length - PROJECT_AUTOMATIC_EVIDENCE_MAX_PER_TASK + 1,
  );
  const prunedIds = new Set(sameTaskAutomatic.slice(0, pruneCount).map((item) => item.id));
  const next = ProjectIntelligenceStateSchema.parse({
    ...state,
    version: state.version + 1,
    updatedAt: now,
    evidence: [...state.evidence.filter((item) => !prunedIds.has(item.id)), evidence],
  });
  assertUniqueIds(next);
  return { state: next, changed: true };
}

function parseProjectIntelligenceState(content: string, path: string): ProjectIntelligenceState {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid Project Intelligence JSON at ${path}`, { cause: error });
  }

  const parsed = ProjectIntelligenceStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid or unsupported Project Intelligence state at ${path}: ${parsed.error.message}`,
    );
  }
  assertUniqueIds(parsed.data);
  return parsed.data;
}

function assertUniqueIds(state: ProjectIntelligenceState): void {
  assertUniqueCollectionIds("task", state.tasks);
  assertUniqueCollectionIds("decision", state.decisions);
  assertUniqueCollectionIds("unknown", state.unknowns);
  assertUniqueCollectionIds("evidence", state.evidence);
}

function assertUniqueCollectionIds(kind: string, records: ReadonlyArray<{ id: string }>): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) {
      throw new Error(`Duplicate Project Intelligence ${kind} id: ${record.id}`);
    }
    seen.add(record.id);
  }
}

function upsertById<T extends { id: string }>(
  items: readonly T[],
  value: T,
): { items: T[]; created: boolean } {
  const index = items.findIndex((item) => item.id === value.id);
  if (index < 0) {
    return { items: [...items, value], created: true };
  }
  const next = [...items];
  next[index] = value;
  return { items: next, created: false };
}

function assertEvidenceSubjectExists(
  state: ProjectIntelligenceState,
  evidence: Omit<ProjectEvidence, "observedAt">,
): void {
  if (evidence.subjectType === "repository") return;
  const subjectId = evidence.subjectId;
  const exists =
    evidence.subjectType === "task"
      ? state.tasks.some((item) => item.id === subjectId)
      : evidence.subjectType === "decision"
        ? state.decisions.some((item) => item.id === subjectId)
        : state.unknowns.some((item) => item.id === subjectId);

  if (!exists) {
    throw new Error(
      `Project Intelligence evidence ${evidence.id} references missing ${evidence.subjectType} ${subjectId ?? "<none>"}`,
    );
  }
}
