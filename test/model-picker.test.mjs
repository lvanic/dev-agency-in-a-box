// Pure-function tests for the auth-gated model picker helpers in web/lib/model-logic.js.
// These are dependency-free pure functions, so they're imported directly — no jsdom/vendor
// rewriting needed.
import test from "node:test";
import assert from "node:assert/strict";
import { providerModelOptions, anyModelSetUp, modelAvailability } from "../web/lib/model-logic.js";

const P = (over) => Object.assign({ id: "p", name: "P", baseUrl: "u", apiKey: "k", models: ["m1", "m2"] }, over);

test("providerModelOptions: only authenticated providers contribute models", () => {
  const providers = [
    P({ id: "a", name: "Authed", auth: "apiKey" }),
    P({ id: "s", name: "Sub", auth: "subscription" }),
    P({ id: "x", name: "Missing", auth: "missing", models: ["secret-model"] }),
    P({ id: "n", name: "NoAuthField", models: ["orphan"] }), // treated as not authenticated
  ];
  const opts = providerModelOptions(providers);
  const values = opts.map((o) => o.value);
  assert.ok(values.includes("a/m1") && values.includes("a/m2"), "apiKey provider's models appear");
  assert.ok(values.includes("s/m1"), "subscription provider's models appear");
  assert.ok(!values.includes("x/secret-model"), "a missing-auth provider's models are HIDDEN");
  assert.ok(!values.includes("n/orphan"), "a provider with no auth field is treated as unauthenticated");
});

test("anyModelSetUp: requires an authenticated provider with models OR a Claude credential", () => {
  assert.equal(anyModelSetUp({ providers: [], secretKeys: [] }), false, "nothing configured → false");
  assert.equal(anyModelSetUp({ providers: [P({ auth: "missing", models: ["m"] })], secretKeys: [] }), false, "keyless provider does not count");
  assert.equal(anyModelSetUp({ providers: [P({ auth: "apiKey", models: ["m"] })], secretKeys: [] }), true, "authenticated provider counts");
  assert.equal(anyModelSetUp({ providers: [], secretKeys: ["claude_token"] }), true, "saved Claude token counts");
});

test("modelAvailability: flags a stale model and suggests the closest substitute", () => {
  const providers = [P({ id: "g", name: "GLM", auth: "apiKey", models: ["glm-4.6"], tiers: { medium: { model: "glm-4.6", fallback: "" } } })];
  assert.deepEqual(modelAvailability("g/glm-4.6", providers), { available: true, substitute: null }, "present model is available");
  const stale = modelAvailability("g/glm-deleted", providers);
  assert.equal(stale.available, false, "missing model is flagged unavailable");
  assert.equal(stale.substitute, "glm-4.6", "suggests the tier model as substitute");
  assert.deepEqual(modelAvailability("ghost/whatever", providers), { available: true, substitute: null }, "unknown provider → treat as available (not our problem to flag)");
});
