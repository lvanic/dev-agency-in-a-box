// A missing dependency must never be scored as a test result. In a live run the tester reported
// `Cannot find module 'supertest'` as a FAIL, baselineFailures found the same module missing on the
// base commit, called it "already failing on main — pre-existing, not gated", and two issues shipped
// with the test gate effectively off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEnvError, detectCommands, runChecks } from "../dist/checks.js";

test("a missing module is an ENV failure, not a code failure", () => {
  // Node and Python both exit 1 for this — the output is the only signal.
  assert.equal(isEnvError("npm test", 1, "Error: Cannot find module 'supertest'"), true);
  assert.equal(isEnvError("npm test", 1, "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'"), true);
  assert.equal(isEnvError("python3 -m pytest -q", 1, "ModuleNotFoundError: No module named 'httpx'"), true);
});

test("a genuine test failure is still a code failure", () => {
  assert.equal(isEnvError("npm test", 1, "AssertionError: expected 200 to equal 404"), false);
  assert.equal(isEnvError("npm test", 1, "2 tests failed"), false);
  assert.equal(isEnvError("npm test", 0, ""), false, "a passing run is never an env error");
});

test("command-not-found and pytest collection errors still count as env", () => {
  assert.equal(isEnvError("npm test", 127, ""), true);
  assert.equal(isEnvError("python3 -m pytest -q", 5, ""), true);
});

async function project() {
  const dir = await mkdtemp(join(tmpdir(), "deps-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node -e 0" } }));
  await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
  await writeFile(join(dir, "node_modules", ".package-lock.json"), "{}");
  return dir;
}

test("deps are reinstalled when package.json changed after the last install", async () => {
  const dir = await project();
  const set = detectCommands(dir);

  // Installed AFTER the manifest → nothing to do. runChecks would skip the install here.
  const old = new Date(Date.now() - 60_000), fresh = new Date();
  await utimes(join(dir, "package.json"), old, old);
  await utimes(join(dir, "node_modules", ".package-lock.json"), fresh, fresh);
  const upToDate = await runChecks(dir, "");
  assert.equal(upToDate.ran, true, "a fresh install should let the checks run");

  // Now an agent adds a dependency mid-run: package.json is newer than the install marker. The
  // install must NOT be skipped — this is the case that produced the missing-module report.
  const newer = new Date(Date.now() + 60_000);
  await utimes(join(dir, "package.json"), newer, newer);
  const stale = await runChecks(dir, "");
  // Either it reinstalled and ran, or the install failed and it reported env-blocked. What it must
  // never do is silently run the suite against stale node_modules and score the result.
  assert.equal(stale.ran, true);
  assert.ok(stale.pass || stale.envBlocked, "a stale tree must reinstall or report env-blocked, never a phantom failure");
});
