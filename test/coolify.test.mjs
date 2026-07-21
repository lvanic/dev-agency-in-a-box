// Tests for the Coolify redeploy trigger config/gating (self-merge auto-deploy).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "dadb-coolify-")), "test.db");

const c = await import("../dist/coolify.js");
const s = await import("../dist/store.js");

test("unconfigured: not configured, no last deploy", () => {
  const st = c.coolifyStatus();
  assert.equal(st.configured, false);
  assert.equal(st.lastAt, null);
  assert.equal(st.autoRedeploy, false); // unset + unconfigured → off (nowhere to deploy)
});

test("triggerCoolifyDeploy no-ops (records a failure) when unconfigured", async () => {
  const r = await c.triggerCoolifyDeploy(false, "test");
  assert.equal(r.ok, false);
  assert.match(r.message, /not configured/i);
  const st = c.coolifyStatus();
  assert.equal(st.lastOk, false);
});

test("configured once base+uuid+token are set; base URL is normalised", () => {
  s.setSetting("coolify_base_url", "https://coolify.example.com/api/");
  s.setSetting("coolify_uuid", "u8w4o0k");
  s.setSecretSetting("coolify_token", "1|secrettoken");
  const st = c.coolifyStatus();
  assert.equal(st.configured, true);
  assert.equal(st.baseUrl, "https://coolify.example.com"); // trailing slash + /api stripped
  assert.equal(st.uuidSet, true);
  assert.equal(st.tokenSet, true);
  assert.equal(st.autoRedeploy, true); // unset + configured → on
});

test("saveCoolifySettings toggles auto-redeploy off explicitly", () => {
  c.saveCoolifySettings({ autoRedeploy: "off" });
  assert.equal(c.coolifyStatus().autoRedeploy, false);
  c.saveCoolifySettings({ autoRedeploy: "on" });
  assert.equal(c.coolifyStatus().autoRedeploy, true);
});

test("maybeRedeployAfterMerge ignores a non-agency repo", () => {
  s.setSetting("agency_repo", "acme/dev-agency");
  const before = c.coolifyStatus().lastAt;
  c.maybeRedeployAfterMerge("acme/some-other-product"); // synchronous guard returns before any fetch
  assert.equal(c.coolifyStatus().lastAt, before); // unchanged — never attempted
});
