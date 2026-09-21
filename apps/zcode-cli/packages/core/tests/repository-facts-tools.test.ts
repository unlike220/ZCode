import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSessionId,
  createRootTraceContext,
  type RepositoryFactsReadOutput,
} from "@zcode/contracts";
import { NodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import { createToolExecutor } from "../src/tool/executor/impl.js";
import { ToolRegistryImpl } from "../src/tool/registry.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import {
  repositoryFactsReadToolEntry,
  repositoryFactsRefreshToolEntry,
} from "../src/tool/handlers/repository-facts.js";
import { readRepositoryFacts } from "../src/project-intelligence/repository-store.js";

test("model-facing tools use executor schemas, trace, cancellation and normal failure semantics", async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-facts-tools-"));
  const workspaceRoot = join(base, "repo");
  const rootDir = join(base, "metadata");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "runtime.ts"), "export class AgentRuntime {}");
  const fileSystemPort = new NodeFileSystemAdapter();
  const sessionId = createSessionId();
  const traceContext = createRootTraceContext({ sessionId });
  const readBinary = fileSystemPort.readBinaryFile.bind(fileSystemPort);
  fileSystemPort.readBinaryFile = async (request, options) => {
    assert.equal(request.trace?.traceId, traceContext.traceId);
    assert.ok(options?.signal);
    return readBinary(request);
  };
  const registry = new ToolRegistryImpl();
  registry.register(repositoryFactsReadToolEntry);
  registry.register(repositoryFactsRefreshToolEntry);
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService({
      ...defaultPermissionConfig,
      allowedTools: new Set(["RepositoryFactsRead", "RepositoryFactsRefresh", "FixtureMutation"]),
    }),
    sessionId,
    traceContext,
    mode: "build",
    workingDirectory: base,
    workspaceRoot,
    fileSystemPort,
    getProjectIntelligenceRoot: () => rootDir,
    emitEvent: async () => {},
  });
  const refresh = await executor.execute({
    id: "refresh",
    name: "RepositoryFactsRefresh",
    input: {},
  });
  assert.equal(refresh.success, true, refresh.error?.message);
  const read = await executor.execute({
    id: "read",
    name: "RepositoryFactsRead",
    input: { query: "AgentRuntime", kind: "symbol" },
  });
  assert.equal(read.success, true, read.error?.message);
  assert.equal((read.output as RepositoryFactsReadOutput).symbols[0]?.file, "runtime.ts");
  assert.equal((read.output as RepositoryFactsReadOutput).freshness, "unknown");
  const invalid = await executor.execute({
    id: "invalid",
    name: "RepositoryFactsRead",
    input: { limit: 1000 },
  });
  assert.equal(invalid.success, false);
  let tokenDuringWrite = "";
  registry.register({
    ...repositoryFactsRefreshToolEntry,
    metadata: { ...repositoryFactsRefreshToolEntry.metadata, name: "FixtureMutation" },
    handler: async () => {
      assert.equal((await readRepositoryFacts({ rootDir, fileSystemPort })).freshness, "stale");
      tokenDuringWrite = await readFile(
        join(rootDir, "repository-facts-invalidation.json"),
        "utf8",
      );
      throw new Error("fixture partial write failure");
    },
  });
  const failed = await executor.execute({ id: "mutation", name: "FixtureMutation", input: {} });
  assert.equal(failed.success, false);
  assert.match(failed.error!.message, /fixture partial write failure/);
  assert.notEqual(
    await readFile(join(rootDir, "repository-facts-invalidation.json"), "utf8"),
    tokenDuringWrite,
  );
  await writeFile(join(rootDir, "repository-facts.json"), "broken");
  const corrupt = await executor.execute({
    id: "corrupt",
    name: "RepositoryFactsRefresh",
    input: {},
  });
  assert.equal(corrupt.success, false);
  assert.match(corrupt.error!.message, /Repository Facts/);
  const cancelled = await executor.execute(
    { id: "cancelled", name: "RepositoryFactsRead", input: {} },
    { signal: AbortSignal.abort() },
  );
  assert.equal(cancelled.success, false);
});
