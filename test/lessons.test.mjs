// Tests for the lessons ledger (P4.11 repo scoping) and the librarian's optional role tag
// (P4.10 — the per-role fold that makes `<role>.learned.md` a live read path instead of dead).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "lessons-")), "agency.db");
const { getDb } = await import("../dist/db/connection.js");
getDb();
const { recordLesson, recentLessons } = await import("../dist/db/lessons.js");
const { splitLessonRole, lessonsToMarkProcessed } = await import("../dist/reflect.js");

test("recentLessons prefers same-repo rows but falls back to global to fill the limit", () => {
  recordLesson("acme/app", 1, "global lesson A");
  recordLesson("acme/app", 2, "global lesson B");
  recordLesson("other/repo", 5, "repo-specific: use pnpm here");
  recordLesson("other/repo", 6, "repo-specific: tests need DATABASE_URL");

  const scoped = recentLessons(2, "other/repo");
  assert.equal(scoped.length, 2);
  assert.ok(scoped.every((l) => l.startsWith("repo-specific")), "same-repo rows win when there are enough of them");

  // A repo with no lessons of its own still gets filled from the global pool (fallback).
  const empty = recentLessons(2, "brand/new-repo");
  assert.equal(empty.length, 2);

  // No repo given → plain global/newest-first behaviour (back-compat).
  const global = recentLessons(10);
  assert.equal(global.length, 4);
});

test("recentLessons repo-scoping fills remaining slots from global when the repo has few of its own", () => {
  recordLesson("solo/repo", 1, "solo lesson");
  const out = recentLessons(3, "solo/repo");
  assert.equal(out.length, 3, "backfilled from global rows");
  assert.ok(out.includes("solo lesson"));
});

test("recordLesson stores an optional role and it round-trips through the DB", () => {
  recordLesson("acme/app", 3, "developer-only lesson", "developer");
  const row = getDb().prepare("SELECT lesson, role FROM lessons WHERE lesson = ?").get("developer-only lesson");
  assert.equal(row.role, "developer");
});

test("splitLessonRole recognises a leading role tag (only for known roles)", () => {
  assert.deepEqual(splitLessonRole("developer: watch for stale lockfiles"), {
    role: "developer",
    lesson: "watch for stale lockfiles",
  });
  assert.deepEqual(splitLessonRole("[reviewer] flags inline styles a lot"), {
    role: "reviewer",
    lesson: "flags inline styles a lot",
  });
  // No tag, or an unrecognised word before the colon → untagged (whole line kept, no role).
  assert.deepEqual(splitLessonRole("repo uses pnpm, corepack enable first"), {
    role: null,
    lesson: "repo uses pnpm, corepack enable first",
  });
  const untagged = splitLessonRole("notarole: this looks like a tag but isn't one");
  assert.equal(untagged.role, null);
  assert.equal(untagged.lesson, "notarole: this looks like a tag but isn't one");
});

test("lessonsToMarkProcessed excludes lessons whose role-specific fold failed (they get retried, not lost)", () => {
  const lessons = [
    { id: 101, repo: "acme/app", number: 1, lesson: "untagged lesson", role: null, created_at: "" },
    { id: 102, repo: "acme/app", number: 2, lesson: "developer lesson (fold ok)", role: "developer", created_at: "" },
    { id: 103, repo: "acme/app", number: 3, lesson: "reviewer lesson (fold failed)", role: "reviewer", created_at: "" },
  ];
  // Only #103's role fold failed — its shared-doc half already happened, but the role-specific
  // half didn't, so it must stay unprocessed for a retry next cycle. #101 (no role) and #102
  // (role fold succeeded) are both fully done and safe to mark processed.
  const failed = new Set([103]);
  assert.deepEqual(lessonsToMarkProcessed(lessons, failed), [101, 102]);

  // No failures at all → everything is safe to mark.
  assert.deepEqual(lessonsToMarkProcessed(lessons, new Set()), [101, 102, 103]);

  // Every tagged lesson's fold failed → only the untagged one is marked.
  assert.deepEqual(lessonsToMarkProcessed(lessons, new Set([102, 103])), [101]);
});
