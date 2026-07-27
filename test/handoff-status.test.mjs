// Tests for renderHandoffStatus — the structured-status → templated-prose translate (zero token cost).
import test from "node:test";
import assert from "node:assert/strict";

const { renderHandoffStatus } = await import("../dist/handoff.js");

test("review verdicts render as readable status", () => {
  assert.match(renderHandoffStatus({ v: 1, phase: "review", verdict: "a" }), /approved/i);
  assert.match(renderHandoffStatus({ v: 1, phase: "review", verdict: "c" }), /changes requested/i);
  assert.match(renderHandoffStatus({ v: 1, phase: "review" }), /reviewing/i);
});

test("round is appended when > 0, omitted otherwise", () => {
  assert.match(renderHandoffStatus({ v: 1, phase: "review", verdict: "c", round: 2 }), /round 2/);
  assert.ok(!/round/.test(renderHandoffStatus({ v: 1, phase: "review", verdict: "c", round: 0 })));
});

test("test results render pass/fail/running", () => {
  assert.match(renderHandoffStatus({ v: 1, phase: "test", test: "p" }), /passed/i);
  assert.match(renderHandoffStatus({ v: 1, phase: "test", test: "f" }), /failed/i);
  assert.match(renderHandoffStatus({ v: 1, phase: "test" }), /running tests/i);
});

test("plan renders a question or a proposal", () => {
  assert.match(renderHandoffStatus({ v: 1, phase: "plan", q: "which db?" }), /which db\?/);
  assert.match(renderHandoffStatus({ v: 1, phase: "plan" }), /approval/i);
});

test("dev shows the branch and file count", () => {
  const s = renderHandoffStatus({ v: 1, phase: "dev", br: "agency/issue-1", files: ["a.ts", "b.ts"] });
  assert.match(s, /agency\/issue-1/);
  assert.match(s, /2 files/);
});

test("done + unknown phase are safe", () => {
  assert.match(renderHandoffStatus({ v: 1, phase: "done" }), /done/i);
  assert.equal(typeof renderHandoffStatus({ v: 1, phase: "revise", round: 1 }), "string");
});
