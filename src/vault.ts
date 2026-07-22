/**
 * Central Vault — read path + one-off legacy migration (docs/central-vault-plan.md).
 *
 * `vaultSlice(repo, role)` is what every agent actually reads: the global entries plus the ones whose
 * scope glob matches this repo and whose role matches (or is unset), ranked by weight then recency and
 * HARD-capped at a small token budget, rendered as raw canonical lines under a one-line header. It is
 * injected in buildSystemPrompt where the old learned-doc block used to be — this is the whole read
 * side of the vault in Phase 1.
 *
 * `migrateLearnedToVault()` is the guarded, run-once boot step that seeds the vault from the effective
 * legacy learned docs (DB override if present, else disk) BEFORE the first agent run after deploy — so
 * switching injection from learned-docs to the vault leaves no dark window. It is deterministic (no
 * LLM): it splits each learned doc into its bullet points and stores each as a `know` entry. A later
 * phase's compress() translator can upsert richer entries by the same keys; this just guarantees the
 * vault is non-empty on day one.
 */
import { getSetting, setSetting } from "./db/settings.js";
import { listVault, upsertVaultEntry, scopeMatches, type VaultEntry, type VaultRow } from "./db/vault.js";
import { purgeAgentOverride } from "./db/agent_overrides.js";
import { readAgentFile } from "./memory.js";
import { ALL_ROLES } from "./agents/roles.js";

// The legacy learned-doc paths, inlined here (the exported constants + loadLearned were removed with
// the retired learned docs — see docs/central-vault-plan.md Phase 3). This one-off boot migration
// still reads their EFFECTIVE content (DB override, if any) so an instance upgrading straight through
// to Phase 3 still seeds the vault before the first agent run — it is a no-op once the flag is set.
const LEGACY_SHARED_LEARNED = "central/playbooks/_learned.md";
const legacyRoleLearned = (role: string): string => `central/agents/${role}.learned.md`;

/** Rough token estimate (chars/4) — same order-of-magnitude heuristic the prompt budgeters use. */
const estTokens = (s: string): number => Math.ceil(s.length / 4);

/** Hard ceiling on the canonical lines injected per run (the header is not counted). */
const SLICE_TOKEN_BUDGET = 250;

/** The canonical single line for an entry — exactly what is stored, re-encoded from the decoded row. */
function canonicalLine(e: VaultEntry): string {
  const out: Record<string, unknown> = { v: e.v, k: e.k, t: e.t, s: e.s };
  if (e.r) out.r = e.r;
  out.c = e.c;
  out.w = e.w;
  return JSON.stringify(out);
}

/**
 * The vault slice for one (repo, role): global + scope-glob-matching + role-matching entries, ranked
 * by weight (3 first) then recency, greedily packed under SLICE_TOKEN_BUDGET. Returns "" when nothing
 * qualifies (so the caller injects no header at all). Best-effort — never throws into the prompt path.
 */
export function vaultSlice(repo?: string, role?: string): string {
  let rows: VaultRow[];
  try {
    rows = listVault(role !== undefined ? { role } : {});
  } catch {
    return "";
  }
  // Scope: keep global entries always; keep repo-scoped ones only when we know the repo and it matches.
  const matched = rows.filter((r) => (repo ? scopeMatches(r.entry.s, repo) : r.entry.s === "*"));
  // Rank: weight desc, then recency (listVault already returns newest-first, a stable secondary order).
  matched.sort((a, b) => b.entry.w - a.entry.w);
  const lines: string[] = [];
  let spent = 0;
  for (const r of matched) {
    const line = canonicalLine(r.entry);
    const cost = estTokens(line);
    if (spent + cost > SLICE_TOKEN_BUDGET && lines.length) break;
    lines.push(line);
    spent += cost;
    if (spent >= SLICE_TOKEN_BUDGET) break;
  }
  if (!lines.length) return "";
  return [
    "Durable shared knowledge as compact records — one JSON object per line",
    "(k=key, t=kind pref|know|env|gloss, s=scope, r=role, c=content, w=weight). Apply them.",
    ...lines,
  ].join("\n");
}

// ── one-off boot migration: legacy learned docs → vault ───────────────────────────────────────────

const MIGRATION_FLAG = "vault_migration_v1";
const PURGE_FLAG = "vault_legacy_purged_v1";
const MAX_MIGRATED_C = 380; // stay under the vault's own MAX_C_LEN, leaving room, since bullets are prose.

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[`*_#>]/g, " ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .split("-")
      .slice(0, 6)
      .join("-")
      .slice(0, 48) || "note"
  );
}

/** Split a learned-doc markdown into its bullet points (falling back to non-empty paragraphs). */
function bulletsOf(md: string): string[] {
  const bullets = md
    .split("\n")
    .map((l) => /^\s*[-*]\s+(.+)$/.exec(l)?.[1]?.trim())
    .filter((x): x is string => !!x);
  if (bullets.length) return bullets;
  return md
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0 && !/^#{1,6}\s/.test(p));
}

/**
 * Seed the vault from the effective legacy learned docs — the shared `_learned.md` (scope "*") and each
 * `<role>.learned.md` (role-tagged). Idempotent + guarded by a settings flag so it runs exactly once
 * per database (same pattern as the issue-state migration in connection.ts). Best-effort: never throws;
 * returns how many entries it created. Bullets carrying an issue/PR ref are skipped (they don't belong
 * in the vault — the write-time guard would reject them anyway).
 */
export async function migrateLearnedToVault(): Promise<number> {
  if (getSetting(MIGRATION_FLAG)) return 0;
  let created = 0;
  const usedKeys = new Set<string>();
  const seed = async (md: string, prefix: string, role?: string): Promise<void> => {
    for (const bullet of bulletsOf(md)) {
      const c = bullet.slice(0, MAX_MIGRATED_C);
      let key = `${prefix}-${slugify(bullet)}`;
      for (let n = 2; usedKeys.has(key); n++) key = `${prefix}-${slugify(bullet)}-${n}`;
      try {
        upsertVaultEntry({ k: key, t: "know", s: "*", ...(role ? { r: role } : {}), c, w: 2 }, "migration");
        usedKeys.add(key);
        created++;
      } catch {
        /* guard rejected (issue ref) or malformed — skip this bullet */
      }
    }
  };
  try {
    const shared = (await readAgentFile(LEGACY_SHARED_LEARNED)) || "";
    if (shared.trim()) await seed(shared, "learned");
    for (const role of ALL_ROLES) {
      const mine = (await readAgentFile(legacyRoleLearned(role))) || "";
      if (mine.trim()) await seed(mine, role, role);
    }
    setSetting(MIGRATION_FLAG, "1"); // one-shot: mark done even when the docs were empty (nothing to redo)
    if (created) console.log(`[agency] vault: migrated ${created} learned bullet(s) into the vault`);
  } catch (err) {
    console.warn("[agency] vault migration skipped:", (err as Error).message);
  }
  return created;
}

/**
 * Retire the legacy learned-doc DB overrides (docs/central-vault-plan.md Phase 3). Once nothing reads
 * or lists `_learned.md` / `<role>.learned.md`, their override/revision/default rows are dead data —
 * hard-purge them (no disk mirror). Guarded run-once; MUST run AFTER migrateLearnedToVault has read
 * their effective content. Best-effort; never throws.
 */
export function purgeLegacyLearnedOverrides(): number {
  if (getSetting(PURGE_FLAG)) return 0;
  let purged = 0;
  try {
    const paths = [LEGACY_SHARED_LEARNED, ...ALL_ROLES.map(legacyRoleLearned)];
    for (const p of paths) {
      purgeAgentOverride(p);
      purged++;
    }
    setSetting(PURGE_FLAG, "1");
    console.log(`[agency] vault: purged ${purged} legacy learned-doc override path(s)`);
  } catch (err) {
    console.warn("[agency] vault legacy purge skipped:", (err as Error).message);
  }
  return purged;
}
