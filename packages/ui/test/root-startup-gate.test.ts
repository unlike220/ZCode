import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldEnableProviderAvailabilityLoginEntryGuard,
  shouldResolveProviderStartupState,
} from "../src/lib/rootStartupGate.js";

test("Z.AI account login is optional at startup", () => {
  assert.equal(shouldEnableProviderAvailabilityLoginEntryGuard(), false);
});

test("provider startup still waits for local provider state hydration", () => {
  assert.equal(
    shouldResolveProviderStartupState({
      providerStartupSyncPending: true,
      providerAvailabilityStartupCheckCompleted: true,
    }),
    true,
  );
  assert.equal(
    shouldResolveProviderStartupState({
      providerStartupSyncPending: false,
      providerAvailabilityStartupCheckCompleted: true,
    }),
    false,
  );
});
