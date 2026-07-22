// Tests for the per-issue run thread (P1, prime-time-plan) — DB-first store + badge reconstruction.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "run-msgs-")), "agency.db");
const { getDb } = await import("../dist/db/connection.js");
getDb();
const { appendRunMsg, listRunThread, hasRunThread, renderBadge } = await import("../dist/db/run_msgs.js");

test("appendRunMsg + listRunThread round-trip, oldest-first, repo+issue scoped", () => {
  appendRunMsg("acme/app", 7, "run-1", "planner", "comment", "Plan the work.");
  appendRunMsg("acme/app", 7, "run-1", "developer", "comment", "Implementing now.");
  appendRunMsg("acme/app", 8, "run-2", "developer", "comment", "Different issue.");
  appendRunMsg("other/repo", 7, "run-3", "developer", "comment", "Different repo, same number.");

  const t = listRunThread("acme/app", 7);
  assert.equal(t.length, 2);
  assert.equal(t[0].agent, "planner", "oldest first");
  assert.equal(t[1].agent, "developer");
  assert.equal(t[1].body, "Implementing now.");
  assert.equal(t[0].runId, "run-1");

  assert.equal(listRunThread("acme/app", 8).length, 1);
  assert.equal(listRunThread("other/repo", 7).length, 1);
});

test("hasRunThread is false until the first append, then true", () => {
  assert.equal(hasRunThread("acme/app", 99), false);
  appendRunMsg("acme/app", 99, "run-x", "tester", "comment", "Running checks.");
  assert.equal(hasRunThread("acme/app", 99), true);
});

test("listRunThread respects its limit (most recent N, still oldest-first)", () => {
  for (let i = 0; i < 5; i++) appendRunMsg("acme/limits", 1, "run-l", "developer", "comment", `msg ${i}`);
  const limited = listRunThread("acme/limits", 1, 2);
  assert.equal(limited.length, 2);
  assert.equal(limited[0].body, "msg 3");
  assert.equal(limited[1].body, "msg 4");
});

test("meta round-trips as parsed JSON; absent meta is null", () => {
  appendRunMsg("acme/meta", 1, "run-m", "developer", "comment", "with meta", { files: ["a.ts"] });
  appendRunMsg("acme/meta", 1, "run-m", "developer", "comment", "no meta");
  const rows = listRunThread("acme/meta", 1);
  assert.deepEqual(rows[0].meta, { files: ["a.ts"] });
  assert.equal(rows[1].meta, null);
});

test("renderBadge: known role gets its dedicated emoji; unknown/custom agent gets the generic 🤖", () => {
  assert.equal(renderBadge("planner"), "🧠 **Planner** · _dev-agency_");
  assert.equal(renderBadge("developer"), "💻 **Developer** · _dev-agency_");
  assert.equal(renderBadge("grill-me"), "🤖 **Grill-me** · _dev-agency_");
});
