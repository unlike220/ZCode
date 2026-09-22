import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { createRootTraceContext, createSessionId, toToolJsonSchema } from "@zcode/contracts";
import { NodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import {
  applyProjectStateUpdate,
  createEmptyProjectIntelligenceState,
  writeProjectIntelligenceState,
} from "../src/project-intelligence/state.js";
import {
  applyProjectWorkUpdate,
  createEmptyProjectWorkState,
  readProjectWorkState,
  writeProjectWorkState,
} from "../src/project-intelligence/work-state.js";
import { createToolExecutor } from "../src/tool/executor/impl.js";
import {
  projectWorkReadToolEntry,
  projectWorkUpdateToolEntry,
} from "../src/tool/handlers/project-work.js";
import { repositoryFactsReadToolEntry } from "../src/tool/handlers/repository-facts.js";
import { editToolEntry } from "../src/tool/handlers/edit.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { writeToolEntry } from "../src/tool/handlers/write.js";
import { ToolRegistryImpl } from "../src/tool/registry.js";
import type { ToolEntry } from "../src/tool/types.js";

const MutationInputSchema = z
  .object({
    paths: z.array(z.string()).min(1),
    fail: z.boolean().optional(),
  })
  .strict();
const MutationOutputSchema = z.object({ ok: z.literal(true) }).strict();

function createMutationEntry(name: string, onRun: () => void): ToolEntry {
  return {
    ...repositoryFactsReadToolEntry,
    capability: "Fixture structured workspace mutation",
    metadata: {
      ...repositoryFactsReadToolEntry.metadata,
      name,
      readOnly: false,
      concurrentSafe: false,
      sideEffectScope: "workspace",
      needsApproval: false,
    },
    permission: {
      ...repositoryFactsReadToolEntry.permission,
      permission: "fixture.project-work.write",
      reason: "Test fixture mutates deterministic workspace paths",
      sideEffectScope: "workspace",
      needsApproval: false,
    },
    inputSchema: toToolJsonSchema(MutationInputSchema),
    outputSchema: toToolJsonSchema(MutationOutputSchema),
    runtimeInputSchema: MutationInputSchema,
    runtimeOutputSchema: MutationOutputSchema,
    resolveWorkspaceMutation: (input) => {
      const parsed = MutationInputSchema.parse(input);
      return {
        kind: "structured_paths",
        targets: parsed.paths.map((path, index) => ({
          path,
          operation:
            parsed.paths.length === 2
              ? index === 0
                ? ("rename_source" as const)
                : ("rename_destination" as const)
              : ("write" as const),
        })),
      };
    },
    handler: async (input) => {
      const parsed = MutationInputSchema.parse(input);
      onRun();
      if (parsed.fail) throw new Error("fixture mutation failed");
      return { ok: true };
    },
  };
}

async function executorFixture() {
  const base = await mkdtemp(join(tmpdir(), "zcode-work-executor-"));
  const workspaceRoot = join(base, "repo");
  const rootDir = join(base, "metadata");
  await mkdir(workspaceRoot);
  await mkdir(join(workspaceRoot, "src"));
  const fileSystemPort = new NodeFileSystemAdapter();
  const registry = new ToolRegistryImpl();
  let runs = 0;
  const mutationEntry = createMutationEntry("FixtureMutation", () => {
    runs += 1;
  });
  registry.register(mutationEntry);
  registry.register(repositoryFactsReadToolEntry);
  const sessionId = createSessionId();
  const traceContext = createRootTraceContext({ sessionId });
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService({
      ...defaultPermissionConfig,
      allowedTools: new Set(["FixtureMutation", "RepositoryFactsRead"]),
    }),
    sessionId,
    traceContext,
    mode: "build",
    workingDirectory: workspaceRoot,
    workspaceRoot,
    fileSystemPort,
    getProjectIntelligenceRoot: () => rootDir,
    emitEvent: async () => {},
  });
  return {
    base,
    workspaceRoot,
    rootDir,
    fileSystemPort,
    registry,
    executor,
    mutationEntry,
    getRuns: () => runs,
  };
}

test("missing work state preserves legacy mutation behavior", async () => {
  const fixture = await executorFixture();
  const result = await fixture.executor.execute({
    id: "legacy",
    name: "FixtureMutation",
    input: { paths: [join(fixture.workspaceRoot, "outside-declared-scope.ts")] },
  });
  assert.equal(result.success, true, result.error?.message);
  assert.equal(fixture.getRuns(), 1);
  assert.equal(
    (await readProjectWorkState(fixture.fileSystemPort, fixture.rootDir)).state.version,
    0,
  );
});

test("central executor blocks out-of-scope structured mutations before handler and records successes", async () => {
  const fixture = await executorFixture();
  const active = applyProjectWorkUpdate(createEmptyProjectWorkState(), {
    expectedVersion: 0,
    operation: "begin",
    work: {
      id: "phase-3",
      objective: "Mutate src only",
      scope: [{ path: "src", recursive: true }],
    },
  }).state;
  await writeProjectWorkState(fixture.fileSystemPort, fixture.rootDir, active);

  const blocked = await fixture.executor.execute({
    id: "blocked",
    name: "FixtureMutation",
    input: { paths: [join(fixture.workspaceRoot, "other", "file.ts")] },
  });
  assert.equal(blocked.success, false);
  assert.match(blocked.error!.message, /outside the active Project Work scope/);
  assert.equal(fixture.getRuns(), 0);

  const allowed = await fixture.executor.execute({
    id: "allowed",
    name: "FixtureMutation",
    input: { paths: [join(fixture.workspaceRoot, "src", "file.ts")] },
  });
  assert.equal(allowed.success, true, allowed.error?.message);
  assert.equal(fixture.getRuns(), 1);
  const after = (await readProjectWorkState(fixture.fileSystemPort, fixture.rootDir)).state;
  assert.deepEqual(after.work?.observedMutationPaths, ["src/file.ts"]);
  assert.equal(after.work?.observedMutationCount, 1);
});

test("all structured targets must be in scope and failed handlers are not recorded", async () => {
  const fixture = await executorFixture();
  const active = applyProjectWorkUpdate(createEmptyProjectWorkState(), {
    expectedVersion: 0,
    operation: "begin",
    work: {
      id: "phase-3",
      objective: "Mutate src only",
      scope: [{ path: "src", recursive: true }],
    },
  }).state;
  await writeProjectWorkState(fixture.fileSystemPort, fixture.rootDir, active);

  const mixed = await fixture.executor.execute({
    id: "mixed",
    name: "FixtureMutation",
    input: {
      paths: [
        join(fixture.workspaceRoot, "src", "from.ts"),
        join(fixture.workspaceRoot, "dest", "to.ts"),
      ],
    },
  });
  assert.equal(mixed.success, false);
  assert.equal(fixture.getRuns(), 0);

  const failed = await fixture.executor.execute({
    id: "failed",
    name: "FixtureMutation",
    input: { paths: [join(fixture.workspaceRoot, "src", "file.ts")], fail: true },
  });
  assert.equal(failed.success, false);
  assert.equal(fixture.getRuns(), 1);
  const after = (await readProjectWorkState(fixture.fileSystemPort, fixture.rootDir)).state;
  assert.equal(after.work?.observedMutationCount, 0);
  assert.deepEqual(after.work?.observedMutationPaths, []);
});

test("paused or corrupt work state fails closed for structured mutations while read-only tools are unaffected", async () => {
  const fixture = await executorFixture();
  const active = applyProjectWorkUpdate(createEmptyProjectWorkState(), {
    expectedVersion: 0,
    operation: "begin",
    work: {
      id: "phase-3",
      objective: "Pause mutations",
      scope: [{ path: "src", recursive: true }],
    },
  }).state;
  const paused = applyProjectWorkUpdate(active, {
    expectedVersion: 1,
    operation: "pause",
  }).state;
  await writeProjectWorkState(fixture.fileSystemPort, fixture.rootDir, paused);

  const pausedResult = await fixture.executor.execute({
    id: "paused",
    name: "FixtureMutation",
    input: { paths: [join(fixture.workspaceRoot, "src", "file.ts")] },
  });
  assert.equal(pausedResult.success, false);
  assert.match(pausedResult.error!.message, /paused/);
  assert.equal(fixture.getRuns(), 0);

  await writeFile(join(fixture.rootDir, "work-state.json"), "broken");
  const corrupt = await fixture.executor.execute({
    id: "corrupt",
    name: "FixtureMutation",
    input: { paths: [join(fixture.workspaceRoot, "src", "file.ts")] },
  });
  assert.equal(corrupt.success, false);
  assert.match(corrupt.error!.message, /Project Work/);
  assert.equal(fixture.getRuns(), 0);

  const readOnly = await fixture.executor.execute({
    id: "read-only",
    name: "RepositoryFactsRead",
    input: {},
  });
  assert.equal(readOnly.success, true, readOnly.error?.message);
});

test("real Write is scope-enforced through the central executor", async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-work-write-"));
  const workspaceRoot = join(base, "repo");
  const rootDir = join(base, "metadata");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  const fileSystemPort = new NodeFileSystemAdapter();
  const state = applyProjectWorkUpdate(createEmptyProjectWorkState(), {
    expectedVersion: 0,
    operation: "begin",
    work: {
      id: "phase-3",
      objective: "Write only under src",
      scope: [{ path: "src", recursive: true }],
    },
  }).state;
  await writeProjectWorkState(fileSystemPort, rootDir, state);

  const registry = new ToolRegistryImpl();
  registry.register(writeToolEntry);
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService(defaultPermissionConfig),
    sessionId: createSessionId(),
    mode: "yolo",
    workingDirectory: workspaceRoot,
    workspaceRoot,
    fileSystemPort,
    getProjectIntelligenceRoot: () => rootDir,
    emitEvent: async () => {},
  });

  const blockedPath = join(workspaceRoot, "outside.ts");
  const blocked = await executor.execute({
    id: "blocked-write",
    name: "Write",
    input: { file_path: blockedPath, content: "blocked" },
  });
  assert.equal(blocked.success, false);
  await assert.rejects(
    readFile(blockedPath, "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );

  const allowedPath = join(workspaceRoot, "src", "allowed.ts");
  const allowed = await executor.execute({
    id: "allowed-write",
    name: "Write",
    input: { file_path: allowedPath, content: "export const allowed = true;\n" },
  });
  assert.equal(allowed.success, true, allowed.error?.message);
  assert.equal(await readFile(allowedPath, "utf8"), "export const allowed = true;\n");
  const after = (await readProjectWorkState(fileSystemPort, rootDir)).state;
  assert.deepEqual(after.work?.observedMutationPaths, ["src/allowed.ts"]);
});

test("Write and Edit publish deterministic structured mutation descriptors", () => {
  const context = {
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
  };
  const write = writeToolEntry.resolveWorkspaceMutation?.(
    { file_path: join(process.cwd(), "a.ts"), content: "x" },
    context,
  );
  const edit = editToolEntry.resolveWorkspaceMutation?.(
    {
      file_path: join(process.cwd(), "b.ts"),
      old_string: "x",
      new_string: "y",
      replace_all: false,
    },
    context,
  );
  assert.equal(write?.kind, "structured_paths");
  assert.equal(edit?.kind, "structured_paths");
  if (write?.kind === "structured_paths") assert.equal(write.targets[0]?.operation, "write");
  if (edit?.kind === "structured_paths") assert.equal(edit.targets[0]?.operation, "edit");
});

test("ProjectWorkUpdate validates linked tasks and close does not change Phase 1 task state", async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-work-tools-"));
  const workspaceRoot = join(base, "repo");
  const rootDir = join(base, "metadata");
  await mkdir(workspaceRoot);
  const fileSystemPort = new NodeFileSystemAdapter();
  const registry = new ToolRegistryImpl();
  registry.register(projectWorkReadToolEntry);
  registry.register(projectWorkUpdateToolEntry);
  const sessionId = createSessionId();
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService({
      ...defaultPermissionConfig,
      allowedTools: new Set(["ProjectWorkRead", "ProjectWorkUpdate"]),
    }),
    sessionId,
    mode: "build",
    workingDirectory: workspaceRoot,
    workspaceRoot,
    fileSystemPort,
    getProjectIntelligenceRoot: () => rootDir,
    emitEvent: async () => {},
  });

  const missing = await executor.execute({
    id: "missing-task",
    name: "ProjectWorkUpdate",
    input: {
      expectedVersion: 0,
      operation: "begin",
      work: {
        id: "phase-3",
        taskId: "P3",
        objective: "Controlled coding",
        scope: [{ path: "src", recursive: true }],
      },
    },
  });
  assert.equal(missing.success, false);
  assert.match(missing.error!.message, /missing Project Task P3/);

  const projectState = applyProjectStateUpdate(createEmptyProjectIntelligenceState(), {
    expectedVersion: 0,
    operation: "upsert_task",
    task: {
      id: "P3",
      title: "Controlled coding",
      status: "in_progress",
      tags: [],
      relatedPaths: [],
    },
  }).state;
  await writeProjectIntelligenceState(fileSystemPort, rootDir, projectState);

  const begun = await executor.execute({
    id: "begin",
    name: "ProjectWorkUpdate",
    input: {
      expectedVersion: 0,
      operation: "begin",
      work: {
        id: "phase-3",
        taskId: "P3",
        objective: "Controlled coding",
        scope: [{ path: "src", recursive: true }],
      },
    },
  });
  assert.equal(begun.success, true, begun.error?.message);

  const closed = await executor.execute({
    id: "close",
    name: "ProjectWorkUpdate",
    input: { expectedVersion: 1, operation: "close" },
  });
  assert.equal(closed.success, true, closed.error?.message);
  assert.equal((await readProjectWorkState(fileSystemPort, rootDir)).state.work, undefined);

  const projectText = await fileSystemPort.readTextFile({ path: join(rootDir, "state.json") });
  assert.match(projectText.content, /"status": "in_progress"/);
  assert.doesNotMatch(projectText.content, /"status": "done"/);
});

test("child registration can read Project Work but cannot update workspace ownership", () => {
  const main: string[] = [];
  const child: string[] = [];
  registerBuiltInTools(
    {
      register: (entry) => main.push(entry.metadata.name),
    },
    { includeProjectStateUpdate: true },
  );
  registerBuiltInTools({
    register: (entry) => child.push(entry.metadata.name),
  });

  assert.ok(main.includes("ProjectWorkRead"));
  assert.ok(main.includes("ProjectWorkUpdate"));
  assert.ok(child.includes("ProjectWorkRead"));
  assert.equal(child.includes("ProjectWorkUpdate"), false);
});
