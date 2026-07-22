/**
 * Central Vault (docs/central-vault-plan.md) — the agency's ONE durable, machine-canonical store of
 * shared knowledge that must survive across runs and repos: user preferences, environment/tooling
 * facts, cross-project craft knowledge, glossary. It fills exactly the UNSCOPED-recall slot the
 * per-repo hard filter in `db/memory.ts` reserved — issue artifacts (plans, reviews, run threads,
 * issue text) are repo-private and NEVER enter here (see the write-time guard below).
 *
 * The canonical stored form is compact machine shorthand — a single-line JSON record, strict-parsed
 * exactly like the Handoff envelope (src/handoff.ts). Human-readable prose is a DERIVED view, never
 * the storage format (that translator lands in Phase 2). This module owns the record schema, its
 * strict encode/decode, the write-time guard, and the table access (upsert + revision history,
 * same append-on-every-write pattern as agent_overrides.ts).
 */
import { getDb, now } from "./connection.js";

export const VAULT_VERSION = 1 as const;

/** kind: pref (user preference) · know (knowledge) · env (environment/tooling fact) · gloss (term). */
export type VaultKind = "pref" | "know" | "env" | "gloss";
const KINDS: ReadonlySet<string> = new Set(["pref", "know", "env", "gloss"]);

export interface VaultEntry {
  v: 1;
  /** unique key-slug (kebab, stable identity; the upsert target). */
  k: string;
  t: VaultKind;
  /** scope glob: "*" global · "owner/repo" · prefix glob "reimedy-*". */
  s: string;
  /** optional role — entry is only injected for that role when set. */
  r?: string;
  /** terse telegraphic content (target ≤ ~30 tokens; open-domain text, not coded enums). */
  c: string;
  /** weight 1–3 (3 = always inject, 1 = only when budget allows). */
  w: 1 | 2 | 3;
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set(["v", "k", "t", "s", "r", "c", "w"]);
const MAX_C_LEN = 400;
const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Input to encode/upsert — `v` is implied. */
export type VaultInput = Omit<VaultEntry, "v">;

/** A stored row: the canonical entry plus its provenance. `source` ∈ human | librarian | migration. */
export interface VaultRow {
  key: string;
  entry: VaultEntry;
  source: string;
  updated_ts: string;
}

export type VaultSource = "human" | "librarian" | "migration";

/**
 * Write-time guard: issue artifacts stay OUT of the vault. Reject `c` carrying an issue/PR reference
 * (`#123`, `owner/repo#123`) or a run/PR/issue URL — unless the caller explicitly opts in with
 * `allowIssueRef` (a generic lesson that happens to name a number legitimately). Mirrors the
 * repo-private boundary the `searchMemory` hard filter enforces on the other side.
 */
const ISSUE_REF_RE = /(?:^|\s|\/)#\d+\b/;
const ARTIFACT_URL_RE = /https?:\/\/\S*\/(?:pull|issues?|runs?|actions\/runs)\//i;
export function contentHasArtifactRef(c: string): boolean {
  return ISSUE_REF_RE.test(c) || ARTIFACT_URL_RE.test(c);
}

/**
 * Encode a Vault record as its single-line JSON canonical form. Strict-validates first and THROWS on
 * anything invalid (unlike encodeHandoff, which only ever receives already-typed input) — a bad
 * record must never reach storage, since the vault is read raw into every agent's prompt. Drops the
 * optional `r` when empty; key order is stable (v,k,t,s,r,c,w) so equal records serialize identically.
 */
export function encodeVaultEntry(input: VaultInput, opts: { allowIssueRef?: boolean } = {}): string {
  const k = String(input.k ?? "").trim();
  if (!KEY_RE.test(k)) throw new Error(`vault: invalid key slug ${JSON.stringify(input.k)} (want kebab-case a-z0-9)`);
  if (!KINDS.has(input.t)) throw new Error(`vault: invalid kind ${JSON.stringify(input.t)}`);
  const s = String(input.s ?? "").trim();
  if (!s) throw new Error("vault: scope (s) required");
  const c = String(input.c ?? "").trim();
  if (!c) throw new Error("vault: content (c) required");
  if (c.length > MAX_C_LEN) throw new Error(`vault: content too long (${c.length} > ${MAX_C_LEN})`);
  if (!opts.allowIssueRef && contentHasArtifactRef(c)) {
    throw new Error("vault: content carries an issue/PR/run reference — issue artifacts stay out of the vault (pass allowIssueRef to override)");
  }
  const w = input.w;
  if (w !== 1 && w !== 2 && w !== 3) throw new Error(`vault: weight must be 1|2|3, got ${JSON.stringify(w)}`);
  const out: Record<string, unknown> = { v: VAULT_VERSION, k, t: input.t, s };
  const r = input.r != null ? String(input.r).trim() : "";
  if (r) out.r = r;
  out.c = c;
  out.w = w;
  return JSON.stringify(out);
}

/**
 * Decode + STRICTLY validate a canonical vault line. Rejects unknown `v`, any key outside the schema,
 * and any field of the wrong type/shape — returns null rather than coercing (same contract as
 * decodeHandoff). Note: the artifact-ref guard is a WRITE-time check, not applied here — an already
 * stored line decodes even if a future guard would reject it, so reads never silently drop rows.
 */
export function decodeVaultEntry(str: string): VaultEntry | null {
  if (typeof str !== "string" || !str.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(str);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) if (!ALLOWED_KEYS.has(key)) return null;
  if (o.v !== VAULT_VERSION) return null;
  if (typeof o.k !== "string" || !KEY_RE.test(o.k)) return null;
  if (typeof o.t !== "string" || !KINDS.has(o.t)) return null;
  if (typeof o.s !== "string" || !o.s.trim()) return null;
  if (typeof o.c !== "string" || !o.c.trim()) return null;
  if (o.w !== 1 && o.w !== 2 && o.w !== 3) return null;
  const out: VaultEntry = { v: 1, k: o.k, t: o.t as VaultKind, s: o.s, c: o.c, w: o.w };
  if (o.r !== undefined) {
    if (typeof o.r !== "string" || !o.r.trim()) return null;
    out.r = o.r;
  }
  return out;
}

// ── table access ────────────────────────────────────────────────────────────────────────────────

function toRow(r: { key: string; entry: string; source: string | null; updated_ts: string | null }): VaultRow | null {
  const entry = decodeVaultEntry(r.entry);
  if (!entry) return null;
  return { key: r.key, entry, source: r.source ?? "", updated_ts: r.updated_ts ?? "" };
}

/**
 * Upsert a record by its key `k`: validates + canonicalizes via encodeVaultEntry (throws on invalid),
 * writes the canonical line to `vault`, and appends to `vault_revisions` — so every change (human,
 * librarian fold, or migration) is auditable and revertible, exactly like agent_revisions.
 */
export function upsertVaultEntry(input: VaultInput, source: VaultSource = "human", opts: { allowIssueRef?: boolean } = {}): VaultEntry {
  const entry = encodeVaultEntry(input, opts); // validates + throws before any DB touch
  const decoded = decodeVaultEntry(entry)!; // never null — just encoded it
  const d = getDb();
  if (!d) return decoded;
  const ts = now();
  d.prepare(
    `INSERT INTO vault (key, entry, source, updated_ts) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET entry = excluded.entry, source = excluded.source, updated_ts = excluded.updated_ts`,
  ).run(decoded.k, entry, source, ts);
  d.prepare(`INSERT INTO vault_revisions (key, entry, source, ts) VALUES (?, ?, ?, ?)`).run(decoded.k, entry, source, ts);
  return decoded;
}

export function getVaultEntry(key: string): VaultRow | null {
  const d = getDb();
  if (!d) return null;
  try {
    const row = d.prepare(`SELECT key, entry, source, updated_ts FROM vault WHERE key = ?`).get(key) as
      | { key: string; entry: string; source: string | null; updated_ts: string | null }
      | undefined;
    return row ? toRow(row) : null;
  } catch {
    return null;
  }
}

/**
 * All stored records (newest first), optionally narrowed to those matching a repo `scope` and/or a
 * `role`. Scope matching honors the glob forms ("*", exact "owner/repo", prefix "reimedy-*"); a role
 * filter keeps global (role-less) entries plus those tagged for that exact role. Malformed rows
 * (should never happen — writes are validated) are dropped rather than surfaced.
 */
export function listVault(opts: { scope?: string; role?: string } = {}): VaultRow[] {
  const d = getDb();
  if (!d) return [];
  let rows: VaultRow[];
  try {
    const raw = d.prepare(`SELECT key, entry, source, updated_ts FROM vault ORDER BY updated_ts DESC`).all() as Array<{
      key: string;
      entry: string;
      source: string | null;
      updated_ts: string | null;
    }>;
    rows = raw.map(toRow).filter((r): r is VaultRow => r != null);
  } catch {
    return [];
  }
  if (opts.scope !== undefined) rows = rows.filter((r) => scopeMatches(r.entry.s, opts.scope!));
  if (opts.role !== undefined) rows = rows.filter((r) => !r.entry.r || r.entry.r === opts.role);
  return rows;
}

export function deleteVaultEntry(key: string): void {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(`DELETE FROM vault WHERE key = ?`).run(key);
  } catch {
    /* best effort */
  }
}

export interface VaultRevision {
  id: number;
  key: string;
  entry: string;
  source: string;
  ts: string;
}

export function listVaultRevisions(key: string, limit = 20): VaultRevision[] {
  const d = getDb();
  if (!d) return [];
  try {
    return d
      .prepare(`SELECT id, key, entry, source, ts FROM vault_revisions WHERE key = ? ORDER BY id DESC LIMIT ?`)
      .all(key, limit) as unknown as VaultRevision[];
  } catch {
    return [];
  }
}

/**
 * Does a stored scope glob match a concrete repo? Forms: "*" (global), exact "owner/repo", or a
 * prefix glob ("reimedy-*"). A glob/exact is tested against BOTH the full "owner/repo" and its bare
 * name (last path segment), so "reimedy-*" matches "ArneNostitz/reimedy-minimal". Exported for tests.
 */
export function scopeMatches(scope: string, repo: string): boolean {
  if (scope === "*") return true;
  if (!repo) return false;
  const name = repo.split("/").pop() ?? repo;
  const test = (pat: string, val: string): boolean => {
    if (!pat.includes("*")) return pat === val;
    const re = new RegExp("^" + pat.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return re.test(val);
  };
  return test(scope, repo) || test(scope, name);
}
