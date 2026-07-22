// Tests for the compact Handoff envelope (P2, prime-time-plan): the single-line JSON wire format
// passed between roles instead of re-feeding the whole GitHub/run thread. See CONTEXT.md's "Handoff".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "handoff-")), "agency.db");
const { getDb } = await import("../dist/db/connection.js");
getDb();

const {
  encodeHandoff,
  decodeHandoff,
  extractHandoffLine,
  renderHandoffLine,
  buildHandoff,
  HANDOFF_VERSION,
} = await import("../dist/handoff.js");
const { recordIssueFiles } = await import("../dist/db/issues.js");
const { recordReview } = await import("../dist/db/reviews.js");

test("encodeHandoff/decodeHandoff round-trip a minimal envelope", () => {
  const wire = encodeHandoff({ phase: "dev" });
  assert.equal(wire, `{"v":1,"phase":"dev"}`);
  const h = decodeHandoff(wire);
  assert.deepEqual(h, { v: 1, phase: "dev" });
});

test("encodeHandoff/decodeHandoff round-trip a full envelope", () => {
  const wire = encodeHandoff({ phase: "review", br: "agency/issue-9", files: ["a.ts", "b.ts"], test: "p", verdict: "c", round: 2, q: "why?" });
  const h = decodeHandoff(wire);
  assert.deepEqual(h, {
    v: 1, phase: "review", br: "agency/issue-9", files: ["a.ts", "b.ts"], test: "p", verdict: "c", round: 2, q: "why?",
  });
});

test("encodeHandoff drops empty/undefined/zero fields — stays minimal", () => {
  const wire = encodeHandoff({ phase: "dev", br: "", files: [], round: 0, q: "   " });
  assert.equal(wire, `{"v":1,"phase":"dev"}`);
});

test("encodeHandoff caps files and q so the envelope can't balloon", () => {
  const manyFiles = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
  const h1 = decodeHandoff(encodeHandoff({ phase: "dev", files: manyFiles }));
  assert.equal(h1.files.length, 12);
  const longQ = "x".repeat(1000);
  const h2 = decodeHandoff(encodeHandoff({ phase: "plan", q: longQ }));
  assert.ok(h2.q.length <= 240);
});

test("encodeHandoff serializes small — the whole point of the envelope", () => {
  const wire = encodeHandoff({ phase: "review", br: "agency/issue-123", files: ["src/a.ts", "src/b.ts"], test: "p", verdict: "c", round: 1 });
  // ~60 tokens is roughly 240 chars (a very rough 4-chars/token heuristic) — this is nowhere close,
  // even with a realistic branch name and a couple of files.
  assert.ok(wire.length < 200, `envelope too long: ${wire.length} chars`);
});

test("decodeHandoff rejects an unknown/missing version", () => {
  assert.equal(decodeHandoff(`{"v":2,"phase":"dev"}`), null);
  assert.equal(decodeHandoff(`{"phase":"dev"}`), null);
});

test("decodeHandoff rejects an unrecognized phase", () => {
  assert.equal(decodeHandoff(`{"v":1,"phase":"bogus"}`), null);
});

test("decodeHandoff rejects wrong field types", () => {
  assert.equal(decodeHandoff(`{"v":1,"phase":"dev","files":"a.ts"}`), null, "files must be an array");
  assert.equal(decodeHandoff(`{"v":1,"phase":"dev","files":[1,2]}`), null, "files must be strings");
  assert.equal(decodeHandoff(`{"v":1,"phase":"dev","round":"1"}`), null, "round must be a number");
  assert.equal(decodeHandoff(`{"v":1,"phase":"dev","round":-1}`), null, "round must be non-negative");
  assert.equal(decodeHandoff(`{"v":1,"phase":"dev","test":"maybe"}`), null, "test must be p|f");
  assert.equal(decodeHandoff(`{"v":1,"phase":"dev","verdict":"yes"}`), null, "verdict must be a|c");
  assert.equal(decodeHandoff(`{"v":1,"phase":"dev","q":7}`), null, "q must be a string");
  assert.equal(decodeHandoff(`{"v":1,"phase":"dev","br":7}`), null, "br must be a string");
});

test("decodeHandoff rejects unknown keys and malformed/non-object JSON", () => {
  assert.equal(decodeHandoff(`{"v":1,"phase":"dev","extra":"nope"}`), null, "unknown key rejected");
  assert.equal(decodeHandoff(`not json`), null);
  assert.equal(decodeHandoff(`[1,2,3]`), null, "array, not an object");
  assert.equal(decodeHandoff(`"just a string"`), null);
  assert.equal(decodeHandoff(``), null);
});

test("HANDOFF_VERSION is 1 (bump + widen decodeHandoff's acceptance if this ever changes)", () => {
  assert.equal(HANDOFF_VERSION, 1);
});

test("extractHandoffLine reads a leading HANDOFF line and strips it from the human-facing rest", () => {
  const text = `HANDOFF {"v":1,"phase":"review","verdict":"a"}\n\nLooks good, ship it.`;
  const { handoff, rest } = extractHandoffLine(text);
  assert.deepEqual(handoff, { v: 1, phase: "review", verdict: "a" });
  assert.equal(rest, "Looks good, ship it.");
});

test("extractHandoffLine tolerates leading blank lines and a colon after the tag", () => {
  const text = `\n\n  HANDOFF: {"v":1,"phase":"dev"}\nBuilding it now.`;
  const { handoff, rest } = extractHandoffLine(text);
  assert.deepEqual(handoff, { v: 1, phase: "dev" });
  assert.equal(rest, "Building it now.");
});

test("extractHandoffLine tolerates trailing prose AFTER the JSON on the same line, and keeps it (real content, not the tag)", () => {
  const text = `HANDOFF {"v":1,"phase":"review","verdict":"a"} — looks good, ship it.\n\nMore detail below.`;
  const { handoff, rest } = extractHandoffLine(text);
  assert.deepEqual(handoff, { v: 1, phase: "review", verdict: "a" });
  assert.equal(rest, "— looks good, ship it.\n\nMore detail below.");
});

test("extractHandoffLine tolerates a single-backtick-wrapped line (models mimic our own instruction's inline-code styling)", () => {
  const text = "`HANDOFF {\"v\":1,\"phase\":\"review\",\"verdict\":\"c\"}`\n\nFix the null check in foo.ts.";
  const { handoff, rest } = extractHandoffLine(text);
  assert.deepEqual(handoff, { v: 1, phase: "review", verdict: "c" });
  assert.equal(rest, "Fix the null check in foo.ts.");
});

test("extractHandoffLine tolerates a triple-backtick-wrapped line too", () => {
  const text = '```HANDOFF {"v":1,"phase":"dev"}```\nBuilding now.';
  const { handoff, rest } = extractHandoffLine(text);
  assert.deepEqual(handoff, { v: 1, phase: "dev" });
  assert.equal(rest, "Building now.");
});

test("extractHandoffLine reads a fenced single-line JSON block when there's no bare line", () => {
  const text = "Some reasoning first.\n\n```json\n{\"v\":1,\"phase\":\"plan\",\"q\":\"which DB?\"}\n```\n\nMore reasoning.";
  const { handoff, rest } = extractHandoffLine(text);
  assert.deepEqual(handoff, { v: 1, phase: "plan", q: "which DB?" });
  assert.ok(!rest.includes("HANDOFF"));
  assert.ok(!rest.includes("```"));
});

test("extractHandoffLine returns null + the original text when there's nothing to parse (fallback path)", () => {
  const text = "APPROVE\n\nLooks good.";
  const { handoff, rest } = extractHandoffLine(text);
  assert.equal(handoff, null);
  assert.equal(rest, text);
});

test("extractHandoffLine returns null on a malformed HANDOFF line (never throws, never guesses), but still strips the tagged line so the caller's fallback parser sees a clean first line", () => {
  const text = `HANDOFF {"v":1,"phase":"nonsense"}\nprose`;
  const { handoff, rest } = extractHandoffLine(text);
  assert.equal(handoff, null);
  assert.equal(rest, "prose");
});

test("renderHandoffLine produces exactly what extractHandoffLine reads back", () => {
  const line = renderHandoffLine({ phase: "revise", br: "agency/issue-4", round: 1 });
  assert.ok(line.startsWith("HANDOFF "));
  const { handoff } = extractHandoffLine(`${line}\nsome prose`);
  assert.deepEqual(handoff, { v: 1, phase: "revise", br: "agency/issue-4", round: 1 });
});

test("buildHandoff composes DB state (files, review verdict) with caller-known fields", () => {
  const repo = "acme/handoff", n = 11;
  const bare = buildHandoff(repo, n, "dev");
  assert.deepEqual(bare, { v: 1, phase: "dev" });

  recordIssueFiles(repo, n, ["src/a.ts", "src/b.ts"]);
  const withFiles = buildHandoff(repo, n, "dev", { br: "agency/issue-11" });
  assert.deepEqual(withFiles, { v: 1, phase: "dev", br: "agency/issue-11", files: ["src/a.ts", "src/b.ts"] });

  recordReview(repo, n, "changes", "fix the thing");
  const withVerdict = buildHandoff(repo, n, "revise", { round: 1 });
  assert.equal(withVerdict.verdict, "c");
  assert.equal(withVerdict.round, 1);

  // caller-supplied `extra` wins over the DB-derived verdict when both are given.
  const overridden = buildHandoff(repo, n, "review", { verdict: "a" });
  assert.equal(overridden.verdict, "a");
});
