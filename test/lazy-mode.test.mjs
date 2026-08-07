// Lazy Julian Mode (experimental): the directive parser the autopilot executes, the auto-merge /
// auto-resume defaults it flips, the approval-gate predicate the pipeline reads, and the state
// snapshot that decides whether a tick is worth an LLM turn at all.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "lazy-")), "agency.db");
const { getDb } = await import("../dist/db/connection.js");
getDb();
const { setSetting } = await import("../dist/db/settings.js");
const { setAuto, autoEnabled } = await import("../dist/db/auto.js");
const { recordIssueStatus } = await import("../dist/db/issues.js");
const { withStatus, setBlocked } = await import("../dist/state.js");
const { parseDirectives, describeDirective, lazyEnabled, lazyAutoApprove, lazySnapshot, pendingAsk, clearPendingAsk } =
  await import("../dist/lazy.js");
const { parseHandoff } = await import("../dist/agents/orchestrator-chat.js");

const lazyOff = () => setSetting("lazy_mode", "off");
const lazyOn = () => setSetting("lazy_mode", "on");

// ── directive parser ────────────────────────────────────────────────────────────────────────────

test("no ```plan block → no directives", () => {
  assert.deepEqual(parseDirectives("I'll let the running work finish."), []);
});

test("parses every verb", () => {
  const d = parseDirectives([
    "Here's the plan.",
    "```plan",
    "start acme/app#12",
    "resume acme/app#13",
    "fix acme/app#14",
    "stop acme/app#15",
    "merge acme/app#16",
    "close acme/app#17 superseded by #12",
    "answer acme/app#18: reuse the existing FooBar helper",
    "route acme/app#19 {workflow: @build}",
    "create acme/app [Add dark mode] toggle in Settings {workflow: @build}",
    "ask which staging domain should previews point at?",
    "wait",
    "```",
  ].join("\n"));
  assert.deepEqual(d.map((x) => x.kind), [
    "start", "resume", "fix", "stop", "merge", "close", "answer", "route", "create", "ask", "wait",
  ]);
  assert.deepEqual(d[0], { kind: "start", repo: "acme/app", number: 12 });
  assert.equal(d[5].note, "superseded by #12");
  assert.equal(d[6].text, "reuse the existing FooBar helper");
  assert.equal(d[7].route, "@build");
  assert.deepEqual(d[8], { kind: "create", repo: "acme/app", title: "Add dark mode", scope: "toggle in Settings", route: "@build" });
  assert.equal(d[9].text, "which staging domain should previews point at?");
});

test("tolerates list bullets, a bare #N with a default repo, and drops junk", () => {
  const d = parseDirectives("```plan\n- start #12\n- frobnicate acme/app#13\n- start\n```", "acme/app");
  assert.deepEqual(d, [{ kind: "start", repo: "acme/app", number: 12 }]);
});

test("a bare #N with no default repo is dropped, not guessed", () => {
  assert.deepEqual(parseDirectives("```plan\nstart #12\n```"), []);
});

test("answer accepts an em-dash separator and keeps punctuation in the text", () => {
  const [d] = parseDirectives("```plan\nanswer acme/app#4 - yes: ship it behind a flag\n```");
  assert.equal(d.kind, "answer");
  assert.equal(d.text, "yes: ship it behind a flag");
});

test("route without an explicit annotation still takes a bare handle", () => {
  const [d] = parseDirectives("```plan\nroute acme/app#7 @dev\n```");
  assert.deepEqual(d, { kind: "route", repo: "acme/app", number: 7, route: "@dev" });
});

test("describeDirective renders each shape for the chat report", () => {
  assert.match(describeDirective({ kind: "start", repo: "acme/app", number: 3 }), /start app#3/);
  assert.match(describeDirective({ kind: "ask", text: "which domain?" }), /asked you: which domain\?/);
  assert.match(describeDirective({ kind: "create", repo: "acme/app", title: "Dark mode", scope: "" }), /Dark mode/);
});

// ── the gates the mode removes ──────────────────────────────────────────────────────────────────

test("lazyEnabled / lazyAutoApprove follow the setting", () => {
  lazyOff();
  assert.equal(lazyEnabled(), false);
  assert.equal(lazyAutoApprove(), false);
  lazyOn();
  assert.equal(lazyEnabled(), true);
  assert.equal(lazyAutoApprove(), true);
  lazyOff();
});

test("auto-merge / auto-resume default ON under lazy mode", () => {
  lazyOff();
  assert.equal(autoEnabled("merge", "acme/app", 1), false, "off by default without the mode");
  assert.equal(autoEnabled("resume", "acme/app", 1), false);
  lazyOn();
  assert.equal(autoEnabled("merge", "acme/app", 1), true);
  assert.equal(autoEnabled("resume", "acme/app", 1), true);
  lazyOff();
});

test("an explicit off at any scope still beats lazy mode", () => {
  lazyOn();
  setAuto("merge", "off", "acme/app");
  assert.equal(autoEnabled("merge", "acme/app", 2), false, "repo-scope off wins");
  setAuto("merge", "on", "acme/app", 2);
  assert.equal(autoEnabled("merge", "acme/app", 2), true, "issue scope still overrides the repo");
  setAuto("merge", "", "acme/app");
  setAuto("merge", "", "acme/app", 2);
  setAuto("merge", "off");
  assert.equal(autoEnabled("merge", "acme/app", 2), false, "global off wins over the lazy default");
  setAuto("merge", "");
  assert.equal(autoEnabled("merge", "acme/app", 2), true, "back to the lazy default");
  lazyOff();
});

// ── the snapshot that gates spending a turn ─────────────────────────────────────────────────────

test("lazySnapshot: nothing actionable in a quiet agency (no LLM turn is spent)", () => {
  assert.equal(lazySnapshot(["quiet/repo"]).actionable, 0);
});

test("lazySnapshot: counts parked, planned and in-review work, and names the blocked reason", () => {
  recordIssueStatus("lazy/repo", 1, withStatus("planned"), { title: "Planned thing" });
  recordIssueStatus("lazy/repo", 2, setBlocked(withStatus("working"), "awaitingAnswer"), { title: "Parked thing" });
  recordIssueStatus("lazy/repo", 3, withStatus("review"), { title: "Reviewed thing" });
  recordIssueStatus("lazy/repo", 4, withStatus("done"), { title: "Finished thing" });
  const snap = lazySnapshot(["lazy/repo"]);
  assert.equal(snap.actionable, 3, "done work is not actionable");
  assert.match(snap.text, /awaitingAnswer/);
  assert.match(snap.text, /Planned thing/);
  assert.doesNotMatch(snap.text, /Finished thing/);
});

test("lazySnapshot surfaces an unanswered question so the Orchestrator can't repeat it", () => {
  clearPendingAsk();
  assert.equal(pendingAsk(), "");
  setSetting("lazy_pending_ask", "which staging domain?");
  assert.match(lazySnapshot(["lazy/repo"]).text, /do NOT ask this again[\s\S]*which staging domain\?/);
  clearPendingAsk();
  assert.doesNotMatch(lazySnapshot(["lazy/repo"]).text, /do NOT ask this again/);
});

// ── handoff proposals can name their target repo (agency-wide chat) ─────────────────────────────

test("parseHandoff reads a block-level repo and per-issue {repo:} overrides", () => {
  const p = parseHandoff([
    "```handoff",
    "workflow: split",
    "repo: acme/app",
    "- [Fix login] tighten the session check {agent: @dev}",
    "- [Bump deps] in the other service {repo: acme/api} {workflow: @build}",
    "```",
  ].join("\n"));
  assert.equal(p.repo, "acme/app");
  assert.equal(p.issues[0].repo, undefined, "inherits the block-level repo at creation time");
  assert.equal(p.issues[0].scope, "tighten the session check");
  assert.equal(p.issues[1].repo, "acme/api");
  assert.equal(p.issues[1].route, "@build");
  assert.equal(p.issues[1].scope, "in the other service");
});

// ── executing directives ────────────────────────────────────────────────────────────────────────

const { executeDirectives, applyLazyRoute } = await import("../dist/lazy.js");
const { getSetting } = await import("../dist/db/settings.js");

function stubDeps() {
  const calls = [];
  const rec = (kind) => async (repo, number) => { calls.push(`${kind} ${repo}#${number}`); };
  return { calls, start: rec("start"), resume: rec("resume"), fix: rec("fix"), stop: rec("stop") };
}

test("executeDirectives runs the actions and reports one line each", async () => {
  const deps = stubDeps();
  const lines = await executeDirectives({}, [
    { kind: "start", repo: "acme/app", number: 1 },
    { kind: "fix", repo: "acme/app", number: 2 },
    { kind: "stop", repo: "acme/app", number: 3 },
  ], deps, 5);
  assert.deepEqual(deps.calls, ["start acme/app#1", "fix acme/app#2", "stop acme/app#3"]);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /started acme\/app#1/);
});

test("executeDirectives never exceeds the free run slots, and says what it held back", async () => {
  const deps = stubDeps();
  const lines = await executeDirectives({}, [
    { kind: "start", repo: "acme/app", number: 1 },
    { kind: "start", repo: "acme/app", number: 2 },
    { kind: "start", repo: "acme/app", number: 3 },
  ], deps, 1);
  assert.deepEqual(deps.calls, ["start acme/app#1"], "only one slot was free");
  assert.match(lines[lines.length - 1], /held back 2 action\(s\)/);
});

test("a failing action is reported, and the rest of the round still runs", async () => {
  const deps = stubDeps();
  deps.start = async () => { throw new Error("no such issue"); };
  const lines = await executeDirectives({}, [
    { kind: "start", repo: "acme/app", number: 9 },
    { kind: "stop", repo: "acme/app", number: 8 },
  ], deps, 5);
  assert.match(lines[0], /start failed — no such issue/);
  assert.deepEqual(deps.calls, ["stop acme/app#8"]);
});

test("`ask` parks the question for the human instead of acting", async () => {
  clearPendingAsk();
  const deps = stubDeps();
  const lines = await executeDirectives({}, [{ kind: "ask", text: "which staging domain?" }], deps, 5);
  assert.deepEqual(deps.calls, []);
  assert.equal(pendingAsk(), "which staging domain?");
  assert.match(lines[0], /I need you on this one/);
  clearPendingAsk();
});

test("`route` pins the route structurally — never as text in the issue body", async () => {
  applyLazyRoute("acme/app", 42, "@dev");
  assert.equal(getSetting("issue_role_pin.acme/app#42"), "@dev");
});

test("lazySnapshot signature changes only when the agency actually moves", () => {
  const a = lazySnapshot(["lazy/repo"]).sig;
  assert.equal(lazySnapshot(["lazy/repo"]).sig, a, "same state → same fingerprint (no repeat turn)");
  recordIssueStatus("lazy/repo", 5, withStatus("planned"), { title: "New work" });
  assert.notEqual(lazySnapshot(["lazy/repo"]).sig, a, "new planned work → re-decide");
});
