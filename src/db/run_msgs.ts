/**
 * Per-issue run thread (P1, prime-time-plan): the central agent chat. Every say()/sayAs() in
 * pipeline.ts appends here FIRST — before the GitHub comment that mirrors it — so this table (not
 * GitHub) is the source of truth the dashboard's run-thread panel and the repo Orchestrator read.
 * DB-first, same shape as orch_msg (./threads.ts) but scoped to one issue and carrying which AGENT
 * spoke + a machine `kind` (currently always "comment"; room for future non-mirrored message kinds).
 */
import { getDb, now } from "./connection.js";

export interface RunMsg {
  id: number;
  repo: string;
  number: number;
  runId: string;
  agent: string;
  kind: string;
  body: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

/** Visible worker badge, keyed by role — kept here (not pipeline.ts) so both the GitHub mirror and
 *  the DB-first run-thread reconstruct the IDENTICAL prefix without duplicating the table. */
const ROLE_BADGE: Record<string, string> = {
  planner: "🧠 **Planner**",
  decomposer: "🪓 **Decomposer**",
  developer: "💻 **Developer**",
  reviewer: "🔍 **Reviewer**",
  tester: "🧪 **Tester**",
  architect: "🏛 **Architect**",
  librarian: "📚 **Librarian**",
  auditor: "🔎 **Auditor**",
  analyzer: "🔬 **Analyzer**",
};

/** The same "🧠 **Planner** · _dev-agency_" badge every agency GitHub comment carries. A built-in
 *  role gets its dedicated emoji; anything else (a custom workflow agent) gets the generic 🤖 + its
 *  capitalized name — matching the old inline `sayAs` formatting exactly. */
export function renderBadge(agent: string): string {
  const known = ROLE_BADGE[agent];
  if (known) return `${known} · _dev-agency_`;
  const label = agent || "agent";
  const cap = label.charAt(0).toUpperCase() + label.slice(1);
  return `🤖 **${cap}** · _dev-agency_`;
}

function rowToMsg(r: { id: number; repo: string; number: number; run_id: string; agent: string; kind: string; body: string; meta: string | null; created_at: string }): RunMsg {
  let meta: Record<string, unknown> | null = null;
  try { meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null; } catch { meta = null; }
  return { id: r.id, repo: r.repo, number: r.number, runId: r.run_id, agent: r.agent, kind: r.kind, body: r.body, meta, createdAt: r.created_at };
}

/** Append one message to an issue's run thread; returns the new row id (0 on failure). */
export function appendRunMsg(
  repo: string,
  number: number,
  runId: string,
  agent: string,
  kind: string,
  body: string,
  meta?: Record<string, unknown> | null,
): number {
  const d = getDb();
  if (!d) return 0;
  try {
    const info = d
      .prepare(`INSERT INTO run_msg (repo, number, run_id, agent, kind, body, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(repo, number, runId, agent, kind, body, meta ? JSON.stringify(meta) : null, now());
    return Number(info.lastInsertRowid) || 0;
  } catch {
    return 0;
  }
}

/** The run thread for one issue, oldest-first. `limit` caps to the most recent N. */
export function listRunThread(repo: string, number: number, limit = 300): RunMsg[] {
  const d = getDb();
  if (!d) return [];
  try {
    const rows = d
      .prepare(`SELECT * FROM run_msg WHERE repo = ? AND number = ? ORDER BY id DESC LIMIT ?`)
      .all(repo, number, limit) as Array<{ id: number; repo: string; number: number; run_id: string; agent: string; kind: string; body: string; meta: string | null; created_at: string }>;
    return rows.map(rowToMsg).reverse();
  } catch {
    return [];
  }
}

/** True if this issue has ANY run_msg rows — the signal the dashboard uses to decide between the
 *  DB-first run thread and the legacy GitHub-thread fallback for issues that predate this table. */
export function hasRunThread(repo: string, number: number): boolean {
  const d = getDb();
  if (!d) return false;
  try {
    return Boolean(d.prepare(`SELECT 1 FROM run_msg WHERE repo = ? AND number = ? LIMIT 1`).get(repo, number));
  } catch {
    return false;
  }
}
