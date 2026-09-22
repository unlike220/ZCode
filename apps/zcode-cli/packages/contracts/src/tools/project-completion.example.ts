import type { ProjectCompletionUpdateInput } from "./project-completion.js";

export const projectCompletionContractExample = {
  expectedVersion: 0,
  operation: "upsert_contract",
  contract: {
    taskId: "phase-3.5",
    title: "Completion contract",
    criteria: [
      {
        id: "blocking-unknowns",
        kind: "blocking_unknowns_resolved",
      },
      {
        id: "tests",
        kind: "task_evidence",
        evidenceKinds: ["test"],
        minimumCount: 1,
        evidenceSource: "automatic",
      },
    ],
  },
} satisfies ProjectCompletionUpdateInput;
