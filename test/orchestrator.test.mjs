// Tests for the orchestrator decision core (Phase 3) — pure next-move logic.
import test from "node:test";
import assert from "node:assert/strict";
import { decideNext } from "../dist/orchestrator.js";

const base = { devChanged: true, round: 0, maxRounds: 1 };

test("developed → test", () => {
  assert.equal(decideNext({ ...base, phase: "developed" }).action, "test");
});

test("tested: pass → review, fail → revise (rounds left), fail → park (no rounds)", () => {
  assert.equal(decideNext({ ...base, phase: "tested", testPass: true }).action, "review");
  assert.equal(decideNext({ ...base, phase: "tested", testPass: false, round: 0, maxRounds: 1 }).action, "revise");
  const out = decideNext({ ...base, phase: "tested", testPass: false, round: 1, maxRounds: 1 });
  assert.equal(out.action, "finalize");
  assert.equal(out.stillChanges, true);
});

test("reviewed: approved → finalize, changes → revise / park", () => {
  assert.equal(decideNext({ ...base, phase: "reviewed", reviewVerdict: "approved" }).action, "finalize");
  assert.equal(decideNext({ ...base, phase: "reviewed", reviewVerdict: "changes", round: 0, maxRounds: 1 }).action, "revise");
  const out = decideNext({ ...base, phase: "reviewed", reviewVerdict: "changes", round: 1, maxRounds: 1 });
  assert.equal(out.action, "finalize");
  assert.equal(out.stillChanges, true);
});

test("revised: no change → stop (no token bleed); changed → re-test", () => {
  assert.equal(decideNext({ ...base, phase: "revised", devChanged: false }).action, "stop");
  assert.equal(decideNext({ ...base, phase: "revised", devChanged: true }).action, "test");
});

test("a clean run walks developed→test→review→finalize without revising", () => {
  let s = { phase: "developed", devChanged: true, round: 0, maxRounds: 1 };
  assert.equal(decideNext(s).action, "test");
  s = { ...s, phase: "tested", testPass: true };
  assert.equal(decideNext(s).action, "review");
  s = { ...s, phase: "reviewed", reviewVerdict: "approved" };
  assert.equal(decideNext(s).action, "finalize");
});

// P3 (prime-time-plan): loop re-evaluation — modelHint on "revise" decisions only.
test("modelHint: only ever set on a revise action, never on test/review/finalize/stop", () => {
  assert.equal(decideNext({ ...base, phase: "developed" }).modelHint, undefined);
  assert.equal(decideNext({ ...base, phase: "tested", testPass: true }).modelHint, undefined);
  assert.equal(decideNext({ ...base, phase: "reviewed", reviewVerdict: "approved" }).modelHint, undefined);
  assert.equal(decideNext({ ...base, phase: "revised", devChanged: false }).modelHint, undefined);
});

test("modelHint: escalate on the 2nd consecutive failure (round >= 1 AND prevRoundFailed), for either failure source", () => {
  // Realistic round values: maxRounds must allow a 2nd+ revise (>= 2) for round to ever reach 1 here —
  // decideNext only returns "revise" while round < maxRounds, so round=1 requires maxRounds >= 2.
  const testFail = decideNext({ phase: "tested", testPass: false, devChanged: true, round: 1, maxRounds: 3, prevRoundFailed: true });
  assert.equal(testFail.action, "revise");
  assert.equal(testFail.modelHint, "escalate");
  const changesReq = decideNext({ phase: "reviewed", reviewVerdict: "changes", devChanged: true, round: 1, maxRounds: 3, prevRoundFailed: true });
  assert.equal(changesReq.action, "revise");
  assert.equal(changesReq.modelHint, "escalate");
  // round 2, 3, … (maxRounds high enough) still escalate once prevRoundFailed is confirmed
  assert.equal(decideNext({ phase: "reviewed", reviewVerdict: "changes", devChanged: true, round: 3, maxRounds: 9, prevRoundFailed: true }).modelHint, "escalate");
});

test("modelHint: round >= 1 alone does NOT escalate without prevRoundFailed confirmed — conservative", () => {
  assert.equal(decideNext({ phase: "tested", testPass: false, devChanged: true, round: 1, maxRounds: 5 }).modelHint, "same");
  assert.equal(decideNext({ phase: "reviewed", reviewVerdict: "changes", devChanged: true, round: 1, maxRounds: 5, prevRoundFailed: false }).modelHint, "same");
});

test("modelHint: with the default maxReviseRounds=1, escalate can never fire — round is always 0 at the only revise-eligible decision", () => {
  // decideNext returns "revise" only while round < maxRounds; with maxRounds=1 that's exclusively
  // round=0, so escalate (which needs round >= 1) is structurally unreachable under default config —
  // the hint on that single round is always "same" or "downshift", never "escalate".
  const d = decideNext({ phase: "reviewed", reviewVerdict: "changes", devChanged: true, round: 0, maxRounds: 1, prevRoundFailed: true });
  assert.equal(d.action, "revise");
  assert.notEqual(d.modelHint, "escalate");
});

test("modelHint: default is 'same' — round 0/1 with no trivial signal", () => {
  assert.equal(decideNext({ phase: "tested", testPass: false, devChanged: true, round: 0, maxRounds: 5 }).modelHint, "same");
  assert.equal(decideNext({ phase: "reviewed", reviewVerdict: "changes", devChanged: true, round: 1, maxRounds: 5 }).modelHint, "same");
});

test("modelHint: downshift ONLY on a fresh (round === 0) revise with confirmed-trivial + <=1 file", () => {
  const d = decideNext({
    phase: "reviewed", reviewVerdict: "changes", devChanged: true, round: 0, maxRounds: 5,
    trivialFeedback: true, filesChanged: 1,
  });
  assert.equal(d.modelHint, "downshift");
  // filesChanged omitted (unknown) + trivial still allowed (undefined counts as "not disqualifying")
  assert.equal(decideNext({ phase: "reviewed", reviewVerdict: "changes", devChanged: true, round: 0, maxRounds: 5, trivialFeedback: true }).modelHint, "downshift");
});

test("modelHint: the round === 0 guard — a trivial+small signal on round >= 1 never downshifts", () => {
  // Same trivial + 1-file signal as the test above, but round=1 (a REPEAT round) — must not downshift;
  // per the docstring, downshift is reserved for a FRESH (first) revise only.
  assert.equal(decideNext({ phase: "reviewed", reviewVerdict: "changes", devChanged: true, round: 1, maxRounds: 5, trivialFeedback: true, filesChanged: 1 }).modelHint, "same");
});

test("modelHint: never downshifts on a large diff or unconfirmed trivial-ness (conservative)", () => {
  assert.equal(decideNext({ phase: "reviewed", reviewVerdict: "changes", devChanged: true, round: 0, maxRounds: 5, trivialFeedback: true, filesChanged: 2 }).modelHint, "same");
  assert.equal(decideNext({ phase: "reviewed", reviewVerdict: "changes", devChanged: true, round: 0, maxRounds: 5, filesChanged: 1 }).modelHint, "same");
  assert.equal(decideNext({ phase: "reviewed", reviewVerdict: "changes", devChanged: true, round: 0, maxRounds: 5 }).modelHint, "same");
  // escalate (confirmed prevRoundFailed) always wins over a trivial signal — persistent trouble trumps "looked small"
  assert.equal(decideNext({ phase: "reviewed", reviewVerdict: "changes", devChanged: true, round: 1, maxRounds: 5, prevRoundFailed: true, trivialFeedback: true, filesChanged: 1 }).modelHint, "escalate");
});
