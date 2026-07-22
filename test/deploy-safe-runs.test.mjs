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
