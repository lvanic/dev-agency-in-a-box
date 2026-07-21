// The agency's own repo must NEVER get the [skip ci] tag: it has no GitHub Actions, and the tag
// would leak into the squash-merge commit on `main` where Coolify honors [skip ci] and would skip
// the webhook auto-deploy — the reason self-merges never redeployed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "dadb-skipci-")), "test.db");
delete process.env.SKIP_CI; // exercise the default (on)

const g = await import("../dist/github.js");
const s = await import("../dist/store.js");

test("agency's own repo is exempt from [skip ci] (bare name)", () => {
  s.setSetting("agency_repo", "dev-agency");
  assert.equal(g.isAgencyRepo("dev-agency"), true);
  assert.equal(g.skipCiEnabledFor("dev-agency"), false, "agency repo never tagged");
});

test("agency's own repo is exempt when owner-qualified", () => {
  s.setSetting("github_owner", "ArneNostitz");
  s.setSetting("agency_repo", "dev-agency");
  assert.equal(g.isAgencyRepo("ArneNostitz/dev-agency"), true);
  assert.equal(g.skipCiEnabledFor("ArneNostitz/dev-agency"), false);
});

test("watched product repos still get [skip ci] by default", () => {
  assert.equal(g.isAgencyRepo("ArneNostitz/some-product"), false);
  assert.equal(g.skipCiEnabledFor("ArneNostitz/some-product"), true, "default on for other repos");
});

test("SKIP_CI=off disables the tag everywhere", () => {
  s.setSetting("skip_ci", "off");
  assert.equal(g.skipCiEnabledFor("ArneNostitz/some-product"), false);
  assert.equal(g.skipCiEnabledFor("dev-agency"), false);
});
