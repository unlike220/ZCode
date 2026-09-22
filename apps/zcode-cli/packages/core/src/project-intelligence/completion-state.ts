import {
  PROJECT_COMPLETION_MAX_CONTRACTS,
  ProjectCompletionEvaluationSchema,
  ProjectCompletionStateSchema,
  type FileSystemPort,
  type FileSystemRevision,
  type ProjectCompletionContract,
  type ProjectCompletionEvaluation,
  type ProjectCompletionState,
  type ProjectCompletionUpdateInput,
  type ProjectCompletionUpdateOutput,
  type ProjectIntelligenceState,
  type ProjectWorkState,
  type TraceContext,
  isFileSystemPortError,
} from "@zcode/contracts";
import { join } from "node:path";

const PROJECT_COMPLETION_MAX_BYTES = 512 * 1024;

export interface ProjectCompletionReadResult {
  exists: boolean;
  revision?: FileSystemRevision;
  state: ProjectCompletionState;
}

export function createEmptyProjectCompletionState(
  now = new Date().toISOString(),
): ProjectCompletionState {
  return {
    schemaVersion: 1,
    version: 0,
    updatedAt: now,
    contracts: [],
  };
}

export async function readProjectCompletionState(
  fileSystemPort: FileSystemPort,
  rootDir: string,
  traceContext?: TraceContext,
): Promise<ProjectCompletionReadResult> {
  const path = resolveProjectCompletionStatePath(rootDir);
  try {
    const read = await fileSystemPort.readTextFile({
      path,
      maxBytes: PROJECT_COMPLETION_MAX_BYTES,
      trace: traceContext,
    });
    if (read.truncated) {
      throw new Error(`Project Completion state exceeds ${PROJECT_COMPLETION_MAX_BYTES} bytes`);
    }
    return {
      exists: true,
      revision: read.revision,
      state: parseProjectCompletionState(read.content, path),
    };
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") {
      return { exists: false, state: createEmptyProjectCompletionState() };
    }
    throw error;
  }
}

export async function writeProjectCompletionState(
  fileSystemPort: FileSystemPort,
  rootDir: string,
  state: ProjectCompletionState,
  options: {
    expectedRevision?: FileSystemRevision;
    traceContext?: TraceContext;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const content = `${JSON.stringify(ProjectCompletionStateSchema.parse(state), null, 2)}\n`;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > PROJECT_COMPLETION_MAX_BYTES) {
    throw new Error(
      `Project Completion state would exceed ${PROJECT_COMPLETION_MAX_BYTES} bytes (${bytes})`,
    );
  }
  await fileSystemPort.writeTextFile(
    {
      path: resolveProjectCompletionStatePath(rootDir),
      content,
      createParents: true,
      atomic: true,
      expectedRevision: options.expectedRevision,
      trace: options.traceContext,
    },
    { signal: options.signal },
  );
}

export function applyProjectCompletionUpdate(
  state: ProjectCompletionState,
  input: ProjectCompletionUpdateInput,
  now = new Date().toISOString(),
): { state: ProjectCompletionState; output: ProjectCompletionUpdateOutput } {
  assertExpectedVersion(state, input.expectedVersion);
  const previousVersion = state.version;
  let contracts = [...state.contracts];
  let created: boolean | undefined;
  let taskId: string;

  if (input.operation === "upsert_contract") {
    taskId = input.contract.taskId;
    const index = contracts.findIndex((contract) => contract.taskId === taskId);
    created = index < 0;
    const nextContract: ProjectCompletionContract = {
      ...input.contract,
      createdAt: index < 0 ? now : contracts[index]!.createdAt,
      updatedAt: now,
    };
    if (index < 0) {
      if (contracts.length >= PROJECT_COMPLETION_MAX_CONTRACTS) {
        throw new Error(
          `Project Completion contract limit reached (${PROJECT_COMPLETION_MAX_CONTRACTS})`,
        );
      }
      contracts.push(nextContract);
    } else {
      contracts[index] = nextContract;
    }
  } else {
    taskId = input.taskId;
    const index = contracts.findIndex((contract) => contract.taskId === taskId);
    if (index < 0) throw new Error(`Project Completion contract for task ${taskId} does not exist`);
    contracts.splice(index, 1);
  }

  contracts.sort((left, right) => left.taskId.localeCompare(right.taskId));
  const next = ProjectCompletionStateSchema.parse({
    schemaVersion: 1,
    version: previousVersion + 1,
    updatedAt: now,
    contracts,
  });
  return {
    state: next,
    output: {
      previousVersion,
      version: next.version,
      updatedAt: now,
      operation: input.operation,
      taskId,
      ...(created === undefined ? {} : { created }),
    },
  };
}

export function evaluateProjectCompletion(
  contract: ProjectCompletionContract,
  projectState: ProjectIntelligenceState,
  workState: ProjectWorkState,
  now = new Date().toISOString(),
): ProjectCompletionEvaluation {
  const criteria = contract.criteria.map((criterion) => {
    switch (criterion.kind) {
      case "blocking_unknowns_resolved": {
        const blocking = projectState.unknowns.filter(
          (unknown) =>
            unknown.blocks.includes(contract.taskId) &&
            (unknown.status === "open" || unknown.status === "investigating"),
        );
        return {
          id: criterion.id,
          kind: criterion.kind,
          status: blocking.length === 0 ? ("pass" as const) : ("fail" as const),
          summary:
            blocking.length === 0
              ? "No open blocking unknowns"
              : `Open blocking unknowns: ${summarizeIds(blocking.map((item) => item.id))}`,
        };
      }
      case "required_unknowns_resolved": {
        const unresolved: string[] = [];
        const missing: string[] = [];
        for (const unknownId of criterion.unknownIds) {
          const unknown = projectState.unknowns.find((item) => item.id === unknownId);
          if (!unknown) {
            missing.push(unknownId);
            continue;
          }
          if (unknown.status !== "resolved" && unknown.status !== "invalidated") {
            unresolved.push(unknownId);
          }
        }
        const failures = [
          ...(missing.length ? [`missing: ${missing.join(", ")}`] : []),
          ...(unresolved.length ? [`unresolved: ${unresolved.join(", ")}`] : []),
        ];
        return {
          id: criterion.id,
          kind: criterion.kind,
          status: failures.length === 0 ? ("pass" as const) : ("fail" as const),
          summary:
            failures.length === 0
              ? `Required unknowns resolved: ${summarizeIds(criterion.unknownIds)}`
              : `Required unknown check failed (${summarizeTextParts(failures)})`,
        };
      }
      case "task_evidence": {
        const evidenceSource = criterion.evidenceSource ?? "any";
        const matching = projectState.evidence.filter(
          (evidence) =>
            evidence.subjectType === "task" &&
            evidence.subjectId === contract.taskId &&
            criterion.evidenceKinds.includes(evidence.kind) &&
            (evidenceSource === "any" ||
              (evidence.provenance?.source === "automatic_tool" &&
                evidence.provenance.outcome === "success")),
        );
        const passed = matching.length >= criterion.minimumCount;
        return {
          id: criterion.id,
          kind: criterion.kind,
          status: passed ? ("pass" as const) : ("fail" as const),
          summary: `Task evidence ${matching.length}/${criterion.minimumCount} matching kinds: ${criterion.evidenceKinds.join(", ")}; source: ${evidenceSource}`,
        };
      }
      case "no_open_project_work": {
        const linked = workState.work?.taskId === contract.taskId ? workState.work : undefined;
        return {
          id: criterion.id,
          kind: criterion.kind,
          status: linked ? ("fail" as const) : ("pass" as const),
          summary: linked
            ? `Project Work ${linked.id} is still ${linked.status}`
            : "No current Project Work is linked to this task",
        };
      }
    }
  });

  const passed = criteria.filter((criterion) => criterion.status === "pass").length;
  const failed = criteria.length - passed;
  return ProjectCompletionEvaluationSchema.parse({
    taskId: contract.taskId,
    configured: true,
    status: failed === 0 ? "ready" : "not_ready",
    evaluatedAt: now,
    criteria,
    passed,
    failed,
  });
}

export function createNotConfiguredCompletionEvaluation(
  taskId: string,
  now = new Date().toISOString(),
): ProjectCompletionEvaluation {
  return ProjectCompletionEvaluationSchema.parse({
    taskId,
    configured: false,
    status: "not_configured",
    evaluatedAt: now,
    criteria: [],
    passed: 0,
    failed: 0,
  });
}

export function findProjectCompletionContract(
  state: ProjectCompletionState,
  taskId: string,
): ProjectCompletionContract | undefined {
  return state.contracts.find((contract) => contract.taskId === taskId);
}

export function resolveProjectCompletionStatePath(rootDir: string): string {
  return join(rootDir, "completion-contracts.json");
}

function parseProjectCompletionState(content: string, path: string): ProjectCompletionState {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (cause) {
    throw new Error(`Invalid Project Completion JSON at ${path}`, { cause });
  }
  const parsed = ProjectCompletionStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid or unsupported Project Completion state at ${path}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function summarizeIds(values: readonly string[], limit = 20): string {
  const head = values.slice(0, limit).join(", ");
  return values.length <= limit ? head : `${head}, … ${values.length - limit} more`;
}

function summarizeTextParts(values: readonly string[], maxChars = 3_500): string {
  const joined = values.join("; ");
  return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars)}…`;
}

function assertExpectedVersion(state: ProjectCompletionState, expectedVersion: number): void {
  if (expectedVersion !== state.version) {
    throw new Error(
      `Project Completion version conflict: expected ${expectedVersion}, current ${state.version}. Read current completion state and retry.`,
    );
  }
}
