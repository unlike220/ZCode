import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectWorkUpdateInputSchema } from "@zcode/contracts";
import { NodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import {
  applyProjectWorkUpdate,
  createEmptyProjectWorkState,
  recordObservedProjectWorkMutation,
  readProjectWorkState,
  writeProjectWorkState,
} from "../src/project-intelligence/work-state.js";
import {
  isProjectWorkPathAllowed,
  resolveProjectWorkMutationPath,
} from "../src/project-intelligence/work-scope.js";
import { buildProjectIntelligenceTurnContext } from "../src/project-intelligence/context.js";

test("project work starts empty, begins once, and rejects stale or duplicate begin", () => {
  const initial = createEmptyProjectWorkState("2026-09-22T00:00:00.000Z");
  assert.equal(initial.schemaVersion, 1);
  assert.equal(initial.version, 0);
  assert.equal(initial.work, undefined);

  const begun = applyProjectWorkUpdate(
    initial,
    {
      expectedVersion: 0,
      operation: "begin",
      work: {
        id: "phase-3",
        objective: "Implement controlled coding",
        scope: [{ path: "apps/zcode-cli", recursive: true }],
      },
    },
    "2026-09-22T00:01:00.000Z",
  );
  assert.equal(begun.state.version, 1);
  assert.equal(begun.state.work?.status, "active");
  assert.equal(begun.output.workId, "phase-3");

  assert.throws(
    () =>
      applyProjectWorkUpdate(begun.state, {
        expectedVersion: 0,
        operation: "pause",
      }),
    /version conflict/,
  );
  assert.throws(
    () =>
      applyProjectWorkUpdate(begun.state, {
        expectedVersion: 1,
        operation: "begin",
        work: {
          id: "second",
          objective: "Competing work",
          scope: [{ path: "src", recursive: true }],
        },
      }),
    /already exists/,
  );
});

test("work lifecycle keeps close separate from task completion semantics", () => {
  const begun = applyProjectWorkUpdate(createEmptyProjectWorkState(), {
    expectedVersion: 0,
    operation: "begin",
    work: {
      id: "phase-3",
      taskId: "P3",
      objective: "Controlled coding",
      scope: [{ path: "src", recursive: true }],
    },
  }).state;
  const paused = applyProjectWorkUpdate(begun, {
    expectedVersion: 1,
    operation: "pause",
  }).state;
  assert.equal(paused.work?.status, "paused");
  const resumed = applyProjectWorkUpdate(paused, {
    expectedVersion: 2,
    operation: "resume",
  }).state;
  assert.equal(resumed.work?.status, "active");
  const revised = applyProjectWorkUpdate(resumed, {
    expectedVersion: 3,
    operation: "revise_scope",
    scope: [{ path: "src/runtime", recursive: true }],
  }).state;
  assert.deepEqual(revised.work?.scope, [{ path: "src/runtime", recursive: true }]);
  const closed = applyProjectWorkUpdate(revised, {
    expectedVersion: 4,
    operation: "close",
  });
  assert.equal(closed.state.work, undefined);
  assert.equal(closed.output.status, "none");
});

test("invalid persisted scopes are rejected before work-state mutation", () => {
  for (const path of ["../escape", "/absolute", "src\\\\windows", "C:/drive-path", "src/./file"]) {
    assert.throws(() =>
      ProjectWorkUpdateInputSchema.parse({
        expectedVersion: 0,
        operation: "begin",
        work: {
          id: "invalid",
          objective: "Invalid scope fixture",
          scope: [{ path, recursive: true }],
        },
      }),
    );
  }
});

test("scope matching is exact, recursive, segment aware, and rejects workspace escape", () => {
  assert.equal(
    isProjectWorkPathAllowed("src/exact.ts", [{ path: "src/exact.ts", recursive: false }]),
    true,
  );
  assert.equal(
    isProjectWorkPathAllowed("src/exact.ts/child", [{ path: "src/exact.ts", recursive: false }]),
    false,
  );
  assert.equal(
    isProjectWorkPathAllowed("src/foo/bar.ts", [{ path: "src/foo", recursive: true }]),
    true,
  );
  assert.equal(
    isProjectWorkPathAllowed("src/foobar/bar.ts", [{ path: "src/foo", recursive: true }]),
    false,
  );
  if (process.platform === "win32") {
    assert.equal(
      isProjectWorkPathAllowed("SRC/Foo/File.ts", [{ path: "src/foo", recursive: true }]),
      true,
    );
  }

  const workspaceRoot = process.platform === "win32" ? "C:\\repo" : "/repo";
  const workingDirectory = join(workspaceRoot, "src");
  assert.equal(
    resolveProjectWorkMutationPath({
      inputPath: join(workspaceRoot, "src", "file.ts"),
      workingDirectory,
      workspaceRoot,
    }),
    "src/file.ts",
  );
  assert.throws(
    () =>
      resolveProjectWorkMutationPath({
        inputPath: join(workspaceRoot, "..", "outside.ts"),
        workingDirectory,
        workspaceRoot,
      }),
    /outside the workspace/,
  );
});

test("observed mutation paths are unique and bounded while total observations continue", () => {
  const begun = applyProjectWorkUpdate(createEmptyProjectWorkState(), {
    expectedVersion: 0,
    operation: "begin",
    work: {
      id: "phase-3",
      objective: "Observe mutations",
      scope: [{ path: "src", recursive: true }],
    },
  }).state;
  const first = recordObservedProjectWorkMutation(
    begun,
    "phase-3",
    ["src/a.ts", "src/a.ts", "src/b.ts"],
    "2026-09-22T00:02:00.000Z",
  );
  assert.equal(first.changed, true);
  assert.equal(first.state.work?.observedMutationCount, 3);
  assert.deepEqual(first.state.work?.observedMutationPaths, ["src/a.ts", "src/b.ts"]);

  let state = first.state;
  for (let index = 0; index < 110; index += 1) {
    state = recordObservedProjectWorkMutation(
      state,
      "phase-3",
      [`src/generated-${index}.ts`],
      "2026-09-22T00:03:00.000Z",
    ).state;
  }
  assert.equal(state.work?.observedMutationPaths.length, 100);
  assert.equal(state.work?.observedMutationPathsTruncated, true);
  assert.equal(state.work?.observedMutationCount, 113);
});

test("work state persists independently per Project Intelligence root", async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-work-state-"));
  const firstRoot = join(base, "first");
  const secondRoot = join(base, "second");
  const fileSystemPort = new NodeFileSystemAdapter();
  const state = applyProjectWorkUpdate(createEmptyProjectWorkState(), {
    expectedVersion: 0,
    operation: "begin",
    work: {
      id: "phase-3",
      objective: "Persist controlled work",
      scope: [{ path: "src", recursive: true }],
    },
  }).state;
  await writeProjectWorkState(fileSystemPort, firstRoot, state);

  assert.equal((await readProjectWorkState(fileSystemPort, firstRoot)).state.work?.id, "phase-3");
  assert.equal((await readProjectWorkState(fileSystemPort, secondRoot)).state.work, undefined);
});

test("active work contributes bounded context and missing work contributes nothing", async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-work-context-"));
  const workspaceRoot = join(base, "repo");
  const rootDir = join(base, "metadata");
  await mkdir(workspaceRoot);
  const fileSystemPort = new NodeFileSystemAdapter();

  assert.equal(
    await buildProjectIntelligenceTurnContext({
      fileSystemPort,
      rootDir,
      query: "controlled coding",
    }),
    null,
  );

  const state = applyProjectWorkUpdate(createEmptyProjectWorkState(), {
    expectedVersion: 0,
    operation: "begin",
    work: {
      id: "phase-3",
      objective: "Implement controlled coding mutation scope",
      scope: [
        { path: "apps/zcode-cli/packages/core/src/project-intelligence", recursive: true },
        { path: "apps/zcode-cli/packages/core/src/tool/types.ts", recursive: false },
      ],
    },
  }).state;
  await writeProjectWorkState(fileSystemPort, rootDir, state);
  const context = await buildProjectIntelligenceTurnContext({
    fileSystemPort,
    rootDir,
    query: "controlled coding",
  });
  assert.match(context!, /Project Work/);
  assert.match(context!, /phase-3/);
  assert.match(context!, /not repository truth or completion proof/i);
  assert.ok(context!.length <= 6000);

  await writeFile(join(rootDir, "work-state.json"), "broken");
  const errors: string[] = [];
  assert.equal(
    await buildProjectIntelligenceTurnContext({
      fileSystemPort,
      rootDir,
      query: "controlled coding",
      onProjectionError: (kind) => errors.push(kind),
    }),
    null,
  );
  assert.deepEqual(errors, ["work"]);
});
