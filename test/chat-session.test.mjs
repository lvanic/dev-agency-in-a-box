// Regression tests for the "chat session not found" failure: a chat turn resumed a session id whose
// workdir (and therefore whose Claude config dir, where the transcript lives) was a throwaway temp
// dir deleted after the previous turn. Two guards: the workdir is stable per conversation, and a
// stale resume id is recognised so the runner can retry fresh instead of failing the chat.
import test from "node:test";
import assert from "node:assert/strict";
import { chatWorkdir } from "../dist/agents/chat.js";
import { isStaleSession } from "../dist/runners/sdk-claude.js";

test("chatWorkdir is stable for the same conversation", () => {
  assert.equal(chatWorkdir("orch|owner/repo"), chatWorkdir("orch|owner/repo"));
});

test("chatWorkdir separates conversations", () => {
  assert.notEqual(chatWorkdir("orch|owner/repo"), chatWorkdir("orch|owner/other"));
  assert.notEqual(chatWorkdir("chat|owner/repo|7|spec"), chatWorkdir("chat|owner/repo|8|spec"));
});

test("chatWorkdir is not a temp dir that gets wiped between turns", () => {
  assert.match(chatWorkdir("orch|owner/repo"), /data[/\\]chat-wd[/\\]/);
});

test("stale-session errors are recognised", () => {
  for (const m of [
    "No conversation found with session ID: abc-123",
    "Session not found",
    "chat session not found",
    "Invalid session id",
  ]) assert.equal(isStaleSession(new Error(m)), true, m);
});

test("real failures are NOT treated as a stale session", () => {
  for (const m of [
    "401 Unauthorized",
    "Reached maximum number of turns",
    "ENOTFOUND api.anthropic.com",
    "rate limit exceeded",
  ]) assert.equal(isStaleSession(new Error(m)), false, m);
});
