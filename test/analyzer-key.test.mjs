// Tests for ANALYZER_API_KEY hardening (P5, docs/prime-time-plan.md #13): auto-generate + persist
// on first boot instead of trusting the retired checked-in docker-compose.yml default.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "analyzerkey-")), "agency.db");
const { getDb } = await import("../dist/db/connection.js");
getDb();
const {
  analyzerApiKey,
  isUntrustedAnalyzerKey,
  RETIRED_DEFAULT_ANALYZER_KEY,
  _resetAnalyzerApiKeyCacheForTests,
} = await import("../dist/analyzerKey.js");
const { getSecretSetting } = await import("../dist/db/settings.js");

test.beforeEach(() => {
  _resetAnalyzerApiKeyCacheForTests();
  delete process.env.ANALYZER_API_KEY;
});

test("isUntrustedAnalyzerKey rejects empty and the retired checked-in default", () => {
  assert.equal(isUntrustedAnalyzerKey(""), true);
  assert.equal(isUntrustedAnalyzerKey(undefined), true);
  assert.equal(isUntrustedAnalyzerKey(RETIRED_DEFAULT_ANALYZER_KEY), true);
  assert.equal(isUntrustedAnalyzerKey("a-real-operator-chosen-secret"), false);
});

test("a trustworthy env var wins outright", () => {
  process.env.ANALYZER_API_KEY = "operator-set-real-secret-value";
  assert.equal(analyzerApiKey(), "operator-set-real-secret-value");
});

test("the retired checked-in default in env is ignored, same as unset", () => {
  process.env.ANALYZER_API_KEY = RETIRED_DEFAULT_ANALYZER_KEY;
  const k = analyzerApiKey();
  assert.notEqual(k, RETIRED_DEFAULT_ANALYZER_KEY);
  assert.equal(k.length, 64); // 32 random bytes, hex-encoded
});

test("with no env, a key is generated once and persisted (encrypted) in the DB", () => {
  const k1 = analyzerApiKey();
  assert.equal(typeof k1, "string");
  assert.ok(k1.length >= 32);
  assert.notEqual(k1, RETIRED_DEFAULT_ANALYZER_KEY);
  // Persisted as an encrypted secret setting, decryptable back to the same value.
  assert.equal(getSecretSetting("analyzer_api_key_generated"), k1);
});

test("a persisted key from a previous boot is reused across a fresh cache (stable across restarts)", () => {
  const k1 = analyzerApiKey();
  _resetAnalyzerApiKeyCacheForTests(); // simulate a fresh process, same DB
  const k2 = analyzerApiKey();
  assert.equal(k1, k2);
});

test("the in-process cache short-circuits repeated calls", () => {
  const k1 = analyzerApiKey();
  const k2 = analyzerApiKey();
  assert.equal(k1, k2);
});
