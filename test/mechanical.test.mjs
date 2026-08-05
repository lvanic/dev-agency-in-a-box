// Mechanical ops are applied by code, before any agent runs. Two things must hold: they do the
// right thing, and a malformed or hostile op can never touch anything outside the repo — an ops
// block is model output, so it is untrusted input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOps, applyOps, safeRepoPath, renderOpResults } from "../dist/mechanical.js";

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "ops-"));
  await mkdir(join(dir, "routes"), { recursive: true });
  await writeFile(join(dir, "routes", "links.test.js"), "// tests\n");
  await writeFile(join(dir, "stale.js"), "// dead\n");
  return dir;
}

test("parseOps reads move/delete/mkdir and skips comments and junk", () => {
  const ops = parseOps([
    "text before",
    "```ops",
    "# a comment",
    "move routes/links.test.js -> test/links.test.js",
    "delete stale.js",
    "mkdir docs",
    "frobnicate everything",
    "```",
  ].join("\n"));
  assert.deepEqual(ops, [
    { kind: "move", from: "routes/links.test.js", to: "test/links.test.js" },
    { kind: "delete", path: "stale.js" },
    { kind: "mkdir", path: "docs" },
  ]);
});

test("parseOps returns nothing when the body has no ops block", () => {
  assert.deepEqual(parseOps("Just a normal issue body."), []);
});

test("applyOps moves, deletes and creates for real", async () => {
  const dir = await repo();
  const results = await applyOps(dir, parseOps("```ops\nmove routes/links.test.js -> test/links.test.js\ndelete stale.js\nmkdir docs\n```"));
  assert.equal(results.filter((r) => r.ok).length, 3, renderOpResults(results));
  assert.ok(existsSync(join(dir, "test", "links.test.js")), "file moved into a directory that did not exist");
  assert.equal(await readFile(join(dir, "test", "links.test.js"), "utf8"), "// tests\n", "contents preserved");
  assert.ok(!existsSync(join(dir, "routes", "links.test.js")), "old path gone");
  assert.ok(!existsSync(join(dir, "stale.js")), "deleted file gone");
  assert.ok(existsSync(join(dir, "docs", ".gitkeep")), "new dir is committable");
});

test("paths outside the repo are refused", async () => {
  const dir = await repo();
  for (const bad of ["../escape.js", "/etc/passwd", ".git/config", ".git/hooks/pre-commit"]) {
    assert.equal(safeRepoPath(dir, bad), null, `${bad} must be rejected`);
  }
  const results = await applyOps(dir, [
    { kind: "delete", path: "../escape.js" },
    { kind: "move", from: "stale.js", to: "../../owned.js" },
  ]);
  assert.equal(results.every((r) => !r.ok), true, "hostile ops must all fail");
  assert.ok(existsSync(join(dir, "stale.js")), "a refused move must not have moved anything");
});

test("a bad op is reported but the rest still run", async () => {
  const dir = await repo();
  const results = await applyOps(dir, parseOps("```ops\nmove nope/missing.js -> test/x.js\ndelete stale.js\n```"));
  assert.equal(results[0].ok, false);
  assert.match(results[0].note, /does not exist/);
  assert.equal(results[1].ok, true, "the second op still ran");
  assert.ok(!existsSync(join(dir, "stale.js")));
});
