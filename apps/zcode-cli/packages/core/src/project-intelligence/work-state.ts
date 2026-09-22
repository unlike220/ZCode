import {
  PROJECT_WORK_MAX_OBSERVED_PATHS,
  ProjectWorkStateSchema,
  type FileSystemPort,
  type FileSystemRevision,
  type ProjectWorkState,
  type ProjectWorkUpdateInput,
  type ProjectWorkUpdateOutput,
  type TraceContext,
  isFileSystemPortError,
} from "@zcode/contracts";
import { join } from "node:path";

const PROJECT_WORK_MAX_BYTES = 512 * 1024;

export interface ProjectWorkReadResult {
  exists: boolean;
  revision?: FileSystemRevision;
  state: ProjectWorkState;
}

export function createEmptyProjectWorkState(now = new Date().toISOString()): ProjectWorkState {
  return {
    schemaVersion: 1,
    version: 0,
    updatedAt: now,
  };
}

export async function readProjectWorkState(
  fileSystemPort: FileSystemPort,
  rootDir: string,
  traceContext?: TraceContext,
): Promise<ProjectWorkReadResult> {
  const path = resolveProjectWorkStatePath(rootDir);
  try {
    const read = await fileSystemPort.readTextFile({
      path,
      maxBytes: PROJECT_WORK_MAX_BYTES,
      trace: traceContext,
    });
    if (read.truncated) {
      throw new Error(`Project Work state exceeds ${PROJECT_WORK_MAX_BYTES} bytes`);
    }
    return {
      exists: true,
      revision: read.revision,
      state: parseProjectWorkState(read.content, path),
    };
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") {
      return { exists: false, state: createEmptyProjectWorkState() };
    }
    throw error;
  }
}

export async function writeProjectWorkState(
  fileSystemPort: FileSystemPort,
  rootDir: string,
  state: ProjectWorkState,
  options: {
    expectedRevision?: FileSystemRevision;
    traceContext?: TraceContext;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  await fileSystemPort.writeTextFile(
    {
      path: resolveProjectWorkStatePath(rootDir),
      content: `${JSON.stringify(ProjectWorkStateSchema.parse(state), null, 2)}\n`,
      createParents: true,
      atomic: true,
      expectedRevision: options.expectedRevision,
      trace: options.traceContext,
    },
    { signal: options.signal },
  );
}

export function applyProjectWorkUpdate(
  state: ProjectWorkState,
  input: ProjectWorkUpdateInput,
  now = new Date().toISOString(),
): { state: ProjectWorkState; output: ProjectWorkUpdateOutput } {
  assertExpectedVersion(state, input.expectedVersion);
  const previousVersion = state.version;
  let work = state.work;

  switch (input.operation) {
    case "begin":
      if (work)
        throw new Error(
          `Project Work ${work.id} already exists; close it before beginning another`,
        );
      work = {
        ...input.work,
        status: "active",
        startedAt: now,
        updatedAt: now,
        observedMutationPaths: [],
        observedMutationCount: 0,
        observedMutationPathsTruncated: false,
      };
      break;
    case "revise_scope":
      work = requireWork(work);
      work = { ...work, scope: input.scope, updatedAt: now };
      break;
    case "pause":
      work = requireWork(work);
      if (work.status !== "active") throw new Error(`Project Work ${work.id} is already paused`);
      work = { ...work, status: "paused", updatedAt: now };
      break;
    case "resume":
      work = requireWork(work);
      if (work.status !== "paused") throw new Error(`Project Work ${work.id} is already active`);
      work = { ...work, status: "active", updatedAt: now };
      break;
    case "close":
      requireWork(work);
      work = undefined;
      break;
  }

  const next = ProjectWorkStateSchema.parse({
    schemaVersion: 1,
    version: previousVersion + 1,
    updatedAt: now,
    ...(work ? { work } : {}),
  });
  return {
    state: next,
    output: {
      previousVersion,
      version: next.version,
      updatedAt: now,
      operation: input.operation,
      ...(work ? { workId: work.id, status: work.status } : { status: "none" }),
    },
  };
}

export function recordObservedProjectWorkMutation(
  state: ProjectWorkState,
  workId: string,
  paths: readonly string[],
  now = new Date().toISOString(),
): { state: ProjectWorkState; changed: boolean } {
  const work = state.work;
  if (!work || work.id !== workId || paths.length === 0) return { state, changed: false };

  const retained = [...work.observedMutationPaths];
  const seen = new Set(retained);
  let truncated = work.observedMutationPathsTruncated;
  for (const path of paths) {
    if (seen.has(path)) continue;
    if (retained.length >= PROJECT_WORK_MAX_OBSERVED_PATHS) {
      truncated = true;
      continue;
    }
    retained.push(path);
    seen.add(path);
  }

  const next = ProjectWorkStateSchema.parse({
    ...state,
    version: state.version + 1,
    updatedAt: now,
    work: {
      ...work,
      updatedAt: now,
      observedMutationPaths: retained,
      observedMutationCount: work.observedMutationCount + paths.length,
      observedMutationPathsTruncated: truncated,
    },
  });
  return { state: next, changed: true };
}

export function resolveProjectWorkStatePath(rootDir: string): string {
  return join(rootDir, "work-state.json");
}

function parseProjectWorkState(content: string, path: string): ProjectWorkState {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (cause) {
    throw new Error(`Invalid Project Work JSON at ${path}`, { cause });
  }
  const parsed = ProjectWorkStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid or unsupported Project Work state at ${path}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function assertExpectedVersion(state: ProjectWorkState, expectedVersion: number): void {
  if (expectedVersion !== state.version) {
    throw new Error(
      `Project Work version conflict: expected ${expectedVersion}, current ${state.version}. Read current work state and retry.`,
    );
  }
}

function requireWork(work: ProjectWorkState["work"]): NonNullable<ProjectWorkState["work"]> {
  if (!work) throw new Error("Project Work has no current work item");
  return work;
}
