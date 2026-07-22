// P3 (prime-time-plan): changedFileCount — real git repo, no hardcoded "main" default, undefined
// (never 0) on a git error so decideNext()'s "unknown diff size never downshifts" contract holds.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const { changedFileCount } = await import("../dist/github.js");

function makeRepo() {
  const wd = mkdtempSync(join(tmpdir(), "changedfiles-"));
  const sh = (c) => execSync(c, { cwd: wd, stdio: "pipe" });
  sh("git init -q && git config user.email a@b.c && git config user.name t && git checkout -q -B trunk");
  writeFileSync(join(wd, "a.txt"), "one\n");
  sh("git add -A && git commit -q -m base");
  sh("git checkout -q -b work");
  return { wd, sh };
}

test("changedFileCount: counts files touched vs. the given base branch (no hardcoded 'main')", async () => {
  const { wd, sh } = makeRepo();
  writeFileSync(join(wd, "a.txt"), "one\ntwo\n");
  writeFileSync(join(wd, "b.txt"), "new\n");
  sh("git add -A && git commit -q -m work");
  assert.equal(await changedFileCount(wd, "trunk"), 2, "explicit base param works even though it's not named 'main'");
});

test("changedFileCount: zero real changes → 0 (not confused with the error case)", async () => {
  const { wd } = makeRepo();
  assert.equal(await changedFileCount(wd, "trunk"), 0);
});

test("changedFileCount: an unresolvable base ref → undefined, never 0", async () => {
  const { wd } = makeRepo();
  writeFileSync(join(wd, "a.txt"), "changed\n");
  const missing = await changedFileCount(wd, "this-branch-does-not-exist");
  assert.equal(missing, undefined, "a git error must surface as undefined, not a misleading 0");
});

test("changedFileCount: a nonexistent workdir → undefined", async () => {
  const missing = await changedFileCount("/no/such/dir/at/all", "trunk");
  assert.equal(missing, undefined);
});
