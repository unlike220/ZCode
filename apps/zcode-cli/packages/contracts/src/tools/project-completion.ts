import { z } from "zod";
import { ProjectEvidenceKindSchema } from "./project-state.js";
import { toToolJsonSchema } from "./json-schema.js";

export const PROJECT_COMPLETION_SCHEMA_VERSION = 1 as const;
export const PROJECT_COMPLETION_MAX_CONTRACTS = 100 as const;
export const PROJECT_COMPLETION_MAX_CRITERIA = 50 as const;

const RecordIdSchema = z.string().trim().min(1).max(120);
const CriterionIdSchema = z.string().trim().min(1).max(120);
const TitleSchema = z.string().trim().min(1).max(500);
const UnknownIdsSchema = z
  .array(RecordIdSchema)
  .min(1)
  .max(100)
  .superRefine((values, context) => addDuplicateIssues(values, context, "unknown id"));
const EvidenceKindsSchema = z
  .array(ProjectEvidenceKindSchema)
  .min(1)
  .max(10)
  .superRefine((values, context) => addDuplicateIssues(values, context, "evidence kind"));

const CriterionCommon = {
  id: CriterionIdSchema,
  label: TitleSchema.optional(),
} as const;

export const ProjectCompletionCriterionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...CriterionCommon,
      kind: z.literal("blocking_unknowns_resolved"),
    })
    .strict(),
  z
    .object({
      ...CriterionCommon,
      kind: z.literal("required_unknowns_resolved"),
      unknownIds: UnknownIdsSchema,
    })
    .strict(),
  z
    .object({
      ...CriterionCommon,
      kind: z.literal("task_evidence"),
      evidenceKinds: EvidenceKindsSchema,
      minimumCount: z.number().int().min(1).max(100),
      evidenceSource: z.enum(["any", "automatic"]).optional(),
    })
    .strict(),
  z
    .object({
      ...CriterionCommon,
      kind: z.literal("no_open_project_work"),
    })
    .strict(),
]);
export type ProjectCompletionCriterion = z.infer<typeof ProjectCompletionCriterionSchema>;

const ProjectCompletionContractMutationSchema = z
  .object({
    taskId: RecordIdSchema,
    title: TitleSchema.optional(),
    criteria: z.array(ProjectCompletionCriterionSchema).min(1).max(PROJECT_COMPLETION_MAX_CRITERIA),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.criteria.map((criterion) => criterion.id),
      context,
      "criterion id",
      ["criteria"],
    );
  });
export type ProjectCompletionContractMutation = z.infer<
  typeof ProjectCompletionContractMutationSchema
>;

export const ProjectCompletionContractSchema = z
  .object({
    taskId: RecordIdSchema,
    title: TitleSchema.optional(),
    criteria: z.array(ProjectCompletionCriterionSchema).min(1).max(PROJECT_COMPLETION_MAX_CRITERIA),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.criteria.map((criterion) => criterion.id),
      context,
      "criterion id",
      ["criteria"],
    );
  });
export type ProjectCompletionContract = z.infer<typeof ProjectCompletionContractSchema>;

export const ProjectCompletionStateSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_COMPLETION_SCHEMA_VERSION),
    version: z.number().int().nonnegative(),
    updatedAt: z.string().min(1),
    contracts: z.array(ProjectCompletionContractSchema).max(PROJECT_COMPLETION_MAX_CONTRACTS),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.contracts.map((contract) => contract.taskId),
      context,
      "task contract",
      ["contracts"],
    );
  });
export type ProjectCompletionState = z.infer<typeof ProjectCompletionStateSchema>;

export const ProjectCompletionCriterionResultSchema = z
  .object({
    id: CriterionIdSchema,
    kind: z.enum([
      "blocking_unknowns_resolved",
      "required_unknowns_resolved",
      "task_evidence",
      "no_open_project_work",
    ]),
    status: z.enum(["pass", "fail"]),
    summary: z.string().trim().min(1).max(4_000),
  })
  .strict();
export type ProjectCompletionCriterionResult = z.infer<
  typeof ProjectCompletionCriterionResultSchema
>;

export const ProjectCompletionEvaluationSchema = z
  .object({
    taskId: RecordIdSchema,
    configured: z.boolean(),
    status: z.enum(["ready", "not_ready", "not_configured"]),
    evaluatedAt: z.string().min(1),
    criteria: z.array(ProjectCompletionCriterionResultSchema).max(PROJECT_COMPLETION_MAX_CRITERIA),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();
export type ProjectCompletionEvaluation = z.infer<typeof ProjectCompletionEvaluationSchema>;

export const ProjectCompletionReadInputSchema = z
  .object({
    taskId: RecordIdSchema.optional(),
    includeEvaluation: z.boolean().default(true),
  })
  .strict();
export type ProjectCompletionReadInput = z.infer<typeof ProjectCompletionReadInputSchema>;
export const ProjectCompletionReadInputJsonSchema = toToolJsonSchema(
  ProjectCompletionReadInputSchema,
);

export const ProjectCompletionReadOutputSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_COMPLETION_SCHEMA_VERSION),
    version: z.number().int().nonnegative(),
    updatedAt: z.string().min(1),
    contracts: z.array(ProjectCompletionContractSchema).max(PROJECT_COMPLETION_MAX_CONTRACTS),
    evaluation: ProjectCompletionEvaluationSchema.optional(),
  })
  .strict();
export type ProjectCompletionReadOutput = z.infer<typeof ProjectCompletionReadOutputSchema>;
export const ProjectCompletionReadOutputJsonSchema = toToolJsonSchema(
  ProjectCompletionReadOutputSchema,
);

const CompletionUpdateBaseSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
});

export const ProjectCompletionUpdateInputSchema = z.discriminatedUnion("operation", [
  CompletionUpdateBaseSchema.extend({
    operation: z.literal("upsert_contract"),
    contract: ProjectCompletionContractMutationSchema,
  }).strict(),
  CompletionUpdateBaseSchema.extend({
    operation: z.literal("remove_contract"),
    taskId: RecordIdSchema,
  }).strict(),
]);
export type ProjectCompletionUpdateInput = z.infer<typeof ProjectCompletionUpdateInputSchema>;
export const ProjectCompletionUpdateInputJsonSchema = toToolJsonSchema(
  ProjectCompletionUpdateInputSchema,
);

export const ProjectCompletionUpdateOutputSchema = z
  .object({
    previousVersion: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
    updatedAt: z.string().min(1),
    operation: z.enum(["upsert_contract", "remove_contract"]),
    taskId: RecordIdSchema,
    created: z.boolean().optional(),
  })
  .strict();
export type ProjectCompletionUpdateOutput = z.infer<typeof ProjectCompletionUpdateOutputSchema>;
export const ProjectCompletionUpdateOutputJsonSchema = toToolJsonSchema(
  ProjectCompletionUpdateOutputSchema,
);

export const ProjectCompletionEvaluateInputSchema = z
  .object({
    taskId: RecordIdSchema,
  })
  .strict();
export type ProjectCompletionEvaluateInput = z.infer<typeof ProjectCompletionEvaluateInputSchema>;
export const ProjectCompletionEvaluateInputJsonSchema = toToolJsonSchema(
  ProjectCompletionEvaluateInputSchema,
);
export const ProjectCompletionEvaluateOutputSchema = ProjectCompletionEvaluationSchema;
export type ProjectCompletionEvaluateOutput = z.infer<typeof ProjectCompletionEvaluateOutputSchema>;
export const ProjectCompletionEvaluateOutputJsonSchema = toToolJsonSchema(
  ProjectCompletionEvaluateOutputSchema,
);

function addDuplicateIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  label: string,
  pathPrefix: Array<string | number> = [],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, index],
        message: `Duplicate ${label}: ${value}`,
      });
      return;
    }
    seen.add(value);
  });
}
