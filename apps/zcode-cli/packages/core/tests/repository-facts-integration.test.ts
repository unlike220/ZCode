import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import { NodeExecutionAdapter } from "../../adapters/src/exec/index.js";
import { createRootTraceContext, type FileSystemPort } from "@zcode/contracts";
import {
  readRepositoryFacts,
  refreshRepositoryFacts,
  invalidateRepositoryFacts,
} from "../src/project-intelligence/repository-store.js";
import { buildProjectIntelligenceTurnContext } from "../src/project-intelligence/context.js";
import {
  applyProjectStateUpdate,
  createEmptyProjectIntelligenceState,
  writeProjectIntelligenceState,
} from "../src/project-intelligence/state.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { invalidateFactsForTool } from "../src/tool/executor/repository-facts.js";
import {
  repositoryFactsReadToolEntry,
  repositoryFactsRefreshToolEntry,
} from "../src/tool/handlers/repository-facts.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";
import {
  appendRuntimeProjectIntelligenceContext,
  resolveRuntimeProjectIntelligenceRoot,
} from "../src/runtime/helpers/project-intelligence.js";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";
import type { TurnRequestState } from "../src/runtime/methods/turn-loop-state.js";
import { createRuntimeUserEntry } from "../src/agent/message-history.js";

test("runtime projection is turn-local, re-reads later generations, and missing/corrupt facts do not block turns", async () => {
  const input = await fixture();
  const config = { memory: { cliStorageRoot: input.rootDir } } as AgentRuntimeConfig;
  const rootDir = resolveRuntimeProjectIntelligenceRoot(config, input.workspaceRoot)!;
  const history = [createRuntimeUserEntry("AgentRuntime")];
  const runtime = {
    config,
    workspaceRoot: input.workspaceRoot,
    fileSystemPort: input.fileSystemPort,
    messageHistory: {
      addEntries: () => {
        assert.fail("Projection must not modify durable history");
      },
    },
  };
  const first: TurnRequestState = { entries: history, outputTokenContinuationCount: 0 };
  await appendRuntimeProjectIntelligenceContext(runtime, {
    input: "AgentRuntime",
    turnTraceContext: createRootTraceContext(),
    turnRequestState: first,
  });
  assert.equal(first.entries.length, 1);
  await writeFile(join(input.workspaceRoot, "runtime.ts"), "export class AgentRuntime {}");
  await refreshRepositoryFacts({ ...input, rootDir });
  await appendRuntimeProjectIntelligenceContext(runtime, {
    input: "AgentRuntime",
    turnTraceContext: createRootTraceContext(),
    turnRequestState: first,
  });
  assert.equal(first.entries.length, 2);
  assert.equal(history.length, 1);
  assert.match(JSON.stringify(first.entries), /Generation 1/);
  await refreshRepositoryFacts({ ...input, rootDir });
  const second: TurnRequestState = { entries: history, outputTokenContinuationCount: 0 };
  await appendRuntimeProjectIntelligenceContext(runtime, {
    input: "AgentRuntime",
    turnTraceContext: createRootTraceContext(),
    turnRequestState: second,
  });
  assert.match(JSON.stringify(second.entries), /Generation 2/);
  assert.doesNotMatch(JSON.stringify(second.entries), /Generation 1/);
  await writeFile(join(rootDir, "repository-facts.json"), "broken");
  const third: TurnRequestState = { entries: history, outputTokenContinuationCount: 0 };
  await appendRuntimeProjectIntelligenceContext(runtime, {
    input: "AgentRuntime",
    turnTraceContext: createRootTraceContext(),
    turnRequestState: third,
  });
  assert.equal(third.entries.length, 1);
});

test("candidate cap and mid-scan cancellation bound refresh without publishing partial writes", async () => {
  const input = await fixture();
  const mock = Object.create(input.fileSystemPort) as FileSystemPort;
  mock.listDirectory = async () => ({
    path: input.workspaceRoot,
    durationMs: 0,
    numEntries: 2001,
    entries: Array.from({ length: 2001 }, (_, index) => ({
      kind: "file" as const,
      name: `${String(index).padStart(4, "0")}.py`,
      path: join(input.workspaceRoot, `${index}.py`),
    })),
  });
  mock.stat = async (request) => ({ path: request.path, kind: "file", sizeBytes: 1 });
  const snapshot = await refreshRepositoryFacts({ ...input, fileSystemPort: mock });
  assert.equal(snapshot.files.length, 2000);
  assert.equal(snapshot.summary.truncated, true);
  const controller = new AbortController();
  const cancelled = Object.create(input.fileSystemPort) as FileSystemPort;
  await writeFile(join(input.workspaceRoot, "cancel.ts"), "export const cancel = 1;");
  cancelled.readBinaryFile = async (request, options) => {
    const read = await input.fileSystemPort.readBinaryFile(request, options);
    controller.abort();
    return read;
  };
  await assert.rejects(
    refreshRepositoryFacts({ ...input, fileSystemPort: cancelled, signal: controller.signal }),
  );
  assert.equal((await readRepositoryFacts(input)).snapshot?.generation, 1);
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "zcode-facts-integration-"));
  const workspaceRoot = join(base, "repo");
  await mkdir(workspaceRoot);
  return {
    base,
    workspaceRoot,
    rootDir: join(base, "storage"),
    fileSystemPort: new NodeFileSystemAdapter(),
    signal: new AbortController().signal,
  };
}

test("real Git enumerates tracked and untracked, excludes ignored directories, captures provenance", async () => {
  const input = await fixture();
  const executionPort = new NodeExecutionAdapter();
  async function git(...args: string[]) {
    const result = await executionPort.run({
      command: { mode: "argv", file: "git", args },
      cwd: input.workspaceRoot,
    });
    assert.equal(result.exitCode, 0, result.stderr.text);
  }
  await git("init", "-b", "fixture");
  await writeFile(join(input.workspaceRoot, ".gitignore"), "node_modules/\ndist/\n");
  await writeFile(join(input.workspaceRoot, "tracked.ts"), "export const tracked = 1;");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  );
  await mkdir(join(input.workspaceRoot, "node_modules"));
  await mkdir(join(input.workspaceRoot, "dist"));
  await writeFile(
    join(input.workspaceRoot, "node_modules", "ignored.js"),
    "export const ignored = 1;",
  );
  await writeFile(join(input.workspaceRoot, "dist", "ignored.js"), "export const ignored = 1;");
  await writeFile(
    join(input.workspaceRoot, "untracked.ts"),
    'export { tracked } from "./tracked.ts";',
  );
  const snapshot = await refreshRepositoryFacts({ ...input, executionPort });
  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    [".gitignore", "tracked.ts", "untracked.ts"],
  );
  assert.equal(snapshot.provenance.method, "git");
  assert.equal(snapshot.provenance.branch, "fixture");
  assert.match(snapshot.provenance.head!, /^[a-f0-9]{40,64}$/);
  assert.equal(snapshot.provenance.dirty, true);
  assert.equal(snapshot.dependencies[0]?.target, "tracked.ts");
  await executionPort.close();
});

test("directory cap fails closed and symlinks/binary/large files are not parsed", async () => {
  const input = await fixture();
  await writeFile(join(input.workspaceRoot, "a.ts"), "export const a = 1;");
  await writeFile(join(input.workspaceRoot, "binary.ts"), Buffer.from([0, 1, 2]));
  await writeFile(join(input.workspaceRoot, "large.ts"), " ".repeat(256 * 1024 + 1));
  await assert.rejects(
    input.fileSystemPort.listDirectory({ path: input.workspaceRoot, maxEntries: 1 }),
    (error: { code: string }) => error.code === "too_large",
  );
  if (process.platform !== "win32") {
    await writeFile(join(input.base, "outside.ts"), "export class Outside {}");
    await symlink(join(input.base, "outside.ts"), join(input.workspaceRoot, "link.ts"));
  }
  const snapshot = await refreshRepositoryFacts(input);
  assert.deepEqual(
    snapshot.symbols.map((symbol) => symbol.name),
    ["a"],
  );
  assert.equal(
    snapshot.files.some((file) => file.path === "link.ts"),
    false,
  );
  assert.equal(snapshot.files.find((file) => file.path === "binary.ts")?.analysis, "skipped");
  assert.equal(snapshot.files.find((file) => file.path === "large.ts")?.analysis, "skipped");
});

test("a parse failure is isolated and a persistence IO failure propagates", async () => {
  const input = await fixture();
  await writeFile(join(input.workspaceRoot, "bad.ts"), "export class {");
  await writeFile(join(input.workspaceRoot, "good.ts"), "export class Good {}");
  const snapshot = await refreshRepositoryFacts(input);
  assert.equal(snapshot.summary.failed, 1);
  assert.equal(snapshot.files.find((file) => file.path === "bad.ts")?.analysis, "failed");
  assert.deepEqual(
    snapshot.symbols.map((symbol) => symbol.name),
    ["Good"],
  );
  const broken = Object.create(input.fileSystemPort) as FileSystemPort;
  broken.writeTextFile = async () => {
    throw new Error("fixture disk failure");
  };
  await assert.rejects(
    refreshRepositoryFacts({ ...input, fileSystemPort: broken }),
    /fixture disk failure/,
  );
  assert.equal((await readRepositoryFacts(input)).snapshot?.generation, 1);
});

test("refresh admission serializes sessions and cannot erase a concurrent invalidation", async () => {
  const input = await fixture();
  await writeFile(join(input.workspaceRoot, "file.ts"), "export const value = 1;");
  const results = await Promise.all([
    refreshRepositoryFacts(input),
    refreshRepositoryFacts(input),
    refreshRepositoryFacts(input),
  ]);
  assert.deepEqual(
    results.map((snapshot) => snapshot.generation),
    [1, 2, 3],
  );
  const paused = Object.create(input.fileSystemPort) as FileSystemPort;
  paused.readBinaryFile = async (request, options) => {
    await invalidateRepositoryFacts(input);
    return input.fileSystemPort.readBinaryFile(request, options);
  };
  await refreshRepositoryFacts({ ...input, fileSystemPort: paused });
  assert.equal((await readRepositoryFacts(input)).freshness, "stale");
});

test("context failures are independent and projection neither writes nor loses Phase 1", async () => {
  const input = await fixture();
  await writeFile(join(input.workspaceRoot, "context.ts"), "export class ContextBuilder {}");
  await refreshRepositoryFacts(input);
  const state = applyProjectStateUpdate(createEmptyProjectIntelligenceState(), {
    expectedVersion: 0,
    operation: "upsert_task",
    task: {
      id: "P1",
      title: "ContextBuilder task",
      status: "in_progress",
      tags: [],
      relatedPaths: [],
    },
  }).state;
  await writeProjectIntelligenceState(input.fileSystemPort, input.rootDir, state);
  const readonly = Object.create(input.fileSystemPort) as FileSystemPort;
  readonly.writeTextFile = async () => {
    throw new Error("projection must not persist");
  };
  const errors: string[] = [];
  const project = {
    ...input,
    fileSystemPort: readonly,
    query: "ContextBuilder",
    onProjectionError: (kind: string) => {
      errors.push(kind);
    },
  };
  const first = await buildProjectIntelligenceTurnContext(project);
  assert.match(first!, /P1/);
  assert.match(first!, /Repository Facts/);
  assert.ok(first!.length <= 6000);
  await writeFile(join(input.rootDir, "repository-facts.json"), "broken");
  const second = await buildProjectIntelligenceTurnContext(project);
  assert.match(second!, /P1/);
  assert.doesNotMatch(second!, /Repository Facts/);
  assert.deepEqual(errors, ["repository"]);
  await writeFile(join(input.rootDir, "state.json"), "broken");
  assert.equal(await buildProjectIntelligenceTurnContext(project), null);
  assert.deepEqual(errors, ["repository", "state", "repository"]);
});

test("child registration is read-only and resolved mutation capabilities invalidate facts", async () => {
  const main: string[] = [];
  const child: string[] = [];
  registerBuiltInTools(
    {
      register: (entry) => {
        main.push(entry.metadata.name);
      },
    },
    { includeProjectStateUpdate: true },
  );
  registerBuiltInTools({
    register: (entry) => {
      child.push(entry.metadata.name);
    },
  });
  assert.ok(main.includes("RepositoryFactsRefresh"));
  assert.ok(child.includes("RepositoryFactsRead"));
  assert.equal(child.includes("RepositoryFactsRefresh"), false);
  const input = await fixture();
  await refreshRepositoryFacts(input);
  const deps = {
    fileSystemPort: input.fileSystemPort,
    getProjectIntelligenceRoot: () => input.rootDir,
    getWorkspaceRoot: () => input.workspaceRoot,
    getWorkingDirectory: () => input.workspaceRoot,
  } as ToolExecutorDeps;
  const trace = createRootTraceContext();
  await invalidateFactsForTool(deps, repositoryFactsReadToolEntry, {}, trace);
  await invalidateFactsForTool(deps, repositoryFactsRefreshToolEntry, {}, trace);
  assert.equal((await readRepositoryFacts(input)).freshness, "unknown");
  const mutating = {
    ...repositoryFactsRefreshToolEntry,
    metadata: { ...repositoryFactsRefreshToolEntry.metadata, name: "FixtureWrite" },
  };
  await invalidateFactsForTool(deps, mutating, {}, trace);
  assert.equal((await readRepositoryFacts(input)).freshness, "stale");
  assert.ok(await readFile(join(input.rootDir, "repository-facts-invalidation.json"), "utf8"));
});
