import assert from "node:assert/strict";
import test from "node:test";
import { sessionHasLoadedSkill } from "../src/agent/loaded-skills.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import {
  amendWorkflowNeedsSkill,
  createWorkflowNeedsSkill,
  requireDynamicWorkflowSkill,
  WORKFLOW_SKILL_NOT_LOADED_CODE,
} from "../src/tool/handlers/workflow-skill-gate.js";

const call = {
  message: {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "skill-1", name: "Skill", input: { skill: "dynamic-workflows" } }],
  },
} satisfies RuntimeMessageEntry;
const success = {
  message: {
    role: "tool",
    content: "loaded",
    toolCallId: "skill-1",
  },
} satisfies RuntimeMessageEntry;

test("only a successful Skill result still in visible history opens the authoring gate", () => {
  assert.equal(sessionHasLoadedSkill([call], "dynamic-workflows"), false);
  assert.equal(
    sessionHasLoadedSkill(
      [{ ...success, message: { ...success.message, isError: true } }, call],
      "dynamic-workflows",
    ),
    false,
  );
  assert.equal(sessionHasLoadedSkill([call, success], "dynamic-workflows"), true);
  assert.equal(sessionHasLoadedSkill([success], "dynamic-workflows"), false);
  assert.equal(sessionHasLoadedSkill([call, success], "other-skill"), false);

  const gate = requireDynamicWorkflowSkill(
    {
      hasLoadedSkill: (name) => sessionHasLoadedSkill([call], name),
    },
    "CreateWorkflow",
  );
  assert.equal(gate?.errorCode, WORKFLOW_SKILL_NOT_LOADED_CODE);
  assert.equal(
    requireDynamicWorkflowSkill(
      {
        hasLoadedSkill: (name) => sessionHasLoadedSkill([call, success], name),
      },
      "CreateWorkflow",
    ),
    undefined,
  );
});

test("saved runs and settings-only retunes need no authoring Skill", () => {
  assert.equal(createWorkflowNeedsSkill({ saved: { name: "review" } }), false);
  assert.equal(createWorkflowNeedsSkill({ script: "return 1" }), true);
  assert.equal(createWorkflowNeedsSkill({ path: "draft.dwf.ts" }), true);
  assert.equal(amendWorkflowNeedsSkill({ run_id: "run-1", max_concurrency: 2 }), false);
  assert.equal(amendWorkflowNeedsSkill({ run_id: "run-1", script: "return 1" }), true);
});
