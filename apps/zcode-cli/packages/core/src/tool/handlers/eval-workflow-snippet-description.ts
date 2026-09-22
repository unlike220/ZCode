/** Provider contract for the synchronous, ephemeral Dynamic Workflow workbench. */
export const EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION = [
  "Compile and run a small Dynamic Workflow TypeScript snippet synchronously against the same compiler, sandbox, and world-read path used by a real workflow.",
  "Use it to test fixed logic before composing CreateWorkflow: parsers, filters, glob/grep behavior, gate predicates, or real command output shapes. It is not orchestration; `agent()`, `ask()`, `report()`, and artifacts belong to a real workflow.",
  "",
  "Input and execution contract:",
  "- Pass exactly one source: `code` inline, or `path` to a workspace-relative/absolute file. The whole file is evaluated; a path is read before confirmation and diagnostics identify its lines.",
  "- Use plain strict TypeScript with top-level `await` and a final `return`. No imports, exports, ambient `declare`, Node/web APIs, agent orchestration, or artifact/report APIs.",
  "- `world.run` command names must be compile-time string literals. Nonzero exit codes are values; spawn failures, timeouts, or output over the cap reject. A snippet containing `world.run` asks the user for confirmation.",
  "- Nothing is persisted and no background task is created. Logs preserve order in the result. The default wall clock is 60 seconds (up to 600 seconds); keep the returned value small. Diagnostics mean nothing executed—fix the snippet and call again.",
  "",
  "For exact facade members, return types, and limits, load the existing `dynamic-workflows` Skill. It provides the compiler's full and snippet facades on demand; this tool keeps only the invocation contract in every request.",
].join("\n");
