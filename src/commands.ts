/**
 * Repo watch-list plumbing + orphan recovery. The dashboard is the only input path (single
 * routing — see CONTEXT.md/ADR-0001, and ADR-0003 for the earlier removal of the @mention/label
 * intake system): repos are added/listed from Settings → Repos (webhook.ts's /add-repo route),
 * not by filing a control-command issue on GitHub. This module now holds what's shared between
 * that dashboard path and the scan loop: the effective watch list, access provisioning
 * (collaborator invite + webhook registration), and post-restart orphan recovery.
 */
import type { Config } from "./config.js";
import { listAllOpenIssues, ensureWebhook, ensureCollaborator } from "./github.js";
import { listWatchedRepos, recordIssueStatus, getIssueStatus } from "./store.js";
import { pushActivity } from "./activity.js";
import { withStatus, setBlocked } from "./state.js";

/** All repos currently watched: config/repos.txt ∪ the runtime list added from the dashboard. */
export function effectiveRepos(cfg: Config): string[] {
  return [...new Set([...cfg.targetRepos, ...listWatchedRepos()])];
}

/**
 * Make sure the agency can actually operate in `repo`: invite+accept the bot as a
 * collaborator (if an admin token is configured) and register the webhook (in webhook mode).
 * Returns a short human-readable note for the confirmation comment.
 */
export async function ensureRepoAccess(cfg: Config, repo: string): Promise<string> {
  const notes: string[] = [];
  if (cfg.adminToken) {
    const c = await ensureCollaborator(repo, cfg.adminToken, cfg.githubToken);
    if (c === "added") notes.push("bot invited + accepted");
    else if (c === "failed") notes.push("⚠️ couldn't invite bot (check ADMIN_GITHUB_TOKEN access)");
  }
  if (cfg.runMode === "webhook" && cfg.publicUrl && cfg.webhookSecret) {
    const url = `${cfg.publicUrl.replace(/\/$/, "")}/webhook`;
    // Webhook registration needs repo admin -> use the owner token, not the bot's.
    const w = await ensureWebhook(repo, url, cfg.webhookSecret, cfg.adminToken ?? cfg.githubToken);
    if (w === "created") notes.push("webhook registered");
  }
  return notes.length ? ` (${notes.join("; ")})` : "";
}

/** Ensure access (collaborator + webhook) across every watched repo. Run at startup. */
export async function ensureAllRepoAccess(cfg: Config): Promise<void> {
  for (const repo of effectiveRepos(cfg)) {
    const note = await ensureRepoAccess(cfg, repo);
    if (note) console.log(`[agency] ${repo}:${note}`);
  }
  // The agency's own repo too (collaborator only — needed for self-improvement PRs).
  if (cfg.selfImprove && cfg.adminToken && !effectiveRepos(cfg).includes(cfg.agencyRepo)) {
    const c = await ensureCollaborator(cfg.agencyRepo, cfg.adminToken, cfg.githubToken);
    if (c === "added") console.log(`[agency] ${cfg.agencyRepo}: bot invited + accepted (self-improvement)`);
  }
}

/**
 * Re-queue issues stranded "working" by a restart mid-run. On a fresh process no work is
 * active, so any in-progress issue is orphaned — park it so it's picked up again. Makes
 * redeploys safe even while an agent was working.
 *
 * `skip` (deploy-safe runs): "repo#number" keys that runner.ts's autoResumeInterrupted already
 * auto-resumed THIS boot from an interrupted-run marker — without this, this sweep would see the
 * same working+unblocked row (now legitimately running again) and re-park it as a false orphan.
 */
export async function recoverOrphans(cfg: Config, skip?: Set<string>): Promise<void> {
  for (const repo of effectiveRepos(cfg)) {
    try {
      for (const i of await listAllOpenIssues(repo)) {
        if (skip?.has(`${repo}#${i.number}`)) continue;
        const st = getIssueStatus(repo, i.number);
        // Only a genuinely in-flight ("working" with NO blocked reason) issue is an orphan after a
        // restart. An already-parked one (needs-attention / awaiting / rate-limited) must NOT be
        // re-parked — that pushed a duplicate "interrupted" notice on every restart.
        if (st.state === "working" && st.blocked == null) {
          // Park it — don't auto-requeue (that loops if restarts keep happening / a run keeps
          // failing). The human re-pins when ready.
          recordIssueStatus(repo, i.number, setBlocked(withStatus("working"), "needsAttention"));
          // DB-only — no GitHub comment (those emailed on every restart and fed a re-dispatch loop).
          pushActivity(repo, i.number, "agency", "done", "⏸ A restart interrupted this mid-run — parked at needs-attention. Press Resume to resume.");
          console.log(`[agency] parked orphaned ${repo} #${i.number}`);
        }
      }
    } catch (err) {
      console.error(`[agency] recovery error on ${repo}:`, (err as Error).message);
    }
  }
}
