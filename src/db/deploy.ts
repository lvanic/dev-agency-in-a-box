/**
 * Deploy-safe runs (P: self-merge quiet window + auto-resume after redeploy). Two small,
 * independent tables:
 *
 *  - interrupted_runs: an issue whose run was cut short by graceful-shutdown drain (or was still
 *    queued and never started) gets a marker here, written in runner.ts's gracefulShutdown. The
 *    NEXT boot reads it and auto-resumes instead of parking at needs-attention (runner.ts
 *    autoResumeInterrupted). `attempts` is a crash-loop guard: it's left untouched by the write
 *    side (markInterrupted) and only bumped by the boot-side processing, so a marker that somehow
 *    survives one full auto-resume attempt without being cleared (the process crashing again
 *    before it can clear itself) reads back attempts >= 1 next boot and gets parked normally
 *    instead of resumed again forever.
 *
 *  - held_updates: an agency-repo PR that was ready to merge but held because other issues were
 *    still in flight (see src/deploySafety.ts). Flushed by a human ("Deploy now" in the dashboard)
 *    or automatically once the pool goes quiet.
 */
import { getDb, now } from "./connection.js";

export interface InterruptedRun {
  repo: string;
  number: number;
  reason: string;
  attempts: number;
  createdAt: string;
}

/** Record (or refresh) an interruption marker. Attempts is intentionally NOT reset on conflict —
 * only the boot-side processing bumps it (see module doc). */
export function markInterrupted(repo: string, number: number, reason = "deploy"): void {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(
      `INSERT INTO interrupted_runs (repo, number, reason, attempts, created_at) VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(repo, number) DO UPDATE SET reason = excluded.reason`,
    ).run(repo, number, reason, now());
  } catch {
    /* best effort */
  }
}

export function listInterrupted(): InterruptedRun[] {
  const d = getDb();
  if (!d) return [];
  try {
    return d
      .prepare(`SELECT repo, number, reason, attempts, created_at AS createdAt FROM interrupted_runs`)
      .all() as unknown as InterruptedRun[];
  } catch {
    return [];
  }
}

/** Bump the attempts counter for one marker (called right before dispatching its auto-resume). */
export function bumpInterruptedAttempts(repo: string, number: number): void {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(`UPDATE interrupted_runs SET attempts = attempts + 1 WHERE repo = ? AND number = ?`).run(repo, number);
  } catch {
    /* best effort */
  }
}

export function clearInterrupted(repo: string, number: number): void {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(`DELETE FROM interrupted_runs WHERE repo = ? AND number = ?`).run(repo, number);
  } catch {
    /* best effort */
  }
}

// ── held_updates (self-merge quiet window) ─────────────────────────────────────────────────────

export interface HeldUpdate {
  repo: string;
  number: number;
  prNumber: number;
  title: string;
  heldAt: string;
}

export function holdUpdate(repo: string, number: number, prNumber: number, title: string): void {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(
      `INSERT INTO held_updates (repo, number, pr_number, title, held_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repo, number) DO UPDATE SET pr_number = excluded.pr_number, title = excluded.title`,
    ).run(repo, number, prNumber || 0, title || "", now());
  } catch {
    /* best effort */
  }
}

export function listHeldUpdates(): HeldUpdate[] {
  const d = getDb();
  if (!d) return [];
  try {
    return d
      .prepare(`SELECT repo, number, pr_number AS prNumber, title, held_at AS heldAt FROM held_updates ORDER BY held_at`)
      .all() as unknown as HeldUpdate[];
  } catch {
    return [];
  }
}

export function clearHeldUpdate(repo: string, number: number): void {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(`DELETE FROM held_updates WHERE repo = ? AND number = ?`).run(repo, number);
  } catch {
    /* best effort */
  }
}
