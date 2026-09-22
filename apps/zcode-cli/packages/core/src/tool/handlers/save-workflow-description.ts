import { SAVED_WORKFLOW_GLOBAL_DIR, SAVED_WORKFLOW_PROJECT_DIR } from "@zcode/contracts";

/** Provider contract for persisting a reusable Dynamic Workflow definition. */
export const SAVE_WORKFLOW_TOOL_DESCRIPTION = [
  "Save a dynamic-workflow TypeScript script as a reusable definition. The required `scope` chooses project or global storage; the definition can later be run by name with CreateWorkflow and discovered with ListSavedWorkflows.",
  `Project definitions are saved under \`${SAVED_WORKFLOW_PROJECT_DIR}/<name>.dwf.ts\` and are visible in that project. Global definitions are saved under \`~/${SAVED_WORKFLOW_GLOBAL_DIR}/<name>.dwf.ts\` and are available from every project on this machine.`,
  "",
  'Use this tool only after the user agrees. If a newly written workflow merely looks reusable, suggest what would be saved and why, then wait; an explicit request such as "save this workflow" is agreement.',
  "",
  "Input and persistence rules:",
  "- Pass exactly one source: `script` for inline TypeScript, or `script_path` for an existing working draft named by a CreateWorkflow or AmendWorkflow result. A `script_path` file's workflow metadata block is discarded; the fields in this call supply the saved metadata.",
  "- `description` is required. `whenToUse` is optional guidance for future callers. Declare only reusable `args` (each has a `type` of `string`, `number`, `boolean`, or `json`, with optional description, required flag, and default). CreateWorkflow validates callers against that declaration before running.",
  "- Saving an existing name REPLACES that definition. The confirmation shows the destination and whether this is an overwrite; choose the name deliberately.",
  "- The script is typechecked before the confirmation and before any file is written. Errors return diagnostics and nothing is saved. A successful save returns the path and the exact CreateWorkflow invocation shape.",
  "",
  'The script uses the same authoring contract as CreateWorkflow: strict plain TypeScript, no imports/exports/ambient `declare`, no Node/web APIs, a final return, and human-readable standalone `phase("...")` markers with an ask or deterministic `world.run` in every phase.',
  "For complete facade signatures, limits, examples, and the exact compiler reference, load the existing `dynamic-workflows` Skill before authoring complex code. The facade is available there on demand and is not duplicated in this tool description.",
].join("\n");
