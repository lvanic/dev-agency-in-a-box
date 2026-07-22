import { getDb, now } from "./connection.js";

export interface LessonRow {
  id: number;
  repo: string;
  number: number;
  lesson: string;
  /** Which role the lesson is about, when the librarian could tell (nullable — most builds span
   *  several roles, so this is best-effort, not guaranteed). */
  role: string | null;
  created_at: string;
}

export function recordLesson(repo: string, number: number, lesson: string, role: string | null = null): void {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(`INSERT INTO lessons (repo, number, lesson, role, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      repo,
      number,
      lesson.slice(0, 600),
      role || null,
      now(),
    );
  } catch {
    /* best effort */
  }
}

/**
 * Recent lessons for the system prompt. When `repo` is given, same-repo lessons are preferred
 * (still fills up to `limit` with global ones if the repo doesn't have enough of its own) —
 * repo-specific quirks ("this repo uses pnpm") matter more to that repo's agents than another
 * repo's, but a nearly-empty repo shouldn't lose the benefit of everything else learned.
 */
export function recentLessons(limit = 12, repo?: string): string[] {
  const d = getDb();
  if (!d) return [];
  try {
    const rows = repo
      ? (d
          .prepare(`SELECT lesson FROM lessons ORDER BY (repo = ?) DESC, id DESC LIMIT ?`)
          .all(repo, limit) as unknown as Array<{ lesson: string }>)
      : (d
          .prepare(`SELECT lesson FROM lessons ORDER BY id DESC LIMIT ?`)
          .all(limit) as unknown as Array<{ lesson: string }>);
    return rows.map((r) => r.lesson).reverse();
  } catch {
    return [];
  }
}

export function unprocessedLessons(): LessonRow[] {
  const d = getDb();
  if (!d) return [];
  try {
    return d
      .prepare(`SELECT id, repo, number, lesson, role, created_at FROM lessons WHERE processed = 0 ORDER BY id`)
      .all() as unknown as LessonRow[];
  } catch {
    return [];
  }
}

export function markLessonsProcessed(ids: number[]): void {
  const d = getDb();
  if (!d || ids.length === 0) return;
  try {
    const stmt = d.prepare(`UPDATE lessons SET processed = 1 WHERE id = ?`);
    for (const id of ids) stmt.run(id);
  } catch {
    /* best effort */
  }
}
