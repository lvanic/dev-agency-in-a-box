// Issues sliced out of an Orchestrator chat must carry the user's ORIGINAL words, and the reviewer
// must be told to gate on them. Without this, every role validates against the sliced scope line —
// which is how a live benchmark shipped a dropped field and a rewritten response shape past four
// consecutive "approved" reviews.
import { test } from "node:test";
import assert from "node:assert/strict";
import { specAnchor, SPEC_ANCHOR_HEADING, ROUTING_GUIDE } from "../dist/agents/orchestrator-chat.js";
import { appendOrchMsg, clearOrchThread } from "../dist/store.js";

const REPO = "acme/spec-anchor-test";

test("specAnchor returns the user's own words, not the orchestrator's paraphrase", () => {
  clearOrchThread(REPO);
  appendOrchMsg(REPO, "user", "Build Linkbox. Health endpoint returns { ok: true }. Search covers notes.");
  appendOrchMsg(REPO, "orchestrator", "I'll slice that into 4 epics.");
  appendOrchMsg(REPO, "user", "Add notes to the backend too");

  const anchor = specAnchor(REPO);
  assert.match(anchor, /\{ ok: true \}/, "the user's literal requirement must survive");
  assert.match(anchor, /Add notes to the backend too/, "later user turns are part of the agreed spec");
  assert.doesNotMatch(anchor, /slice that into 4 epics/, "the orchestrator's paraphrase must NOT be the anchor");
  clearOrchThread(REPO);
});

test("specAnchor is capped so a long chat can't blow up every issue body", () => {
  clearOrchThread(REPO);
  appendOrchMsg(REPO, "user", "x".repeat(9000));
  const anchor = specAnchor(REPO, 500);
  assert.ok(anchor.length < 600, `expected a capped anchor, got ${anchor.length} chars`);
  assert.match(anchor, /truncated/, "truncation must be visible to the reader");
  clearOrchThread(REPO);
});

test("specAnchor is empty for a repo with no chat (hand-written issues get no anchor)", () => {
  clearOrchThread(REPO);
  assert.equal(specAnchor(REPO), "");
});

test("the routing guide steers to the cheapest shape and keeps the human in the loop", () => {
  assert.match(ROUTING_GUIDE, /ONE issue is the default/, "single-issue default must be stated");
  assert.match(ROUTING_GUIDE, /epic/i, "ordered work must be steered to an epic, not N top-level issues");
  assert.match(ROUTING_GUIDE, /State which shape you chose and why/, "the user must be able to overrule the choice");
});

test("the spec anchor heading is a stable contract between the issue body and the reviewer gate", () => {
  // pipeline.ts:specGate() matches on this exact string; drift silently disables the gate.
  assert.equal(SPEC_ANCHOR_HEADING, "### SPEC — the original request (binding)");
});
