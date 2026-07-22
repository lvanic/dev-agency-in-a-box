/**
 * Per-issue digest (P1, prime-time-plan): a compact, DETERMINISTIC one-liner — no LLM call —
 * upserted every time run_msg gets a new row (see pipeline.ts say()/sayAs()). This is what the repo
 * Orchestrator's repoContext() reads to genuinely "know" every run without re-reading whole threads.
 */
import { getDb, now } from "./connection.js";
import { getIssueStatus, filesFor } from "./issues.js";
import { getReview } from "./reviews.js";
import { listRunThread } from "./run_msgs.js";

const MAX_LEN = 300;

/** Build the digest from whatever's already recorded: lifecycle phase (+ blocked reason), the
 *  latest reviewer verdict, the declared file footprint, and — if given — the message that just
 *  triggered this upsert (who spoke + a short snippet of what they said). Pure/deterministic so it's
 *  cheap enough to run on every run_msg append and trivially unit-testable. */
export function buildDigest(repo: string, number: number, lastAgent?: string, lastBody?: string): string {
  const status = getIssueStatus(repo, number);
  const rev = getReview(repo, number);
  const files = filesFor(repo, number);
  const parts: string[] = [status.blocked ? `${status.state}/${status.blocked}` : status.state];
  if (lastAgent) parts.push(lastAgent);
  if (rev) parts.push(rev.verdict === "changes" ? "changes requested" : "approved");
  if (files.length) parts.push(`files: ${files.slice(0, 5).join(", ")}`);
  const head = parts.join(" · ");
  const snippet = (lastBody ?? "").replace(/\s+/g, " ").trim();
  const withSnippet = snippet ? `${head} — ${snippet}` : head;
  return withSnippet.slice(0, MAX_LEN);
}

/** Recompute + persist the digest for one issue. Returns the digest (best-effort: still returned
 *  even if the DB write fails, so a caller can still e.g. push it live). */
export function upsertIssueDigest(repo: string, number: number, lastAgent?: string, lastBody?: string): string {
  const digest = buildDigest(repo, number, lastAgent, lastBody);
  const d = getDb();
  if (d) {
    try {
      d.prepare(
        `INSERT INTO issue_digest (repo, number, digest, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo, number) DO UPDATE SET digest = excluded.digest, updated_at = excluded.updated_at`,
      ).run(repo, number, digest, now());
    } catch {
      /* best effort */
    }
  }
  return digest;
}

/**
 * Re-upsert the digest from CURRENT state, with no new triggering message of its own — for callers
 * whose side effect (e.g. recordReview) changes what the digest should report (the verdict) but
 * isn't itself a run_msg append. Without this, a digest upserted by say("reviewer", …) BEFORE
 * recordReview() persists the PREVIOUS round's verdict until the next unrelated run_msg append.
 * Reuses the latest run_msg's agent + snippet so the correction doesn't lose "what was just said".
 */
export function refreshIssueDigest(repo: string, number: number): string {
  const last = listRunThread(repo, number, 1)[0];
  return upsertIssueDigest(repo, number, last?.agent, last?.body);
}

export function getIssueDigest(repo: string, number: number): string | null {
  const d = getDb();
  if (!d) return null;
  try {
    const r = d.prepare(`SELECT digest FROM issue_digest WHERE repo = ? AND number = ?`).get(repo, number) as { digest?: string } | undefined;
    return r?.digest ?? null;
  } catch {
    return null;
  }
}
