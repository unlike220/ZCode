import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.includes(":") &&
      value.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
    "Expected a normalized workspace-relative POSIX path",
  );
const shortText = z.string().max(1024);
const location = z
  .object({ line: z.number().int().positive(), column: z.number().int().positive() })
  .strict();
export const RepositoryFileClassificationSchema = z.enum([
  "source",
  "test",
  "config",
  "docs",
  "generated",
  "other",
]);
export const RepositoryFileFactSchema = z
  .object({
    path: relativePath,
    classification: RepositoryFileClassificationSchema,
    language: shortText.optional(),
    size: z.number().int().nonnegative(),
    revision: shortText.optional(),
    analysis: z.enum(["analyzed", "unsupported", "skipped", "failed"]),
    frameworks: z.array(shortText).max(10),
  })
  .strict();
export const RepositorySymbolFactSchema = z
  .object({
    id: shortText,
    name: shortText,
    kind: z.enum([
      "class",
      "interface",
      "type",
      "enum",
      "function",
      "method",
      "variable",
      "module",
    ]),
    file: relativePath,
    start: location,
    end: location.optional(),
    container: shortText.optional(),
    exported: z.boolean().optional(),
    analyzer: shortText,
  })
  .strict();
export const RepositoryDependencyFactSchema = z
  .object({
    source: relativePath,
    specifier: shortText,
    target: relativePath.optional(),
    kind: z.enum(["import", "export", "require", "module-reference"]),
    analyzer: shortText,
  })
  .strict();
export const RepositoryProvenanceSchema = z
  .object({
    method: z.enum(["git", "filesystem"]),
    head: shortText.optional(),
    branch: shortText.optional(),
    dirty: z.boolean().optional(),
    analyzer: shortText,
    mutationToken: shortText.optional(),
  })
  .strict();
export const RepositorySummarySchema = z
  .object({
    files: z.number().int().nonnegative(),
    symbols: z.number().int().nonnegative(),
    dependencies: z.number().int().nonnegative(),
    tests: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
export const RepositoryFactsSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    generation: z.number().int().positive(),
    indexedAt: z.string().datetime(),
    provenance: RepositoryProvenanceSchema,
    files: z.array(RepositoryFileFactSchema).max(2000),
    symbols: z.array(RepositorySymbolFactSchema).max(20000),
    dependencies: z.array(RepositoryDependencyFactSchema).max(20000),
    summary: RepositorySummarySchema,
  })
  .strict();
export const RepositoryFactsReadInputSchema = z
  .object({
    query: z.string().max(2000).optional(),
    path: relativePath.optional(),
    kind: z.enum(["file", "symbol", "dependency", "test"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export const RepositoryFactsReadOutputSchema = z
  .object({
    freshness: z.enum(["unknown", "stale", "not_indexed"]),
    generation: z.number().int().nonnegative(),
    indexedAt: z.string().datetime().optional(),
    provenance: RepositoryProvenanceSchema.optional(),
    summary: RepositorySummarySchema,
    files: z.array(RepositoryFileFactSchema).max(50),
    symbols: z.array(RepositorySymbolFactSchema).max(50),
    dependencies: z.array(RepositoryDependencyFactSchema).max(50),
    truncated: z.boolean(),
  })
  .strict();
export const RepositoryFactsRefreshInputSchema = z.object({}).strict();
export const RepositoryFactsRefreshOutputSchema = RepositoryFactsReadOutputSchema.omit({
  files: true,
  symbols: true,
  dependencies: true,
  truncated: true,
});
export type RepositoryFileFact = z.infer<typeof RepositoryFileFactSchema>;
export type RepositorySymbolFact = z.infer<typeof RepositorySymbolFactSchema>;
export type RepositoryDependencyFact = z.infer<typeof RepositoryDependencyFactSchema>;
export type RepositoryProvenance = z.infer<typeof RepositoryProvenanceSchema>;
export type RepositoryFactsSnapshot = z.infer<typeof RepositoryFactsSnapshotSchema>;
export type RepositoryFactsReadInput = z.infer<typeof RepositoryFactsReadInputSchema>;
export type RepositoryFactsReadOutput = z.infer<typeof RepositoryFactsReadOutputSchema>;
export const RepositoryFactsReadInputJsonSchema = toToolJsonSchema(RepositoryFactsReadInputSchema);
export const RepositoryFactsReadOutputJsonSchema = toToolJsonSchema(
  RepositoryFactsReadOutputSchema,
);
export const RepositoryFactsRefreshInputJsonSchema = toToolJsonSchema(
  RepositoryFactsRefreshInputSchema,
);
export const RepositoryFactsRefreshOutputJsonSchema = toToolJsonSchema(
  RepositoryFactsRefreshOutputSchema,
);
