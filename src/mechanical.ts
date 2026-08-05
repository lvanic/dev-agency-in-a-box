/**
 * Deterministic mechanical ops — file shuffling done by code, not by an agent.
 *
 * Moving, renaming and deleting files is fully specified work with one correct outcome, so paying a
 * plan → build → test → review pipeline for it is pure waste: in a live benchmark the tail issue of
 * a build spent ~192k tokens to move one test file and write a README. An issue can instead carry an
 * `ops` block, which the pipeline applies before any agent starts.
 *
 * Ops are intentionally few and boring. Anything needing judgement is not an op — it is work for the
 * developer, and this module is not a general shell (that is what hooks are for).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";

export type Op =
  | { kind: "move"; from: string; to: string }
  | { kind: "delete"; path: string }
  | { kind: "mkdir"; path: string };

export interface OpResult { op: Op; ok: boolean; note: string }

/** Every path in an ops block is repo-relative and must stay inside the repo. Rejects absolute
 *  paths, `..` escapes and anything under `.git/` — an ops block is untrusted model output. */
export function safeRepoPath(workdir: string, p: string): string | null {
  const raw = p.trim();
  if (!raw || isAbsolute(raw) || raw.includes("\0")) return null;
  const full = normalize(join(workdir, raw));
  const rel = relative(workdir, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  if (rel === ".git" || rel.startsWith(`.git${"/"}`)) return null;
  return full;
}

/**
 * Parse the ```ops fenced block out of an issue body. One op per line:
 *   move <from> -> <to>
 *   delete <path>
 *   mkdir <path>
 * Unparseable lines are skipped rather than guessed at — a malformed op must never become a
 * different, silently-wrong op.
 */
export function parseOps(body: string): Op[] {
  const m = body.match(/```ops\s*([\s\S]*?)```/i);
  if (!m) return [];
  const ops: Op[] = [];
  for (const line of m[1].split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith("#")) continue;
    const mv = line.match(/^move\s+(.+?)\s*->\s*(.+)$/i);
    if (mv) { ops.push({ kind: "move", from: mv[1].trim(), to: mv[2].trim() }); continue; }
    const del = line.match(/^delete\s+(.+)$/i);
    if (del) { ops.push({ kind: "delete", path: del[1].trim() }); continue; }
    const md = line.match(/^mkdir\s+(.+)$/i);
    if (md) { ops.push({ kind: "mkdir", path: md[1].trim() }); continue; }
  }
  return ops;
}

/** `git mv`/`git rm` so history follows the file; falls back to a plain fs move when the path is
 *  untracked (git errors on those, and an untracked file still needs moving). */
async function git(workdir: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: workdir, timeout: 30_000 }, (err) => resolve(!err));
  });
}

/** Apply ops in order. Never throws: a failed op is reported and the rest still run, so one stale
 *  path in a block can't strand the whole issue. */
export async function applyOps(workdir: string, ops: Op[]): Promise<OpResult[]> {
  const out: OpResult[] = [];
  for (const op of ops) {
    if (op.kind === "move") {
      const from = safeRepoPath(workdir, op.from), to = safeRepoPath(workdir, op.to);
      if (!from || !to) { out.push({ op, ok: false, note: "path outside the repo" }); continue; }
      if (!existsSync(from)) { out.push({ op, ok: false, note: `${op.from} does not exist` }); continue; }
      await mkdir(dirname(to), { recursive: true }).catch(() => {});
      const viaGit = await git(workdir, ["mv", "-f", op.from, op.to]);
      if (!viaGit) {
        const moved = await rename(from, to).then(() => true).catch(() => false);
        if (!moved) { out.push({ op, ok: false, note: "move failed" }); continue; }
      }
      out.push({ op, ok: true, note: `${op.from} → ${op.to}` });
      continue;
    }
    if (op.kind === "delete") {
      const target = safeRepoPath(workdir, op.path);
      if (!target) { out.push({ op, ok: false, note: "path outside the repo" }); continue; }
      if (!existsSync(target)) { out.push({ op, ok: false, note: `${op.path} does not exist` }); continue; }
      if (!(await git(workdir, ["rm", "-r", "-f", op.path]))) {
        const gone = await rm(target, { recursive: true, force: true }).then(() => true).catch(() => false);
        if (!gone) { out.push({ op, ok: false, note: "delete failed" }); continue; }
      }
      out.push({ op, ok: true, note: `deleted ${op.path}` });
      continue;
    }
    const dir = safeRepoPath(workdir, op.path);
    if (!dir) { out.push({ op, ok: false, note: "path outside the repo" }); continue; }
    const made = await mkdir(dir, { recursive: true }).then(() => true).catch(() => false);
    // Git doesn't track empty directories — a .gitkeep is what makes the mkdir survive a commit.
    if (made) await writeFile(join(dir, ".gitkeep"), "").catch(() => {});
    out.push({ op, ok: made, note: made ? `created ${op.path}/` : "mkdir failed" });
  }
  return out;
}

/** One compact line per op for the activity stream / the developer's task text. */
export function renderOpResults(results: OpResult[]): string {
  return results.map((r) => `${r.ok ? "✓" : "✗"} ${r.note}`).join("\n");
}
