// Central Vault translate tool (Phase 2): deterministic render + tolerant compress-output parsing.
// The LLM call itself (runVaultCompletion/compressToEntries/explainEntry) is best-effort and not
// exercised here — only the pure, deterministic pieces the UI + save path depend on.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "vault-tr-db-")), "agency.db");
const { getDb } = await import("../dist/db/connection.js");
getDb();
const { renderVault, parseCompressOutput, canonicalLineOf } = await import("../dist/vaultTranslate.js");
const { decodeVaultEntry } = await import("../dist/db/vault.js");

const E = (o) => decodeVaultEntry(canonicalLineOf({ v: 1, ...o }));

test("renderVault groups by kind, sorts by weight, is deterministic", () => {
  const entries = [
    { k: "b-know", t: "know", s: "*", c: "low", w: 1 },
    { k: "a-pref", t: "pref", s: "*", c: "pref one", w: 3 },
    { k: "a-know", t: "know", s: "reimedy-*", c: "high", w: 3, r: "reviewer" },
  ].map(E);
  const md1 = renderVault(entries);
  const md2 = renderVault([...entries].reverse());
  assert.equal(md1, md2, "order-independent output");
  assert.ok(md1.indexOf("## Preferences") < md1.indexOf("## Knowledge"), "kind order pref before know");
  assert.ok(md1.indexOf("a-know") < md1.indexOf("b-know"), "within kind, higher weight first");
  assert.match(md1, /scope `reimedy-\*`/);
  assert.match(md1, /role reviewer/);
  assert.match(md1, /scope global/);
});

test("renderVault handles empty", () => {
  assert.equal(renderVault([]), "_(vault is empty)_");
});

test("parseCompressOutput extracts canonical lines, tolerates fences/prose, dedupes by key", () => {
  const reply = [
    "Here are the records:",
    "```json",
    '{"v":1,"k":"pkg-mgr","t":"pref","s":"*","c":"pnpm>npm","w":3}',
    "```",
    '{"v":1,"k":"pkg-mgr","t":"pref","s":"*","c":"dupe key dropped","w":1}',
    "not a json line",
    '{"v":1,"k":"stack","t":"env","s":"reimedy-*","c":"tauri2+flutter","w":2}',
    '{"v":2,"k":"bad-ver","t":"env","s":"*","c":"x","w":1}',
  ].join("\n");
  const got = parseCompressOutput(reply);
  assert.equal(got.length, 2, "two valid unique entries");
  assert.equal(got[0].k, "pkg-mgr");
  assert.equal(got[0].c, "pnpm>npm"); // first wins on duplicate key
  assert.equal(got[1].k, "stack");
  assert.ok(!("v" in got[0]), "returns VaultInput (no v)");
});

test("canonicalLineOf matches the stored encoding, round-trips through decode", () => {
  const line = canonicalLineOf(E({ k: "rt", t: "know", s: "*", r: "developer", c: "x", w: 2 }));
  assert.equal(line, '{"v":1,"k":"rt","t":"know","s":"*","r":"developer","c":"x","w":2}');
  assert.equal(decodeVaultEntry(line).r, "developer");
});
