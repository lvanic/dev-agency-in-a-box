/**
 * Controlled upstream-contribution channel (P5, docs/prime-time-plan.md #12).
 *
 * "Forks improve the original without messing it up": when a fork's self-improvement loop or
 * Process Analyzer produces a GENERIC finding — one that doesn't call out any of ITS OWN watched
 * product repos by name — this optionally ALSO proposes it to the upstream project, as a clearly
 * labeled ("[from fork] …") draft PR or advisory issue a human reviews and merges by hand. An
 * INSTANCE-SPECIFIC finding (it names one of the fork's own repos) never travels upstream — only
 * the instance's existing local behavior applies to those.
 *
 * Off by default and double-gated: `upstream_contrib_enabled` (bool, default false — opt-in) AND a
 * non-empty `upstream_repo` (str, defaults to the canonical project so turning the toggle on is the
 * only step for a fresh fork, but an explicitly-cleared field disables the channel — see
 * `upstreamTarget()` below for why this reads the raw setting instead of the usual sStr default).
 */
import type { Config } from "./config.js";
import { sBool } from "./settings.js";
import { getSetting } from "./store.js";
import { effectiveRepos } from "./commands.js";
import { createIssue, openUpstreamContribPr } from "./github.js";

export const FORK_PREFIX = "[from fork]";
const DEFAULT_UPSTREAM_REPO = "ArneNostitz/dev-agency";

/**
 * The configured upstream repo, or null when the channel is off, unset, or would just point back
 * at this instance's own repo. `upstream_repo` is a str OPS_SETTING with a non-empty DEFAULT (so a
 * fork works with zero typing once the toggle is on) — which means the usual `sStr()` helper can't
 * tell "never touched" (→ use the default) apart from "the operator explicitly blanked it to
 * disable" (both read back as "fall through to the default" in sStr). So this reads the DB row
 * directly: `null` (row never written) still resolves to the default; `""` (row explicitly written
 * empty, e.g. by clearing the Settings field) is respected as "disabled". Exported for tests.
 */
export function upstreamTarget(cfg: Config): string | null {
  if (!sBool("upstream_contrib_enabled", "UPSTREAM_CONTRIB_ENABLED", false)) return null;
  const dbRaw = getSetting("upstream_repo");
  const raw = (dbRaw !== null ? dbRaw : process.env.UPSTREAM_REPO?.trim() || DEFAULT_UPSTREAM_REPO).trim();
  if (!raw) return null; // explicitly cleared → disabled
  if (raw.toLowerCase() === cfg.agencyRepo.toLowerCase()) return null; // pointing at itself is a no-op
  return raw;
}

function repoNameVariants(repo: string): string[] {
  const bare = repo.split("/").pop() || repo;
  return [repo.toLowerCase(), bare.toLowerCase()];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Heuristic: `text` is "generic" — safe to also propose upstream — when it does not reference any
 * OTHER watched repo by name (mentioning the agency's own repo is fine; that's exactly the
 * operational-health content meant to travel upstream). Deliberately simple word-boundary name
 * matching rather than NLP: a missed instance-specific mention just fails safe (nothing is withheld
 * that shouldn't be — it's simply not offered upstream when it's actually generic); an unrelated
 * word coincidentally matching a very short repo name is the accepted tradeoff for staying
 * dependency-free and auditable. Exported for tests.
 */
export function looksGeneric(text: string, cfg: Config): boolean {
  const hay = (text || "").toLowerCase();
  const agencyNames = new Set(repoNameVariants(cfg.agencyRepo));
  for (const repo of effectiveRepos(cfg)) {
    for (const name of repoNameVariants(repo)) {
      if (agencyNames.has(name)) continue;
      if (new RegExp(`\\b${escapeRe(name)}\\b`, "i").test(hay)) return false;
    }
  }
  return true;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "contrib"
  );
}

/**
 * Best-effort: propose a GENERIC self-improvement fold (the shared Learned doc, or one role's
 * `<role>.learned.md`) to the upstream repo as a brand-new, additive file — never overwrites
 * upstream's own copy of that doc, so it can never conflict. Draft PR only; never auto-merged. A
 * no-op when the channel is off/unset.
 *
 * The genericity check runs against `opts.content` — the EXACT payload that would ship upstream —
 * not just this round's new lessons. `content` is the FULL cumulative learned doc (this round's
 * fold merged into everything folded in prior rounds), so an earlier round could have written
 * something instance-specific even when this round's own delta is clean; checking only the delta
 * would let that older instance-specific text leak upstream unnoticed. If the full doc fails the
 * check, the mirror is skipped outright (logged) — it is never redacted/edited to "make it generic".
 */
export async function maybeContributeLearnedUpstream(
  cfg: Config,
  opts: { label: string; content: string; sourceLessons: string[] },
): Promise<void> {
  try {
    const upstream = upstreamTarget(cfg);
    if (!upstream) return;
    if (!opts.sourceLessons.length) return;
    if (!looksGeneric(opts.content, cfg)) {
      console.log(
        `[agency] upstream contribution skipped: the cumulative "${opts.label}" doc looks instance-specific ` +
          `(names a watched repo) even though this round's new lessons alone may not — never partially ` +
          `redacted, just held back until the doc as a whole is generic.`,
      );
      return;
    }
    const slug = slugify(opts.label);
    const title = `${FORK_PREFIX} ${opts.label} — folded lessons from a fork`;
    const body =
      `Opened automatically by **${cfg.agencyRepo}**'s self-improvement loop (Settings → General → ` +
      `"Contribute upstream"). These lessons were judged GENERIC — not specific to any of that fork's ` +
      `own watched repos. **Draft only; review and merge by hand — never auto-merged.**\n\n` +
      `### Lessons folded\n${opts.sourceLessons.map((l) => `- ${l}`).join("\n")}\n\n` +
      `### Proposed content (\`${opts.label}\`)\n\n${opts.content}`;
    const r = await openUpstreamContribPr(upstream, {
      filePath: `memory/contrib/${slug}-${Date.now()}.md`,
      content: opts.content,
      title,
      body,
      branchPrefix: `agency/upstream-contrib-${slug}`,
    });
    if (r) console.log(`[agency] upstream contribution: opened draft PR ${r.url} on ${upstream}`);
  } catch (err) {
    console.warn("[agency] upstream contribution skipped:", (err as Error).message);
  }
}

/**
 * Best-effort: mirror a GENERIC Process Analyzer advisory issue upstream too, as its own issue
 * (never a PR — analyzer proposals are advisory text, not code). A no-op when the channel is
 * off/unset or the advisory looks instance-specific.
 */
export async function maybeContributeAnalyzerIssueUpstream(
  cfg: Config,
  opts: { title: string; body: string },
): Promise<void> {
  try {
    const upstream = upstreamTarget(cfg);
    if (!upstream) return;
    if (!looksGeneric(`${opts.title}\n${opts.body}`, cfg)) return;
    const title = `${FORK_PREFIX} ${opts.title}`;
    const body =
      `Opened automatically by **${cfg.agencyRepo}**'s Process Analyzer (Settings → General → ` +
      `"Contribute upstream"). Advisory only — never auto-acted on.\n\n---\n\n${opts.body}`;
    await createIssue(upstream, title, body);
  } catch (err) {
    console.warn("[agency] upstream analyzer issue skipped:", (err as Error).message);
  }
}
