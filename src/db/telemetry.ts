import { getDb, now } from "./connection.js";

export function recordRunStep(repo: string, number: number, role: string, tool: string, detail: string, ok = true): void {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(`INSERT INTO run_step (repo, number, role, tool, detail, ok, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(repo, number, role, tool, (detail || "").slice(0, 200), ok ? 1 : 0, now());
  } catch { /* best effort */ }
}

export interface ToolStat { role: string; tool: string; uses: number; fails: number }
/** How often each (role, tool) is used since an ISO time — surfaces repeating mechanical work. */

export function toolStatsSince(sinceIso: string): ToolStat[] {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare(
      `SELECT role, tool, COUNT(*) AS uses, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS fails
       FROM run_step WHERE ts >= ? GROUP BY role, tool ORDER BY uses DESC`,
    ).all(sinceIso) as unknown as ToolStat[];
  } catch { return []; }
}

export function recordIncident(kind: string, detail: string): void {
  recordRunStep("", 0, "system", kind, detail, false);
}

// ── Per-endpoint GitHub API call counting (diagnostic) ───────────────────────────────────────────
// Purely observational, layered on recordIncident("github-rate-limit"): that surfaces a 429 AFTER it
// trips; this counts calls per coarse endpoint key so a runaway caller (a scan loop hammering one
// endpoint) is caught BEFORE the limit is hit. In-memory only (resets on restart) — it's a live
// pressure gauge, not durable history. When one endpoint crosses the threshold within the current
// window we emit ONE incident + warn, then reset that endpoint's counter so it only re-warns if the
// pressure recurs.
const HOT_ENDPOINT_THRESHOLD = Number(process.env.GH_ENDPOINT_WARN?.trim()) || 200;
const apiCallCounts = new Map<string, number>();

/** Count one GitHub call against its coarse endpoint key (e.g. "pr list", "api repos/:/:/issues/:n/comments"). */
export function bumpApiCall(endpoint: string): void {
  const n = (apiCallCounts.get(endpoint) ?? 0) + 1;
  apiCallCounts.set(endpoint, n);
  if (n >= HOT_ENDPOINT_THRESHOLD) {
    recordIncident("github-endpoint-hot", `gh endpoint "${endpoint}" reached ${n} calls in the current window — likely a scan-loop hot spot`);
    console.warn(`[agency] gh endpoint "${endpoint}" reached ${n} calls this window — check for a scan loop`);
    apiCallCounts.set(endpoint, 0); // reset this endpoint's window; re-warns only if the pressure recurs
  }
}

export interface ApiCallStat { endpoint: string; calls: number }
/** Snapshot of current per-endpoint call counts, busiest first — diagnostic (dashboard / post-run audit). */
export function apiCallStats(): ApiCallStat[] {
  return [...apiCallCounts.entries()]
    .map(([endpoint, calls]) => ({ endpoint, calls }))
    .sort((a, b) => b.calls - a.calls);
}

export interface FailureStat { role: string; tool: string; count: number; sample: string }

export function recentFailuresSince(sinceIso: string, limit = 15): FailureStat[] {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare(
      `SELECT role, tool, COUNT(*) AS count, MAX(detail) AS sample
       FROM run_step WHERE ts >= ? AND ok = 0 GROUP BY role, tool ORDER BY count DESC LIMIT ?`,
    ).all(sinceIso, limit) as unknown as FailureStat[];
  } catch { return []; }
}

export function runStepCountSince(sinceIso: string): number {
  const d = getDb();
  if (!d) return 0;
  try {
    const r = d.prepare(`SELECT COUNT(*) AS n FROM run_step WHERE ts >= ?`).get(sinceIso) as { n?: number } | undefined;
    return r?.n ?? 0;
  } catch { return 0; }
}
