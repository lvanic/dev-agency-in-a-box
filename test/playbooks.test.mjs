// Tests for selectPlaybooks — progressive-disclosure playbook gating (token-optimization).
import test from "node:test";
import assert from "node:assert/strict";

const { selectPlaybooks } = await import("../dist/agents/roles.js");

const DEV = [
  "engineering-principles", "reuse-first", "frontend-atomic-design", "theming",
  "logic-separation", "backend", "database", "how-to-write-tests", "git-workflow",
];
const NON_DOMAIN = ["engineering-principles", "reuse-first", "logic-separation", "git-workflow"];

test("cross-cutting playbooks are always kept, regardless of task", () => {
  const got = selectPlaybooks(DEV, "add a database migration for the users table with a new column");
  for (const p of NON_DOMAIN) assert.ok(got.includes(p), `expected ${p} kept`);
});

test("a database task keeps database, drops frontend/theming", () => {
  const got = selectPlaybooks(DEV, "add a sqlite migration and a new schema table for user sessions");
  assert.ok(got.includes("database"), "database kept");
  assert.ok(!got.includes("frontend-atomic-design"), "frontend dropped");
  assert.ok(!got.includes("theming"), "theming dropped");
});

test("a UI task keeps frontend + theming, drops backend/database", () => {
  const got = selectPlaybooks(DEV, "build the Today screen component with the section picker and dark mode colors");
  assert.ok(got.includes("frontend-atomic-design"), "frontend kept");
  assert.ok(got.includes("theming"), "theming kept");
  assert.ok(!got.includes("backend"), "backend dropped");
  assert.ok(!got.includes("database"), "database dropped");
});

test("a testing task keeps how-to-write-tests", () => {
  const got = selectPlaybooks(DEV, "add jest unit tests and improve coverage for the journal service module");
  assert.ok(got.includes("how-to-write-tests"), "tests playbook kept");
});

test("short / empty / undefined task falls back to ALL playbooks (never under-load)", () => {
  assert.deepEqual(selectPlaybooks(DEV, "fix typo"), DEV);
  assert.deepEqual(selectPlaybooks(DEV, ""), DEV);
  assert.deepEqual(selectPlaybooks(DEV, undefined), DEV);
});

test("a role whose only playbook is a domain one never ends up empty", () => {
  // tester loads only how-to-write-tests; a task with no 'test' keyword must still keep it.
  const got = selectPlaybooks(["how-to-write-tests"], "refactor the geolocation check-in flow for the media picker screen");
  assert.deepEqual(got, ["how-to-write-tests"]);
});
