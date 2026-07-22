// Central Vault (docs/central-vault-plan.md) — strict encode/decode, write-time guard, scope-glob
// matching, upsert+revisions, budget-capped slice, and the one-off learned→vault boot migration.
// Redirects BOTH the SQLite file (DB_PATH) and the memory/ disk mirror (AGENCY_MEMORY_ROOT) at a
// throwaway tmp dir so this never touches the real checkout.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const memRoot = mkdtempSync(join(tmpdir(), "vault-mem-"));
process.env.AGENCY_MEMORY_ROOT = memRoot;
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "vault-db-")), "agency.db");

const { getDb } = await import("../dist/db/connection.js");
getDb();
const {
  encodeVaultEntry,
  decodeVaultEntry,
  contentHasArtifactRef,
  upsertVaultEntry,
  getVaultEntry,
  listVault,
  deleteVaultEntry,
  listVaultRevisions,
  scopeMatches,
} = await import("../dist/db/vault.js");
const { vaultSlice, migrateLearnedToVault } = await import("../dist/vault.js");
const { searchMemory } = await import("../dist/db/memory.js");

test("encode → decode round-trips and drops empty role, stable key order", () => {
  const line = encodeVaultEntry({ k: "pkg-manager", t: "pref", s: "*", c: "pnpm>npm always", w: 3 });
  assert.equal(line, '{"v":1,"k":"pkg-manager","t":"pref","s":"*","c":"pnpm>npm always","w":3}');
  const back = decodeVaultEntry(line);
  assert.deepEqual(back, { v: 1, k: "pkg-manager", t: "pref", s: "*", c: "pnpm>npm always", w: 3 });
  assert.equal(back.r, undefined);
});

test("encode keeps role when set", () => {
  const line = encodeVaultEntry({ k: "review-craft", t: "know", s: "*", r: "reviewer", c: "run tests before verdict", w: 2 });
  assert.match(line, /"r":"reviewer"/);
  assert.equal(decodeVaultEntry(line).r, "reviewer");
});

test("encode rejects bad key / kind / weight / empty content", () => {
  assert.throws(() => encodeVaultEntry({ k: "Bad Key", t: "pref", s: "*", c: "x", w: 1 }), /invalid key/);
  assert.throws(() => encodeVaultEntry({ k: "k", t: "nope", s: "*", c: "x", w: 1 }), /invalid kind/);
  assert.throws(() => encodeVaultEntry({ k: "k", t: "pref", s: "*", c: "x", w: 4 }), /weight/);
  assert.throws(() => encodeVaultEntry({ k: "k", t: "pref", s: "*", c: "  ", w: 1 }), /content/);
  assert.throws(() => encodeVaultEntry({ k: "k", t: "pref", s: "", c: "x", w: 1 }), /scope/);
});

test("decode strictly rejects unknown version, unknown key, wrong types", () => {
  assert.equal(decodeVaultEntry('{"v":2,"k":"a","t":"pref","s":"*","c":"x","w":1}'), null);
  assert.equal(decodeVaultEntry('{"v":1,"k":"a","t":"pref","s":"*","c":"x","w":1,"x":1}'), null); // unknown key
  assert.equal(decodeVaultEntry('{"v":1,"k":"a","t":"pref","s":"*","c":"x","w":9}'), null); // bad weight
  assert.equal(decodeVaultEntry('{"v":1,"k":"A B","t":"pref","s":"*","c":"x","w":1}'), null); // bad key slug
  assert.equal(decodeVaultEntry("not json"), null);
  assert.equal(decodeVaultEntry("[]"), null);
});

test("write-time guard blocks issue/PR refs unless allowIssueRef", () => {
  assert.equal(contentHasArtifactRef("fixed in #142 last week"), true);
  assert.equal(contentHasArtifactRef("see https://github.com/a/b/pull/12 for detail"), true);
  assert.equal(contentHasArtifactRef("pnpm over npm, lockfile v9"), false);
  assert.throws(() => encodeVaultEntry({ k: "leak", t: "know", s: "*", c: "as in #99", w: 1 }), /issue\/PR\/run/);
  // opt-in override
  assert.ok(encodeVaultEntry({ k: "ok", t: "know", s: "*", c: "as in #99", w: 1 }, { allowIssueRef: true }));
});

test("scopeMatches handles global, exact, prefix-glob against full path and bare name", () => {
  assert.equal(scopeMatches("*", "ArneNostitz/anything"), true);
  assert.equal(scopeMatches("ArneNostitz/dev-agency", "ArneNostitz/dev-agency"), true);
  assert.equal(scopeMatches("dev-agency", "ArneNostitz/dev-agency"), true); // bare-name match
  assert.equal(scopeMatches("reimedy-*", "ArneNostitz/reimedy-minimal"), true);
  assert.equal(scopeMatches("reimedy-*", "ArneNostitz/dev-agency"), false);
});

test("upsert stores by key, updates in place, and appends a revision each write", () => {
  upsertVaultEntry({ k: "up-1", t: "env", s: "*", c: "first", w: 1 }, "human");
  upsertVaultEntry({ k: "up-1", t: "env", s: "*", c: "second", w: 2 }, "librarian");
  const row = getVaultEntry("up-1");
  assert.equal(row.entry.c, "second");
  assert.equal(row.entry.w, 2);
  assert.equal(row.source, "librarian");
  const revs = listVaultRevisions("up-1");
  assert.equal(revs.length, 2); // both writes kept
  deleteVaultEntry("up-1");
  assert.equal(getVaultEntry("up-1"), null);
});

test("listVault filters by scope glob and by role", () => {
  upsertVaultEntry({ k: "lv-global", t: "pref", s: "*", c: "g", w: 3 });
  upsertVaultEntry({ k: "lv-repo", t: "env", s: "reimedy-*", c: "r", w: 2 });
  upsertVaultEntry({ k: "lv-role", t: "know", s: "*", r: "reviewer", c: "rc", w: 2 });
  const forReimedy = listVault({ scope: "ArneNostitz/reimedy-minimal" }).map((r) => r.key);
  assert.ok(forReimedy.includes("lv-global") && forReimedy.includes("lv-repo"));
  const forRole = listVault({ role: "developer" }).map((r) => r.key);
  assert.ok(!forRole.includes("lv-role")); // reviewer-only entry excluded for developer
  assert.ok(forRole.includes("lv-global"));
  for (const k of ["lv-global", "lv-repo", "lv-role"]) deleteVaultEntry(k);
});

test("vaultSlice ranks by weight, respects role/scope, and caps the token budget", () => {
  upsertVaultEntry({ k: "s-hi", t: "pref", s: "*", c: "high weight fact", w: 3 });
  upsertVaultEntry({ k: "s-lo", t: "pref", s: "*", c: "low weight fact", w: 1 });
  upsertVaultEntry({ k: "s-rev", t: "know", s: "*", r: "reviewer", c: "reviewer only", w: 3 });
  upsertVaultEntry({ k: "s-repo", t: "env", s: "other-*", c: "unrelated repo", w: 3 });
  const slice = vaultSlice("ArneNostitz/dev-agency", "developer");
  const hi = slice.indexOf("s-hi");
  const lo = slice.indexOf("s-lo");
  assert.ok(hi > -1 && lo > -1 && hi < lo, "higher weight appears first");
  assert.ok(!slice.includes("s-rev"), "reviewer-only excluded for developer");
  assert.ok(!slice.includes("s-repo"), "non-matching repo scope excluded");
  // Budget cap: many big entries must not blow ~250 tokens of canonical lines.
  for (let i = 0; i < 60; i++) upsertVaultEntry({ k: `bulk-${i}`, t: "know", s: "*", c: "x".repeat(300), w: 2 });
  const big = vaultSlice("ArneNostitz/dev-agency", "developer");
  const bodyChars = big.split("\n").filter((l) => l.startsWith("{")).join("\n").length;
  assert.ok(bodyChars / 4 <= 300, `slice body ~${Math.round(bodyChars / 4)} tokens should stay near budget`);
  for (let i = 0; i < 60; i++) deleteVaultEntry(`bulk-${i}`);
  for (const k of ["s-hi", "s-lo", "s-rev", "s-repo"]) deleteVaultEntry(k);
});

test("unscoped searchMemory routes to the vault; term + weight ranked", () => {
  upsertVaultEntry({ k: "sv-1", t: "pref", s: "*", c: "always prefer pnpm lockfiles", w: 3 });
  const hits = searchMemory("pnpm lockfile", {}); // no repo → vault
  assert.ok(hits.some((h) => h.kind === "vault" && h.text.includes("pnpm")));
  deleteVaultEntry("sv-1");
});

test("migrateLearnedToVault seeds bullets once, scopes role docs, and skips issue refs", async () => {
  const agentsDir = join(memRoot, "memory", "central", "agents");
  const booksDir = join(memRoot, "memory", "central", "playbooks");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(booksDir, { recursive: true });
  writeFileSync(join(booksDir, "_learned.md"), "# Learned\n- prefer small PRs\n- mention #142 (should be skipped)\n");
  writeFileSync(join(agentsDir, "reviewer.learned.md"), "- always run tests before the verdict\n");

  const n = await migrateLearnedToVault();
  assert.ok(n >= 2, `seeded ${n} entries`);
  const all = listVault();
  const shared = all.find((r) => r.entry.c.includes("prefer small PRs"));
  assert.ok(shared && shared.entry.s === "*" && !shared.entry.r, "shared bullet is global, role-less");
  const reviewer = all.find((r) => r.entry.c.includes("run tests before the verdict"));
  assert.ok(reviewer && reviewer.entry.r === "reviewer", "role doc bullet tagged reviewer");
  assert.ok(!all.some((r) => /#142/.test(r.entry.c)), "issue-ref bullet skipped by the guard");

  // Idempotent: second call is a no-op (flag set).
  assert.equal(await migrateLearnedToVault(), 0);
});
