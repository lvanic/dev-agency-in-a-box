/**
 * Deploy-safe runs: the self-merge quiet window (human-gated hold) for the agency's own repo, plus
 * the pure decision functions both it and the auto-resume-after-redeploy path are built on.
 *
 * When cfg.agencyRepo has a PR ready to merge while OTHER issues are still in flight, merging
 * immediately would trigger Coolify's autodeploy mid-run — the container restarts, in-flight work
 * gets interrupted (recoverable via runner.ts's interrupted-run marker + auto-resume, but still a
 * disruption). Instead of merging right away we hold it in a small queue (db/deploy.ts's
 * held_updates) and surface it in the dashboard as an "Update ready" chip; a human can deploy now
 * (interrupting on purpose) or wait for the pool to go quiet, at which point it flushes on its own.
 *
 * `self_merge_hold` (settings, default true) is the kill-switch — off restores the old
 * "merge immediately" behavior.
 *
 * No module in this file's import chain reaches back into runner.ts or webhook.ts — both of those
 * import FROM here, so keeping it a leaf avoids a circular import.
 */
import type { Config } from "./config.js";
import { sBool } from "./settings.js";
import { inFlightKeys, poolStatus } from "./pool.js";
import { mergePrForBranch, findPrForBranch, prMergeStatus, closeIssue } from "./github.js";
import { afterMerge, type MergedFile } from "./merge_hooks.js";
import { pushActivity } from "./activity.js";
import { recordIssueStatus, clearReview, getIssueRow } from "./store.js";
import { withStatus } from "./state.js";
import { holdUpdate, listHeldUpdates, clearHeldUpdate } from "./db/deploy.js";

/**
 * Pure decision: should a ready-to-merge agency-repo PR be HELD instead of merged right now?
 * `ownKey` ("repo#number") never counts against itself — only OTHER in-flight work triggers a hold.
 */
export function shouldHoldSelfMerge(holdEnabled: boolean, inFlight: string[], ownKey: string): boolean {
  if (!holdEnabled) return false;
  return inFlight.some((k) => k !== ownKey);
}

/**
 * Pure decision: is this interrupted-run marker eligible for another auto-resume attempt? attempts
 * counts prior boot-side processing attempts for this exact marker row — see db/deploy.ts's module
 * doc for why a marker that already shows attempts >= max is a crash loop, not a normal redeploy.
 */
export function shouldAutoResumeMarker(attempts: number, maxAttempts = 1): boolean {
  return attempts < maxAttempts;
}

export interface SelfMergeOutcome {
  ok: boolean;
  held: boolean;
  msg?: string;
  files?: MergedFile[];
}

/**
 * Merge repo#number's PR on `branch` — UNLESS it's the agency's own repo and other runs are in
 * flight, in which case hold it in the queue instead (see module doc). Non-agency repos and quiet
 * pools behave exactly like a plain `mergePrForBranch` call.
 */
export async function attemptSelfMerge(cfg: Config, repo: string, number: number, branch: string): Promise<SelfMergeOutcome> {
  const isAgencyRepo = repo.toLowerCase() === cfg.agencyRepo.toLowerCase();
  const holdEnabled = isAgencyRepo && sBool("self_merge_hold", "", true);
  const ownKey = `${repo}#${number}`;
  if (shouldHoldSelfMerge(holdEnabled, inFlightKeys(), ownKey)) {
    const others = inFlightKeys().filter((k) => k !== ownKey);
    const pr = await findPrForBranch(repo, branch).catch(() => null);
    const title = getIssueRow(repo, number)?.title || `#${number}`;
    holdUpdate(repo, number, pr?.number ?? 0, title);
    pushActivity(repo, number, "agency", "text", `⏸ holding self-merge: ${others.length} run${others.length === 1 ? "" : "s"} in flight`);
    console.log(`[agency] holding self-merge ${ownKey} — ${others.length} other run(s) in flight`);
    return { ok: true, held: true, msg: `held — ${others.length} other run(s) in flight` };
  }
  const r = await mergePrForBranch(repo, branch);
  return { ok: r.ok, held: false, msg: r.msg, files: r.files };
}

/**
 * Merge every currently-held update right now, regardless of pool state — used by the dashboard's
 * "Deploy now" button (a human deliberately accepting the interruption) and by the auto-flush tick
 * once it's confirmed the pool is quiet. Best-effort per row: a row is only cleared once its update
 * has actually landed (merged here, or found already merged/closed externally — e.g. a human merged
 * it directly on GitHub). A genuine merge failure (conflict, failing checks, a transient API error)
 * KEEPS the row — the chip stays up, an activity warning explains why, and the next flush retries —
 * rather than silently dropping the update.
 */
async function flushHeldUpdates(): Promise<number> {
  const held = listHeldUpdates();
  let merged = 0;
  for (const h of held) {
    const branch = `agency/issue-${h.number}`;
    try {
      // Check reality first: someone may have merged or closed this PR directly on GitHub while it
      // sat held. Either way there's nothing left for US to merge — clear the row without treating
      // it as our own failure.
      const status = await prMergeStatus(h.repo, branch).catch(() => null);
      if (status?.merged) {
        console.log(`[agency] held self-merge ${h.repo}#${h.number} was already merged externally — clearing`);
        clearHeldUpdate(h.repo, h.number);
        continue;
      }
      if (status && status.state === "CLOSED") {
        console.log(`[agency] held self-merge ${h.repo}#${h.number}'s PR was closed externally — clearing`);
        pushActivity(h.repo, h.number, "agency", "text", "The held PR was closed outside the agency — dropping it from the deploy queue.");
        clearHeldUpdate(h.repo, h.number);
        continue;
      }
      const r = await mergePrForBranch(h.repo, branch);
      if (r.ok) {
        afterMerge(h.repo, h.number, r.files, h.title);
        await closeIssue(h.repo, h.number, `🚀 Merged ${r.msg} — held update deployed.`).catch(() => {});
        recordIssueStatus(h.repo, h.number, withStatus("done"));
        clearReview(h.repo, h.number);
        pushActivity(h.repo, h.number, "agency", "done", `🚀 deploying held update(s): #${h.prNumber || h.number}`);
        console.log(`[agency] flushed held self-merge ${h.repo}#${h.number} (PR #${h.prNumber})`);
        clearHeldUpdate(h.repo, h.number);
        merged++;
      } else {
        // Keep the row — surface the failure but let the queue (and the dashboard chip) persist so
        // it isn't silently lost; the next auto-flush tick or "Deploy now" click retries it.
        pushActivity(h.repo, h.number, "agency", "text", `⚠ held update failed to merge: ${r.msg} — will retry`);
        console.warn(`[agency] held self-merge flush failed ${h.repo}#${h.number}: ${r.msg}`);
      }
    } catch (err) {
      pushActivity(h.repo, h.number, "agency", "text", `⚠ held update failed to merge: ${(err as Error).message} — will retry`);
      console.error(`[agency] held self-merge flush error ${h.repo}#${h.number}:`, (err as Error).message);
    }
  }
  return merged;
}

// Deploy-safe runs, issue #3 fix: a single-process in-flight latch. "Deploy now" (a human click) and
// the auto-flush tick (a timer) can otherwise both call flushHeldUpdates at once — double-merging
// the same held PR and double-firing afterMerge's side effects (change journal + gitnexus reindex).
// Node is single-threaded/single-process here, so a module-level promise is sufficient; a second
// caller just awaits the SAME in-flight run instead of starting its own.
let flushInFlight: Promise<number> | null = null;

function runFlush(): Promise<number> {
  const p = flushHeldUpdates().finally(() => {
    if (flushInFlight === p) flushInFlight = null;
  });
  flushInFlight = p;
  return p;
}

/** Auto-flush: only merges held updates once the pool is fully quiet (0 running, 0 queued). Called
 * from a timer; a no-op most ticks (nothing held, or other work still in flight). Serialized with
 * "Deploy now" (see flushInFlight above) — never runs concurrently with it. */
export async function flushHeldUpdatesIfQuiet(): Promise<number> {
  if (flushInFlight) return flushInFlight;
  if (!listHeldUpdates().length) return 0;
  const { running, queued } = poolStatus();
  if (running > 0 || queued > 0) return 0;
  return runFlush();
}

/** Flush every held update right now — the dashboard's "Deploy now" button. Serialized with the
 * auto-flush tick (see flushInFlight above): if one is already running, this awaits that SAME run
 * instead of starting a second one. */
export async function flushHeldUpdatesNow(): Promise<number> {
  if (flushInFlight) return flushInFlight;
  return runFlush();
}
