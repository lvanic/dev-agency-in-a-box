// #161: loop-budget parking latch + per-endpoint gh call observability.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "dadb-161-")), "test.db");
process.env.GH_ENDPOINT_WARN = "3"; // low threshold so the test can trip it deterministically
const s = await import("../dist/store.js");
const gh = await import("../dist/github.js");

test("auto-parked latch: set once, cleared by resetAutoAttempts", () => {
  const repo = "acme/app", n = 7;
  assert.equal(s.isAutoParked(repo, n), false, "not parked initially");
  s.markAutoParked(repo, n);
  assert.equal(s.isAutoParked(repo, n), true, "parked after mark");
  s.resetAutoAttempts(repo, n); // good state reached → allow future re-park
  assert.equal(s.isAutoParked(repo, n), false, "reset clears the latch");
});

test("clearAutoParked releases the latch independently", () => {
  const repo = "acme/app", n = 8;
  s.markAutoParked(repo, n);
  s.clearAutoParked(repo, n);
  assert.equal(s.isAutoParked(repo, n), false);
});

test("endpointKey groups by shape, dropping ids and flags", () => {
  assert.equal(gh.endpointKey(["pr", "list", "--repo", "a/b", "--json", "number"]), "pr list");
  assert.equal(gh.endpointKey(["issue", "view", "123", "--repo", "a/b"]), "issue view");
  assert.equal(
    gh.endpointKey(["api", "repos/a/b/issues/123/comments", "--paginate"]),
    "api repos/a/b/issues/:n/comments",
    "numeric ids collapse to :n so calls group",
  );
});

test("bumpApiCall counts per endpoint and warns once past the threshold", () => {
  const t0 = new Date(Date.now() - 1000).toISOString();
  for (let i = 0; i < 3; i++) s.bumpApiCall("pr list"); // GH_ENDPOINT_WARN=3 → trips on the 3rd
  const stats = s.apiCallStats();
  const prList = stats.find((x) => x.endpoint === "pr list");
  assert.ok(prList, "endpoint tracked");
  assert.equal(prList.calls, 0, "counter resets after warning so it only re-warns on recurrence");
  // The trip is recorded as a system incident (ok=0) for the analyzer to pick up.
  const fails = s.recentFailuresSince(t0);
  assert.ok(fails.some((f) => f.tool === "github-endpoint-hot"), "hot-endpoint incident recorded");
});
