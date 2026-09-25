import assert from "node:assert/strict";
import test from "node:test";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";
import { listProtocolSlashCommands } from "../src/zcode-protocol/slash-commands.js";
import { resolveSessionDynamicWorkflowEnabled } from "../src/zcode-protocol/dynamic-workflow-policy.js";

test("workflow prompt expansion requires explicit enablement", () => {
  assert.equal(resolveZCodeBuiltinPromptCommand("/workflow test"), undefined);
  assert.equal(
    resolveZCodeBuiltinPromptCommand("/workflow test", { dynamicWorkflowEnabled: false }),
    undefined,
  );

  const enabled = resolveZCodeBuiltinPromptCommand("/workflow test", {
    dynamicWorkflowEnabled: true,
  });
  assert.equal(typeof enabled, "string");
  assert.match(enabled ?? "", /workflow/i);
});

test("session override presence wins over Host Dynamic Workflow policy", () => {
  assert.equal(resolveSessionDynamicWorkflowEnabled(undefined, false), false);
  assert.equal(resolveSessionDynamicWorkflowEnabled(undefined, true), true);
  assert.equal(resolveSessionDynamicWorkflowEnabled(true, false), true);
  assert.equal(resolveSessionDynamicWorkflowEnabled(false, true), false);
});

test("workflow slash catalog requires explicit enablement", async () => {
  const omitted = await listProtocolSlashCommands();
  const disabled = await listProtocolSlashCommands({ dynamicWorkflowEnabled: false });
  const enabled = await listProtocolSlashCommands({ dynamicWorkflowEnabled: true });

  assert.equal(
    omitted.some((command) => command.name === "workflow"),
    false,
  );
  assert.equal(
    disabled.some((command) => command.name === "workflow"),
    false,
  );
  assert.equal(
    enabled.some((command) => command.name === "workflow"),
    true,
  );
});
