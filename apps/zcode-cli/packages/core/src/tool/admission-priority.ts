import type { ModelToolAdmissionPriority } from "@zcode/contracts";
import type { ToolMetadata } from "./types.js";

const MANDATORY_TOOL_NAMES = new Set([
  "Read",
  "Write",
  "Edit",
  "Bash",
  "ExitPlanMode",
  "RespondToCoordinator",
  "submit_result",
  "escalate",
]);

const HIGH_TOOL_NAMES = new Set([
  "Glob",
  "Grep",
  "Skill",
  "AskUserQuestion",
  "SendMessage",
  "TaskOutput",
  "TaskStop",
  "ResolveWorkflowQuestion",
  // Keep the primary Dynamic Workflow entrypoint discoverable under pressure;
  // secondary workflow management/reference tools remain optional until lazy discovery.
  "CreateWorkflow",
]);

const OPTIONAL_TOOL_NAMES = new Set([
  "WebFetch",
  "WebSearch",
  "CronCreate",
  "CronList",
  "CronUpdate",
  "CronDelete",
  "OffPeakCreate",
  "OffPeakList",
  "js",
  "AmendWorkflow",
  "SaveWorkflow",
  "EvalWorkflowSnippet",
  "ListWorkflowRuns",
  "GetWorkflowRun",
  "ResumeWorkflowRun",
  "ListSavedWorkflows",
  "ListModels",
]);

export function resolveToolAdmissionPriority(metadata: ToolMetadata): ModelToolAdmissionPriority {
  if (metadata.admissionPriority) return metadata.admissionPriority;

  // MCP discovery stays fully initialized. Only its per-request provider schema
  // is optional under context pressure; no server/tool identity is hard-coded.
  if (metadata.mcpPresentation) return "optional";

  if (MANDATORY_TOOL_NAMES.has(metadata.name)) return "mandatory";
  if (HIGH_TOOL_NAMES.has(metadata.name)) return "high";
  if (OPTIONAL_TOOL_NAMES.has(metadata.name)) return "optional";
  return "normal";
}
