// Tests for searchMemory — the backend of the `recall` agent tool (Phase 1).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "dadb-recall-")), "test.db");
const s = await import("../dist/store.js");

test("searchMemory: empty query / no data → []", () => {
  assert.deepEqual(s.searchMemory(""), []);
  assert.deepEqual(s.searchMemory("anything"), []);
});

test("searchMemory: finds and ranks across lessons, plans, reviews, issues (repo-scoped)", () => {
  s.recordLesson("acme/app", 1, "Resolve merge conflicts by merging origin/main, never rebasing the shared branch.");
  s.recordPlan("acme/app", 2, "Plan: add rate limit handling with exponential backoff to the API client.");
  s.recordReview("acme/app", 3, "approved", "Rate limit retry looks correct; backoff capped at 30s.");
  s.recordIssueState("acme/app", 4, { title: "Fix flaky rate limit test", state: "planned" });

  // Artifacts are repo-PRIVATE — reachable only on the scoped path (unscoped now routes to the vault).
  const hits = s.searchMemory("rate limit", { repo: "acme/app" });
  assert.ok(hits.length >= 2, "matches multiple sources");
  assert.ok(hits.every((h) => h.text.toLowerCase().includes("rate limit") || h.text.toLowerCase().includes("rate")), "hits are relevant");
  assert.ok(hits.some((h) => h.kind === "plan"), "includes the plan");

  const conflict = s.searchMemory("merge conflict", { repo: "acme/app" });
  assert.ok(conflict.some((h) => h.kind === "lesson"), "finds the conflict lesson");

  assert.deepEqual(s.searchMemory("zzz-nonexistent-term", { repo: "acme/app" }), [], "no false matches");
});

test("searchMemory: repo scope is private — no cross-repo bleed", () => {
  s.recordPlan("acme/diary", 1, "Expo journal app with SQLite bullet entry setup and date navigation.");
  s.recordPlan("acme/reimedy", 86, "Swap-by-config provider seam: local bundled ICD-10 now, remote KB later via flag.");

  // Scoped to diary: must NOT surface the reimedy plan even though it matches the query.
  const scoped = s.searchMemory("provider seam ICD-10", { repo: "acme/diary" });
  assert.ok(!scoped.some((h) => h.repo === "acme/reimedy"), "reimedy memory never leaks into diary recall");

  // Scoped to reimedy: its own plan is reachable.
  const own = s.searchMemory("provider seam ICD-10", { repo: "acme/reimedy" });
  assert.ok(own.some((h) => h.repo === "acme/reimedy" && h.number === 86), "own repo memory is reachable");

  // No repo → unscoped routes to the Central Vault, NOT the repo-private artifact tables — so a
  // repo's plans/lessons never surface unscoped (they were the cross-repo bleed the filter closed).
  const all = s.searchMemory("provider seam ICD-10");
  assert.ok(!all.some((h) => h.repo === "acme/reimedy"), "unscoped no longer leaks artifacts — it hits the vault");
  assert.ok(all.every((h) => h.kind === "vault"), "unscoped hits are vault entries only");
});

test("searchMemory: repo scope is private — no cross-repo bleed", () => {
  s.recordPlan("acme/diary", 1, "Expo journal app with SQLite bullet entry setup and date navigation.");
  s.recordPlan("acme/reimedy", 86, "Swap-by-config provider seam: local bundled ICD-10 now, remote KB later via flag.");

  // Scoped to diary: must NOT surface the reimedy plan even though it matches the query.
  const scoped = s.searchMemory("provider seam ICD-10", { repo: "acme/diary" });
  assert.ok(!scoped.some((h) => h.repo === "acme/reimedy"), "reimedy memory never leaks into diary recall");

  // Scoped to reimedy: its own plan is reachable.
  const own = s.searchMemory("provider seam ICD-10", { repo: "acme/reimedy" });
  assert.ok(own.some((h) => h.repo === "acme/reimedy" && h.number === 86), "own repo memory is reachable");

  // No repo → unscoped (central-vault style) still returns across repos.
  const all = s.searchMemory("provider seam ICD-10");
  assert.ok(all.some((h) => h.repo === "acme/reimedy"), "unscoped search is unrestricted");
});

test("searchMemory: repo scope is private — no cross-repo bleed", () => {
  s.recordPlan("acme/diary", 1, "Expo journal app with SQLite bullet entry setup and date navigation.");
  s.recordPlan("acme/reimedy", 86, "Swap-by-config provider seam: local bundled ICD-10 now, remote KB later via flag.");

  // Scoped to diary: must NOT surface the reimedy plan even though it matches the query.
  const scoped = s.searchMemory("provider seam ICD-10", { repo: "acme/diary" });
  assert.ok(!scoped.some((h) => h.repo === "acme/reimedy"), "reimedy memory never leaks into diary recall");

  // Scoped to reimedy: its own plan is reachable.
  const own = s.searchMemory("provider seam ICD-10", { repo: "acme/reimedy" });
  assert.ok(own.some((h) => h.repo === "acme/reimedy" && h.number === 86), "own repo memory is reachable");

  // No repo → unscoped (central-vault style) still returns across repos.
  const all = s.searchMemory("provider seam ICD-10");
  assert.ok(all.some((h) => h.repo === "acme/reimedy"), "unscoped search is unrestricted");
});

test("searchMemory: respects limit and truncates long text", () => {
  for (let i = 10; i < 30; i++) s.recordLesson("acme/app", i, "caching strategy note number " + i);
  const hits = s.searchMemory("caching", { repo: "acme/app", limit: 5 });
  assert.equal(hits.length, 5, "limit honored");
  assert.ok(hits[0].text.length <= 800, "text capped");
});
