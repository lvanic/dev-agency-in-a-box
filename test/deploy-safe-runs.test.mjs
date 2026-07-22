// Deploy-safe runs: the interruption marker (write/read/clear + crash-loop attempt cap), the
// self-merge quiet-window hold queue, and their pure decision functions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "deploy-safe-")), "agency.db");
const { getDb } = await import("../dist/db/connection.js");
getDb();
const {
  markInterrupted,
  listInterrupted,
  bumpInterruptedAttempts,
  clearInterrupted,
  holdUpdate,
  listHeldUpdates,
  clearHeldUpdate,
} = await import("../dist/db/deploy.js");
const { shouldHoldSelfMerge, shouldAutoResumeMarker, flushHeldUpdatesIfQuiet } = await import("../dist/deploySafety.js");
const { dispatch, poolStatus } = await import("../dist/pool.js");
const { addEpicChild, listEpicChildren } = await import("../dist/db/epic_tables.js");
const { mergeEpic } = await import("../dist/epics.js");
const { maybeTripCircuit } = await import("../dist/github.js");
const { getIssueStatus, recordIssueStatus } = await import("../dist/store.js");
const { withStatus } = await import("../dist/state.js");

// ── interrupted_runs marker ──────────────────────────────────────────────────────────────────────

test("interrupted-run marker: write, read, clear", () => {
  assert.equal(listInterrupted().length, 0);
  markInterrupted("acme/app", 42, "deploy");
  const rows = listInterrupted();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].repo, "acme/app");
  assert.equal(rows[0].number, 42);
  assert.equal(rows[0].reason, "deploy");
  assert.equal(rows[0].attempts, 0);
  clearInterrupted("acme/app", 42);
  assert.equal(listInterrupted().length, 0);
});

test("shouldAutoResumeMarker: pure attempt-cap check", () => {
  assert.equal(shouldAutoResumeMarker(0), true, "first attempt always allowed");
  assert.equal(shouldAutoResumeMarker(1), false, "default cap is 1");
  assert.equal(shouldAutoResumeMarker(0, 2), true);
  assert.equal(shouldAutoResumeMarker(1, 2), true, "custom higher cap");
  assert.equal(shouldAutoResumeMarker(2, 2), false);
});

test("interrupted-run marker: attempts cap guards a crash loop", () => {
  markInterrupted("acme/app", 7);
  let row = listInterrupted().find((r) => r.number === 7);
  assert.equal(shouldAutoResumeMarker(row.attempts), true, "fresh marker — eligible for auto-resume");
  bumpInterruptedAttempts("acme/app", 7); // boot-side processing acted on it
  row = listInterrupted().find((r) => r.number === 7);
  assert.equal(row.attempts, 1);
  assert.equal(shouldAutoResumeMarker(row.attempts), false, "already attempted once — a second interruption is a crash loop, park instead");
  clearInterrupted("acme/app", 7);
});

test("markInterrupted does not reset attempts on a re-write of the same marker", () => {
  markInterrupted("acme/app", 9);
  bumpInterruptedAttempts("acme/app", 9);
  markInterrupted("acme/app", 9, "deploy"); // e.g. a second SIGTERM before boot-processing ever ran
  const row = listInterrupted().find((r) => r.number === 9);
  assert.equal(row.attempts, 1, "attempts survives a re-write — only the boot-side processing bumps it");
  clearInterrupted("acme/app", 9);
});

// Regression for the fix where autoResumeInterrupted's `finally { clearInterrupted(...) }` cleared
// the marker milliseconds after dispatch (which only ENQUEUES the resumed run) — so a second
// interruption arriving before that resumed run ever finished always reinserted at attempts=0 and
// the crash-loop guard never engaged. This models the full sequence end to end using the same
// exported primitives runner.ts's autoResumeInterrupted / gracefulShutdown / activity.ts's
// clearActive actually call, without needing the full pipeline.
test("interrupted-run marker: interrupt -> auto-resume -> interrupted again -> next boot parks (no further resume)", () => {
  const repo = "acme/app", n = 55;
  // First deploy interrupts it.
  markInterrupted(repo, n, "deploy");
  let row = listInterrupted().find((r) => r.number === n);
  assert.equal(row.attempts, 0);
  assert.equal(shouldAutoResumeMarker(row.attempts), true, "fresh marker — boot auto-resumes it");
  // Boot-side processing: bump BEFORE dispatching, and — per the fix — do NOT clear the row just
  // because forceResume's dispatch() call returned (dispatch only enqueues the work).
  bumpInterruptedAttempts(repo, n);
  // Before the resumed run ever reaches activity.ts's clearActive (i.e. before it finishes), a
  // SECOND deploy interrupts the very same issue again.
  markInterrupted(repo, n, "deploy");
  row = listInterrupted().find((r) => r.number === n);
  assert.equal(row.attempts, 1, "attempts survived the second interruption — the row was never cleared");
  // Next boot reads this marker: it's now exhausted, so it parks instead of auto-resuming again.
  assert.equal(shouldAutoResumeMarker(row.attempts), false, "crash-loop guard trips");
  clearInterrupted(repo, n); // parking clears the marker (see runner.ts's exhausted branch)
  assert.equal(listInterrupted().find((r) => r.number === n), undefined);
});

test("interrupted-run marker: cleared once the resumed run completes normally (no second interruption)", () => {
  const repo = "acme/app", n = 56;
  markInterrupted(repo, n, "deploy");
  bumpInterruptedAttempts(repo, n); // boot-side auto-resume attempt
  // The resumed run finishes on its own — activity.ts's clearActive clears the marker there.
  clearInterrupted(repo, n);
  assert.equal(listInterrupted().find((r) => r.number === n), undefined, "no crash-loop — nothing left to park later");
});

test("interrupted-run marker: manual dashboard Resume also clears it (webhook.ts's /resume handler)", () => {
  const repo = "acme/app", n = 57;
  markInterrupted(repo, n, "deploy");
  bumpInterruptedAttempts(repo, n);
  // A human presses Resume before the auto-resumed run itself would have cleared it — the manual
  // trigger drops the stale marker immediately (see webhook.ts's /resume handler).
  clearInterrupted(repo, n);
  assert.equal(listInterrupted().find((r) => r.number === n), undefined);
});

// ── self-merge quiet window: pure decision + held_updates queue ─────────────────────────────────

test("shouldHoldSelfMerge: pure decision", () => {
  assert.equal(shouldHoldSelfMerge(true, [], "acme/app#1"), false, "nothing else in flight");
  assert.equal(shouldHoldSelfMerge(true, ["acme/app#1"], "acme/app#1"), false, "only itself in flight never counts");
  assert.equal(shouldHoldSelfMerge(true, ["acme/app#1", "acme/other#2"], "acme/app#1"), true, "another run in flight");
  assert.equal(shouldHoldSelfMerge(false, ["acme/app#1", "acme/other#2"], "acme/app#1"), false, "disabled by setting");
});

test("held_updates queue: hold, list, upsert, clear", () => {
  assert.equal(listHeldUpdates().length, 0);
  holdUpdate("acme/agency", 100, 55, "Improve X");
  let held = listHeldUpdates();
  assert.equal(held.length, 1);
  assert.equal(held[0].prNumber, 55);
  assert.equal(held[0].title, "Improve X");
  holdUpdate("acme/agency", 100, 56, "Improve X (updated)"); // same repo#number upserts
  held = listHeldUpdates();
  assert.equal(held.length, 1, "does not duplicate the row");
  assert.equal(held[0].prNumber, 56);
  clearHeldUpdate("acme/agency", 100);
  assert.equal(listHeldUpdates().length, 0);
});

// ── auto-flush-on-quiet gating ────────────────────────────────────────────────────────────────

test("flushHeldUpdatesIfQuiet: no-op with nothing held", async () => {
  assert.equal(await flushHeldUpdatesIfQuiet(), 0);
});

test("flushHeldUpdatesIfQuiet: does not flush while other work is in flight", async () => {
  holdUpdate("acme/agency", 101, 60, "Held while busy");
  let release;
  const gate = new Promise((r) => { release = r; });
  dispatch("acme/app#999", () => gate);
  assert.ok(poolStatus().running >= 1, "pool has the dispatched task running");
  const merged = await flushHeldUpdatesIfQuiet();
  assert.equal(merged, 0, "held while the pool isn't quiet — must not flush");
  assert.equal(listHeldUpdates().length, 1, "the held row survives — not flushed");
  release();
  await new Promise((r) => setTimeout(r, 20)); // let the pool settle back to idle
  clearHeldUpdate("acme/agency", 101);
});

// ── mergeEpic routes through attemptSelfMerge (the last self-merge bypass — see PR #199's audit) ──

// Force gh() to short-circuit instead of making a real network call, so this test is deterministic
// and offline. maybeTripCircuit only opens for a rate-limit-shaped message (see gh-circuit-breaker
// tests) — this is the same mechanism, just reused as a network stub for a message that never
// otherwise appears in this file's tests.
test("mergeEpic (agency's own repo) holds a child merge instead of merging straight through when other work is in flight", async () => {
  maybeTripCircuit(["issue", "comment"], new Error("API rate limit exceeded for installation ID 1."));

  const repo = "acme/agency", parent = 900, child = 901;
  addEpicChild(repo, parent, child, "Sub work");

  let release;
  const gate = new Promise((r) => { release = r; });
  dispatch("acme/other#1", () => gate); // occupy the pool so attemptSelfMerge's hold path engages

  const cfg = { agencyRepo: repo };
  const result = await mergeEpic(cfg, repo, parent);

  assert.equal(result.ok, false, "held, not fully merged — the parent can't close until it flushes");
  assert.equal(result.held, 1, "the held count is a real field callers can branch on, not msg string-matching");
  assert.match(result.msg, /holding/i);
  const held = listHeldUpdates().find((h) => h.repo === repo && h.number === child);
  assert.ok(held, "the child was queued in held_updates instead of merged via mergePrForBranch directly");
  assert.equal(listEpicChildren(repo, parent)[0].state, "open", "child not marked done while its merge is held");

  release();
  await new Promise((r) => setTimeout(r, 20)); // let the pool settle back to idle
  clearHeldUpdate(repo, child);
});

test("mergeEpic (a non-agency repo) is unaffected by the hold — behaves like a plain merge attempt", async () => {
  const repo = "acme/app", parent = 910, child = 911; // NOT cfg.agencyRepo
  addEpicChild(repo, parent, child, "Sub work");

  let release;
  const gate = new Promise((r) => { release = r; });
  dispatch("acme/other#2", () => gate); // other work in flight — irrelevant for a non-agency repo

  const cfg = { agencyRepo: "acme/agency" };
  const result = await mergeEpic(cfg, repo, parent);

  // No hold applies (repo !== cfg.agencyRepo), so attemptSelfMerge falls through to a real
  // mergePrForBranch attempt — which fails offline (no PR/network), NOT a held queue entry.
  assert.equal(result.ok, false);
  assert.equal(result.held, 0, "a non-agency repo is never held");
  assert.doesNotMatch(result.msg, /holding/i, "a non-agency repo is never held");
  assert.equal(listHeldUpdates().find((h) => h.repo === repo && h.number === child), undefined);

  release();
  await new Promise((r) => setTimeout(r, 20));
});

// Regression for the webhook.ts /close bug this PR fixes: a held child used to be indistinguishable
// from a genuinely failed one, so /close fell through to closeIssue+recordIssueStatus("done") on the
// parent while the child's PR hadn't actually merged. mergeEpic's `held` field is what a caller must
// branch on instead (see webhook.ts's /close route); this models the full held -> flushed -> retried
// sequence end to end through mergeEpic itself.
test("mergeEpic: a held-then-flushed child eventually lets a retried mergeEpic close the parent", async () => {
  const repo = "acme/agency", parent = 920, child = 921;
  addEpicChild(repo, parent, child, "Sub work 3");

  let release;
  const gate = new Promise((r) => { release = r; });
  dispatch("acme/other#3", () => gate); // occupy the pool so the first call holds

  const cfg = { agencyRepo: repo };
  const held = await mergeEpic(cfg, repo, parent);
  assert.equal(held.ok, false);
  assert.equal(held.held, 1, "child queued, not merged — a caller must NOT close the parent on this result");
  assert.equal(listEpicChildren(repo, parent)[0].state, "open");

  release();
  await new Promise((r) => setTimeout(r, 20)); // pool goes quiet

  // Simulate what a real flush (flushHeldUpdatesIfQuiet/"Deploy now", deploySafety.ts) + the next
  // reconcileEpics scan (epics.ts) do once the held update actually lands: the child issue's DB
  // status flips to done, its epics-table row is marked done, and the held_updates row clears.
  // (Exercising the real flush here would require a genuine GitHub merge — out of reach offline.)
  recordIssueStatus(repo, child, withStatus("done"));
  const { updateEpicChild } = await import("../dist/db/epic_tables.js");
  updateEpicChild(repo, parent, child, "done", true);
  clearHeldUpdate(repo, child);

  // Retried mergeEpic (the human re-clicking Merge/Close once the checklist shows it landed, or the
  // dashboard auto-retrying): every child is already `childDone`, so the loop merges nothing new and
  // goes straight to closing the parent — no second hold, no failure.
  const retried = await mergeEpic(cfg, repo, parent);
  assert.equal(retried.ok, true, "every child is done now — the parent closes normally");
  assert.equal(retried.held, 0);
  assert.equal(getIssueStatus(repo, parent).state, "done", "parent's own DB status flips to done only on this real close");
});
