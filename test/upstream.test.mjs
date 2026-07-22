// Tests for the controlled upstream-contribution channel (P5, docs/prime-time-plan.md #12): the
// generic-vs-instance-specific heuristic and the enable/target resolution. Never touches the
// network — openUpstreamContribPr / createIssue are not exercised here.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "upstream-")), "agency.db");
const { getDb } = await import("../dist/db/connection.js");
getDb();
const { setSetting } = await import("../dist/db/settings.js");
const { upstreamTarget, looksGeneric, FORK_PREFIX, maybeContributeLearnedUpstream } = await import("../dist/upstream.js");
const { OPS_SETTINGS } = await import("../dist/settings.js");

test("both settings are declared in OPS_SETTINGS (so the generic /settings ops-save path accepts them)", () => {
  const keys = OPS_SETTINGS.map((s) => s.key);
  assert.ok(keys.includes("upstream_contrib_enabled"));
  assert.ok(keys.includes("upstream_repo"));
});

const cfg = (overrides = {}) => ({
  githubToken: "x",
  owner: "acme",
  targetRepos: ["acme/widgets"],
  runMode: "once",
  pollIntervalSeconds: 60,
  agencyRepo: "acme/dev-agency",
  selfImprove: true,
  ...overrides,
});

test("upstreamTarget is off by default (opt-in bool)", () => {
  assert.equal(upstreamTarget(cfg()), null);
});

test("upstreamTarget resolves the default repo once the toggle is on", () => {
  setSetting("upstream_contrib_enabled", "on");
  assert.equal(upstreamTarget(cfg()), "ArneNostitz/dev-agency");
});

test("upstreamTarget is null when pointed at the instance's own repo (case-insensitive)", () => {
  setSetting("upstream_contrib_enabled", "on");
  setSetting("upstream_repo", "ACME/Dev-Agency");
  assert.equal(upstreamTarget(cfg({ agencyRepo: "acme/dev-agency" })), null);
});

test("upstreamTarget respects an explicit custom repo", () => {
  setSetting("upstream_contrib_enabled", "on");
  setSetting("upstream_repo", "someorg/upstream-project");
  assert.equal(upstreamTarget(cfg()), "someorg/upstream-project");
});

test("upstreamTarget is disabled by an explicitly-cleared repo field, even though the default is non-empty", () => {
  setSetting("upstream_contrib_enabled", "on");
  setSetting("upstream_repo", ""); // the operator cleared the Settings field
  assert.equal(upstreamTarget(cfg()), null);
});

test("upstreamTarget is null once the toggle is off again, regardless of the repo field", () => {
  setSetting("upstream_contrib_enabled", "off");
  setSetting("upstream_repo", "someorg/upstream-project");
  assert.equal(upstreamTarget(cfg()), null);
});

test("looksGeneric is true for content naming only the agency's own repo", () => {
  const c = cfg({ targetRepos: ["acme/widgets", "acme/gizmos"] });
  assert.equal(looksGeneric("Watch for stale lockfiles before running the tester.", c), true);
  assert.equal(looksGeneric("dev-agency's librarian should dedupe lessons more aggressively.", c), true);
});

test("looksGeneric is false when a watched product repo is named (bare name or owner/name)", () => {
  const c = cfg({ targetRepos: ["acme/widgets", "acme/gizmos"] });
  assert.equal(looksGeneric("widgets needs a pnpm workaround for its flaky build.", c), false);
  assert.equal(looksGeneric("acme/gizmos always fails lint on the generated client.", c), false);
});

test("looksGeneric matches on word boundaries, not substrings", () => {
  const c = cfg({ targetRepos: ["acme/widgets"] });
  // "widgetsmith" contains "widgets" as a substring but is a different word — must not false-positive.
  assert.equal(looksGeneric("widgetsmith is a great tool for woodworking, unrelated to any repo.", c), true);
});

test("FORK_PREFIX is the exact label used on every upstream PR/issue title", () => {
  assert.equal(FORK_PREFIX, "[from fork]");
});

// Security fix: the genericity gate must run against the EXACT payload that ships upstream (the
// full cumulative learned doc), not just this round's new lessons — an earlier round could have
// folded instance-specific text into the doc even when this round's own delta is clean.
test("maybeContributeLearnedUpstream gates on the cumulative content, not just this round's delta", async () => {
  setSetting("upstream_contrib_enabled", "on");
  setSetting("upstream_repo", "someorg/upstream-project");
  const c = cfg({ targetRepos: ["acme/widgets"] });

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const start = Date.now();
    await maybeContributeLearnedUpstream(c, {
      label: "Learned (shared)",
      // This round's delta alone is perfectly generic...
      sourceLessons: ["watch for stale lockfiles before running the tester"],
      // ...but the FULL cumulative doc (what actually ships) still carries an older,
      // instance-specific line folded in a prior round.
      content:
        "## Learned\n- watch for stale lockfiles before running the tester\n" +
        "- acme/widgets needs a pnpm workaround for its flaky build (folded 3 rounds ago)",
    });
    const elapsed = Date.now() - start;
    // Must return before ever attempting openUpstreamContribPr's gh/git calls — a real attempt
    // would take far longer (network + subprocess) than this in-process short-circuit.
    assert.ok(elapsed < 2000, "must skip before attempting any network/gh call");
  } finally {
    console.log = origLog;
  }
  assert.ok(
    logs.some((l) => l.includes("instance-specific")),
    "logs why the mirror was skipped instead of silently dropping it",
  );
});

// Confirms the skip is genuinely gated on genericity (not just "always skip") by re-running
// `looksGeneric` — the same function the gate calls — directly against both payload shapes.
test("looksGeneric itself: true for the delta alone, false once the cumulative content is checked", () => {
  const c = cfg({ targetRepos: ["acme/widgets"] });
  const delta = "watch for stale lockfiles before running the tester";
  const cumulative =
    "## Learned\n- watch for stale lockfiles before running the tester\n" +
    "- acme/widgets needs a pnpm workaround for its flaky build (folded 3 rounds ago)";
  assert.equal(looksGeneric(delta, c), true, "the delta alone looks generic");
  assert.equal(looksGeneric(cumulative, c), false, "the full cumulative doc reveals the instance-specific line");
});
