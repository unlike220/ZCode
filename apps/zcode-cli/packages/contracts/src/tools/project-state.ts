// ============================================================
// Project State Tools - workspace-scoped structured project intelligence
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const PROJECT_INTELLIGENCE_SCHEMA_VERSION = 1 as const;

export const ProjectTaskStatusSchema = z.enum(["planned", "in_progress", "blocked", "done"]);
export type ProjectTaskStatus = z.infer<typeof ProjectTaskStatusSchema>;

export const ProjectDecisionStatusSchema = z.enum(["proposed", "accepted", "superseded"]);
export type ProjectDecisionStatus = z.infer<typeof ProjectDecisionStatusSchema>;

export const ProjectUnknownStatusSchema = z.enum([
  "open",
  "investigating",
  "resolved",
  "invalidated",
]);
export type ProjectUnknownStatus = z.infer<typeof ProjectUnknownStatusSchema>;

export const ProjectEvidenceKindSchema = z.enum([
  "source",
  "test",
  "command",
  "runtime",
  "git",
  "external",
]);
export type ProjectEvidenceKind = z.infer<typeof ProjectEvidenceKindSchema>;

export const ProjectEvidenceSubjectTypeSchema = z.enum([
  "task",
  "decision",
  "unknown",
  "repository",
]);
export type ProjectEvidenceSubjectType = z.infer<typeof ProjectEvidenceSubjectTypeSchema>;

const ProjectRecordIdSchema = z.string().trim().min(1).max(120);
const ProjectToolCallIdSchema = z.string().trim().min(1).max(200);
const ProjectRecordTitleSchema = z.string().trim().min(1).max(500);
const ProjectTextSchema = z.string().trim().min(1).max(20_000);
const ProjectTagsSchema = z.array(z.string().trim().min(1).max(120)).max(50).default([]);
const ProjectPathsSchema = z.array(z.string().trim().min(1).max(2_000)).max(100).default([]);

export const ProjectTaskSchema = z
  .object({
    id: ProjectRecordIdSchema,
    title: ProjectRecordTitleSchema,
    status: ProjectTaskStatusSchema,
    summary: z.string().trim().max(20_000).optional(),
    tags: ProjectTagsSchema,
    relatedPaths: ProjectPathsSchema,
    updatedAt: z.string().min(1),
  })
  .strict();
export type ProjectTask = z.infer<typeof ProjectTaskSchema>;

export const ProjectDecisionSchema = z
  .object({
    id: ProjectRecordIdSchema,
    title: ProjectRecordTitleSchema,
    status: ProjectDecisionStatusSchema,
    statement: ProjectTextSchema,
    rationale: z.string().trim().max(20_000).optional(),
    tags: ProjectTagsSchema,
    relatedPaths: ProjectPathsSchema,
    updatedAt: z.string().min(1),
  })
  .strict();
export type ProjectDecision = z.infer<typeof ProjectDecisionSchema>;

export const ProjectUnknownSchema = z
  .object({
    id: ProjectRecordIdSchema,
    question: ProjectTextSchema,
    status: ProjectUnknownStatusSchema,
    answer: z.string().trim().max(20_000).optional(),
    blocks: z.array(ProjectRecordIdSchema).max(100).default([]),
    tags: ProjectTagsSchema,
    relatedPaths: ProjectPathsSchema,
    updatedAt: z.string().min(1),
  })
  .strict();
export type ProjectUnknown = z.infer<typeof ProjectUnknownSchema>;

export const ProjectEvidenceAutomaticToolProvenanceSchema = z
  .object({
    source: z.literal("automatic_tool"),
    toolName: ProjectRecordIdSchema,
    toolCallId: ProjectToolCallIdSchema,
    traceId: ProjectToolCallIdSchema.optional(),
    outcome: z.literal("success"),
    command: z
      .object({
        category: z.enum(["test", "git", "build", "package", "network", "search", "other"]),
        safeName: z.string().trim().min(1).max(128).optional(),
        hash: z
          .string()
          .regex(/^[a-f0-9]{16}$/u)
          .optional(),
        exitCode: z.number().int().optional(),
        status: z.literal("completed"),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProjectEvidenceAutomaticToolProvenance = z.infer<
  typeof ProjectEvidenceAutomaticToolProvenanceSchema
>;

const ProjectEvidenceBaseSchema = z
  .object({
    id: ProjectRecordIdSchema,
    subjectType: ProjectEvidenceSubjectTypeSchema,
    subjectId: ProjectRecordIdSchema.optional(),
    kind: ProjectEvidenceKindSchema,
    reference: ProjectTextSchema,
    summary: z.string().trim().max(20_000).optional(),
    observedAt: z.string().min(1),
    provenance: ProjectEvidenceAutomaticToolProvenanceSchema.optional(),
  })
  .strict();

export const ProjectEvidenceSchema = ProjectEvidenceBaseSchema.superRefine((value, context) => {
  if (value.subjectType === "repository" && value.subjectId !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subjectId"],
      message: "repository evidence must not set subjectId",
    });
  }
  if (value.subjectType !== "repository" && value.subjectId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subjectId"],
      message: "task/decision/unknown evidence requires subjectId",
    });
  }
});
export type ProjectEvidence = z.infer<typeof ProjectEvidenceSchema>;

export const ProjectIntelligenceStateSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_INTELLIGENCE_SCHEMA_VERSION),
    version: z.number().int().nonnegative(),
    updatedAt: z.string().min(1),
    tasks: z.array(ProjectTaskSchema),
    decisions: z.array(ProjectDecisionSchema),
    unknowns: z.array(ProjectUnknownSchema),
    evidence: z.array(ProjectEvidenceSchema),
  })
  .strict();
export type ProjectIntelligenceState = z.infer<typeof ProjectIntelligenceStateSchema>;

const ProjectTaskMutationSchema = ProjectTaskSchema.omit({ updatedAt: true });
const ProjectDecisionMutationSchema = ProjectDecisionSchema.omit({ updatedAt: true });
const ProjectUnknownMutationSchema = ProjectUnknownSchema.omit({ updatedAt: true });
const ProjectEvidenceMutationSchema = ProjectEvidenceBaseSchema.omit({
  observedAt: true,
  provenance: true,
}).superRefine((value, context) => {
  if (value.subjectType === "repository" && value.subjectId !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subjectId"],
      message: "repository evidence must not set subjectId",
    });
  }
  if (value.subjectType !== "repository" && value.subjectId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subjectId"],
      message: "task/decision/unknown evidence requires subjectId",
    });
  }
});

export const ProjectStateReadInputSchema = z
  .object({
    query: z.string().trim().max(4_000).optional(),
    limit: z.number().int().min(1).max(50).default(12),
    includeEvidence: z.boolean().default(true),
  })
  .strict();
export type ProjectStateReadInput = z.infer<typeof ProjectStateReadInputSchema>;
export const ProjectStateReadInputJsonSchema = toToolJsonSchema(ProjectStateReadInputSchema);

export const ProjectStateSummarySchema = z
  .object({
    tasks: z.number().int().nonnegative(),
    activeTasks: z.number().int().nonnegative(),
    decisions: z.number().int().nonnegative(),
    openUnknowns: z.number().int().nonnegative(),
    evidence: z.number().int().nonnegative(),
  })
  .strict();
export type ProjectStateSummary = z.infer<typeof ProjectStateSummarySchema>;

export const ProjectStateReadOutputSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_INTELLIGENCE_SCHEMA_VERSION),
    version: z.number().int().nonnegative(),
    updatedAt: z.string().min(1),
    tasks: z.array(ProjectTaskSchema),
    decisions: z.array(ProjectDecisionSchema),
    unknowns: z.array(ProjectUnknownSchema),
    evidence: z.array(ProjectEvidenceSchema),
    summary: ProjectStateSummarySchema,
  })
  .strict();
export type ProjectStateReadOutput = z.infer<typeof ProjectStateReadOutputSchema>;
export const ProjectStateReadOutputJsonSchema = toToolJsonSchema(ProjectStateReadOutputSchema);

const ProjectStateUpdateBaseSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
});

export const ProjectStateUpdateInputSchema = z.discriminatedUnion("operation", [
  ProjectStateUpdateBaseSchema.extend({
    operation: z.literal("upsert_task"),
    task: ProjectTaskMutationSchema,
  }).strict(),
  ProjectStateUpdateBaseSchema.extend({
    operation: z.literal("upsert_decision"),
    decision: ProjectDecisionMutationSchema,
  }).strict(),
  ProjectStateUpdateBaseSchema.extend({
    operation: z.literal("upsert_unknown"),
    unknown: ProjectUnknownMutationSchema,
  }).strict(),
  ProjectStateUpdateBaseSchema.extend({
    operation: z.literal("upsert_evidence"),
    evidence: ProjectEvidenceMutationSchema,
  }).strict(),
]);
export type ProjectStateUpdateInput = z.infer<typeof ProjectStateUpdateInputSchema>;
export const ProjectStateUpdateInputJsonSchema = toToolJsonSchema(ProjectStateUpdateInputSchema);

export const ProjectStateUpdateOutputSchema = z
  .object({
    previousVersion: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
    updatedAt: z.string().min(1),
    operation: z.enum(["upsert_task", "upsert_decision", "upsert_unknown", "upsert_evidence"]),
    recordId: ProjectRecordIdSchema,
    created: z.boolean(),
  })
  .strict();
export type ProjectStateUpdateOutput = z.infer<typeof ProjectStateUpdateOutputSchema>;
export const ProjectStateUpdateOutputJsonSchema = toToolJsonSchema(ProjectStateUpdateOutputSchema);
