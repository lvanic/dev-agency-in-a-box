// Epics: completing an epic (all sub-issues done) moves the parent to "done" — #240.
// Previously the auto-detected completion parked the epic in "review"; it should be terminal.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "epics-")), "agency.db");
const { getDb } = await import("../dist/db/connection.js");
getDb();

const { reconcileEpics } = await import("../dist/epics.js");
const { addEpicChild, updateEpicChild } = await import("../dist/db/epic_tables.js");
const { recordIssueStatus, getIssueStatus } = await import("../dist/store.js");
const { withStatus } = await import("../dist/state.js");
const { maybeTripCircuit } = await import("../dist/github.js");

// Stub every gh() call (clone/close/comment) to fail fast + deterministically offline — the
// completion must NOT depend on GitHub writes succeeding (they're all best-effort .catch'd).
maybeTripCircuit(["issue", "comment"], new Error("API rate limit exceeded for installation ID 1."));

const REPO = "acme/app";
const thread = (number, closed) => ({ number, closed });

test("reconcileEpics completes an epic → done when all sub-issues are done", async () => {
  const parent = 500, child = 501;
  recordIssueStatus(REPO, parent, withStatus("working"));
  addEpicChild(REPO, parent, child, "Sub work");
  // Child is merged/done — both the DB lifecycle and the epic-table row reflect it.
  recordIssueStatus(REPO, child, withStatus("done"));
  updateEpicChild(REPO, parent, child, "done", true);

  await reconcileEpics(REPO, new Map([[parent, thread(parent, false)], [child, thread(child, true)]]));

  assert.equal(getIssueStatus(REPO, parent).state, "done", "a finished epic lands in done, not review");
});

test("reconcileEpics leaves an epic alone while sub-issues are still open", async () => {
  const parent = 510, child = 511;
  recordIssueStatus(REPO, parent, withStatus("working"));
  addEpicChild(REPO, parent, child, "Sub work");
  recordIssueStatus(REPO, child, withStatus("working"));

  await reconcileEpics(REPO, new Map([[parent, thread(parent, false)], [child, thread(child, false)]]));

  assert.equal(getIssueStatus(REPO, parent).state, "working", "not done until every sub-issue is done");
});

test("reconcileEpics marks the epic done even when the integration review can't run (offline)", async () => {
  // The review path (cloneRepo + runRole) throws here — completion must still stick. The done
  // transition lives in reconcileEpics, gated only on sub-issues being done (#240).
  const parent = 520, child = 521;
  recordIssueStatus(REPO, parent, withStatus("working"));
  addEpicChild(REPO, parent, child, "Sub work");
  recordIssueStatus(REPO, child, withStatus("done"));
  updateEpicChild(REPO, parent, child, "done", true);

  await reconcileEpics(REPO, new Map([[parent, thread(parent, false)], [child, thread(child, true)]]));

  assert.equal(getIssueStatus(REPO, parent).state, "done");
});
