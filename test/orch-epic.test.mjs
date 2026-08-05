// Ordered, dependent slices proposed from a chat must be creatable as ONE epic. Flat top-level
// issues have no auto-advance: in a live benchmark a 4-part build cost 8 manual clicks (start +
// merge per part), while an epic's ▶ Play runs the parts back-to-back (onChildMerged).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHandoff } from "../dist/agents/orchestrator-chat.js";

const block = (body) => "Sure — here's the split.\n\n```handoff\n" + body + "\n```";

test("an epic: line turns ordered parts into an epic proposal", () => {
  const p = parseHandoff(block([
    "workflow: split",
    "epic: Linkbox",
    "- [Foundation] package.json + db layer",
    "- [API layer] express routes {workflow: @build}",
  ].join("\n")));
  assert.equal(p.epic, "Linkbox");
  assert.equal(p.issues.length, 2);
  assert.equal(p.issues[1].route, "@build", "per-issue routing still parses alongside the epic line");
  assert.equal(p.issues[1].scope, "express routes", "the route annotation is stripped from the scope");
});

test("a single-part proposal is never wrapped in an epic", () => {
  const p = parseHandoff(block("epic: Linkbox\n- [Build it] the whole app"));
  assert.equal(p.epic, undefined, "an epic of one just adds a click");
  assert.equal(p.issues.length, 1);
});

test("proposals without an epic line stay flat (unchanged behaviour)", () => {
  const p = parseHandoff(block("workflow: split\n- [One] a\n- [Two] b"));
  assert.equal(p.epic, undefined);
  assert.equal(p.workflow, "split");
  assert.equal(p.issues.length, 2);
});
