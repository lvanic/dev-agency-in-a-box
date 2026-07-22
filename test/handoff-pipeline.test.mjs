// P2 (prime-time-plan): the Handoff envelope wired into pipeline.ts — structured planner/reviewer
// parsing (with the legacy keyword/regex parser kept as a fallback), the human-note extractor that
// replaces re-feeding the whole thread, and the compact per-role prompt payload (handoffBlock).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "handoff-pipeline-")), "test.db");

const { getDb } = await import("../dist/db/connection.js");
getDb();
const {
  parsePlannerDecision,
  parseReviewVerdict,
  latestHumanNote,
  handoffBlock,
} = await import("../dist/pipeline.js");
const { recordIssueStatus, upsertIssueDigest } = await import("../dist/store.js");
const { withStatus } = await import("../dist/state.js");

// ---- parsePlannerDecision: structured HANDOFF line preferred, keyword sniff as fallback ----

test("parsePlannerDecision reads a structured HANDOFF line: questions", () => {
  const d = parsePlannerDecision(`HANDOFF {"v":1,"phase":"plan","q":"which DB?"}\n\nA few things are unclear:\n1. which DB?`);
  assert.equal(d.kind, "questions");
  assert.equal(d.structured, true);
  assert.ok(d.body.includes("which DB?"));
});

test("parsePlannerDecision reads a structured HANDOFF line: build immediately (dev = old PLAN AUTO)", () => {
  const d = parsePlannerDecision(`HANDOFF {"v":1,"phase":"dev"}\n\nAdd a logout button to the header.`);
  assert.equal(d.kind, "plan");
  assert.equal(d.auto, true);
  assert.equal(d.structured, true);
  assert.equal(d.body, "Add a logout button to the header.");
});

test("parsePlannerDecision reads a structured HANDOFF line: propose for approval (old PLAN)", () => {
  const d = parsePlannerDecision(`HANDOFF {"v":1,"phase":"plan"}\n\nThis touches the shared Entity type.`);
  assert.equal(d.kind, "plan");
  assert.equal(d.auto, false);
  assert.equal(d.structured, true);
});

test("parsePlannerDecision falls back to the legacy keyword sniff when the HANDOFF line is missing", () => {
  const d1 = parsePlannerDecision("QUESTIONS\n1. Which DB?");
  assert.equal(d1.kind, "questions");
  assert.equal(d1.structured, false);

  const d2 = parsePlannerDecision("PLAN AUTO\nadd a field");
  assert.equal(d2.auto, true);
  assert.equal(d2.structured, false);

  const d3 = parsePlannerDecision("Here is what I'd do...");
  assert.equal(d3.kind, "plan");
  assert.equal(d3.structured, false);
});

test("parsePlannerDecision falls back when the HANDOFF line is present but malformed", () => {
  const d = parsePlannerDecision(`HANDOFF {"v":1,"phase":"nonsense"}\nPLAN AUTO\nbuild it`);
  assert.equal(d.structured, false);
  assert.equal(d.auto, true);
});

// ---- parseReviewVerdict: structured HANDOFF line preferred, APPROVE/REQUEST CHANGES as fallback ----

test("parseReviewVerdict reads a structured HANDOFF verdict and strips the machine line from `rest`", () => {
  const v = parseReviewVerdict(`HANDOFF {"v":1,"phase":"review","verdict":"c"}\n\nAddress the null check in foo.ts.`);
  assert.equal(v.verdict, "changes");
  assert.equal(v.structured, true);
  assert.equal(v.rest, "Address the null check in foo.ts.");
});

test("parseReviewVerdict reads an approval verdict", () => {
  const v = parseReviewVerdict(`HANDOFF {"v":1,"phase":"review","verdict":"a"}\n\nLGTM.`);
  assert.equal(v.verdict, "approved");
  assert.equal(v.structured, true);
});

test("parseReviewVerdict falls back to the legacy APPROVE/REQUEST CHANGES first line", () => {
  const v1 = parseReviewVerdict("REQUEST CHANGES\n\nFix the null check.");
  assert.equal(v1.verdict, "changes");
  assert.equal(v1.structured, false);
  assert.equal(v1.rest, "REQUEST CHANGES\n\nFix the null check."); // fallback: rest is the raw text, unchanged

  const v2 = parseReviewVerdict("APPROVE\n\nLGTM.");
  assert.equal(v2.verdict, "approved");
  assert.equal(v2.structured, false);
});

// Regression: a backtick-wrapped or trailing-prose HANDOFF line used to fail LINE_RE entirely, so
// extractHandoffLine returned {handoff:null, rest:<UNSTRIPPED full text>} — the fallback then ran
// changesRequested() against a first line that was the raw `HANDOFF {...}` tag (never the phrase
// "request changes"), silently reporting "approved" even though the model's (unparsed) verdict was
// "c". That could merge a PR the reviewer actually rejected. Both shapes must now parse correctly.
test("parseReviewVerdict does NOT flip a rejected verdict to approved when the HANDOFF line is backtick-wrapped", () => {
  const text = '`HANDOFF {"v":1,"phase":"review","verdict":"c"}`\n\nThe null check in foo.ts is missing.';
  const v = parseReviewVerdict(text);
  assert.equal(v.verdict, "changes", "must not silently flip to approved");
  assert.equal(v.structured, true, "the backtick-tolerant regex should decode this, not fall back");
  assert.equal(v.rest, "The null check in foo.ts is missing.");
});

test("parseReviewVerdict does NOT flip a rejected verdict to approved when trailing prose follows the JSON on the same line", () => {
  const text = 'HANDOFF {"v":1,"phase":"review","verdict":"c"} — please address the points below.\n\nSee the null check in foo.ts.';
  const v = parseReviewVerdict(text);
  assert.equal(v.verdict, "changes", "must not silently flip to approved");
  assert.equal(v.structured, true);
  assert.equal(v.rest, "— please address the points below.\n\nSee the null check in foo.ts.");
});

test("parseReviewVerdict: even if a backtick-wrapped HANDOFF line were somehow unparseable, the tagged line is still stripped so the fallback regex isn't poisoned by it", () => {
  // Belt-and-braces: extractHandoffLine strips ANY line matching the (now backtick-tolerant) HANDOFF
  // tag pattern before falling back, regardless of whether the JSON itself decodes.
  const text = "`HANDOFF {totally not json}`\nREQUEST CHANGES: fix the null check.";
  const v = parseReviewVerdict(text);
  assert.equal(v.structured, false, "malformed JSON still falls back");
  assert.equal(v.verdict, "changes", "fallback regex sees the clean, stripped first line");
});

// ---- latestHumanNote: the one bit of "thread" that's still real task content ----

test("latestHumanNote pulls only the trailing human block(s), not the whole thread", () => {
  const thread =
    "[agency] **Proposed approach** ...\n\n---\n\n[human] ok\n\n---\n\n[agency] built it, opened PR\n\n---\n\n[human] also handle the empty state";
  assert.equal(latestHumanNote(thread), "[human] also handle the empty state");
});

test("latestHumanNote returns empty when the agency spoke last (nothing new to apply)", () => {
  const thread = "[human] ok\n\n---\n\n[agency] building now";
  assert.equal(latestHumanNote(thread), "");
});

test("latestHumanNote joins consecutive trailing human comments", () => {
  const thread = "[agency] proposal\n\n---\n\n[human] also add X\n\n---\n\n[human] and Y too";
  const note = latestHumanNote(thread);
  assert.ok(note.includes("also add X"));
  assert.ok(note.includes("and Y too"));
});

// ---- handoffBlock: the compact per-role payload that replaces the re-fed thread ----

test("handoffBlock embeds the current Handoff envelope and the issue digest, never the full thread", () => {
  const repo = "acme/handoff-block", n = 21;
  recordIssueStatus(repo, n, withStatus("working"));

  // Round 1: a long, verbose reviewer comment lands in the run thread (what the OLD code would have
  // re-fed verbatim to every subsequent role). The digest only ever keeps a ≤300-char snippet of it.
  const round1Prose = "REQUEST CHANGES — " + "this is a very long review comment full of detail ".repeat(20);
  upsertIssueDigest(repo, n, "reviewer", round1Prose);

  const block = handoffBlock(repo, n, "revise", { br: "agency/issue-21", round: 1, verdict: "c" });

  // (b) the current Handoff envelope is present, single-line JSON, carrying this round's state.
  assert.match(block, /### Handoff\nHANDOFF \{"v":1,"phase":"revise","br":"agency\/issue-21","verdict":"c","round":1\}/);
  // (c) the issue digest is present...
  assert.match(block, /### Digest\n/);
  // (d) a pointer to recall() for anything older.
  assert.match(block, /recall/i);
  // ...but NOT the first round's full prose — only ever a ≤300-char truncated digest snippet.
  assert.ok(!block.includes(round1Prose), "the full first-round prose must not be re-fed verbatim");
  const digestLine = block.split("### Digest\n")[1].split("\n\n")[0];
  assert.ok(digestLine.length <= 300, `digest snippet should be capped, was ${digestLine.length} chars`);
});

test("handoffBlock never contains the literal words that would signal a re-fed conversation thread", () => {
  const repo = "acme/handoff-block-2", n = 22;
  const block = handoffBlock(repo, n, "dev", { br: "agency/issue-22" });
  assert.ok(!/### Conversation/i.test(block));
  assert.ok(!/conversation so far/i.test(block));
});
