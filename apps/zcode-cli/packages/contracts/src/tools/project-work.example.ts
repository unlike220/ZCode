import type { ProjectWorkUpdateInput } from "./project-work.js";

export const projectWorkBeginExample = {
  expectedVersion: 0,
  operation: "begin",
  work: {
    id: "phase-3",
    objective: "Add controlled coding scope enforcement",
    scope: [
      {
        path: "apps/zcode-cli/packages/core/src/project-intelligence",
        recursive: true,
      },
    ],
  },
} satisfies ProjectWorkUpdateInput;
