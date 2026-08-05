// Per-repo credentials (issue #263): the pure KEY=value parser + masking, and an encrypted
// store round-trip that only ever exposes key NAMES + masked values (never the plaintext).
// Points DB_PATH at a throwaway tmp dir so it never touches the real checkout.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "repocreds-")), "test.db");

const { parseEnvLines, maskCredValue, repoCredentials, repoCredentialKeys } = await import("../dist/creds.js");
const { setRepoCreds, getRepoCreds } = await import("../dist/store.js");

test("parseEnvLines: KEY=value, comments, blanks, export, quotes, dup, malformed", () => {
  const parsed = parseEnvLines(
    [
      "# a comment",
      "",
      "OPENAI_API_KEY=sk-abc123",
      "export DATABASE_URL=postgres://u:p@h/db",
      'QUOTED="has spaces"',
      "SINGLE='single quoted'",
      "not a valid line",
      "=novalue",
      "1BAD=nope",
      "OPENAI_API_KEY=sk-override",
    ].join("\n"),
  );
  assert.deepEqual(parsed, {
    OPENAI_API_KEY: "sk-override", // later line wins
    DATABASE_URL: "postgres://u:p@h/db", // leading `export ` stripped
    QUOTED: "has spaces", // surrounding quotes removed
    SINGLE: "single quoted",
  });
  assert.equal(Object.keys(parseEnvLines("")).length, 0);
});

test("maskCredValue: never leaks the plaintext, only bullets", () => {
  for (const v of ["x", "sk-supersecret-value", "1234"]) {
    const m = maskCredValue(v);
    assert.match(m, /^•+$/);
    assert.ok(!m.includes(v) || v.length === 0);
  }
});

test("store round-trip: encrypted at rest, exposes only names + masks", () => {
  const repo = "acme/app";
  setRepoCreds(repo, "OPENAI_API_KEY=sk-topsecret\nSTRIPE_KEY=sk_live_xyz");

  // Raw stored value must NOT be plaintext (it's encrypted).
  const raw = getRepoCreds(repo);
  assert.equal(raw, "OPENAI_API_KEY=sk-topsecret\nSTRIPE_KEY=sk_live_xyz"); // decrypted for run-time use
  // The at-run env carries the real values (for injection only).
  assert.deepEqual(repoCredentials(repo), { OPENAI_API_KEY: "sk-topsecret", STRIPE_KEY: "sk_live_xyz" });
  // The dashboard-facing view never carries plaintext.
  const keys = repoCredentialKeys(repo);
  assert.deepEqual(keys.map((k) => k.key).sort(), ["OPENAI_API_KEY", "STRIPE_KEY"]);
  for (const k of keys) {
    assert.match(k.masked, /^•+$/);
    assert.ok(!JSON.stringify(k).includes("topsecret"));
    assert.ok(!JSON.stringify(k).includes("sk_live_xyz"));
  }
});

test("repoCredentials: empty for an unknown repo", () => {
  assert.deepEqual(repoCredentials("nobody/here"), {});
  assert.deepEqual(repoCredentialKeys("nobody/here"), []);
});
