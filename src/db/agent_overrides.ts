import { getDb, now } from "./connection.js";
import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { agentFileRepoPath, isSafeAgentPath } from "../memory.js";

// src/db/ -> project root (two levels up). Overridable so tests can redirect disk mirroring at a
// throwaway tmp dir instead of writing into this actual checkout's memory/ files (same pattern as
// DB_PATH for the SQLite file).
const projectRoot = process.env.AGENCY_MEMORY_ROOT?.trim() || join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const diskSyncWarned = new Set<string>(); // per-path — one file's read-only FS shouldn't silence others.
const diskSyncQueue = new Map<string, Promise<void>>(); // per-path write serialization — last write wins, in order.

function absPathFor(path: string): string {
  return join(projectRoot, agentFileRepoPath(path));
}

/**
 * Best-effort: mirror a live DB override back onto the git-tracked file under memory/. Without
 * this, an edit made in the dashboard (or by self-improvement) only ever lives in the DB — the
 * on-disk file silently drifts from what agents actually run on, and `git diff`/code review never
 * sees it. Failures (e.g. a read-only filesystem in some container setups) are swallowed after one
 * warning PER PATH: the DB override still applies regardless, this is purely to keep disk honest.
 *
 * Writes for the same path are serialized through `diskSyncQueue` — setAgentOverride fires this
 * without awaiting it (callers shouldn't block on a filesystem mirror), so two overlapping saves
 * for the same path could otherwise race and land out of order.
 */
function queueDiskSync(path: string, content: string): void {
  if (!isSafeAgentPath(path)) return;
  const prior = diskSyncQueue.get(path) ?? Promise.resolve();
  const next = prior
    .catch(() => {}) // a previous failure must not poison the chain for later writes
    .then(async () => {
      try {
        const abs = absPathFor(path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
      } catch (err) {
        if (!diskSyncWarned.has(path)) {
          diskSyncWarned.add(path);
          console.warn(`[agency] agent-override disk sync skipped for ${path} (read-only filesystem?):`, (err as Error).message);
        }
      }
    });
  diskSyncQueue.set(path, next);
}

/**
 * Capture the TRUE pristine default for a path — what's on disk right now — the first time it's
 * ever overridden, before `queueDiskSync` gets a chance to mirror an edit over it. Without this,
 * once a path has been edited once, the on-disk file IS the edited content, so a later "revert to
 * default" (which used to just fall back to reading disk) would "revert" to the last edit instead
 * of what actually shipped. No-ops if a pristine snapshot already exists for this path.
 */
function capturePristineDefault(path: string): void {
  const d = getDb();
  if (!d) return;
  try {
    const already = d.prepare(`SELECT 1 FROM agent_defaults WHERE path = ?`).get(path);
    if (already) return;
    let content = "";
    try {
      content = readFileSync(absPathFor(path), "utf8");
    } catch {
      content = ""; // file doesn't exist on disk yet — that absence IS the pristine default
    }
    d.prepare(`INSERT INTO agent_defaults (path, content, captured_at) VALUES (?, ?, ?)`).run(path, content, now());
  } catch {
    /* best effort */
  }
}

export function getAgentOverride(path: string): string | null {
  const d = getDb();
  if (!d) return null;
  try {
    const row = d.prepare(`SELECT content FROM agent_overrides WHERE path = ?`).get(path) as { content?: string } | undefined;
    return row?.content ?? null;
  } catch {
    return null;
  }
}

/**
 * The pristine on-disk default captured the first time `path` was ever overridden — or null if
 * it's never been touched (in which case the real disk file IS still the default; see
 * `readWithOverride` in memory.ts, which checks this before falling back to disk).
 */
export function getAgentDefault(path: string): string | null {
  const d = getDb();
  if (!d) return null;
  try {
    const row = d.prepare(`SELECT content FROM agent_defaults WHERE path = ?`).get(path) as { content?: string } | undefined;
    return row?.content ?? null;
  } catch {
    return null;
  }
}

export function setAgentOverride(path: string, content: string, source = "dashboard", note = ""): void {
  const d = getDb();
  if (!d) return;
  try {
    const hadOverride = d.prepare(`SELECT 1 FROM agent_overrides WHERE path = ?`).get(path);
    if (!hadOverride) capturePristineDefault(path); // snapshot BEFORE the first mirror ever touches disk
    d.prepare(
      `INSERT INTO agent_overrides (path, content, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    ).run(path, content, now());
    // Keep a full history so every change (dashboard or self-improvement) is auditable/revertible.
    d.prepare(`INSERT INTO agent_revisions (path, content, source, note, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      path,
      content,
      source,
      note,
      now(),
    );
  } catch {
    return; // DB write failed — leave disk untouched too.
  }
  queueDiskSync(path, content);
}

export interface AgentRevision {
  id: number;
  path: string;
  source: string;
  note: string;
  created_at: string;
}

export function listAgentRevisions(path: string, limit = 20): AgentRevision[] {
  const d = getDb();
  if (!d) return [];
  try {
    return d
      .prepare(`SELECT id, path, source, note, created_at FROM agent_revisions WHERE path = ? ORDER BY id DESC LIMIT ?`)
      .all(path, limit) as unknown as AgentRevision[];
  } catch {
    return [];
  }
}

export function getAgentRevision(id: number): string | null {
  const d = getDb();
  if (!d) return null;
  try {
    const row = d.prepare(`SELECT content FROM agent_revisions WHERE id = ?`).get(id) as { content?: string } | undefined;
    return row?.content ?? null;
  } catch {
    return null;
  }
}

export function deleteAgentOverride(path: string): void {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(`DELETE FROM agent_overrides WHERE path = ?`).run(path);
  } catch {
    return;
  }
  // Restore the true pristine default back onto disk too, undoing whatever the live override had
  // mirrored there — otherwise disk would keep showing the last edit even after a revert.
  const pristine = getAgentDefault(path);
  if (pristine != null) queueDiskSync(path, pristine);
}

/**
 * Hard-purge every DB trace of a path — the live override, its full revision history, and the
 * pristine-default snapshot — WITHOUT the disk mirror that deleteAgentOverride does. Used to retire
 * the legacy learned docs (docs/central-vault-plan.md Phase 3): those rows are dead data now
 * (nothing reads or lists them), so this just removes them rather than "reverting" to a default that
 * no longer means anything. Best-effort.
 */
export function purgeAgentOverride(path: string): void {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(`DELETE FROM agent_overrides WHERE path = ?`).run(path);
    d.prepare(`DELETE FROM agent_revisions WHERE path = ?`).run(path);
    d.prepare(`DELETE FROM agent_defaults WHERE path = ?`).run(path);
  } catch {
    /* best effort */
  }
}

export function listAgentOverridePaths(): string[] {
  const d = getDb();
  if (!d) return [];
  try {
    return (d.prepare(`SELECT path FROM agent_overrides`).all() as Array<{ path: string }>).map((r) => r.path);
  } catch {
    return [];
  }
}
