import { getDb, now } from "./connection.js";
import { listVault } from "./vault.js";

export interface MemoryHit { kind: "lesson" | "plan" | "review" | "issue" | "vault"; repo: string; number: number; text: string; at: string }


export function searchMemory(query: string, opts: { repo?: string; limit?: number } = {}): MemoryHit[] {
  const d = getDb();
  if (!d) return [];
  const repo = opts.repo;
  const limit = opts.limit ?? 8;
  const terms = String(query || "").toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2).slice(0, 8);
  if (!terms.length) return [];
  // Unscoped recall routes to the Central Vault: the per-repo hard filter below deliberately reserves
  // the no-repo slot for shared, cross-repo knowledge, which now lives in the vault (not these private
  // artifact tables). Repo-scoped recall is unchanged — it never bleeds one repo's history into another.
  if (!repo) return searchVault(terms, limit);
  const rows: MemoryHit[] = [];
  try {
    const grab = (kind: MemoryHit["kind"], sql: string) => {
      for (const r of d.prepare(sql).all() as unknown as Array<{ repo: string; number: number; text: string | null; at: string | null }>) {
        if (r.text) rows.push({ kind, repo: r.repo, number: r.number, text: r.text, at: r.at ?? "" });
      }
    };
    grab("lesson", `SELECT repo, number, lesson AS text, created_at AS at FROM lessons ORDER BY id DESC LIMIT 300`);
    grab("plan", `SELECT repo, number, plan AS text, created_at AS at FROM plans ORDER BY id DESC LIMIT 200`);
    grab("review", `SELECT repo, number, summary AS text, updated_at AS at FROM pr_review WHERE summary IS NOT NULL ORDER BY updated_at DESC LIMIT 200`);
    grab("issue", `SELECT repo, number, title AS text, updated_at AS at FROM issues WHERE title IS NOT NULL ORDER BY updated_at DESC LIMIT 300`);
  } catch {
    return [];
  }
  const scored = rows
    // Per-repo private: plans, lessons, reviews and issues are project-private artifacts —
    // never surface one repo's issue history in another repo's recall (no cross-repo bleed).
    // Shared knowledge/preferences belong in a separate central vault, not here.
    .filter((r) => !repo || r.repo === repo)
    .map((r) => {
      const t = r.text.toLowerCase();
      let s = 0;
      for (const term of terms) if (t.includes(term)) s++;
      return { r, s };
    })
    .filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s || (new Date(b.r.at || 0).getTime() - new Date(a.r.at || 0).getTime()));
  return scored.slice(0, limit).map((x) => ({ ...x.r, text: x.r.text.slice(0, 800) }));
}

/** Term-match the vault's canonical content for unscoped recall — weight then term-overlap ranked. */
function searchVault(terms: string[], limit: number): MemoryHit[] {
  const scored = listVault()
    .map((row) => {
      const t = row.entry.c.toLowerCase();
      let s = 0;
      for (const term of terms) if (t.includes(term)) s++;
      return { row, s };
    })
    .filter((x) => x.s > 0);
  scored.sort((a, b) => b.row.entry.w - a.row.entry.w || b.s - a.s);
  return scored.slice(0, limit).map((x) => ({
    kind: "vault" as const,
    repo: x.row.entry.s,
    number: 0,
    text: x.row.entry.c,
    at: x.row.updated_ts,
  }));
}
