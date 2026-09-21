import type {
  RepositoryFactsReadInput,
  RepositoryFactsReadOutput,
  RepositoryFileFact,
  RepositorySymbolFact,
  RepositoryDependencyFact,
} from "@zcode/contracts";
import type { RepositoryFactsRead } from "./repository-store.js";

const STOP_WORDS = new Set(
  "where what which who how are is the a an in on of to for about show repository facts exist exists created cover imports import symbols files tests".split(
    " ",
  ),
);
const MAX_RESULT_BYTES = 24000;

export function selectRepositoryFacts(
  read: RepositoryFactsRead,
  input: RepositoryFactsReadInput = {},
): RepositoryFactsReadOutput {
  const snapshot = read.snapshot;
  const output: RepositoryFactsReadOutput = {
    freshness: read.freshness,
    generation: snapshot?.generation ?? 0,
    ...(snapshot ? { indexedAt: snapshot.indexedAt, provenance: snapshot.provenance } : {}),
    summary: snapshot?.summary ?? {
      files: 0,
      symbols: 0,
      dependencies: 0,
      tests: 0,
      failed: 0,
      skipped: 0,
      truncated: false,
    },
    files: [],
    symbols: [],
    dependencies: [],
    truncated: false,
  };
  if (!snapshot) return output;
  const tokens = (input.query?.toLowerCase().match(/[\p{L}\p{N}_./@-]+/gu) ?? []).filter(
    (token) => token.length > 0 && !STOP_WORDS.has(token),
  );
  const testQuery = input.kind === "test" || /\btests?\b/i.test(input.query ?? "");
  type Candidate =
    | { kind: "file"; value: RepositoryFileFact }
    | { kind: "symbol"; value: RepositorySymbolFact }
    | { kind: "dependency"; value: RepositoryDependencyFact };
  const candidates: Array<{ record: Candidate; score: number }> = [];
  function add(record: Candidate, path: string, text: string, name?: string) {
    if (input.path && path !== input.path && !path.startsWith(`${input.path}/`)) return;
    if (input.kind && input.kind !== "test" && input.kind !== record.kind) return;
    const isTest = record.kind === "file" && record.value.classification === "test";
    if (input.kind === "test" && !isTest) return;
    const lower = text.toLowerCase();
    let score = tokens.reduce(
      (sum, token) => sum + (name?.toLowerCase() === token ? 10 : lower.includes(token) ? 2 : 0),
      0,
    );
    if (testQuery && isTest) score += 1;
    if (input.query?.trim() && score === 0) return;
    candidates.push({ record, score });
  }
  for (const file of snapshot.files)
    add(
      { kind: "file", value: file },
      file.path,
      `${file.path} ${file.language ?? ""} ${file.classification} ${file.frameworks.join(" ")}`,
    );
  for (const symbol of snapshot.symbols)
    add(
      { kind: "symbol", value: symbol },
      symbol.file,
      `${symbol.name} ${symbol.file} ${symbol.kind}`,
      symbol.name,
    );
  for (const edge of snapshot.dependencies)
    add(
      { kind: "dependency", value: edge },
      edge.source,
      `${edge.source} ${edge.specifier} ${edge.target ?? ""}`,
      edge.specifier,
    );
  candidates.sort((a, b) => b.score - a.score);
  const limit = Math.max(1, Math.min(50, input.limit ?? 20));
  let bytes = Buffer.byteLength(JSON.stringify(output));
  let added = 0;
  for (const { record } of candidates) {
    const size = Buffer.byteLength(JSON.stringify(record.value));
    if (added >= limit || bytes + size > MAX_RESULT_BYTES) {
      output.truncated = true;
      break;
    }
    bytes += size;
    added++;
    if (record.kind === "file") output.files.push(record.value);
    else if (record.kind === "symbol") output.symbols.push(record.value);
    else output.dependencies.push(record.value);
  }
  return output;
}
