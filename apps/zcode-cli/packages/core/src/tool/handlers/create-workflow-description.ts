import { SAVED_WORKFLOW_PROJECT_DIR, WORKFLOW_DRAFTS_DIR } from "@zcode/contracts";

/**
 * CreateWorkflow 的 provider contract。
 *
 * 编译器 facade 不是每轮都需要的调用契约：完整声明由 dynamic-workflows Skill 在模型明确
 * 请求后按需返回。这里保留会影响一次正确调用的规则，避免把参考手册再次复制进工具 schema。
 */
export const CREATE_WORKFLOW_TOOL_DESCRIPTION = [
  "Create and run a new dynamic workflow: a TypeScript script that orchestrates model-driven subagents with ordinary control flow (loops, conditionals, and fan-out).",
  "The script is typechecked first. A clean script opens the user's confirmation gate and then starts in the background; the final top-level return value arrives in a completion notification. Compilation errors are returned as diagnostics and nothing runs.",
  "",
  "When to use:",
  '- Use this tool only when the user explicitly asks for a workflow (for example, "use a workflow" or "使用 workflow"). That request is mandatory routing: do not substitute Agent, do the work inline, or decide that the task is too small.',
  "- This starts a NEW run. To repair, extend, or retune an existing run, use AmendWorkflow with its run ID instead.",
  "",
  "Workflow source — pass exactly one:",
  "- `script`: an inline one-off TypeScript workflow.",
  `- \`saved\`: a named definition from \`${SAVED_WORKFLOW_PROJECT_DIR}/\`; pass its declared values in \`saved.args\` (for example, \`saved: { name: "pr-review", args: { pr: "123" } }\`).`,
  "- `path`: a workspace-relative or absolute script file. Pass `args` only with `path` when the file declares them.",
  `Inline scripts are copied under \`${WORKFLOW_DRAFTS_DIR}/\`; on diagnostics, edit the named file and resubmit with \`path\` instead of pasting the whole script again. Before writing a new script, consider ListSavedWorkflows.`,
  "The user confirms the actual script that will execute. Saved-workflow arguments are validated before execution; unknown keys, missing required values, and wrong types are rejected.",
  "",
  "Required authoring contract:",
  "- Plain TypeScript under strict checking. Use plain `interface`/`type` declarations for `ask<T>` results. No `import`, `export`, or `declare` statements; no Node/web APIs such as `process`, `fetch`, or `fs`.",
  "- Top-level `await` and a final `return <value>` are allowed. The final return is the model-facing report; keep user-facing files and dashboards in `artifact.*` instead of duplicating them in the report.",
  '- Cover the script with standalone `phase("...")` markers. Each phase needs at least one `agent(...).ask(...)` or `world.run(...)`; use human-readable compile-time literal names in the user\'s language.',
  "- Named agents must be unique within a run and stable across revisions. Use `Promise.all` for joins only where the next step needs every result, and keep typed results narrow.",
  "- `world.run` command names must be compile-time string literals. A nonzero exit code is a returned value, while spawn failures, timeouts, and output over the per-stream cap reject; branch on `exitCode` for deterministic gates.",
  "- The runtime owns provider retries and concurrency adaptation. Set `max_concurrency` or `subagent_model` only when the user asks; `subagent_model` changes workflow subagents, not the main session model.",
  "",
  "For complete facade signatures, return types, limits, examples, and snippet-only APIs, load the existing `dynamic-workflows` Skill before authoring complex code. It returns the exact compiler facade on demand; do not guess missing members.",
].join("\n");
