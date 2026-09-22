import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import {
  ProjectIntelligenceStateSchema,
  ProjectStateUpdateInputSchema,
  createFileSystemError,
  createSessionId,
  toToolJsonSchema,
  type FileSystemPort,
  type ProjectEvidence,
  type ProjectIntelligenceState,
} from "@zcode/contracts";
import { NodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import {
  PROJECT_AUTOMATIC_EVIDENCE_MAX_PER_TASK,
  applyAutomaticProjectEvidence,
  applyProjectStateUpdate,
  createEmptyProjectIntelligenceState,
  readProjectIntelligenceState,
  writeProjectIntelligenceState,
} from "../src/project-intelligence/state.js";
import {
  applyProjectWorkUpdate,
  createEmptyProjectWorkState,
  writeProjectWorkState,
} from "../src/project-intelligence/work-state.js";
import { evaluateProjectCompletion } from "../src/project-intelligence/completion-state.js";
import { createToolExecutor } from "../src/tool/executor/impl.js";
import { ToolRegistryImpl } from "../src/tool/registry.js";
import type { ToolEntry } from "../src/tool/types.js";

const FixtureInputSchema = z.object({ command: z.string() }).strict();
const FixtureOutputSchema = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
    perf: z
      .object({
        detail: z
          .object({
            kind: z.literal("command"),
            command: z
              .object({
                category: z.string().optional(),
                name: z.string().optional(),
                hash: z.string().optional(),
                status: z.enum([
                  "completed",
                  "failed",
                  "timed_out",
                  "cancelled",
                  "spawn_error",
                  "backgrounded",
                ]),
                exitCode: z.number().int().optional(),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

function commandEntry(
  options: {
    category?: string;
    status?: "completed" | "failed" | "timed_out" | "cancelled" | "spawn_error" | "backgrounded";
    exitCode?: number;
    name?: string;
  } = {},
): ToolEntry {
  return {
    capability: "Fixture command observation",
    metadata: {
      name: "Bash",
      description: "Produce deterministic command telemetry for automatic evidence tests",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      timeoutMs: 30_000,
      maxOutputBytes: 10_000,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    inputSchema: toToolJsonSchema(FixtureInputSchema),
    outputSchema: toToolJsonSchema(FixtureOutputSchema),
    runtimeInputSchema: FixtureInputSchema,
    runtimeOutputSchema: FixtureOutputSchema,
    handler: async () => ({
      stdout: "RAW_STDOUT_MUST_NOT_BE_EVIDENCE",
      stderr: "RAW_STDERR_MUST_NOT_BE_EVIDENCE",
      perf: {
        detail: {
          kind: "command" as const,
          command: {
            category: options.category ?? "test",
            name: options.name ?? "pnpm",
            hash: "0123456789abcdef",
            status: options.status ?? "completed",
            ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : { exitCode: 0 }),
          },
        },
      },
    }),
    permission: {
      permission: "fixture.command",
      reason: "Fixture command observation",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: 10_000,
      maxModelBytes: 10_000,
      strategy: "truncate",
      preview: { maxBytes: 10_000, direction: "head" },
    },
    timeout: { defaultMs: 30_000, maxMs: 30_000, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "Fixture command cancelled",
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}

function projectWithTask(taskId = "P1"): ProjectIntelligenceState {
  return applyProjectStateUpdate(
    createEmptyProjectIntelligenceState("2026-09-22T00:00:00.000Z"),
    {
      expectedVersion: 0,
      operation: "upsert_task",
      task: {
        id: taskId,
        title: "Automatic evidence task",
        status: "in_progress",
        tags: [],
        relatedPaths: [],
      },
    },
    "2026-09-22T00:00:00.000Z",
  ).state;
}

function automaticEvidence(
  id: string,
  taskId = "P1",
  observedAt = "2026-09-22T00:00:00.000Z",
): ProjectEvidence {
  return {
    id,
    subjectType: "task",
    subjectId: taskId,
    kind: "test",
    reference: `tool-call:${id}`,
    summary: "Observed successful test command via pnpm, exit 0",
    observedAt,
    provenance: {
      source: "automatic_tool",
      toolName: "Bash",
      toolCallId: id,
      outcome: "success",
      command: {
        category: "test",
        safeName: "pnpm",
        hash: "0123456789abcdef",
        exitCode: 0,
        status: "completed",
      },
    },
  };
}

async function fixture(
  options: {
    entry?: ToolEntry;
    linkedTask?: boolean;
    fileSystemPort?: FileSystemPort;
  } = {},
) {
  const base = await mkdtemp(join(tmpdir(), "zcode-auto-evidence-"));
  const workspaceRoot = join(base, "repo");
  const rootDir = join(base, "metadata");
  await mkdir(workspaceRoot);
  const baseFs = new NodeFileSystemAdapter();
  const fileSystemPort = options.fileSystemPort ?? baseFs;
  await writeProjectIntelligenceState(baseFs, rootDir, projectWithTask());
  if (options.linkedTask !== false) {
    const work = applyProjectWorkUpdate(createEmptyProjectWorkState(), {
      expectedVersion: 0,
      operation: "begin",
      work: {
        id: "work-1",
        ...(options.linkedTask === false ? {} : { taskId: "P1" }),
        objective: "Verify automatically",
        scope: [{ path: "src", recursive: true }],
      },
    }).state;
    await writeProjectWorkState(baseFs, rootDir, work);
  }

  const registry = new ToolRegistryImpl();
  registry.register(options.entry ?? commandEntry());
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService({
      ...defaultPermissionConfig,
      allowedTools: new Set(["Bash"]),
    }),
    sessionId: createSessionId(),
    mode: "build",
    workingDirectory: workspaceRoot,
    workspaceRoot,
    fileSystemPort,
    getProjectIntelligenceRoot: () => rootDir,
    emitEvent: async () => {},
  });
  return { baseFs, fileSystemPort, rootDir, workspaceRoot, executor };
}

test("persisted evidence accepts automatic provenance while model upsert rejects provenance", () => {
  const state = projectWithTask();
  const evidence = automaticEvidence("auto-1");
  const parsed = ProjectIntelligenceStateSchema.parse({ ...state, evidence: [evidence] });
  assert.equal(parsed.evidence[0]?.provenance?.source, "automatic_tool");

  assert.throws(() =>
    ProjectStateUpdateInputSchema.parse({
      expectedVersion: state.version,
      operation: "upsert_evidence",
      evidence: {
        ...evidence,
        observedAt: undefined,
      },
    }),
  );
});

test("manual ProjectStateUpdate cannot overwrite engine-authored automatic evidence", () => {
  const state = {
    ...projectWithTask(),
    evidence: [automaticEvidence("auto-protected")],
  };
  assert.throws(
    () =>
      applyProjectStateUpdate(state, {
        expectedVersion: state.version,
        operation: "upsert_evidence",
        evidence: {
          id: "auto-protected",
          subjectType: "task",
          subjectId: "P1",
          kind: "test",
          reference: "manual replacement",
        },
      }),
    /engine-authored automatic evidence/,
  );
});

test("central executor captures successful linked command evidence without raw output", async () => {
  const f = await fixture();
  const result = await f.executor.execute({
    id: "tool-success-1",
    name: "Bash",
    input: { command: "pnpm test" },
  });
  assert.equal(result.success, true, result.error?.message);

  const state = (await readProjectIntelligenceState(f.baseFs, f.rootDir)).state;
  assert.equal(state.evidence.length, 1);
  const evidence = state.evidence[0]!;
  assert.equal(evidence.subjectType, "task");
  assert.equal(evidence.subjectId, "P1");
  assert.equal(evidence.kind, "test");
  assert.equal(evidence.provenance?.source, "automatic_tool");
  assert.equal(evidence.provenance?.toolCallId, "tool-success-1");
  assert.equal(evidence.provenance?.command?.category, "test");
  assert.equal(evidence.provenance?.command?.status, "completed");
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /RAW_STDOUT_MUST_NOT_BE_EVIDENCE/);
  assert.doesNotMatch(serialized, /RAW_STDERR_MUST_NOT_BE_EVIDENCE/);
});

test("automatic command kind mapping preserves test and git, other categories become command", async () => {
  for (const [category, command, expectedKind] of [
    ["test", "pnpm test", "test"],
    ["test", "pnpm exec tsx --test test-file.ts", "test"],
    ["git", "git status", "git"],
    ["build", "pnpm run build", "command"],
  ] as const) {
    const f = await fixture({ entry: commandEntry({ category }) });
    const result = await f.executor.execute({
      id: `tool-${category}`,
      name: "Bash",
      input: { command },
    });
    assert.equal(result.success, true, result.error?.message);
    const state = (await readProjectIntelligenceState(f.baseFs, f.rootDir)).state;
    assert.equal(state.evidence[0]?.kind, expectedKind);
  }
});

test("heuristic telemetry cannot spoof test or git evidence kinds", async () => {
  for (const [id, category, command] of [
    ["echo-test", "test", "echo pnpm test"],
    ["masked-test", "test", "pnpm test || true"],
    ["echo-git", "git", "echo git status"],
    ["masked-git", "git", "git status || true"],
  ] as const) {
    const f = await fixture({ entry: commandEntry({ category }) });
    const result = await f.executor.execute({
      id,
      name: "Bash",
      input: { command },
    });
    assert.equal(result.success, true, result.error?.message);
    const state = (await readProjectIntelligenceState(f.baseFs, f.rootDir)).state;
    assert.equal(state.evidence[0]?.kind, "command");
    assert.equal(state.evidence[0]?.provenance?.command?.category, "other");
  }

  const chained = await fixture({ entry: commandEntry({ category: "test" }) });
  const result = await chained.executor.execute({
    id: "safe-chain",
    name: "Bash",
    input: { command: "pnpm test && echo verified" },
  });
  assert.equal(result.success, true, result.error?.message);
  assert.equal(
    (await readProjectIntelligenceState(chained.baseFs, chained.rootDir)).state.evidence[0]?.kind,
    "test",
  );
});

test("failed timed-out cancelled and backgrounded commands do not create completion evidence", async () => {
  for (const status of ["failed", "timed_out", "cancelled", "backgrounded"] as const) {
    const f = await fixture({
      entry: commandEntry({
        status,
        exitCode: status === "failed" ? 1 : 0,
      }),
    });
    const result = await f.executor.execute({
      id: `tool-${status}`,
      name: "Bash",
      input: { command: "pnpm test" },
    });
    assert.equal(result.success, true, result.error?.message);
    const state = (await readProjectIntelligenceState(f.baseFs, f.rootDir)).state;
    assert.equal(state.evidence.length, 0);
  }
});

test("missing or unlinked Project Work produces no automatic task evidence", async () => {
  const noWork = await fixture({ linkedTask: false });
  const result = await noWork.executor.execute({
    id: "tool-no-work",
    name: "Bash",
    input: { command: "pnpm test" },
  });
  assert.equal(result.success, true, result.error?.message);
  assert.equal(
    (await readProjectIntelligenceState(noWork.baseFs, noWork.rootDir)).state.evidence.length,
    0,
  );

  const base = await mkdtemp(join(tmpdir(), "zcode-auto-evidence-unlinked-"));
  const workspaceRoot = join(base, "repo");
  const rootDir = join(base, "metadata");
  await mkdir(workspaceRoot);
  const fs = new NodeFileSystemAdapter();
  await writeProjectIntelligenceState(fs, rootDir, projectWithTask());
  const work = applyProjectWorkUpdate(createEmptyProjectWorkState(), {
    expectedVersion: 0,
    operation: "begin",
    work: {
      id: "work-unlinked",
      objective: "No task attribution",
      scope: [{ path: "src", recursive: true }],
    },
  }).state;
  await writeProjectWorkState(fs, rootDir, work);
  const registry = new ToolRegistryImpl();
  registry.register(commandEntry());
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService({
      ...defaultPermissionConfig,
      allowedTools: new Set(["Bash"]),
    }),
    sessionId: createSessionId(),
    mode: "build",
    workingDirectory: workspaceRoot,
    workspaceRoot,
    fileSystemPort: fs,
    getProjectIntelligenceRoot: () => rootDir,
    emitEvent: async () => {},
  });
  const unlinked = await executor.execute({
    id: "tool-unlinked",
    name: "Bash",
    input: { command: "pnpm test" },
  });
  assert.equal(unlinked.success, true, unlinked.error?.message);
  assert.equal((await readProjectIntelligenceState(fs, rootDir)).state.evidence.length, 0);
});

test("automatic evidence application is idempotent and bounded without pruning manual evidence", () => {
  let state = projectWithTask();
  const manual = applyProjectStateUpdate(
    state,
    {
      expectedVersion: state.version,
      operation: "upsert_evidence",
      evidence: {
        id: "manual-keep",
        subjectType: "task",
        subjectId: "P1",
        kind: "test",
        reference: "manual evidence",
      },
    },
    "2026-09-22T00:00:01.000Z",
  ).state;
  state = manual;

  const first = automaticEvidence("auto-idempotent", "P1", "2026-09-22T00:00:02.000Z");
  const once = applyAutomaticProjectEvidence(state, first, first.observedAt);
  const twice = applyAutomaticProjectEvidence(once.state, first, first.observedAt);
  assert.equal(once.changed, true);
  assert.equal(twice.changed, false);
  assert.equal(twice.state.version, once.state.version);

  state = twice.state;
  for (let index = 0; index < PROJECT_AUTOMATIC_EVIDENCE_MAX_PER_TASK + 5; index += 1) {
    const evidence = automaticEvidence(
      `auto-${index}`,
      "P1",
      new Date(Date.UTC(2026, 8, 22, 0, 1, index)).toISOString(),
    );
    state = applyAutomaticProjectEvidence(state, evidence, evidence.observedAt).state;
  }
  assert.ok(state.evidence.some((evidence) => evidence.id === "manual-keep"));
  assert.equal(
    state.evidence.filter((evidence) => evidence.provenance?.source === "automatic_tool").length,
    PROJECT_AUTOMATIC_EVIDENCE_MAX_PER_TASK,
  );
});

test("automatic-only completion criteria ignore manual evidence and accept automatic evidence", () => {
  let project = projectWithTask();
  project = applyProjectStateUpdate(project, {
    expectedVersion: project.version,
    operation: "upsert_evidence",
    evidence: {
      id: "manual-test",
      subjectType: "task",
      subjectId: "P1",
      kind: "test",
      reference: "manual test claim",
    },
  }).state;

  const contract = {
    taskId: "P1",
    criteria: [
      {
        id: "verified-test",
        kind: "task_evidence" as const,
        evidenceKinds: ["test" as const],
        minimumCount: 1,
        evidenceSource: "automatic" as const,
      },
    ],
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
  };
  const work = createEmptyProjectWorkState();
  assert.equal(evaluateProjectCompletion(contract, project, work).status, "not_ready");

  const auto = automaticEvidence("auto-test");
  project = applyAutomaticProjectEvidence(project, auto, auto.observedAt).state;
  assert.equal(evaluateProjectCompletion(contract, project, work).status, "ready");

  const legacyContract = {
    ...contract,
    criteria: [{ ...contract.criteria[0]!, evidenceSource: undefined }],
  };
  const manualOnly = {
    ...project,
    evidence: project.evidence.filter((evidence) => evidence.provenance === undefined),
  };
  assert.equal(evaluateProjectCompletion(legacyContract, manualOnly, work).status, "ready");
});

test("automatic capture retries a bounded stale Project State write", async () => {
  const baseFs = new NodeFileSystemAdapter();
  let staleWrites = 0;
  const flakyFs = new Proxy(baseFs, {
    get(target, property, receiver) {
      if (property === "writeTextFile") {
        return async (...args: Parameters<FileSystemPort["writeTextFile"]>) => {
          const request = args[0];
          if (
            request.path.endsWith("state.json") &&
            request.expectedRevision &&
            staleWrites === 0
          ) {
            staleWrites += 1;
            throw createFileSystemError({
              code: "stale_write",
              path: request.path,
              message: "Injected stale write",
            });
          }
          return target.writeTextFile(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as FileSystemPort;

  const f = await fixture({ fileSystemPort: flakyFs });
  const result = await f.executor.execute({
    id: "tool-retry",
    name: "Bash",
    input: { command: "pnpm test" },
  });
  assert.equal(result.success, true, result.error?.message);
  assert.equal(staleWrites, 1);
  const state = (await readProjectIntelligenceState(baseFs, f.rootDir)).state;
  assert.equal(state.evidence.length, 1);
  assert.equal(state.evidence[0]?.provenance?.toolCallId, "tool-retry");
});
