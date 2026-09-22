import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const PROJECT_WORK_SCHEMA_VERSION = 1 as const;
export const PROJECT_WORK_MAX_SCOPE_ENTRIES = 100 as const;
export const PROJECT_WORK_MAX_OBSERVED_PATHS = 100 as const;

const ProjectWorkIdSchema = z.string().trim().min(1).max(120);
const ProjectWorkObjectiveSchema = z.string().trim().min(1).max(20_000);
const ProjectWorkPathSchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.includes(":") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Expected a normalized workspace-relative POSIX path",
  );

export const ProjectWorkStatusSchema = z.enum(["active", "paused"]);
export type ProjectWorkStatus = z.infer<typeof ProjectWorkStatusSchema>;

export const ProjectWorkScopeEntrySchema = z
  .object({
    path: ProjectWorkPathSchema,
    recursive: z.boolean(),
  })
  .strict();
export type ProjectWorkScopeEntry = z.infer<typeof ProjectWorkScopeEntrySchema>;

export const ProjectWorkItemSchema = z
  .object({
    id: ProjectWorkIdSchema,
    taskId: ProjectWorkIdSchema.optional(),
    objective: ProjectWorkObjectiveSchema,
    status: ProjectWorkStatusSchema,
    scope: z.array(ProjectWorkScopeEntrySchema).min(1).max(PROJECT_WORK_MAX_SCOPE_ENTRIES),
    startedAt: z.string().min(1),
    updatedAt: z.string().min(1),
    observedMutationPaths: z.array(ProjectWorkPathSchema).max(PROJECT_WORK_MAX_OBSERVED_PATHS),
    observedMutationCount: z.number().int().nonnegative(),
    observedMutationPathsTruncated: z.boolean(),
  })
  .strict();
export type ProjectWorkItem = z.infer<typeof ProjectWorkItemSchema>;

export const ProjectWorkStateSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_WORK_SCHEMA_VERSION),
    version: z.number().int().nonnegative(),
    updatedAt: z.string().min(1),
    work: ProjectWorkItemSchema.optional(),
  })
  .strict();
export type ProjectWorkState = z.infer<typeof ProjectWorkStateSchema>;

export const ProjectWorkReadInputSchema = z.object({}).strict();
export type ProjectWorkReadInput = z.infer<typeof ProjectWorkReadInputSchema>;
export const ProjectWorkReadInputJsonSchema = toToolJsonSchema(ProjectWorkReadInputSchema);

export const ProjectWorkReadOutputSchema = ProjectWorkStateSchema;
export type ProjectWorkReadOutput = z.infer<typeof ProjectWorkReadOutputSchema>;
export const ProjectWorkReadOutputJsonSchema = toToolJsonSchema(ProjectWorkReadOutputSchema);

const ProjectWorkUpdateBaseSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
});

const ProjectWorkBeginItemSchema = z
  .object({
    id: ProjectWorkIdSchema,
    taskId: ProjectWorkIdSchema.optional(),
    objective: ProjectWorkObjectiveSchema,
    scope: z.array(ProjectWorkScopeEntrySchema).min(1).max(PROJECT_WORK_MAX_SCOPE_ENTRIES),
  })
  .strict();

export const ProjectWorkUpdateInputSchema = z.discriminatedUnion("operation", [
  ProjectWorkUpdateBaseSchema.extend({
    operation: z.literal("begin"),
    work: ProjectWorkBeginItemSchema,
  }).strict(),
  ProjectWorkUpdateBaseSchema.extend({
    operation: z.literal("revise_scope"),
    scope: z.array(ProjectWorkScopeEntrySchema).min(1).max(PROJECT_WORK_MAX_SCOPE_ENTRIES),
  }).strict(),
  ProjectWorkUpdateBaseSchema.extend({
    operation: z.literal("pause"),
  }).strict(),
  ProjectWorkUpdateBaseSchema.extend({
    operation: z.literal("resume"),
  }).strict(),
  ProjectWorkUpdateBaseSchema.extend({
    operation: z.literal("close"),
  }).strict(),
]);
export type ProjectWorkUpdateInput = z.infer<typeof ProjectWorkUpdateInputSchema>;
export const ProjectWorkUpdateInputJsonSchema = toToolJsonSchema(ProjectWorkUpdateInputSchema);

export const ProjectWorkUpdateOutputSchema = z
  .object({
    previousVersion: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
    updatedAt: z.string().min(1),
    operation: z.enum(["begin", "revise_scope", "pause", "resume", "close"]),
    workId: ProjectWorkIdSchema.optional(),
    status: z.enum(["active", "paused", "none"]),
  })
  .strict();
export type ProjectWorkUpdateOutput = z.infer<typeof ProjectWorkUpdateOutputSchema>;
export const ProjectWorkUpdateOutputJsonSchema = toToolJsonSchema(ProjectWorkUpdateOutputSchema);
