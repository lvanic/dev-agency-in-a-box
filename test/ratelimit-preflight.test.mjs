// Preventive rate-limit pre-flight (#159): before a GitHub-heavy repo scan, scanRepo() reads the
// remaining core-API quota once and SKIPS the tick if it's below a configurable floor — rather than
// starting and tripping the reactive circuit breaker partway through. These cover the pure decision
// (rateBudgetTooLow) and the fail-open guard on the quota reader (ghCoreRateRemaining).
import test from "node:test";
import assert from "node:assert/strict";
import { rateBudgetTooLow, ghCoreRateRemaining, maybeTripCircuit } from "../dist/github.js";

test("rateBudgetTooLow: skip only when a real reading is below a positive floor", () => {
  assert.equal(rateBudgetTooLow(50, 150), true, "below floor → skip");
  assert.equal(rateBudgetTooLow(150, 150), false, "exactly at floor → proceed");
  assert.equal(rateBudgetTooLow(500, 150), false, "above floor → proceed");
});

test("rateBudgetTooLow: fail-open on a null (failed) reading", () => {
  assert.equal(rateBudgetTooLow(null, 150), false, "unknown quota never blocks a scan");
});

test("rateBudgetTooLow: a floor of 0 (or less) disables the check", () => {
  assert.equal(rateBudgetTooLow(0, 0), false, "floor 0 → never skip");
  assert.equal(rateBudgetTooLow(1, -5), false, "negative floor → never skip");
});

test("ghCoreRateRemaining: returns null (fail-open) while the circuit breaker is open", async () => {
  // Trip the reactive breaker; the preventive probe must not fire a gh call while it's open, and
  // returns null so the caller proceeds rather than blocking on a guaranteed-failing read.
  maybeTripCircuit(["api", "rate_limit"], new Error("API rate limit exceeded for installation ID 1."));
  assert.equal(await ghCoreRateRemaining(), null);
});
