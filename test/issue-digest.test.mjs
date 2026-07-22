// Tests for the deterministic (no-LLM) per-issue digest (P1, prime-time-plan) — upserted on every
// run_msg append from whatever's already recorded: lifecycle phase, latest review verdict, files.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "issue-digest-")), "agency.db");
const { getDb } = await import("../dist/db/connection.js");
getDb();
const { buildDigest, upsertIssueDigest, getIssueDigest } = await import("../dist/db/issue_digest.js");
const { recordIssueStatus, recordIssueFiles } = await import("../dist/db/issues.js");
const { recordReview } = await import("../dist/db/reviews.js");
const { withStatus, setBlocked } = await import("../dist/state.js");

test("buildDigest is pure (no LLM): reflects state, verdict and files as they stand", () => {
  recordIssueStatus("acme/app", 1, withStatus("working"));
  const bare = buildDigest("acme/app", 1);
  assert.match(bare, /^working/);

  recordIssueFiles("acme/app", 1, ["src/a.ts", "src/b.ts"]);
  const withFiles = buildDigest("acme/app", 1);
  assert.match(withFiles, /files: src\/a\.ts, src\/b\.ts/);

  recordReview("acme/app", 1, "changes", "needs a fix");
  const withVerdict = buildDigest("acme/app", 1);
  assert.match(withVerdict, /changes requested/);
});

test("buildDigest folds in the triggering message (agent + snippet) when given", () => {
  const d = buildDigest("acme/msg", 2, "tester", "  All checks passed.  \n\nnext line");
  assert.match(d, /tester/);
  assert.match(d, /All checks passed\. next line/); // whitespace collapsed
});

test("buildDigest surfaces the blocked reason alongside state", () => {
  recordIssueStatus("acme/blocked", 3, setBlocked(withStatus("working"), "needsAttention"));
  assert.match(buildDigest("acme/blocked", 3), /^working\/needsAttention/);
});

test("buildDigest never exceeds 300 chars", () => {
  const huge = "x".repeat(2000);
  const d = buildDigest("acme/long", 4, "developer", huge);
  assert.ok(d.length <= 300);
});

test("upsertIssueDigest persists + is readable via getIssueDigest; re-upsert overwrites in place", () => {
  assert.equal(getIssueDigest("acme/persist", 5), null);
  recordIssueStatus("acme/persist", 5, withStatus("working"));
  const d1 = upsertIssueDigest("acme/persist", 5, "planner", "Planning the work.");
  assert.equal(getIssueDigest("acme/persist", 5), d1);

  recordIssueStatus("acme/persist", 5, withStatus("review"));
  const d2 = upsertIssueDigest("acme/persist", 5, "reviewer", "Looks good.");
  assert.notEqual(d2, d1);
  assert.equal(getIssueDigest("acme/persist", 5), d2, "overwritten, not appended");
});
