// Tests for the Orchestrator handoff parser (v4) — pure parsing of the agent's ```handoff block.
import test from "node:test";
import assert from "node:assert/strict";
import { parseHandoff, parseQuestion } from "../dist/agents/orchestrator-chat.js";

test("no block → null", () => {
  assert.equal(parseHandoff("just chatting, no proposal here"), null);
});

test("full-build single issue", () => {
  const p = parseHandoff("Here's what I'd build:\n\n```handoff\nworkflow: full-build\n- [Add password reset] email-link reset using the mailer; routes + UI + tests\n```");
  assert.equal(p.workflow, "full-build");
  assert.equal(p.issues.length, 1);
  assert.equal(p.issues[0].title, "Add password reset");
  assert.match(p.issues[0].scope, /email-link reset/);
});

test("split into ordered epics", () => {
  const p = parseHandoff("```handoff\nworkflow: split\n- [Epic 1: data model] schema + migration\n- [Epic 2: API] endpoints\n- [Epic 3: UI] dashboard\n```");
  assert.equal(p.workflow, "split");
  assert.equal(p.issues.length, 3);
  assert.equal(p.issues[2].title, "Epic 3: UI");
});

test("invalid workflow falls back by issue count", () => {
  assert.equal(parseHandoff("```handoff\nworkflow: nonsense\n- [One] a\n```").workflow, "full-build");
  assert.equal(parseHandoff("```handoff\nworkflow: nonsense\n- [One] a\n- [Two] b\n```").workflow, "split");
});

test("block with no issues → null", () => {
  assert.equal(parseHandoff("```handoff\nworkflow: full-build\n```"), null);
});

test("parseHandoff extracts per-issue {agent}/{workflow} route recommendations", () => {
  const p = parseHandoff(
    "```handoff\nworkflow: split\n- [Fix login] tighten session check {agent: @dev}\n- [Rework auth] full auth overhaul {workflow: @build}\n- [Just notes] no route here\n```",
  );
  assert.equal(p.issues.length, 3);
  assert.equal(p.issues[0].route, "@dev");
  assert.equal(p.issues[0].scope, "tighten session check");
  assert.equal(p.issues[1].route, "@build");
  assert.equal(p.issues[1].scope, "full auth overhaul");
  assert.equal(p.issues[2].route, undefined);
});

test("parseQuestion → null when no block", () => {
  assert.equal(parseQuestion("no choices here, just prose"), null);
});

test("parseQuestion reads a single-pick block", () => {
  const q = parseQuestion("Which way?\n\n```question\nmulti: false\n- Pivot to Flutter\n- Keep Expo\n- Something else\n```");
  assert.equal(q.multi, false);
  assert.deepEqual(q.options, ["Pivot to Flutter", "Keep Expo", "Something else"]);
});

test("parseQuestion reads a multi-pick block and dedups/caps", () => {
  const q = parseQuestion("```question\nmulti: true\n- iOS\n- Android\n- iOS\n- Web\n```");
  assert.equal(q.multi, true);
  assert.deepEqual(q.options, ["iOS", "Android", "Web"]);
});

test("parseQuestion tolerates numbered/starred bullets and empty block → null", () => {
  const q = parseQuestion("```question\n1) A\n2. B\n* C\n```");
  assert.deepEqual(q.options, ["A", "B", "C"]);
  assert.equal(q.multi, false);
  assert.equal(parseQuestion("```question\nmulti: true\n```"), null);
});
