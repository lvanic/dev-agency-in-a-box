/**
 * The self-evolving loop, in two stages:
 *
 *   1. REFLECT (after every finished build): a cheap librarian agent looks at what happened
 *      and distills 0–3 reusable lessons into SQLite. Recent lessons are injected into every
 *      agent's system prompt, so the agency immediately benefits.
 *
 *   2. IMPROVE (when enough lessons pile up): the accumulated lessons are folded into the CENTRAL
 *      VAULT — compressed (cheap model) into canonical entries, scoped generic→global / else the
 *      lesson's own repo, role-tagged when the librarian tagged them. This applies live (the vault
 *      is injected into every agent) and every write is kept in vault_revisions (auditable +
 *      revertible). The FIXED persona/playbooks/constitution are user-only and never touched.
 *      (This replaced the retired per-agent "Learned" markdown docs — see docs/central-vault-plan.md.)
 */
import type { Config } from "./config.js";
import { runRole } from "./agents/roleAgent.js";
import { ROLES, type RoleName } from "./agents/roles.js";
import {
  recordLesson,
  recordRun,
  unprocessedLessons,
  markLessonsProcessed,
  upsertVaultEntry,
  listVault,
  type LessonRow,
  type VaultEntry,
} from "./store.js";
import { setActive, clearActive } from "./activity.js";
import { dispatch } from "./pool.js";
import { sNum } from "./settings.js";
import { maybeContributeLearnedUpstream, looksGeneric } from "./upstream.js";
import { compressToEntries, renderVault } from "./vaultTranslate.js";

/** Parse the librarian's reply: "LESSONS:\n- ..." or "NOTHING". Exported for tests. */
export function parseLessons(text: string): string[] {
  if (/^\s*NOTHING\b/i.test(text.trim())) return [];
  const idx = text.search(/LESSONS\s*:/i);
  if (idx < 0) return [];
  const out: string[] = [];
  for (const line of text.slice(idx).split("\n")) {
    const m = /^\s*[-*]\s+(.+)$/.exec(line);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out.slice(0, 3);
}

const ROLE_NAMES = new Set(Object.keys(ROLES));

/**
 * A lesson line may optionally carry a leading role tag ("developer: watch for X" / "[reviewer] …")
 * when the librarian judges it belongs to one role specifically, rather than the whole build (see
 * the librarian persona for the exact format it's asked to produce). Untagged lines — the common
 * case — get role=null, meaning they only ever fold into the SHARED learned doc. Exported for tests.
 */
export function splitLessonRole(raw: string): { role: RoleName | null; lesson: string } {
  // Bracketed/parenthesised form — "[reviewer] ..." / "(developer): ..." — the closing bracket
  // itself is the delimiter, so a trailing colon/dash is optional.
  const bracketed = /^\s*[[(]\s*([a-z]+)\s*[\])]\s*[:\-]?\s*(.+)$/i.exec(raw);
  // Plain "role: ..." / "role - ..." form — a colon or dash is required so an ordinary sentence
  // that merely starts with a role word ("developer built the fix") is never mistaken for a tag.
  const plain = /^\s*([a-z]+)\s*[:\-]\s*(.+)$/i.exec(raw);
  const m = bracketed || plain;
  if (m) {
    const cand = m[1].toLowerCase();
    if (ROLE_NAMES.has(cand) && m[2].trim()) return { role: cand as RoleName, lesson: m[2].trim() };
  }
  return { role: null, lesson: raw.trim() };
}

/**
 * Stage 1 — reflect on a finished build. Best-effort: never throws, never blocks the
 * pipeline outcome (the PR is already up when this runs).
 */
export async function runReflection(
  repo: string,
  issueNumber: number,
  workdir: string,
  context: string,
): Promise<void> {
  try {
    const res = await runRole("librarian", {
      workdir,
      repo,
      issueNumber,
      task:
        `A build for ${repo}#${issueNumber} just finished. Decide if anything is worth remembering ` +
        `for future runs (see your output format).\n\n### What happened\n${context.slice(0, 6000)}`,
    });
    recordRun(repo, issueNumber, "librarian", res.model, res.turns, "reflect", res.costUsd);
    const lessons = parseLessons(res.text);
    for (const raw of lessons) {
      const { role, lesson } = splitLessonRole(raw);
      recordLesson(repo, issueNumber, lesson, role);
    }
    if (lessons.length) console.log(`[agency] librarian: ${lessons.length} lesson(s) from ${repo}#${issueNumber}`);
  } catch (err) {
    console.warn("[agency] reflection skipped:", (err as Error).message);
  }
}

/**
 * Decide which lesson ids are safe to mark processed after a self-improve pass: everything EXCEPT
 * lessons whose vault fold failed (their bucket compressed to nothing, threw, or every proposed entry
 * was rejected). A failed lesson stays queued and is retried next cycle instead of being lost silently.
 * Exported for tests.
 */
export function lessonsToMarkProcessed(lessons: LessonRow[], failedIds: Set<number>): number[] {
  return lessons.filter((l) => !failedIds.has(l.id)).map((l) => l.id);
}

const lessonsPrThreshold = (): number => sNum("lessons_pr_threshold", "LESSONS_PR_THRESHOLD", 5);

let improving = false;

/**
 * Stage 2 — when enough unprocessed lessons exist, open ONE draft PR against the agency's
 * own repo that folds them into the playbooks. Dispatched into the worker pool (deduped),
 * so it never blocks normal issue work.
 */
export function maybeSelfImprove(cfg: Config): void {
  if (!cfg.selfImprove) return;
  const lessons = unprocessedLessons();
  if (lessons.length < lessonsPrThreshold() || improving) return;
  dispatch(`self#improve`, () => selfImprove(cfg, lessons));
}

/**
 * Bucket lessons for the vault fold by (scope, role) — the policy that decides where each lesson lands.
 * Scope: a GENERIC lesson (looksGeneric — names no watched product repo) becomes global "*"; anything
 * else is scoped to the lesson's own "owner/repo". Role: the tag the librarian already applied at record
 * time (splitLessonRole), when it's a known role. Same (scope, role) → one bucket (compressed together).
 * Pure + exported for tests — the scoping matrix is the testable heart of the fold; compress is the LLM.
 */
export interface LessonBucket { scope: string; role: string | null; lessons: LessonRow[] }
export function bucketLessonsForVault(lessons: LessonRow[], cfg: Config): LessonBucket[] {
  const buckets = new Map<string, LessonBucket>();
  for (const l of lessons) {
    const scope = looksGeneric(l.lesson, cfg) ? "*" : l.repo;
    const role = l.role && ROLE_NAMES.has(l.role) ? l.role : null;
    const bkey = `${scope}|${role ?? ""}`;
    const b = buckets.get(bkey) ?? { scope, role, lessons: [] };
    b.lessons.push(l);
    buckets.set(bkey, b);
  }
  return [...buckets.values()];
}

async function selfImprove(cfg: Config, lessons: LessonRow[]): Promise<void> {
  improving = true;
  const repo = cfg.agencyRepo;
  console.log(`[agency] self-improvement: folding ${lessons.length} lesson(s) into the vault`);
  setActive(repo, 0, "issue", "librarian", `self-improvement (${lessons.length} lessons)`);
  try {
    // Each bucket is compressed TOGETHER (one cheap-model call per bucket, not per lesson) into canonical
    // vault entries; WE set s/r from the bucket so scoping stays policy-controlled — the model only
    // shapes the key/kind/content.
    const buckets = bucketLessonsForVault(lessons, cfg);

    // Existing keys are passed as compress hints so a lesson that refines a known fact upserts its entry
    // instead of duplicating it. Grown as we go so entries added this pass also dedupe within the pass.
    const existingKeys = listVault().map((r) => r.key);
    const failed = new Set<number>();
    const globalEntries: VaultEntry[] = []; // the generic (scope "*") additions — offered upstream below
    const globalLessons: string[] = [];

    for (const b of buckets) {
      try {
        const text = b.lessons.map((l) => `- ${l.lesson}`).join("\n");
        const proposed = await compressToEntries(text, existingKeys);
        if (!proposed.length) {
          console.warn(`[agency] self-improvement: bucket [${b.scope}] compressed to nothing — its lessons stay queued.`);
          for (const l of b.lessons) failed.add(l.id);
          continue;
        }
        let stored = 0;
        for (const e of proposed) {
          // Override scope/role with the bucket's policy value; keep the model's key/kind/content/weight.
          const input = { k: e.k, t: e.t, s: b.scope, c: e.c, w: e.w, ...(b.role ? { r: b.role } : {}) };
          try {
            const saved = upsertVaultEntry(input, "librarian");
            existingKeys.push(saved.k);
            if (b.scope === "*") globalEntries.push(saved);
            stored++;
          } catch (err) {
            // Guard rejection (e.g. an issue ref slipped into c) — drop that entry, keep the rest.
            console.warn(`[agency] self-improvement: dropped a vault entry:`, (err as Error).message);
          }
        }
        if (!stored) { for (const l of b.lessons) failed.add(l.id); continue; }
        if (b.scope === "*") globalLessons.push(...b.lessons.map((l) => l.lesson));
        console.log(
          `[agency] self-improvement: folded ${b.lessons.length} lesson(s) → ${stored} vault entr${stored === 1 ? "y" : "ies"} ` +
            `[scope ${b.scope}${b.role ? `, role ${b.role}` : ""}]`,
        );
      } catch (err) {
        console.warn(`[agency] self-improvement: bucket [${b.scope}] fold skipped:`, (err as Error).message);
        for (const l of b.lessons) failed.add(l.id);
      }
    }

    // Upstream contribution (P5), REPOINTED from the retired _learned.md fold: the GENERIC (global) vault
    // additions become the upstream draft-PR payload as RENDERED markdown (not raw shorthand). looksGeneric
    // is re-checked inside the call; a no-op when the channel is off. Never blocks the local fold above.
    if (globalEntries.length) {
      void maybeContributeLearnedUpstream(cfg, {
        label: "vault (shared)",
        content: renderVault(globalEntries),
        sourceLessons: globalLessons,
      });
    }

    const toMark = lessonsToMarkProcessed(lessons, failed);
    if (toMark.length) markLessonsProcessed(toMark);
  } catch (err) {
    console.error("[agency] self-improvement failed:", (err as Error).message);
  } finally {
    clearActive(repo, 0);
    improving = false;
  }
}
