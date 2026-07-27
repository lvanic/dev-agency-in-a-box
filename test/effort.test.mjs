// Tests for per-role thinking effort (token-optimization): mechanical roles lowered, judgment roles default.
import test from "node:test";
import assert from "node:assert/strict";

const { ROLES, effortFor } = await import("../dist/agents/roles.js");

test("mechanical roles are lowered below the SDK default", () => {
  assert.equal(ROLES.tester.effort, "low");
  assert.equal(ROLES.librarian.effort, "low");
  assert.equal(ROLES.analyzer.effort, "low");
  assert.equal(ROLES.decomposer.effort, "medium");
});

test("judgment roles keep the SDK default (undefined = high)", () => {
  for (const r of ["developer", "architect", "reviewer", "planner", "auditor"]) {
    assert.equal(ROLES[r].effort, undefined, `${r} should not lower effort`);
  }
});

test("effortFor returns the role's setting by default", () => {
  assert.equal(effortFor(ROLES.tester), "low");
  assert.equal(effortFor(ROLES.developer), undefined);
});

test("AGENT_EFFORT env forces a floor for all roles", () => {
  const prev = process.env.AGENT_EFFORT;
  try {
    process.env.AGENT_EFFORT = "low";
    assert.equal(effortFor(ROLES.developer), "low", "env forces developer to low");
    assert.equal(effortFor(ROLES.tester), "low");
    process.env.AGENT_EFFORT = "bogus";
    assert.equal(effortFor(ROLES.developer), undefined, "invalid env ignored → role default");
  } finally {
    if (prev === undefined) delete process.env.AGENT_EFFORT; else process.env.AGENT_EFFORT = prev;
  }
});
