// Merging twice must not report a failure. The dashboard's Merge is a two-tap arm/confirm, and
// auto-merge can race a human click — the second call then found no OPEN PR and returned a hard
// error, which the UI showed as a red "couldn't merge — conflicts?" toast over a PR that had in
// fact just merged cleanly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const github = readFileSync(join(root, "src", "github.ts"), "utf8");
const app = readFileSync(join(root, "web", "app.js"), "utf8");

test("an already-merged branch is looked up before reporting no open PR", () => {
  const fn = github.slice(github.indexOf("export async function mergePrForBranch"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const checkAt = body.indexOf("mergedPrForBranch");
  const failAt = body.indexOf('"no open PR for this issue"');
  assert.ok(checkAt > -1, "mergePrForBranch must consult the merged-PR lookup");
  assert.ok(checkAt < failAt, "the merged-PR check must come BEFORE giving up with 'no open PR'");
});

test("mergedPrForBranch queries merged PRs, not open ones", () => {
  const fn = github.slice(github.indexOf("export async function mergedPrForBranch"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /"--state", "merged"/, "must filter to merged PRs");
  assert.doesNotMatch(body, /"--state", "open"/);
});

test("the merge toast reports the server's reason, not a hard-coded conflict guess", () => {
  const line = app.split("\n").find((l) => /^\s*merge\(repo, number\)/.test(l));
  assert.ok(line, "merge action not found in web/app.js");
  assert.doesNotMatch(line, /conflicts\?/, "every failure was being reported as a merge conflict");
  assert.match(line, /e && e\.message/, "the server's error message must reach the toast");
});
