/**
 * The self-evolving loop, in two stages:
 *
 *   1. REFLECT (after every finished build): a cheap librarian agent looks at what happened
 *      and distills 0–3 reusable lessons into SQLite. Recent lessons are injected into every
 *      agent's system prompt, so the agency immediately benefits.
 *
 *   2. IMPROVE (when enough lessons pile up): a librarian agent folds the accumulated lessons
 *      into the LEARNING part of the agents — the DB-backed "Learned (shared)" doc that's
 *      injected into every agent. This applies live (no redeploy) and every change is kept in
 *      the agent_revisions history (auditable + revertible). The self-improvement loop only
 *      ever touches the LEARNING part — the FIXED persona/playbooks/constitution are user-only.
 */
import type { Config } from "./config.js";
import { runRole } from "./agents/roleAgent.js";
import { ROLES, type RoleName } from "./agents/roles.js";
import { readAgentFile, SHARED_LEARNED_PATH, roleLearnedPath } from "./memory.js";
import {
  recordLesson,
  recordRun,
  unprocessedLessons,
  markLessonsProcessed,
  setAgentOverride,
  type LessonRow,
} from "./store.js";
import { setActive, clearActive } from "./activity.js";
import { dispatch } from "./pool.js";
import { sNum } from "./settings.js";

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
 * Decide which lesson ids are safe to mark processed after a self-improve pass: everything
 * EXCEPT lessons whose role-specific fold failed. Every lesson (tagged or not) already fed the
 * shared doc by this point — this only gates the ADDITIONAL per-role fold, so a role-tagged
 * lesson whose role fold failed stays queued and gets retried next cycle instead of being lost.
 * Exported for tests.
 */
export function lessonsToMarkProcessed(lessons: LessonRow[], failedRoleLessonIds: Set<number>): number[] {
  return lessons.filter((l) => !failedRoleLessonIds.has(l.id)).map((l) => l.id);
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

async function selfImprove(cfg: Config, lessons: LessonRow[]): Promise<void> {
  improving = true;
  const repo = cfg.agencyRepo;
  console.log(`[agency] self-improvement: folding ${lessons.length} lessons into the Learned doc`);
  setActive(repo, 0, "issue", "librarian", `self-improvement (${lessons.length} lessons)`);
  try {
    const current = (await readAgentFile(SHARED_LEARNED_PATH)) || "";
    const list = lessons.map((l) => `- (${l.repo}#${l.number}) ${l.lesson}`).join("\n");
    const res = await runRole("librarian", {
      workdir: process.cwd(),
      repo,
      issueNumber: 0,
      task:
        `Maintain our LEARNED playbook — durable, reusable, cross-project guidance distilled from real runs, ` +
        `injected into every agent. Fold the new lessons into the current doc: merge related points, dedupe, ` +
        `organise by theme, and DROP anything noisy, one-off, or already covered by our fixed playbooks. ` +
        `Keep it tight.\n\n### Current LEARNED playbook\n${current || "(empty)"}\n\n### New lessons\n${list}\n\n` +
        `Output ONLY the complete updated LEARNED playbook as markdown — no preamble, no commentary.`,
    });
    const content = res.text.trim();
    recordRun(repo, 0, "librarian", res.model, res.turns, "self-improve", res.costUsd);
    if (content) {
      // Live + versioned: applies on the next agent run, history kept in agent_revisions.
      setAgentOverride(SHARED_LEARNED_PATH, content, "self-improve", `folded ${lessons.length} lessons`);
      console.log(`[agency] self-improvement: Learned doc updated (+${lessons.length} lessons, live)`);

      // Per-role fold: lessons the librarian tagged with a specific role ALSO fold into that
      // role's own learned doc (central/agents/<role>.learned.md). This is what makes the
      // per-role read path (loadLearned → roleLearnedPath, read every run in roleAgent.ts) live —
      // previously nothing ever wrote it.
      const byRole = new Map<string, LessonRow[]>();
      for (const l of lessons) {
        if (l.role && ROLE_NAMES.has(l.role)) {
          const arr = byRole.get(l.role) ?? [];
          arr.push(l);
          byRole.set(l.role, arr);
        }
      }
      // Lessons whose role-specific fold fails must NOT be marked processed — they'd be silently
      // lost forever instead of retried next cycle (they've already served the shared doc above,
      // but their role-specific half of the job is still outstanding).
      const failedRoleLessonIds = new Set<number>();
      for (const [role, roleLessons] of byRole) {
        const path = roleLearnedPath(role);
        try {
          const roleCurrent = (await readAgentFile(path)) || "";
          const roleList = roleLessons.map((l) => `- (${l.repo}#${l.number}) ${l.lesson}`).join("\n");
          const roleRes = await runRole("librarian", {
            workdir: process.cwd(),
            repo,
            issueNumber: 0,
            task:
              `Maintain the ${role}'s OWN learned notes — durable guidance specific to the ${role} role only ` +
              `(not the shared playbook, which is maintained separately). Fold the new lessons into the ` +
              `current doc: merge related points, dedupe, and DROP anything noisy or one-off. Keep it tight.\n\n` +
              `### Current ${role}.learned.md\n${roleCurrent || "(empty)"}\n\n### New lessons for ${role}\n${roleList}\n\n` +
              `Output ONLY the complete updated markdown — no preamble, no commentary.`,
          });
          recordRun(repo, 0, "librarian", roleRes.model, roleRes.turns, "self-improve", roleRes.costUsd);
          const roleContent = roleRes.text.trim();
          if (roleContent) {
            setAgentOverride(path, roleContent, "self-improve", `folded ${roleLessons.length} ${role} lesson(s)`);
            console.log(`[agency] self-improvement: ${role}.learned.md updated (+${roleLessons.length} lessons, live)`);
          } else {
            console.warn(`[agency] self-improvement: ${role} fold produced no content — its lessons stay queued.`);
            for (const l of roleLessons) failedRoleLessonIds.add(l.id);
          }
        } catch (err) {
          console.warn(`[agency] self-improvement: ${role} fold skipped:`, (err as Error).message);
          for (const l of roleLessons) failedRoleLessonIds.add(l.id);
        }
      }

      const toMark = lessonsToMarkProcessed(lessons, failedRoleLessonIds);
      if (toMark.length) markLessonsProcessed(toMark);
    } else {
      console.warn("[agency] self-improvement produced no content — lessons stay queued.");
    }
  } catch (err) {
    console.error("[agency] self-improvement failed:", (err as Error).message);
  } finally {
    clearActive(repo, 0);
    improving = false;
  }
}
