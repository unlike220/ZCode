import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  isFileSystemPortError,
  RepositoryFactsSnapshotSchema,
  type FileSystemPort,
  type FileSystemRevision,
  type RepositoryFactsSnapshot,
  type TraceContext,
} from "@zcode/contracts";
import { scanRepository, type RepositoryScanInput } from "./repository-scan.js";

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const refreshes = new Map<string, Promise<unknown>>();
export interface RepositoryStorageInput {
  rootDir: string;
  fileSystemPort: FileSystemPort;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}
export interface RepositoryFactsRead {
  snapshot?: RepositoryFactsSnapshot;
  revision?: FileSystemRevision;
  freshness: "not_indexed" | "unknown" | "stale";
}

export async function readRepositoryFacts(
  input: RepositoryStorageInput,
): Promise<RepositoryFactsRead> {
  input.signal?.throwIfAborted();
  let read;
  try {
    read = await input.fileSystemPort.readTextFile(
      {
        path: join(input.rootDir, "repository-facts.json"),
        maxBytes: MAX_SNAPSHOT_BYTES,
        trace: input.traceContext,
      },
      { signal: input.signal },
    );
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found")
      return { freshness: "not_indexed" };
    throw error;
  }
  if (read.truncated) throw new Error("Repository Facts snapshot exceeds size limit");
  let snapshot: RepositoryFactsSnapshot;
  try {
    snapshot = RepositoryFactsSnapshotSchema.parse(JSON.parse(read.content));
  } catch (cause) {
    throw new Error("Invalid or unsupported Repository Facts snapshot", { cause });
  }
  const token = await readMutationToken(input);
  return {
    snapshot,
    revision: read.revision,
    freshness: token === snapshot.provenance.mutationToken ? "unknown" : "stale",
  };
}

export async function refreshRepositoryFacts(
  input: RepositoryStorageInput & RepositoryScanInput,
): Promise<RepositoryFactsSnapshot> {
  input.signal?.throwIfAborted();
  const previous = refreshes.get(input.rootDir) ?? Promise.resolve();
  const work = previous
    .catch(() => {})
    .then(async () => {
      input.signal?.throwIfAborted();
      const current = await readRepositoryFacts(input);
      const token = await readMutationToken(input);
      const scan = await scanRepository(input);
      const snapshot = RepositoryFactsSnapshotSchema.parse({
        schemaVersion: 1,
        generation: (current.snapshot?.generation ?? 0) + 1,
        indexedAt: new Date().toISOString(),
        ...scan,
        provenance: { ...scan.provenance, ...(token ? { mutationToken: token } : {}) },
      });
      const content = `${JSON.stringify(snapshot)}\n`;
      if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES)
        throw new Error("Repository Facts snapshot exceeds size limit");
      input.signal?.throwIfAborted();
      await input.fileSystemPort.writeTextFile(
        {
          path: join(input.rootDir, "repository-facts.json"),
          content,
          atomic: true,
          createParents: true,
          expectedRevision: current.revision,
          trace: input.traceContext,
        },
        { signal: input.signal },
      );
      return snapshot;
    });
  refreshes.set(input.rootDir, work);
  try {
    return await work;
  } finally {
    if (refreshes.get(input.rootDir) === work) refreshes.delete(input.rootDir);
  }
}

export async function invalidateRepositoryFacts(input: RepositoryStorageInput): Promise<void> {
  input.signal?.throwIfAborted();
  await input.fileSystemPort.writeTextFile(
    {
      path: join(input.rootDir, "repository-facts-invalidation.json"),
      content: `${JSON.stringify(randomUUID())}\n`,
      atomic: true,
      createParents: true,
      trace: input.traceContext,
    },
    { signal: input.signal },
  );
}

async function readMutationToken(input: RepositoryStorageInput): Promise<string | undefined> {
  let read;
  try {
    read = await input.fileSystemPort.readTextFile(
      {
        path: join(input.rootDir, "repository-facts-invalidation.json"),
        maxBytes: 1024,
        trace: input.traceContext,
      },
      { signal: input.signal },
    );
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") return undefined;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(read.content);
    if (read.truncated || typeof value !== "string" || value.length > 128)
      throw new Error("invalid token");
    return value;
  } catch (cause) {
    throw new Error("Invalid Repository Facts invalidation token", { cause });
  }
}
