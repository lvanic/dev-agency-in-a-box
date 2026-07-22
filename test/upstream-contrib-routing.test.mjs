// Fork-vs-direct-push routing for the upstream-contribution channel (P5 security fix): a fork's
// bot token typically has no write access on the canonical upstream repo, so pushing straight there
// fails permission-denied. `chooseContribRoute`/`parsePushPermission` are the PURE decision logic,
// deliberately split out of `hasDirectPushAccess` (which makes the actual `gh api` call) so this can
// be unit-tested without touching the network — never invokes `gh`/`git` here.
import test from "node:test";
import assert from "node:assert/strict";

const { chooseContribRoute, parsePushPermission } = await import("../dist/github.js");

test("chooseContribRoute: push access -> direct, no access -> fork", () => {
  assert.equal(chooseContribRoute(true), "direct");
  assert.equal(chooseContribRoute(false), "fork");
});

test("parsePushPermission reads gh api's `-q .permissions.push` stdout", () => {
  assert.equal(parsePushPermission("true"), true);
  assert.equal(parsePushPermission("true\n"), true); // gh output is newline-terminated
  assert.equal(parsePushPermission("TRUE"), true); // tolerate case
  assert.equal(parsePushPermission("false"), false);
  assert.equal(parsePushPermission(""), false); // e.g. a private repo the token can't even read
  assert.equal(parsePushPermission("null"), false); // jq's ".permissions.push" on a field that's absent
});

test("the realistic fork scenario (no push access) routes to fork, not a doomed direct push", () => {
  // Mirrors the actual call site: chooseContribRoute(await hasDirectPushAccess(upstreamRepo)).
  // A fork's bot token has no push permission on the canonical upstream project.
  const mockedPermissionCheck = parsePushPermission("false");
  assert.equal(chooseContribRoute(mockedPermissionCheck), "fork");
});

test("a repo the bot DOES have push access on (e.g. its own repo) still takes the direct fast path", () => {
  const mockedPermissionCheck = parsePushPermission("true");
  assert.equal(chooseContribRoute(mockedPermissionCheck), "direct");
});
