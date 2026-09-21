import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import { resolveProjectIntelligenceRoot } from "../src/project-intelligence/path.js";
import { analyzeRepositoryFile } from "../src/project-intelligence/repository-analyzer.js";
import {
  readRepositoryFacts,
  refreshRepositoryFacts,
  invalidateRepositoryFacts,
} from "../src/project-intelligence/repository-store.js";
import { selectRepositoryFacts } from "../src/project-intelligence/repository-query.js";
import { buildRepositoryFactsTurnContext } from "../src/project-intelligence/repository-context.js";

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "zcode-facts-"));
  const workspaceRoot = join(base, "repo");
  await mkdir(workspaceRoot);
  const rootDir = resolveProjectIntelligenceRoot({
    cliStorageRoot: join(base, "storage"),
    workspacePath: workspaceRoot,
  });
  return {
    cliStorageRoot: join(base, "storage"),
    workspaceRoot,
    rootDir,
    fileSystemPort: new NodeFileSystemAdapter(),
    signal: new AbortController().signal,
  };
}

test("missing snapshot is not indexed and creates no facts", async () => {
  const input = await fixture();
  const read = await readRepositoryFacts(input);
  assert.equal(read.freshness, "not_indexed");
  assert.equal(read.snapshot, undefined);
  assert.equal(await buildRepositoryFactsTurnContext({ ...input, query: "anything" }), null);
});

test("refresh persists deterministic metadata, excludes fallback build paths, and survives sessions", async () => {
  const input = await fixture();
  await mkdir(join(input.workspaceRoot, "src"));
  await mkdir(join(input.workspaceRoot, "node_modules"));
  await writeFile(
    join(input.workspaceRoot, "src", "agent.ts"),
    'export function AgentRuntime() { return "secret-source-marker"; }',
  );
  await writeFile(
    join(input.workspaceRoot, "src", "agent.test.ts"),
    'import { AgentRuntime } from "./agent.ts"; import { test } from "node:test";',
  );
  await writeFile(join(input.workspaceRoot, "node_modules", "hidden.ts"), "export class Hidden {}");
  await writeFile(join(input.workspaceRoot, "thing.py"), "class Unsupported: pass");
  const first = await refreshRepositoryFacts(input);
  const second = await refreshRepositoryFacts(input);
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  assert.deepEqual(first.files, second.files);
  assert.deepEqual(first.symbols, second.symbols);
  assert.deepEqual(
    first.files.map((file) => file.path),
    ["src/agent.test.ts", "src/agent.ts", "thing.py"],
  );
  assert.equal(first.files[0]?.classification, "test");
  assert.ok(first.files[0]?.frameworks.includes("node:test"));
  assert.equal(first.files[2]?.analysis, "unsupported");
  assert.equal(
    first.symbols.some((symbol) => symbol.file === "thing.py"),
    false,
  );
  assert.equal(
    first.dependencies.find((edge) => edge.specifier === "./agent.ts")?.target,
    "src/agent.ts",
  );
  assert.equal(
    first.dependencies.find((edge) => edge.specifier === "node:test")?.target,
    undefined,
  );
  const persisted = await readFile(join(input.rootDir, "repository-facts.json"), "utf8");
  assert.equal(persisted.includes("secret-source-marker"), false);
  const later = await readRepositoryFacts({
    ...input,
    fileSystemPort: new NodeFileSystemAdapter(),
  });
  assert.equal(later.snapshot?.generation, 2);
  assert.equal(later.freshness, "unknown");
  assert.equal(
    (
      await readRepositoryFacts({
        ...input,
        rootDir: resolveProjectIntelligenceRoot({
          cliStorageRoot: input.cliStorageRoot,
          workspacePath: "other",
        }),
      })
    ).freshness,
    "not_indexed",
  );
});

test("workspace identity isolation reuses the Phase 1 root rule", async () => {
  const input = await fixture();
  const root = (workspaceIdentity: string, workspacePath = input.workspaceRoot) =>
    resolveProjectIntelligenceRoot({
      cliStorageRoot: input.cliStorageRoot,
      workspacePath,
      workspaceIdentity,
    });
  const first = root("remote-workspace-one");
  const second = root("remote-workspace-two");
  assert.notEqual(first, second);
  assert.equal(first, root(" remote-workspace-one ", "another-local-path"));
  await refreshRepositoryFacts({ ...input, rootDir: first });
  assert.equal((await readRepositoryFacts({ ...input, rootDir: first })).snapshot?.generation, 1);
  assert.equal((await readRepositoryFacts({ ...input, rootDir: second })).freshness, "not_indexed");
});

test("AST symbols are deterministic and preserve raw imports without fabricated resolution", () => {
  const source =
    'import x from "./missing"; export interface Agent {} export class Runtime { run() {} } export const n = 1;';
  const first = analyzeRepositoryFile("src/runtime.ts", source);
  assert.deepEqual(first, analyzeRepositoryFile("src/runtime.ts", source));
  assert.ok(
    first.symbols.some(
      (symbol) => symbol.name === "Agent" && symbol.kind === "interface" && symbol.exported,
    ),
  );
  assert.ok(first.symbols.some((symbol) => symbol.name === "run" && symbol.container));
  assert.equal(first.dependencies[0]?.specifier, "./missing");
  assert.equal(first.dependencies[0]?.target, undefined);
  assert.deepEqual(analyzeRepositoryFile("source.rs", "fn fake() {}").symbols, []);
});

test("query is relevant and bounded, with explicit invalidation", async () => {
  const input = await fixture();
  await writeFile(
    join(input.workspaceRoot, "agent.ts"),
    "export class AgentRuntime {} export function unrelated() {}",
  );
  const snapshot = await refreshRepositoryFacts(input);
  const selected = selectRepositoryFacts(
    { snapshot, freshness: "unknown" },
    { query: "where is AgentRuntime created?", limit: 1 },
  );
  assert.equal(selected.symbols[0]?.name, "AgentRuntime");
  assert.equal(selected.files.length + selected.symbols.length + selected.dependencies.length, 1);
  assert.equal(await buildRepositoryFactsTurnContext({ ...input, query: "zznomatch" }), null);
  const reminder = await buildRepositoryFactsTurnContext({ ...input, query: "AgentRuntime" });
  assert.match(reminder!, /unknown/);
  await invalidateRepositoryFacts(input);
  assert.equal((await readRepositoryFacts(input)).freshness, "stale");
  await refreshRepositoryFacts(input);
  assert.equal((await readRepositoryFacts(input)).freshness, "unknown");
});

test("corrupt and unsupported snapshots fail closed, cancellation does not publish", async () => {
  const input = await fixture();
  await mkdir(input.rootDir, { recursive: true });
  for (const contents of ["broken", '{"schemaVersion":99}']) {
    await writeFile(join(input.rootDir, "repository-facts.json"), contents);
    await assert.rejects(readRepositoryFacts(input), /Repository Facts/);
    await assert.rejects(refreshRepositoryFacts(input), /Repository Facts/);
    assert.equal(await readFile(join(input.rootDir, "repository-facts.json"), "utf8"), contents);
  }
  const clean = await fixture();
  await assert.rejects(refreshRepositoryFacts({ ...clean, signal: AbortSignal.abort() }));
  assert.equal((await readRepositoryFacts(clean)).freshness, "not_indexed");
});
