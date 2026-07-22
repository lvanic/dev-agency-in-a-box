// Central Vault Phase 3: the librarian fold's SCOPING policy (bucketLessonsForVault) + the legacy
// learned-override purge. The compress() step is an LLM call and not exercised here — the scoping
// matrix (generic→global, repo-specific→scoped, role-tagged→role) is the testable heart of the fold.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect BOTH the DB and the memory/ disk mirror at throwaway dirs — setAgentOverride mirrors to
// AGENCY_MEMORY_ROOT, so without this the purge test would write a stray _learned.md into the checkout.
process.env.AGENCY_MEMORY_ROOT = mkdtempSync(join(tmpdir(), "vault-fold-mem-"));
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "vault-fold-db-")), "agency.db");
const { getDb } = await import("../dist/db/connection.js");
getDb();
const { bucketLessonsForVault } = await import("../dist/reflect.js");
const { setAgentOverride, getAgentOverride, purgeAgentOverride, listAgentRevisions } = await import("../dist/db/agent_overrides.js");

// cfg names one watched product repo (acme/widgets) so looksGeneric can tell generic from specific.
const cfg = { agencyRepo: "acme/dev-agency", targetRepos: ["acme/widgets"], upstreamRepo: "" };
const L = (id, repo, lesson, role = null) => ({ id, repo, number: id, lesson, role, created_at: "" });

test("generic lesson → global scope '*'", () => {
  const b = bucketLessonsForVault([L(1, "acme/widgets", "Always prefer pnpm; enable corepack first.")], cfg);
  assert.equal(b.length, 1);
  assert.equal(b[0].scope, "*");
  assert.equal(b[0].role, null);
});

test("repo-specific lesson (names a watched repo) → scoped to that repo", () => {
  const b = bucketLessonsForVault([L(2, "acme/widgets", "widgets needs a pnpm workaround for its flaky build.")], cfg);
  assert.equal(b[0].scope, "acme/widgets");
});

test("role-tagged lesson → role set, scope by genericity", () => {
  const b = bucketLessonsForVault([L(3, "acme/widgets", "run tests before every verdict.", "reviewer")], cfg);
  assert.equal(b[0].role, "reviewer");
  assert.equal(b[0].scope, "*"); // generic content → global, but still role-tagged
});

test("unknown role tag is dropped (role → null)", () => {
  const b = bucketLessonsForVault([L(4, "acme/widgets", "generic note", "notarole")], cfg);
  assert.equal(b[0].role, null);
});

test("same (scope, role) lessons collapse into one bucket; different ones split", () => {
  const buckets = bucketLessonsForVault([
    L(10, "acme/widgets", "prefer pnpm always."),                       // *, null
    L(11, "acme/widgets", "enable corepack before install."),           // *, null  → same bucket as 10
    L(12, "acme/widgets", "run tests before verdict.", "reviewer"),      // *, reviewer
    L(13, "acme/widgets", "widgets build is flaky, retry once."),        // acme/widgets, null
  ], cfg);
  const byKey = Object.fromEntries(buckets.map((b) => [`${b.scope}|${b.role ?? ""}`, b.lessons.length]));
  assert.equal(byKey["*|"], 2, "two generic untagged lessons share a bucket");
  assert.equal(byKey["*|reviewer"], 1);
  assert.equal(byKey["acme/widgets|"], 1);
  assert.equal(buckets.length, 3);
});

test("purgeAgentOverride removes the override + its full revision history (no disk mirror)", () => {
  const P = "central/playbooks/_learned.md";
  setAgentOverride(P, "some legacy learned content", "self-improve", "old fold");
  setAgentOverride(P, "more legacy content", "self-improve", "another fold");
  assert.equal(getAgentOverride(P), "more legacy content");
  assert.ok(listAgentRevisions(P).length >= 2);
  purgeAgentOverride(P);
  assert.equal(getAgentOverride(P), null);
  assert.equal(listAgentRevisions(P).length, 0, "revisions purged too");
});
