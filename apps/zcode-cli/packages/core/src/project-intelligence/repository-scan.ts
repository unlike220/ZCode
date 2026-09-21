import { join, posix } from "node:path";
import type {
  ExecutionPort,
  FileSystemPort,
  RepositoryFactsSnapshot,
  RepositoryFileFact,
  RepositoryProvenance,
  TraceContext,
} from "@zcode/contracts";
import { isFileSystemPortError } from "@zcode/contracts";
import {
  analyzeRepositoryFile,
  REPOSITORY_ANALYZER,
  supportsRepositorySymbols,
  type RepositoryAnalyzer,
} from "./repository-analyzer.js";

const MAX_FILES = 2000;
const MAX_ENTRIES = 4000;
const MAX_DEPTH = 32;
const MAX_PARSE_BYTES = 256 * 1024;
const MAX_TOTAL_PARSE_BYTES = 16 * 1024 * 1024;
const MAX_FACTS = 20000;
const MAX_GIT_BYTES = 2 * 1024 * 1024;
const EXCLUDED = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
  "__pycache__",
  "target",
]);
const FRAMEWORKS = [
  "node:test",
  "vitest",
  "jest",
  "@jest/globals",
  "@playwright/test",
  "mocha",
  "ava",
  "cypress",
];

export interface RepositoryScanInput {
  workspaceRoot: string;
  fileSystemPort: FileSystemPort;
  executionPort?: ExecutionPort;
  traceContext?: TraceContext;
  signal?: AbortSignal;
  analyzer?: RepositoryAnalyzer;
}

export async function scanRepository(input: RepositoryScanInput) {
  const candidates = await enumerate(input);
  const files: RepositoryFactsSnapshot["files"] = [];
  const symbols: RepositoryFactsSnapshot["symbols"] = [];
  const dependencies: RepositoryFactsSnapshot["dependencies"] = [];
  let totalBytes = 0;
  let truncated = candidates.truncated;
  const safeDirectories = new Set<string>();
  for (const path of candidates.paths) {
    input.signal?.throwIfAborted();
    if (!isSafeRepositoryPath(path) || !(await safeParents(input, path, safeDirectories))) {
      truncated = true;
      continue;
    }
    const absolute = join(input.workspaceRoot, path);
    let stat;
    try {
      stat = await input.fileSystemPort.stat(
        { path: absolute, followSymlinks: false, trace: input.traceContext },
        { signal: input.signal },
      );
    } catch (error) {
      if (isFileSystemPortError(error) && error.code === "not_found") {
        truncated = true;
        continue;
      }
      throw error;
    }
    if (stat.kind !== "file") {
      truncated = true;
      continue;
    }
    const classification = classify(path);
    const file: RepositoryFileFact = {
      path,
      classification,
      language: language(path),
      size: stat.sizeBytes,
      ...(stat.revision ? { revision: stat.revision.hash ?? stat.revision.id } : {}),
      analysis: supportsRepositorySymbols(path) ? "skipped" : "unsupported",
      frameworks: [],
    };
    files.push(file);
    if (
      !supportsRepositorySymbols(path) ||
      classification === "generated" ||
      stat.sizeBytes > MAX_PARSE_BYTES ||
      totalBytes + stat.sizeBytes > MAX_TOTAL_PARSE_BYTES ||
      symbols.length >= MAX_FACTS ||
      dependencies.length >= MAX_FACTS
    )
      continue;
    const read = await input.fileSystemPort.readBinaryFile(
      { path: absolute, maxBytes: MAX_PARSE_BYTES, trace: input.traceContext },
      { signal: input.signal },
    );
    totalBytes += read.bytesRead;
    if (read.content.includes(0)) continue;
    let analyzed;
    try {
      analyzed = (input.analyzer?.analyze ?? analyzeRepositoryFile)(
        path,
        new TextDecoder("utf-8", { fatal: true }).decode(read.content),
      );
    } catch {
      input.signal?.throwIfAborted();
      file.analysis = "failed";
      continue;
    }
    file.analysis = analyzed.supported ? "analyzed" : "unsupported";
    file.revision = read.revision?.hash ?? read.revision?.id ?? file.revision;
    truncated ||=
      analyzed.truncated ||
      symbols.length + analyzed.symbols.length > MAX_FACTS ||
      dependencies.length + analyzed.dependencies.length > MAX_FACTS;
    symbols.push(...analyzed.symbols.slice(0, MAX_FACTS - symbols.length));
    dependencies.push(...analyzed.dependencies.slice(0, MAX_FACTS - dependencies.length));
    if (classification === "test")
      file.frameworks = FRAMEWORKS.filter((framework) =>
        analyzed.dependencies.some((edge) => edge.specifier === framework),
      );
  }
  const known = new Set(files.map((file) => file.path));
  for (const edge of dependencies) {
    if (!edge.specifier.startsWith("./") && !edge.specifier.startsWith("../")) continue;
    const target = posix.normalize(posix.join(posix.dirname(edge.source), edge.specifier));
    if (isSafeRepositoryPath(target) && known.has(target)) edge.target = target;
  }
  symbols.sort(
    (a, b) =>
      compare(a.file, b.file) ||
      a.start.line - b.start.line ||
      a.start.column - b.start.column ||
      compare(a.id, b.id),
  );
  dependencies.sort(
    (a, b) =>
      compare(a.source, b.source) || compare(a.specifier, b.specifier) || compare(a.kind, b.kind),
  );
  return {
    files,
    symbols,
    dependencies,
    provenance: candidates.provenance,
    summary: {
      files: files.length,
      symbols: symbols.length,
      dependencies: dependencies.length,
      tests: files.filter((file) => file.classification === "test").length,
      failed: files.filter((file) => file.analysis === "failed").length,
      skipped: files.filter(
        (file) => file.analysis === "skipped" || file.analysis === "unsupported",
      ).length,
      truncated,
    },
  };
}

async function enumerate(
  input: RepositoryScanInput,
): Promise<{ paths: string[]; provenance: RepositoryProvenance; truncated: boolean }> {
  const probe = await git(input, ["rev-parse", "--is-inside-work-tree"], true);
  if (probe?.trim() === "true") {
    const raw = await git(input, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
    ]);
    const paths = [...new Set(raw!.split("\0").filter(Boolean))].sort(compare);
    const head = (await git(input, ["rev-parse", "--verify", "HEAD"], true))?.trim();
    const branch = (await git(input, ["symbolic-ref", "--short", "-q", "HEAD"], true))?.trim();
    const status = await git(input, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
      "--",
      ".",
    ]);
    return {
      paths: paths.slice(0, MAX_FILES),
      truncated: paths.length > MAX_FILES,
      provenance: {
        method: "git",
        analyzer: REPOSITORY_ANALYZER,
        ...(head ? { head } : {}),
        ...(branch ? { branch } : {}),
        dirty: status !== "",
      },
    };
  }
  const paths: string[] = [];
  let visited = 0;
  let truncated = false;
  async function walk(directory: string, depth: number): Promise<void> {
    input.signal?.throwIfAborted();
    if (++visited > MAX_ENTRIES || depth > MAX_DEPTH) {
      truncated = true;
      return;
    }
    const listing = await input.fileSystemPort.listDirectory(
      {
        path: join(input.workspaceRoot, directory),
        maxEntries: MAX_ENTRIES,
        trace: input.traceContext,
      },
      { signal: input.signal },
    );
    for (const entry of listing.entries.sort((a, b) => compare(a.name, b.name))) {
      if (paths.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (!isSafeRepositoryPath(path)) {
        truncated = true;
        continue;
      }
      if (entry.kind === "directory" && !EXCLUDED.has(entry.name)) await walk(path, depth + 1);
      else if (entry.kind === "file") paths.push(path);
    }
  }
  await walk("", 0);
  return {
    paths: paths.sort(compare),
    truncated,
    provenance: { method: "filesystem", analyzer: REPOSITORY_ANALYZER },
  };
}

async function git(
  input: RepositoryScanInput,
  args: string[],
  optional = false,
): Promise<string | undefined> {
  if (!input.executionPort) return undefined;
  input.signal?.throwIfAborted();
  const result = await input.executionPort.run(
    {
      command: { mode: "argv", file: "git", args },
      cwd: input.workspaceRoot,
      timeoutMs: 10000,
      outputLimit: {
        maxInlineBytes: MAX_GIT_BYTES,
        maxBufferBytes: MAX_GIT_BYTES,
        persistOutput: "none",
      },
      trace: input.traceContext,
    },
    { signal: input.signal },
  );
  input.signal?.throwIfAborted();
  if (result.stdout.truncated || result.stderr.truncated)
    throw new Error("Repository Facts Git output limit exceeded");
  if (result.status !== "completed" || result.exitCode !== 0) {
    if (optional && (result.exitCode !== undefined || result.status === "spawn_error"))
      return undefined;
    throw new Error(`Repository Facts Git query failed (${result.status})`);
  }
  return result.stdout.text;
}

async function safeParents(input: RepositoryScanInput, path: string, checked: Set<string>) {
  const segments = path.split("/");
  for (let length = 1; length < segments.length; length++) {
    const parent = segments.slice(0, length).join("/");
    if (checked.has(parent)) continue;
    const stat = await input.fileSystemPort.stat(
      { path: join(input.workspaceRoot, parent), followSymlinks: false, trace: input.traceContext },
      { signal: input.signal },
    );
    if (stat.kind !== "directory") return false;
    checked.add(parent);
  }
  return true;
}

export function isSafeRepositoryPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !path.includes("\0") &&
    !/[\\:]/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function classify(path: string): RepositoryFileFact["classification"] {
  if (
    path.split("/").some((part) => EXCLUDED.has(part)) ||
    /(?:\.min\.[jt]s|\.generated\.[^.]+|\.map|\.lock)$/.test(path)
  )
    return "generated";
  if (/\.(?:md|mdx|rst|txt)$/i.test(path)) return "docs";
  if (
    /(?:^|\/)(?:__tests__|tests?|specs?)\//i.test(path) ||
    /(?:^|[./_-])(?:test|spec)\.[^.]+$/i.test(path) ||
    /(?:^|\/)test_[^/]+\.py$/.test(path)
  )
    return "test";
  if (
    /(?:^|\/)(?:[^/]*config[^/]*|package\.json|Dockerfile|Makefile|\.[^/]+)$/.test(path) ||
    /\.(?:json|ya?ml|toml|ini)$/i.test(path)
  )
    return "config";
  return language(path) ? "source" : "other";
}

function language(path: string): string | undefined {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      ts: "typescript",
      tsx: "typescript",
      mts: "typescript",
      cts: "typescript",
      js: "javascript",
      jsx: "javascript",
      mjs: "javascript",
      cjs: "javascript",
      py: "python",
      rs: "rust",
      go: "go",
      java: "java",
      c: "c",
      h: "c",
      cpp: "cpp",
      cs: "csharp",
      rb: "ruby",
      sh: "shell",
      swift: "swift",
    } as Record<string, string>
  )[extension];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
