import type { ProjectStateUpdateInput } from "./project-state.js";

/**
 * Minimal optimistic-concurrency write example for hosts or tools consuming
 * the Project Intelligence contract.
 */
export const projectStateTaskUpdateExample: ProjectStateUpdateInput = {
  expectedVersion: 0,
  operation: "upsert_task",
  task: {
    id: "P1",
    title: "Index the repository",
    status: "in_progress",
    tags: ["repository"],
    relatedPaths: ["src"],
  },
};
