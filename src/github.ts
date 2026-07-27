/**
 * Thin wrappers around the GitHub CLI (`gh`). We shell out rather than use a
 * REST client because `gh` handles auth, pagination, and is the same tool the
 * agents themselves use inside their working copies.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync, appendFileSync, existsSync } from "node:fs";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { sBool, sStr } from "./settings.js";
import { ghBotToken, ghUserToken } from "./creds.js";
import { recordOutgoingComment, setCommentGhId, getConversation, recordIncident, getSetting } from "./store.js";

const execFileAsync = promisify(execFile);

/** True when `repo` is the agency's own repo, resolved the same way config.ts does. */
export function isAgencyRepo(repo: string): boolean {
  const raw = sStr("agency_repo", "AGENCY_REPO", "dev-agency").trim();
  const full = raw.includes("/") ? raw : `${sStr("github_owner", "GITHUB_OWNER", "").trim()}/${raw}`;
  const nameOf = (r: string) => r.split("/").pop();
  return repo === full || nameOf(repo) === nameOf(raw);
}

/**
 * Whether to append the `[skip ci]` tag to agency commits in `repo`. On by default (SKIP_CI) to
 * save GitHub Actions minutes on watched product repos, but NEVER for the agency's own repo — see
 * the long note at the hook-install site.
 */
export function skipCiEnabledFor(repo: string): boolean {
  if (!sBool("skip_ci", "SKIP_CI", true)) return false;
  return !isAgencyRepo(repo);
}

// Circuit breaker (Process Analyzer findings, dev-agency-analyzer#156-199): `gh` had zero retry/
// back-off logic — once GitHub rate-limits a repo, every scan tick re-hits the SAME failing call
// (issue-comments fetch was the observed hot path) with no delay and no exit condition. One 6h
// telemetry window recorded 180,071 failed calls to a single endpoint before the analyzer flagged
// it — pure log noise burning CPU, not real work. Trip the circuit on the FIRST rate-limit error and
// short-circuit every `gh`/`ghAs` call (fail fast, no exec) until the cooldown elapses: one real
// failure logged instead of thousands, and GitHub's actual quota gets a chance to recover instead of
// being hammered while already exhausted.
export const PRIMARY_RATE_LIMIT_COOLDOWN_MS = 10 * 60_000; // GitHub's primary limit resets hourly;
// a conservative partial wait — short enough that legitimate work resumes well within the hour,
// long enough that a scan loop (30s+ cadence) can't retrigger the same failure many times over.
export const SECONDARY_RATE_LIMIT_COOLDOWN_MS = 60_000; // secondary/abuse-detection limits are
// short-lived (seconds, per GitHub's own docs) — a full 10-minute pause would be needlessly
// conservative here.
let circuitOpenUntil = 0;
let circuitReason = "";
function circuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}
/** Test/inspection hook — the internal circuit state, without exposing the trip/gh internals. */
export function circuitStatus(): { open: boolean; until: number; reason: string } {
  return { open: circuitOpen(), until: circuitOpenUntil, reason: circuitReason };
}
export function maybeTripCircuit(args: string[], err: unknown): void {
  const msg = (err as Error)?.message || "";
  if (!/rate limit|secondary rate|abuse detection|was submitted too quickly/i.test(msg)) return;
  recordIncident("github-rate-limit", `${args.slice(0, 2).join(" ")}: ${msg.slice(0, 160)}`);
  if (circuitOpen()) return; // already open — this is exactly the retry storm we're preventing
  const secondary = /secondary rate|abuse detection|was submitted too quickly/i.test(msg);
  circuitOpenUntil = Date.now() + (secondary ? SECONDARY_RATE_LIMIT_COOLDOWN_MS : PRIMARY_RATE_LIMIT_COOLDOWN_MS);
  circuitReason = msg.slice(0, 200);
  console.warn(`[agency] gh circuit OPEN (${secondary ? "secondary" : "primary"} rate limit) — pausing all gh calls until ${new Date(circuitOpenUntil).toISOString()}`);
}
function circuitError(): Error {
  return new Error(`gh circuit open (${circuitReason || "GitHub rate limit"}) — retry after ${new Date(circuitOpenUntil).toISOString()}`);
}

/** Run gh as the human owner ("acts as you"); empty token falls back to the stored owner/bot token. */
async function ghAs(token: string, args: string[]): Promise<string> {
  if (circuitOpen()) throw circuitError();
  const t = token || ghUserToken() || ghBotToken();
  try {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 10 * 1024 * 1024,
      env: t ? { ...process.env, GH_TOKEN: t, GITHUB_TOKEN: t } : process.env,
    });
    return stdout.trim();
  } catch (err) {
    maybeTripCircuit(args, err);
    throw err;
  }
}

/** Run gh as the agency bot, using the dashboard-stored bot token (or GITHUB_TOKEN env). */
async function gh(args: string[]): Promise<string> {
  if (circuitOpen()) throw circuitError();
  const token = ghBotToken();
  try {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 10 * 1024 * 1024,
      env: token ? { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } : process.env,
    });
    return stdout.trim();
  } catch (err) {
    maybeTripCircuit(args, err);
    throw err;
  }
}

export interface Issue {
  number: number;
  title: string;
  body: string;
}

/** Hidden marker appended to every agency comment so we can tell our messages from a human's. */
export const AGENCY_MARKER = "<!-- dev-agency -->";



export async function commentOnIssue(repo: string, issue: number, body: string): Promise<void> {
  // DB-first: record the agency comment immediately so the dashboard renders it without waiting on
  // GitHub. The GitHub mirror runs in the BACKGROUND — a run never waits on (or fails because of) a
  // comment post; a failed mirror is linked later by the reconcile.
  const localId = recordOutgoingComment({ repo, number: issue, author: "dev-agency", body, source: "agency" });
  if (issue <= 0) return; // dashboard-only issue (no GitHub number yet) — DB is enough
  void (async () => {
    try {
      const out = await gh(["api", "-X", "POST", `repos/${repo}/issues/${issue}/comments`, "-f", `body=${body}\n\n${AGENCY_MARKER}`]);
      const j = JSON.parse(out);
      if (j?.id) setCommentGhId(localId, j.id, j.created_at);
    } catch { /* GitHub mirror failed (rate limit / parse) — it's in the DB; reconcile links it later */ }
  })();
}

/**
 * Delete ALL agency comments (those carrying the AGENCY_MARKER) from an issue on GitHub.
 * Used by the full-reset action to return the issue to its initial state. Human comments are
 * preserved. Returns the count of deleted comments.
 */
export async function deleteAgencyComments(repo: string, issue: number): Promise<number> {
  const comments = await ghFetchAll(`repos/${repo}/issues/${issue}/comments`).catch(() => null);
  if (!comments || !Array.isArray(comments)) return 0;
  const agencyComments = (comments as Array<{ id: number; body?: string }>).filter((c) => (c.body || "").includes(AGENCY_MARKER));
  let deleted = 0;
  for (const c of agencyComments) {
    await gh(["api", "-X", "DELETE", `repos/${repo}/issues/comments/${c.id}`]).catch(() => {});
    deleted++;
  }
  return deleted;
}

export async function listComments(repo: string, issue: number): Promise<Array<{ body: string }>> {
  const out = await gh([
    "issue", "view", String(issue), "--repo", repo, "--json", "comments",
  ]).catch(() => '{"comments":[]}');
  const data = JSON.parse(out) as { comments?: Array<{ body: string }> };
  return data.comments ?? [];
}



export interface ThreadInspect {
  /** the agency has commented on this thread at least once. */
  agencyEverCommented: boolean;
  /** the latest comment is from a human (not the agency). */
  lastIsHuman: boolean;
  /** id of the latest comment (0 if none) — used as a per-thread cursor. */
  lastCommentId: number;
  /** body of the latest comment if it's a human's, else "". */
  lastHumanBody: string;
  /** GitHub author_association of the latest comment (OWNER/MEMBER/COLLABORATOR/…). */
  lastAuthorAssoc: string;
  /** the latest AGENCY comment has a 👍 reaction (an approval signal) — folded in from the same fetch. */
  approvedByReaction: boolean;
}

/** GitHub author_association values that may DRIVE the agency (a workspace member of the repo). */
const TRIGGER_ASSOC = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
/** True if an issue/comment author (by their GitHub author_association) is allowed to trigger runs. */
export function canTrigger(assoc: string): boolean {
  return TRIGGER_ASSOC.has((assoc || "").trim().toUpperCase());
}


/** One API call that tells us everything the router needs about a thread's comments. */
// Memoize signals per thread keyed by the issue's updatedAt: if GitHub's updatedAt hasn't advanced,
// the comment list is unchanged, so the prior result is exact — and we skip the per-thread
// `gh` subprocess entirely. This is the dominant per-scan cost on idle repos.
// ── Direct GitHub REST (no subprocess) ──────────────────────────────────────────────────────────
// The `gh` CLI forks a process (startup + keyring + TLS) per call. When a bot token is available we
// hit the REST API directly with `fetch` instead; on ANY problem (no token / non-200 / network /
// parse) we return null and the caller falls back to `gh`, so keyring-only setups and edge cases
// (pagination, etc.) keep working exactly as before. Read-only hot paths only.
function ghHeaders(): Record<string, string> | null {
  const t = ghBotToken();
  if (!t) return null;
  return { Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json", "User-Agent": "dev-agency", "X-GitHub-Api-Version": "2022-11-28" };
}
/** Single REST page → array, or null to fall back to gh. */
async function ghFetchPage(path: string): Promise<unknown[] | null> {
  const h = ghHeaders();
  if (!h) return null;
  try {
    const r = await fetch(`https://api.github.com/${path}`, { headers: h });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j : null;
  } catch { return null; }
}
/** All REST pages (follows Link rel=next, bounded) → array, or null to fall back to gh. */
async function ghFetchAll(path: string): Promise<unknown[] | null> {
  const h = ghHeaders();
  if (!h) return null;
  try {
    let url: string = `https://api.github.com/${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    const out: unknown[] = [];
    for (let i = 0; i < 20 && url; i++) {
      const r = await fetch(url, { headers: h });
      if (!r.ok) return null;
      const page = await r.json();
      if (!Array.isArray(page)) return null;
      out.push(...page);
      const m = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get("link") || "");
      url = m ? m[1] : "";
    }
    return out;
  } catch { return null; }
}

const sigCache = new Map<string, { at: string; sig: ThreadInspect }>();
export async function threadSignals(repo: string, number: number, updatedAt?: string): Promise<ThreadInspect> {
  const key = `${repo}#${number}`;
  if (updatedAt) { const c = sigCache.get(key); if (c && c.at === updatedAt) return c.sig; }
  let arr: Array<{ id: number; body: string; assoc?: string; plus?: number }> = [];
  const viaFetch = await ghFetchAll(`repos/${repo}/issues/${number}/comments`);
  if (viaFetch) {
    arr = (viaFetch as Array<{ id: number; body?: string; author_association?: string; reactions?: { "+1"?: number } }>).map((c) => ({ id: c.id, body: c.body ?? "", assoc: c.author_association, plus: c.reactions?.["+1"] }));
  } else {
    const out = await gh([
      "api", `repos/${repo}/issues/${number}/comments`, "--paginate", "--jq", '[.[]|{id,body,assoc:.author_association,plus:.reactions["+1"]}]',
    ]).catch(() => "[]");
    try { arr = JSON.parse(out); } catch { /* ignore */ }
  }
  const agencyEverCommented = arr.some((c) => c.body.includes(AGENCY_MARKER));
  const last = arr[arr.length - 1];
  const lastIsHuman = Boolean(last) && !last.body.includes(AGENCY_MARKER);
  // 👍 on the most recent AGENCY comment = an approval reaction (was a second full fetch).
  let approvedByReaction = false;
  for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].body.includes(AGENCY_MARKER)) { approvedByReaction = (arr[i].plus ?? 0) > 0; break; } }
  const sig: ThreadInspect = {
    agencyEverCommented,
    lastIsHuman,
    lastCommentId: last?.id ?? 0,
    lastHumanBody: lastIsHuman ? last.body : "",
    lastAuthorAssoc: last?.assoc ?? "",
    approvedByReaction,
  };
  if (updatedAt) sigCache.set(key, { at: updatedAt, sig });
  return sig;
}

/** A short "thanks/looks good" style comment that should NOT trigger a code change. */
const NO_OP_RE =
  /^\s*(thanks?|thank you|ty|nice|great|good( job)?|perfect|cool|awesome|love it|looks good|lgtm|done|ok|okay|👍|👌|🎉|🙏|❤️|💯)[.! ]*$/i;
export function isNoOpComment(body: string): boolean {
  return NO_OP_RE.test((body || "").trim());
}

export interface RecentThread {
  number: number;
  title: string;
  body: string;
  closed: boolean;
  comments: number;
  updatedAt: string;
}

/** Issues updated recently, ANY state, with the bits the router needs. */
export async function listRecentThreads(repo: string, limit = 60): Promise<RecentThread[]> {
  type Raw = { number: number; title: string; body: string | null; state: string; comments: number | unknown[]; updatedAt: string };
  let raw: Raw[] = [];
  // REST returns PRs in the issues list too; filter them out (they carry a pull_request field).
  const viaFetch = await ghFetchPage(`repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=${limit}`);
  if (viaFetch) {
    raw = (viaFetch as Array<Record<string, unknown>>)
      .filter((i) => !i.pull_request)
      .map((i) => ({ number: i.number as number, title: (i.title as string) ?? "", body: (i.body as string) ?? "", state: (i.state as string) ?? "open", comments: (i.comments as number) ?? 0, updatedAt: (i.updated_at as string) ?? "" }));
  } else {
    // `gh issue list` never returns PRs (the CLI separates issues from PRs), so this fallback
    // needs no pull_request filter of its own.
    const out = await gh([
      "issue", "list", "--repo", repo, "--state", "all",
      "--json", "number,title,body,state,comments,updatedAt", "--limit", String(limit),
    ]).catch(() => "[]");
    try { raw = JSON.parse(out); } catch { /* ignore */ }
  }
  return raw.map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    closed: (i.state ?? "").toUpperCase() === "CLOSED",
    // gh returns `comments` as a count (number) on most versions, an array on some.
    comments: Array.isArray(i.comments) ? i.comments.length : Number(i.comments) || 0,
    updatedAt: i.updatedAt ?? "",
  }));
}

export interface MergedPr { number: number; title: string; mergedAt: string; sha: string; url: string }

/** The most recently MERGED PRs on a repo (newest first) — powers the build-stamp tooltip so you can
 *  confirm the running build matches a specific merge. One cheap gh read. */
export async function listMergedPrs(repo: string, limit = 5): Promise<MergedPr[]> {
  const out = await gh(["pr", "list", "--repo", repo, "--state", "merged", "--json", "number,title,mergedAt,mergeCommit,url", "--limit", String(Math.max(1, limit))]).catch(() => "[]");
  try {
    const arr = JSON.parse(out) as Array<{ number: number; title: string; mergedAt?: string; mergeCommit?: { oid?: string }; url?: string }>;
    return arr.map((p) => ({ number: p.number, title: p.title || "", mergedAt: p.mergedAt || "", sha: (p.mergeCommit?.oid || "").slice(0, 7), url: p.url || "" }));
  } catch {
    return [];
  }
}

/** True only if the issue's agency PR was actually MERGED (not just closed). One cheap gh read. */
export async function prMerged(repo: string, branch: string): Promise<boolean> {
  const out = await gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", "mergedAt", "--limit", "1"]).catch(() => "[]");
  try {
    const arr = JSON.parse(out) as Array<{ mergedAt?: string | null }>;
    return Boolean(arr[0]?.mergedAt);
  } catch {
    return false;
  }
}


/** Marker on the single epic tracking comment so we update it in place instead of spamming. */
export const EPIC_MARKER = "<!-- epic-tracker -->";

/** Create-or-update the one epic tracking comment on a parent issue. */
export async function upsertTrackerComment(repo: string, parent: number, body: string): Promise<void> {
  const full = `${body}\n\n${EPIC_MARKER}\n${AGENCY_MARKER}`;
  // Robustly find the EXISTING tracker comment so we EDIT it (no email) instead of posting a new one
  // every scan (the old `--paginate --jq` returns invalid JSON on a busy epic → id stayed 0 → a fresh
  // comment each pass → hundreds of notification emails). Raw fetch + tolerant parse.
  const out = await gh(["api", `repos/${repo}/issues/${parent}/comments`, "--paginate", "-f", "per_page=100"]).catch(() => "");
  let id = 0;
  for (const c of parseGhCommentsJson(out)) {
    if ((c.body || "").includes(EPIC_MARKER)) id = c.id ?? id;
  }
  if (id) {
    await gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${id}`, "-f", `body=${full}`]).catch(() => {});
  } else {
    await gh(["api", "-X", "POST", `repos/${repo}/issues/${parent}/comments`, "-f", `body=${full}`]).catch(() => {});
  }
}

export interface ThreadComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  isAgency: boolean;
}
export interface ThreadFull {
  title: string;
  body: string;
  author: string;
  createdAt: string;
  state: string;
  comments: ThreadComment[];
}

/**
 * Normalize `gh api --paginate` output into a flat array of raw comment objects. With --paginate,
 * gh concatenates each page's JSON array as "[...][...]" (invalid as a whole), so we join them.
 * Tolerant of empty output and of an NDJSON stream (one object/array per line) as a fallback.
 */
export function parseGhCommentsJson(
  out: string,
): Array<{ id?: number; user?: { login?: string }; body?: string; created_at?: string }> {
  const s = (out || "").trim();
  if (!s) return [];
  try {
    return JSON.parse(s.replace(/\]\s*\[/g, ","));
  } catch {
    const acc: Array<{ id?: number; user?: { login?: string }; body?: string; created_at?: string }> = [];
    for (const line of s.split("\n")) {
      const l = line.trim();
      if (!l) continue;
      try {
        const v = JSON.parse(l);
        if (Array.isArray(v)) acc.push(...v);
        else acc.push(v);
      } catch {
        /* skip malformed line */
      }
    }
    return acc;
  }
}

/** The full structured conversation for the dashboard side panel (issue or PR). */
export async function getThreadFull(repo: string, number: number): Promise<ThreadFull> {
  const head = await gh([
    "api", `repos/${repo}/issues/${number}`,
    "--jq", "{title:.title, body:.body, author:.user.login, createdAt:.created_at, state:.state}",
  ]).catch(() => "{}");
  let h: { title?: string; body?: string; author?: string; createdAt?: string; state?: string } = {};
  try {
    h = JSON.parse(head);
  } catch {
    /* ignore */
  }
  // Fetch the raw comment objects (no server-side jq — that combo with --paginate proved fragile
  // and silently dropped the agency's comments). Up to 100/page, paginated, parsed robustly.
  const out = await gh([
    "api", `repos/${repo}/issues/${number}/comments`, "--paginate", "-f", "per_page=100",
  ]).catch(() => "");
  const raw = parseGhCommentsJson(out);
  const comments: ThreadComment[] = raw.map((c) => {
    const body = c.body ?? "";
    return {
      id: c.id ?? 0,
      author: c.user?.login ?? "?",
      body: body.replace(AGENCY_MARKER, "").trim(),
      createdAt: c.created_at ?? "",
      isAgency: body.includes(AGENCY_MARKER),
    };
  });
  return {
    title: h.title ?? `#${number}`,
    body: h.body ?? "",
    author: h.author ?? "?",
    createdAt: h.createdAt ?? "",
    state: h.state ?? "open",
    comments,
  };
}

/**
 * Post a comment that counts as the HUMAN speaking (no agency marker), used by the dashboard's
 * inline reply. It therefore re-engages the agency exactly like a comment typed in GitHub.
 * Works on both issues and PRs (PRs share the issues comment endpoint).
 *
 * If `asToken` is given (the owner's token), the comment is authored by THAT account — so
 * dashboard replies appear under your own name, not the bot's. Falls back to the bot token.
 */
export async function commentAsHuman(repo: string, number: number, body: string, asToken?: string): Promise<{ id?: number; created_at?: string }> {
  const args = ["api", "-X", "POST", `repos/${repo}/issues/${number}/comments`, "-f", `body=${body}`];
  const out = asToken ? await ghAs(asToken, args) : await gh(args);
  try {
    const j = JSON.parse(out);
    return { id: j?.id, created_at: j?.created_at };
  } catch {
    return {};
  }
}

/**
 * Edit an existing issue comment. Uses the owner's token first (so edits appear under your name),
 * falls back to the bot token. Pass the comment's numeric id (from getThreadFull).
 */
export async function editCommentAsHuman(repo: string, commentId: number, body: string, asToken?: string): Promise<void> {
  const args = ["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-f", `body=${body}`];
  if (asToken) await ghAs(asToken, args);
  else await gh(args);
}


/** List the repos the given token can access (owner + collaborator + org), newest first. */
export async function listUserRepos(token: string): Promise<Array<{ full_name: string; private: boolean }>> {
  const out = await ghAs(token, [
    "api", "--paginate",
    "user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
    "--jq", ".[]|{full_name,private}",
  ]).catch(() => "");
  const repos: Array<{ full_name: string; private: boolean }> = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    try {
      repos.push(JSON.parse(line));
    } catch {
      /* skip a bad line */
    }
  }
  return repos;
}

/** Read a UTF-8 file from a repo via the contents API, or null if missing. */
export async function readRepoFile(repo: string, path: string): Promise<string | null> {
  const out = await gh(["api", `repos/${repo}/contents/${path}`, "--jq", ".content"]).catch(() => "");
  if (!out) return null;
  try {
    return Buffer.from(out.replace(/\s/g, ""), "base64").toString("utf8");
  } catch {
    return null;
  }
}



/**
 * Permanently delete an issue (owner-only GraphQL mutation, so it needs the admin token).
 * Returns ok=false if no admin token or the API refuses — the caller can fall back to close.
 */
export async function deleteIssueHard(
  repo: string,
  number: number,
  adminToken?: string,
): Promise<{ ok: boolean; msg: string }> {
  if (!adminToken) return { ok: false, msg: "no admin token" };
  try {
    const nodeId = (await gh(["api", `repos/${repo}/issues/${number}`, "--jq", ".node_id"])).trim();
    if (!nodeId) return { ok: false, msg: "issue not found" };
    await ghAs(adminToken, [
      "api", "graphql", "-f",
      `query=mutation{deleteIssue(input:{issueId:"${nodeId}"}){clientMutationId}}`,
    ]);
    return { ok: true, msg: "deleted" };
  } catch (err) {
    return { ok: false, msg: (err as Error).message };
  }
}

/** The full thread as readable text, each comment tagged [human] or [agency]. */
/** Recent comment thread, capped so we don't re-feed a snowballing history to every agent every
 *  run. Reads the LOCAL conversation (the DB is the source of truth — every comment lands there
 *  first; GitHub-side comments fold in via webhook/scan), so building a prompt costs no GitHub
 *  round-trip. Older context is intentionally dropped — agents pull it back via `recall`. */
export async function commentThread(repo: string, issue: number, lastN = 8, perComment = 1500): Promise<string> {
  const comments = getConversation(repo, issue);
  const recent = comments.slice(-lastN);
  const dropped = comments.length - recent.length;
  const body = recent
    .map((c) => {
      const who = c.isAgency ? "[agency]" : "[human]";
      const text = c.body.replace(AGENCY_MARKER, "").trim().slice(0, perComment);
      return `${who} ${text}`;
    })
    .join("\n\n---\n\n");
  return dropped > 0
    ? `_(${dropped} earlier comment(s) omitted — use the recall tool if you need them)_\n\n---\n\n${body}`
    : body;
}

/** Configure git to authenticate through gh, then clone `repo` to `dest`. */
export async function cloneRepo(repo: string, dest: string, onProgress?: (percent: number, phase: string) => void): Promise<void> {
  await gh(["auth", "setup-git"]);
  // Use a raw streaming `git clone` (not `gh repo clone`) so we can parse git's own progress
  // lines ("Receiving objects: NN%") and report real progress instead of a stuck spinner.
  await new Promise<void>((resolve, reject) => {
    const token = ghBotToken();
    const env = token ? { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } : process.env;
    const url = `https://github.com/${repo}.git`;
    const p = spawn("git", ["clone", "--progress", "--depth", "50", url, dest], { env });
    let stderr = "";
    // Emit only when the mapped percentage CHANGES — git repeats the same percentage across many
    // progress lines (especially "Resolving deltas"), which flooded the live stream with
    // identical "95%" events.
    let lastPct = -1;
    const send = (pct: number, phase: string): void => {
      const rounded = Math.round(pct);
      if (rounded === lastPct) return;
      lastPct = rounded;
      onProgress?.(rounded, phase);
    };
    const emit = (line: string) => {
      if (!onProgress) return;
      // git progress lines, e.g.: "Receiving objects:  42% (d/n)" or "Resolving deltas: 80%"
      let m = line.match(/Receiving objects:\s+(\d+)%/);
      if (m) { send(Math.min(95, Number(m[1])), "cloning"); return; }
      m = line.match(/Resolving deltas:\s+(\d+)%/);
      if (m) { send(95, "resolving"); return; }
      m = line.match(/Compressing objects:\s+(\d+)%/);
      if (m) { send(Math.min(20, Number(m[1]) / 5), "compressing"); return; }
      m = line.match(/Counting objects:\s+(\d+)%/);
      if (m) { send(Math.min(5, Number(m[1]) / 20), "counting"); return; }
    };
    p.stderr.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      stderr += s;
      // Progress lines are \r-separated within a single line; split on both so we catch each.
      for (const line of s.split(/[\r\n]/)) if (line.trim()) emit(line);
    });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) { if (onProgress) onProgress(100, "cloned"); resolve(); }
      else {
        const tail = stderr.trim().slice(-300);
        // GitHub returns 404/"Repository not found" for a repo that doesn't exist OR a private repo
        // the token can't see. Surface that distinctly so the run failure points at access, not git.
        const msg = /not found|404|401|403/i.test(tail)
          ? `couldn't clone ${repo} — the agency's GitHub token has no access (is the repo private? invite the bot as a collaborator) or the repo doesn't exist`
          : `git clone exited ${code}: ${tail}`;
        reject(new Error(msg));
      }
    });
  });
  // Safety net for the deterministic `git add -A` finalize: never sweep generated dirs even if
  // the repo lacks a .gitignore for them.
  try {
    appendFileSync(
      join(dest, ".git", "info", "exclude"),
      "\nnode_modules/\ndist/\nbuild/\n.next/\nout/\ncoverage/\n.gnhome/\n.gitnexus/\n",
    );
  } catch {
    /* non-fatal */
  }
  // Save GitHub Actions minutes on watched product repos: our tester runs the same checks
  // in-container, so CI on agency branch commits is redundant. A commit-msg hook appends [skip ci]
  // to every commit the agents make (push + PR runs are skipped); the squash-merge to main still
  // runs CI via the PR title. Opt out with SKIP_CI=false.
  //
  // NEVER tag the agency's OWN repo: it has no GitHub Actions, so the tag skips nothing — and it
  // would leak from the branch commits into the squash-merge commit on `main`, where Coolify honors
  // [skip ci]/[ci skip] and would SKIP the webhook auto-deploy. That's exactly why self-merges never
  // redeployed. Exempting the agency repo lets the existing Coolify GitHub-webhook autodeploy ship
  // self-merges the same way it ships human merges — no API token needed.
  if (skipCiEnabledFor(repo)) {
    try {
      const hook = join(dest, ".git", "hooks", "commit-msg");
      const script =
        "#!/bin/sh\n" +
        "# dev-agency: skip redundant GitHub Actions CI on agency commits (tester runs in-container).\n" +
        'if ! grep -qiE "\\[(skip ci|ci skip)\\]" "$1"; then printf "\\n[skip ci]\\n" >> "$1"; fi\n';
      writeFileSync(hook, script, { mode: 0o755 });
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * Bring `dest` to a fresh, up-to-date checkout of the repo's default branch. Reuses an existing
 * clone when present (fetch + hard reset + clean — seconds instead of a full clone, and ignored
 * artifacts like node_modules survive for the tester); clones from scratch only the first time or
 * when the reuse fails. Returns true when the existing clone was reused.
 */
export async function syncRepo(repo: string, dest: string, onProgress?: (percent: number, phase: string) => void): Promise<boolean> {
  if (existsSync(join(dest, ".git"))) {
    try {
      await gh(["auth", "setup-git"]); // keep git's credential helper current (token rotation)
      onProgress?.(10, "fetching");
      await runGit(dest, ["fetch", "--depth", "50", "origin"]);
      onProgress?.(70, "fetching");
      // origin/HEAD is set by the original clone; re-resolve it if it's ever missing.
      let head = await runGit(dest, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).catch(() => "");
      if (!head) {
        await runGit(dest, ["remote", "set-head", "origin", "--auto"]);
        head = await runGit(dest, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
      }
      await runGit(dest, ["checkout", "-f", head.replace(/^origin\//, "")]);
      await runGit(dest, ["reset", "--hard", head]);
      await runGit(dest, ["clean", "-fd"]); // drop untracked leftovers; ignored files (node_modules, dist) stay
      onProgress?.(100, "cloned");
      return true;
    } catch (err) {
      console.warn(`[agency] workdir reuse failed for ${repo} — recloning (${(err as Error).message.slice(0, 140)})`);
    }
  }
  await rm(dest, { recursive: true, force: true });
  await cloneRepo(repo, dest, onProgress);
  return false;
}




/** Mark the issue's PR ready (if draft) and squash-merge it. */
export async function mergePrForBranch(
  repo: string,
  branch: string,
): Promise<{ ok: boolean; msg: string; files?: Array<{ path: string; additions?: number; deletions?: number }> }> {
  const pr = await findPrForBranch(repo, branch);
  if (!pr) return { ok: false, msg: "no open PR for this issue" };
  // Capture the change set BEFORE merging (the branch is deleted on merge) for the change journal.
  let files: Array<{ path: string; additions?: number; deletions?: number }> | undefined;
  try {
    const out = await gh(["pr", "view", String(pr.number), "--repo", repo, "--json", "files"]);
    const d = JSON.parse(out) as { files?: Array<{ path: string; additions?: number; deletions?: number }> };
    files = d.files;
  } catch { /* best effort — journal still records the merge with an empty footprint */ }
  try {
    if (pr.isDraft) await gh(["pr", "ready", String(pr.number), "--repo", repo]).catch(() => {});
    await gh(["pr", "merge", String(pr.number), "--repo", repo, "--squash", "--delete-branch"]);
    return { ok: true, msg: pr.url, files };
  } catch (err) {
    return { ok: false, msg: (err as Error).message };
  }
}

/**
 * Create a new GitHub repo and return its canonical full name + URL. A bare `name` creates under the
 * connected account; `owner/name` under that owner (needs perms there). `--add-readme` gives it an
 * initial commit + default branch so the agency can clone and index it right away — a truly empty
 * repo has no default branch and can't be cloned. Uses the connected OAuth/bot token (needs `repo`
 * scope). Throws (with gh's stderr) if the name is taken or the token lacks permission.
 */
export async function createRepo(
  name: string,
  opts: { private?: boolean; description?: string } = {},
): Promise<{ full_name: string; url: string }> {
  const args = ["repo", "create", name, opts.private === false ? "--public" : "--private", "--add-readme"];
  if (opts.description?.trim()) args.push("--description", opts.description.trim());
  await gh(args); // prints the new repo's URL; non-zero exit (name taken / no perms) surfaces to caller
  // Resolve canonical owner/name + URL — a bare name resolves against the connected account.
  const view = await gh(["repo", "view", name, "--json", "nameWithOwner,url"]);
  const j = JSON.parse(view) as { nameWithOwner: string; url: string };
  return { full_name: j.nameWithOwner, url: j.url };
}

/** Create a new issue (used by the planner to decompose work into sub-issues). */
export async function createIssue(
  repo: string,
  title: string,
  body: string,
  asToken?: string,
): Promise<{ number: number; url: string }> {
  const args = ["issue", "create", "--repo", repo, "--title", title, "--body", body];
  // asToken (owner token) makes you the author; else the bot creates it.
  const out = asToken ? await ghAs(asToken, args) : await gh(args);
  const url = out.trim().split("\n").pop() ?? "";
  const m = /\/issues\/(\d+)/.exec(url);
  return { number: m ? Number(m[1]) : 0, url };
}

/** Open PRs whose head is an agency branch (agency/issue-N). */
export async function listAgencyPrs(
  repo: string,
): Promise<Array<{ number: number; title: string; branch: string; issueNumber: number }>> {
  const out = await gh([
    "pr", "list", "--repo", repo, "--state", "open", "--json", "number,title,headRefName", "--limit", "50",
  ]).catch(() => "[]");
  const arr = JSON.parse(out) as Array<{ number: number; title: string; headRefName: string }>;
  return arr
    .filter((p) => /^agency\/issue-\d+$/.test(p.headRefName))
    .map((p) => ({
      number: p.number,
      title: p.title,
      branch: p.headRefName,
      issueNumber: Number(p.headRefName.split("-").pop()),
    }));
}

/** Health of an agency PR: merge conflicts and CI checks. */
export async function prHealth(
  repo: string,
  pr: number,
): Promise<{ status: "ok" | "pending" | "failing" | "conflict"; detail: string }> {
  const out = await gh([
    "pr", "view", String(pr), "--repo", repo, "--json", "mergeable,statusCheckRollup",
  ]).catch(() => "");
  if (!out) return { status: "ok", detail: "" };
  let d: { mergeable?: string; statusCheckRollup?: Array<{ status?: string; conclusion?: string; state?: string }> } = {};
  try {
    d = JSON.parse(out);
  } catch {
    return { status: "ok", detail: "" };
  }
  if (d.mergeable === "CONFLICTING") return { status: "conflict", detail: "merge conflicts with the base branch" };

  const checks = d.statusCheckRollup ?? [];
  if (checks.length > 0) {
    const pending = checks.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING");
    if (pending) return { status: "pending", detail: "checks running" };
    const failing = checks.some(
      (c) =>
        ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(c.conclusion ?? "") ||
        c.state === "FAILURE" ||
        c.state === "ERROR",
    );
    if (failing) return { status: "failing", detail: "CI checks failing" };
  }
  return { status: "ok", detail: "" };
}


/** Comment on a PR (issue-comment endpoint works, but gh pr comment is clearer). */
export async function commentOnPr(repo: string, pr: number, body: string): Promise<void> {
  await gh(["pr", "comment", String(pr), "--repo", repo, "--body", `${body}\n\n${AGENCY_MARKER}`]).catch(() => {});
}

export async function closeIssue(repo: string, issue: number, comment?: string, reason?: "completed" | "not planned"): Promise<void> {
  if (comment) await commentOnIssue(repo, issue, comment);
  const args = ["issue", "close", String(issue), "--repo", repo];
  if (reason) args.push("--reason", reason);
  await gh(args).catch(() => {});
}

/** Fetch a single issue (any state) as an Issue, or null if it can't be read — or if the number
 *  is actually a PR. `gh issue view` resolves PR numbers too (GitHub's API treats PRs as issues),
 *  and this is the funnel every force* dispatch reads through, so rejecting PRs here keeps
 *  Play/Resume/Approve from ever running the pipeline on a PR-numbered card (#150). */
export async function getIssue(repo: string, number: number): Promise<Issue | null> {
  const out = await gh([
    "issue", "view", String(number), "--repo", repo, "--json", "number,title,body,url",
  ]).catch(() => "");
  if (!out) return null;
  try {
    const i = JSON.parse(out) as { number: number; title: string; body: string | null; url?: string };
    if (typeof i.url === "string" && i.url.includes("/pull/")) return null; // a PR, not an issue
    return { number: i.number, title: i.title, body: i.body ?? "" };
  } catch {
    return null;
  }
}

/** All open issues in a repo (used to scan for control commands). */
export async function listAllOpenIssues(repo: string): Promise<Issue[]> {
  const out = await gh([
    "issue", "list", "--repo", repo, "--state", "open",
    "--json", "number,title,body", "--limit", "50",
  ]).catch(() => "[]");
  const raw = JSON.parse(out) as Array<{
    number: number; title: string; body: string | null;
  }>;
  return raw.map((i) => ({
    number: i.number, title: i.title, body: i.body ?? "",
  }));
}

export async function repoExists(repo: string, token?: string): Promise<boolean> {
  try {
    const args = ["repo", "view", repo, "--json", "name"];
    if (token) await ghAs(token, args);
    else await gh(args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a GitHub "issues" webhook pointing at `url` exists on `repo` (idempotent).
 * Lets the agency register its own hooks so webhook mode needs no manual GitHub setup.
 */
export async function ensureWebhook(
  repo: string,
  url: string,
  secret: string,
  token?: string,
): Promise<"created" | "exists" | "failed"> {
  // Registering webhooks needs repo admin, so use the owner/admin token when provided.
  const run = (args: string[]) => (token ? ghAs(token, args) : gh(args));
  // issues/comments for pins+replies; check_suite/workflow_run for CI results; pull_request +
  // push so PR updates and base-branch changes (conflicts) are reacted to instantly.
  const wantEvents = ["issues", "issue_comment", "check_suite", "workflow_run", "pull_request", "push"];
  try {
    const json = await run(["api", `repos/${repo}/hooks`]).catch(() => "[]");
    const hooks = JSON.parse(json) as Array<{ id: number; config?: { url?: string }; events?: string[] }>;
    const existing = hooks.find((h) => h.config?.url === url);

    if (existing) {
      // Make sure it listens for the events we need (older hooks only had "issues").
      if (wantEvents.some((e) => !existing.events?.includes(e))) {
        const tmp = join(tmpdir(), `agency-hook-${Date.now()}.json`);
        writeFileSync(tmp, JSON.stringify({ events: wantEvents }));
        await run(["api", `repos/${repo}/hooks/${existing.id}`, "-X", "PATCH", "--input", tmp]).catch(() => {});
      }
      return "exists";
    }

    const tmp = join(tmpdir(), `agency-hook-${Date.now()}.json`);
    writeFileSync(
      tmp,
      JSON.stringify({
        name: "web",
        active: true,
        events: wantEvents,
        config: { url, content_type: "json", secret, insecure_ssl: "0" },
      }),
    );
    await run(["api", `repos/${repo}/hooks`, "-X", "POST", "--input", tmp]);
    return "created";
  } catch {
    return "failed";
  }
}

/**
 * Ensure the bot account (owner of `botToken`) is a collaborator on `repo`. The `adminToken`
 * (repo owner) sends the invite; the bot token accepts it. Idempotent.
 */
export async function ensureCollaborator(
  repo: string,
  adminToken: string,
  botToken: string,
): Promise<"added" | "already" | "failed"> {
  try {
    const botLogin = (await ghAs(botToken, ["api", "user", "--jq", ".login"])).trim();
    if (!botLogin) return "failed";

    // Owner invites the bot (201 = invited, 204 = already a collaborator).
    await ghAs(adminToken, [
      "api", "-X", "PUT", `repos/${repo}/collaborators/${botLogin}`, "-f", "permission=push",
    ]);

    // Bot accepts any pending invitation for this repo.
    const ids = (
      await ghAs(botToken, [
        "api", "/user/repository_invitations",
        "--jq", `.[] | select(.repository.full_name=="${repo}") | .id`,
      ]).catch(() => "")
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of ids) {
      await ghAs(botToken, ["api", "-X", "PATCH", `/user/repository_invitations/${id}`]).catch(() => {});
    }
    return ids.length > 0 ? "added" : "already";
  } catch {
    return "failed";
  }
}

export interface PullRequest {
  number: number;
  url: string;
  isDraft: boolean;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  // git push/fetch authenticate via gh's credential helper, which reads GH_TOKEN — inject the
  // resolved bot token so pushes work even when it isn't in the container env (dashboard creds).
  const token = ghBotToken();
  const env = token ? { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } : process.env;
  const { stdout } = await execFileAsync("git", args, { cwd, env, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/** Like runGit but never throws — returns the exit code + output so we can branch on git failures
 *  (e.g. a `git merge` that exits 1 on conflicts is an expected outcome, not an error). */
async function runGitCode(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const token = ghBotToken();
  const env = token ? { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } : process.env;
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
        stdout: (stdout || "").toString().trim(),
        stderr: (stderr || "").toString().trim(),
      });
    });
  });
}

export interface BaseMergeResult {
  status: "clean" | "conflicts" | "error";
  files: string[];
}

/**
 * Deterministically merge the base branch (default "main") into the PR branch already checked out
 * in `workdir`, to clear merge conflicts before we mark a PR mergeable. We do this in code rather
 * than hoping the agent runs the right git commands: a clean auto-merge needs no agent at all, and
 * only genuine content conflicts get handed off — with the exact file list. The shallow clone is
 * deepened first so a merge base exists (a `--depth 50` clone often can't merge `origin/main`).
 * On conflicts the working tree is LEFT in the conflicted state for the caller's agent to resolve;
 * `ensureBranchPushed` then completes the merge commit and pushes.
 */
export async function mergeBaseInto(workdir: string, base?: string): Promise<BaseMergeResult> {
  try {
    // Default to the clone's REAL default branch (origin/HEAD), not a hardcoded "main" — repos whose
    // default differs would otherwise fetch/merge a non-existent origin/main and error.
    if (!base) {
      const head = (await runGit(workdir, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).catch(() => "origin/main")).trim();
      base = head.replace(/^origin\//, "") || "main";
    }
    // Deepen history so a merge base exists.
    await runGitCode(workdir, ["fetch", "--unshallow", "origin"]); // no-op once the clone is complete
    // CRITICAL: force-update the remote-tracking ref. A plain `git fetch origin main` only updates
    // FETCH_HEAD, not refs/remotes/origin/main, so a later `git merge origin/main` can merge a STALE
    // main → reports "Already up to date / clean" while GitHub still sees the PR as conflicting →
    // the Fix flow loops forever, burning tokens. An explicit destination refspec fixes this.
    await runGitCode(workdir, ["fetch", "-f", "origin", `${base}:refs/remotes/origin/${base}`]);
    // Always grab the freshest base into FETCH_HEAD and MERGE THAT — never the (possibly stale)
    // tracking ref. Merging a stale `origin/main` is what made the agent report "clean" while GitHub
    // still saw the PR as conflicting, looping the Fix flow forever.
    const fh = await runGitCode(workdir, ["fetch", "origin", base]);
    const target = fh.code === 0 ? "FETCH_HEAD" : `origin/${base}`;
    await runGitCode(workdir, ["merge", "--abort"]); // clear any half-finished merge from a prior try
    await runGitCode(workdir, ["config", "user.email", "bot@dev-agency.local"]);
    await runGitCode(workdir, ["config", "user.name", "dev-agency-bot"]);
    const m = await runGitCode(workdir, ["merge", target, "--no-edit"]);
    if (m.code === 0) return { status: "clean", files: [] };
    const un = await runGitCode(workdir, ["diff", "--name-only", "--diff-filter=U"]);
    const files = un.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (files.length) return { status: "conflicts", files };
    // merge failed for a non-conflict reason (e.g. unrelated histories / fetch failure)
    return { status: "error", files: [] };
  } catch {
    return { status: "error", files: [] };
  }
}

/** Local HEAD sha of a checkout — lets the orchestrator tell whether an agent actually committed. */
export async function localHeadSha(workdir: string): Promise<string> {
  return runGit(workdir, ["rev-parse", "HEAD"]).catch(() => "");
}
/** True if the working tree has staged/unstaged changes (agent edited but didn't commit). */
export async function workdirDirty(workdir: string): Promise<boolean> {
  const s = await runGit(workdir, ["status", "--porcelain"]).catch(() => "");
  return s.trim().length > 0;
}
/** Number of files touched vs. `base` (the repo's real base branch — pass `repoBaseBranch(repo)`,
 *  never hardcode "main") — a cheap proxy for "how big is this diff", used (conservatively) by the
 *  orchestrator's P3 model-hint downshift signal. Returns undefined (NOT 0) on any git error (unknown
 *  ref, no merge base, …) — decideNext()'s contract is "unknown diff size never downshifts", and a
 *  bogus 0 would look identical to a genuinely empty, safe-to-downshift diff. */
export async function changedFileCount(workdir: string, base: string): Promise<number | undefined> {
  try {
    const out = await runGit(workdir, ["diff", "--name-only", `${base}...HEAD`]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean).length;
  } catch {
    return undefined;
  }
}

/** Current head commit SHA of a branch (cheap API read). Used to cache conflict probes per-SHA. */
export async function branchHeadSha(repo: string, branch: string): Promise<string> {
  const out = await gh(["api", `repos/${repo}/commits/${encodeURIComponent(branch)}`, "-q", ".sha"]).catch(() => "");
  return out.trim();
}

// One reusable clone per repo for non-destructive conflict probes (kept warm, just re-fetched).
const conflictProbeDirs = new Map<string, string>();

/**
 * Best-effort list of the files that conflict when merging `base` into a PR `branch`, computed
 * WITHOUT mutating the PR: we merge in a throwaway probe checkout and immediately abort. GitHub's
 * API only exposes a mergeable boolean (not which files), so we derive the file list locally and
 * cache a warm clone per repo. Returns [] if it can't be determined (network/history issues) — the
 * UI still shows the conflict box, just without per-file detail.
 */
export async function conflictFiles(repo: string, branch: string, base?: string): Promise<string[]> {
  return (await mergeProbe(repo, branch, base)).files;
}

/**
 * Probe the FRESH remote state for a real branch→base merge (the same check GitHub runs). Returns
 * `ok:false` when the probe couldn't run (network/history) — callers must NOT treat that as "clean".
 * Used both to list conflicting files AND to verify a conflict is genuinely resolved on the REMOTE
 * (the local workdir or GitHub's cached `mergeable` flag both lie right after a push).
 */
export async function mergeProbe(repo: string, branch: string, base?: string): Promise<{ ok: boolean; files: string[] }> {
  try {
    const baseB = base || await repoBaseBranch(repo);
    let dir = conflictProbeDirs.get(repo);
    if (!dir || !existsSync(join(dir, ".git"))) {
      dir = join(tmpdir(), "agency-conflict-" + repo.replace(/[^a-z0-9]+/gi, "_"));
      await rm(dir, { recursive: true, force: true });
      await cloneRepo(repo, dir);
      conflictProbeDirs.set(repo, dir);
    }
    await runGitCode(dir, ["config", "user.email", "bot@dev-agency.local"]);
    await runGitCode(dir, ["config", "user.name", "dev-agency-bot"]);
    await runGitCode(dir, ["merge", "--abort"]); // clear any aborted probe state
    await runGitCode(dir, ["fetch", "--unshallow", "origin"]);
    // Force-update BOTH tracking refs (plain fetch only moves FETCH_HEAD → stale checkout/merge → []).
    const f = await runGitCode(dir, ["fetch", "-f", "origin", `${baseB}:refs/remotes/origin/${baseB}`, `${branch}:refs/remotes/origin/${branch}`]);
    if (f.code !== 0) return { ok: false, files: [] };
    const co = await runGitCode(dir, ["checkout", "-f", "-B", "_conflict_probe", `origin/${branch}`]);
    if (co.code !== 0) return { ok: false, files: [] };
    const m = await runGitCode(dir, ["merge", "--no-commit", "--no-ff", `origin/${baseB}`]);
    let files: string[] = [];
    if (m.code !== 0) {
      const un = await runGitCode(dir, ["diff", "--name-only", "--diff-filter=U"]);
      files = un.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    }
    await runGitCode(dir, ["merge", "--abort"]);
    return { ok: true, files };
  } catch {
    return { ok: false, files: [] };
  }
}

/**
 * Deterministically make sure the agency branch holds ALL the work and is pushed — so a run
 * that did the work but never got to `git push` (looped / was interrupted) still lands its
 * code. Returns true if the branch has commits beyond main.
 */
export async function ensureBranchPushed(workdir: string, branch: string): Promise<boolean> {
  try {
    const cur = await runGit(workdir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
    if (cur !== branch) {
      // CRITICAL: get the EXISTING remote branch first (it may already hold pushed work from a
      // prior run). `checkout -B` alone would reset the branch to the current HEAD (base), throwing
      // that work away and making us report "no commits" → needs-attention even though the fix is
      // already on origin/<branch>. Fetch + checkout the remote branch when it exists.
      await runGit(workdir, ["fetch", "origin", branch]).catch(() => {});
      const got = await runGit(workdir, ["checkout", branch]).then(() => true).catch(() => false);
      if (!got) {
        const fromRemote = await runGit(workdir, ["checkout", "-B", branch, `origin/${branch}`]).then(() => true).catch(() => false);
        if (!fromRemote) await runGit(workdir, ["checkout", "-B", branch]).catch(() => {}); // brand-new branch
      }
    }
    await runGit(workdir, ["add", "-A"]).catch(() => {});
    const staged = await runGit(workdir, ["diff", "--cached", "--name-only"]).catch(() => "");
    if (staged.trim()) {
      await runGit(workdir, ["commit", "-m", "agency: finalize work"]).catch(() => {});
    }
    await runGit(workdir, ["push", "-u", "origin", branch]).catch(() => {});
    // Count commits ahead of the repo's REAL default branch (origin/HEAD), not a hardcoded
    // origin/main — repos whose default isn't "main" have no origin/main, which made this return 0
    // and wrongly report "no commits" → needs-attention even when the work was pushed.
    const baseRef = (await runGit(workdir, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).catch(() => "")).trim();
    let ahead: string;
    if (!baseRef || baseRef === `origin/${branch}` || baseRef.replace(/^origin\//, "") === branch) {
      // No DISTINCT base: an empty repo whose default GitHub branch IS this agency branch (origin/HEAD
      // resolves to the branch itself). `base..branch` would be empty → "no commits" even though the
      // branch holds all the work. Count every commit on the branch instead so finalize opens a PR.
      ahead = await runGit(workdir, ["rev-list", "--count", branch]).catch(() => "0");
    } else {
      ahead = await runGit(workdir, ["rev-list", "--count", `${baseRef}..${branch}`]).catch(() => "0");
    }
    return Number(ahead) > 0;
  } catch {
    return false;
  }
}

/** Deterministically put the workdir on an existing remote branch (for Fix/resume on a PR). */
export async function fetchCheckout(workdir: string, branch: string): Promise<void> {
  // Force-update the tracking ref and RESET the local branch to it. A plain `git checkout <branch>`
  // in a reused workdir switches to a STALE local branch (behind origin), so the conflict-resolution
  // merge then runs against the wrong tree and reports "clean" while GitHub still conflicts.
  await runGit(workdir, ["fetch", "-f", "origin", `${branch}:refs/remotes/origin/${branch}`]).catch(() => {});
  const ok = await runGit(workdir, ["checkout", "-f", "-B", branch, `origin/${branch}`]).then(() => true).catch(() => false);
  if (!ok) await runGit(workdir, ["checkout", branch]).catch(() => {}); // brand-new local branch
}

// ── Per-repo branch model ────────────────────────────────────────────────────────────────────
// Two named branches per repo, both user-settable (Settings → Repositories), both defaulting to the
// repo's real GitHub default branch so an unconfigured repo behaves exactly as before:
//   • PRODUCTION — the released/live branch. `promoteStagingToProduction` merges staging into it.
//   • STAGING    — the integration branch agents open PRs against (dev happens against a live env).
// Agent PRs, conflict probes and the merge-base ALL target STAGING via `repoBaseBranch` (kept as the
// name every base call site already uses). When staging === production (the default), that is just
// the old single-branch behavior. Legacy `repo_base.<repo>` still works — folded into staging.
const repoDefaultCache = new Map<string, string>();
async function detectDefaultBranch(repo: string): Promise<string> {
  const cached = repoDefaultCache.get(repo);
  if (cached) return cached;
  let base = "main";
  try {
    const out = await gh(["repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]);
    const detected = out.trim();
    // NEVER treat an agency work branch as the default. A repo pushed while empty adopts the FIRST
    // pushed branch as its GitHub default — which for us is `agency/issue-N`. Using it as base means
    // base == head, and `gh pr create` is rejected. Fall back to "main"; ensureBaseExists() makes it.
    if (detected && !/^agency\//.test(detected)) base = detected;
  } catch { /* offline / no gh — fall back to main */ }
  repoDefaultCache.set(repo, base);
  return base;
}

/** The repo's PRODUCTION (released) branch: `repo_production.<repo>` override, else the GitHub default. */
export async function repoProductionBranch(repo: string): Promise<string> {
  const override = (getSetting(`repo_production.${repo}`) || "").trim();
  if (override) return override;
  return detectDefaultBranch(repo);
}

/** The repo's STAGING (integration) branch: `repo_staging.<repo>` (or legacy `repo_base.<repo>`)
 *  override, else = production. This is what agents open PRs against. */
export async function repoStagingBranch(repo: string): Promise<string> {
  const override = (getSetting(`repo_staging.${repo}`) || getSetting(`repo_base.${repo}`) || "").trim();
  if (override) return override;
  return repoProductionBranch(repo);
}

/** The base for agent PRs / conflict probes / merge-base = the STAGING branch. Single source of truth;
 *  every existing base call site funnels through here, so pointing it at staging is all it takes. */
export async function repoBaseBranch(repo: string): Promise<string> {
  return repoStagingBranch(repo);
}

/** Does branch `name` exist on the remote? One cheap API read. */
export async function remoteBranchExists(repo: string, name: string): Promise<boolean> {
  const out = await gh(["api", `repos/${repo}/branches/${encodeURIComponent(name)}`, "-q", ".name"]).catch(() => "");
  return out.trim() === name;
}

/** SHA of a branch's ROOT (oldest) commit, via the API — the commits list is newest-first, so the
 * last page's last entry is the root. Returns "" if it can't be determined. */
async function rootCommitSha(repo: string, branch: string): Promise<string> {
  const out = await gh([
    "api", "--paginate", "-X", "GET", `repos/${repo}/commits`,
    "-f", `sha=${branch}`, "-f", "per_page=100", "-q", ".[].sha",
  ]).catch(() => "");
  const shas = out.trim().split("\n").filter(Boolean);
  return shas.length ? shas[shas.length - 1] : "";
}

/**
 * Make sure `base` exists on the remote so a PR can target it. For a normal repo it already does and
 * this is a single cheap read. For a repo that was pushed while empty (its only branch is the agency
 * head branch, which GitHub made the default), we create `base` from the head branch's ROOT commit
 * and point the repo default at it — all via the API, so this works from finalize AND the dashboard
 * "Create PR" (neither needs a workdir). Returns true if `base` now exists and differs from `head`.
 * (Prevention for NEW repos is createRepo's `--add-readme`; this recovers repos created without it.)
 */
async function ensureBaseExists(repo: string, base: string, head: string): Promise<boolean> {
  if (base === head) return false; // nothing to target — caller must not open a PR against itself
  if (await remoteBranchExists(repo, base)) return true;
  const root = await rootCommitSha(repo, head);
  if (!root) return false;
  const made = await gh([
    "api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${base}`, "-f", `sha=${root}`,
  ]).then(() => true).catch(() => false);
  if (!made && !(await remoteBranchExists(repo, base))) return false; // create failed and still absent
  await gh(["api", "-X", "PATCH", `repos/${repo}`, "-f", `default_branch=${base}`]).catch(() => {});
  repoDefaultCache.set(repo, base);
  console.log(`[agency] ${repo}: created missing base branch '${base}' (repo had no default besides '${head}')`);
  return true;
}

/**
 * Make sure the STAGING branch exists so agent PRs can target it. When staging differs from
 * production (a real staging setup) and is missing, branch it off PRODUCTION's current tip — so
 * staging starts as a copy of the released code, NOT off an agency work branch, and the repo default
 * is left untouched. Returns the resolved staging branch name.
 */
async function ensureStagingBranch(repo: string): Promise<string> {
  const staging = await repoStagingBranch(repo);
  const prod = await repoProductionBranch(repo);
  if (staging === prod) return staging;                       // no distinct staging → old behavior
  if (await remoteBranchExists(repo, staging)) return staging;
  const prodSha = (await gh(["api", `repos/${repo}/git/ref/heads/${encodeURIComponent(prod)}`, "-q", ".object.sha"]).catch(() => "")).trim();
  if (prodSha) {
    const made = await gh(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${staging}`, "-f", `sha=${prodSha}`]).then(() => true).catch(() => false);
    if (made) console.log(`[agency] ${repo}: created staging branch '${staging}' from '${prod}'`);
  }
  return staging;
}

/** Open a draft PR for the branch if none exists; returns the PR (or null). */
export async function ensureDraftPr(repo: string, issue: number, branch: string, title: string): Promise<PullRequest | null> {
  const existing = await findPrForBranch(repo, branch);
  if (existing) return existing;
  const base = await ensureStagingBranch(repo); // resolve + create staging (off production) if needed
  if (!(await ensureBaseExists(repo, base, branch))) {
    console.warn(`[agency] ${repo} #${issue}: cannot open PR — base '${base}' is missing/equal to head '${branch}'`);
    return null;
  }
  await gh([
    "pr", "create", "--repo", repo, "--draft", "--base", base, "--head", branch,
    "--title", title || `Work for #${issue}`, "--body", `Closes #${issue}`,
  ]).catch((e) => {
    // Don't swallow silently — a swallowed failure here is exactly what made approved issues park as
    // "no commits". Log it so finalize's "PR couldn't open" branch is diagnosable.
    console.warn(`[agency] ${repo} #${issue}: gh pr create failed — ${String((e as Error)?.message || e).slice(0, 200)}`);
  });
  return findPrForBranch(repo, branch);
}

/** Find an OPEN PR with this exact head→base pair (promote flow — findPrForBranch filters head only). */
async function findOpenPr(repo: string, head: string, base: string): Promise<PullRequest | null> {
  const out = await gh([
    "pr", "list", "--repo", repo, "--head", head, "--base", base, "--state", "open",
    "--json", "number,url,isDraft", "--limit", "1",
  ]).catch(() => "[]");
  const raw = JSON.parse(out) as Array<{ number: number; url: string; isDraft: boolean }>;
  return raw.length ? raw[0] : null;
}

/**
 * Promote: open (or reuse) a PR from STAGING → PRODUCTION and merge it as a MERGE COMMIT — history
 * preserved, staging branch kept alive (never squashed/deleted, unlike an issue PR). Deterministic,
 * no agent/tokens. Returns the PR url on success. No-op with a clear message when staging === prod or
 * there's nothing to promote.
 */
export async function promoteStagingToProduction(repo: string): Promise<{ ok: boolean; url?: string; msg?: string }> {
  const staging = await repoStagingBranch(repo);
  const prod = await repoProductionBranch(repo);
  if (staging === prod) {
    return { ok: false, msg: `Staging and production are the same branch ('${prod}'). Set a distinct staging branch in Settings → Repositories first.` };
  }
  if (!(await remoteBranchExists(repo, staging))) {
    return { ok: false, msg: `Staging branch '${staging}' doesn't exist yet — merge some work first.` };
  }
  await ensureBaseExists(repo, prod, staging); // create production if it somehow doesn't exist yet
  let pr = await findOpenPr(repo, staging, prod);
  if (!pr) {
    await gh([
      "pr", "create", "--repo", repo, "--base", prod, "--head", staging,
      "--title", `Promote ${staging} → ${prod}`,
      "--body", `Promote **${staging}** into **${prod}** (from the dev-agency dashboard).`,
    ]).catch((e) => {
      console.warn(`[agency] ${repo}: promote pr create failed — ${String((e as Error)?.message || e).slice(0, 200)}`);
    });
    pr = await findOpenPr(repo, staging, prod);
  }
  if (!pr) {
    return { ok: false, msg: `Nothing to promote — '${staging}' has no commits ahead of '${prod}' (already up to date).` };
  }
  const merged = await gh(["pr", "merge", String(pr.number), "--repo", repo, "--merge"]).then(() => true).catch((e) => {
    console.warn(`[agency] ${repo}: promote merge failed — ${String((e as Error)?.message || e).slice(0, 200)}`);
    return false;
  });
  if (!merged) return { ok: false, url: pr.url, msg: `Opened promote PR ${pr.url} but the merge failed (conflicts or checks). Resolve it on GitHub.` };
  console.log(`[agency] ${repo}: promoted ${staging} → ${prod} via ${pr.url}`);
  return { ok: true, url: pr.url };
}

/** Parse `gh api repos/<repo> -q .permissions.push`'s raw stdout into a boolean. Exported for tests. */
export function parsePushPermission(raw: string): boolean {
  return (raw || "").trim().toLowerCase() === "true";
}

/**
 * Pure routing decision, separated from the actual `gh api` permission check so it's unit-testable
 * without a network call: direct-push is the fast path ONLY when we actually have push access on
 * the upstream repo (true for the agency's own repo, or a repo the bot happens to collaborate on);
 * a typical fork's bot token has none there, so the fork-based flow is the realistic default.
 * Exported for tests.
 */
export function chooseContribRoute(hasDirectPushAccess: boolean): "direct" | "fork" {
  return hasDirectPushAccess ? "direct" : "fork";
}

/** Whether the bot's token can push straight to `repo` (checked, not assumed). */
async function hasDirectPushAccess(repo: string): Promise<boolean> {
  try {
    const out = await gh(["api", `repos/${repo}`, "-q", ".permissions.push"]);
    return parsePushPermission(out);
  } catch {
    return false; // couldn't even read permissions → definitely can't push directly
  }
}

/**
 * Idempotently fork `upstreamRepo` into the bot's own account and bring the fork's default branch
 * in sync with upstream (best-effort — an out-of-date fork would otherwise base the new branch off
 * stale content). Returns the fork owner's login, or null if forking failed (no write access
 * anywhere, rate-limited, etc.) — the caller aborts the whole contribution in that case.
 */
async function ensureFork(upstreamRepo: string): Promise<string | null> {
  try {
    const login = (await gh(["api", "user", "-q", ".login"])).trim();
    if (!login) return null;
    // `gh repo fork --clone=false` is idempotent: no-ops (non-fatal exit) if the fork already exists.
    await gh(["repo", "fork", upstreamRepo, "--clone=false"]).catch(() => {});
    const forkName = `${login}/${upstreamRepo.split("/").pop()}`;
    // Best-effort: an existing fork can be behind upstream (it isn't kept in sync automatically),
    // which would base the new branch off a stale tree. Ignore failure — worst case the PR still
    // opens, just potentially against an older base.
    await gh(["repo", "sync", forkName, "--source", upstreamRepo]).catch(() => {});
    return login;
  } catch (err) {
    console.warn(`[agency] couldn't fork ${upstreamRepo} for the upstream contribution:`, (err as Error).message);
    return null;
  }
}

/**
 * Propose a small, ADDITIVE markdown file to a DIFFERENT (upstream) repo via a draft PR — the
 * controlled upstream-contribution channel (P5, docs/prime-time-plan.md; see src/upstream.ts for
 * the enable/genericity gating that decides whether to call this at all). Deliberately never
 * touches any existing upstream file (a brand-new path under `filePath`) so it can never conflict
 * with or clobber the target repo's own content, and always opens the PR as a **draft** — a human
 * reviews and merges it by hand, same as every other agency-opened PR.
 *
 * Routing (see `chooseContribRoute`): pushes straight to `upstreamRepo` ONLY when a cheap
 * permission check confirms the bot's token can actually push there (e.g. the agency's own repo, or
 * one it collaborates on). The realistic case — a fork proposing to the canonical upstream project —
 * has no such access, so it forks the repo into the bot's own account (idempotent), pushes the
 * branch there instead, and opens the PR with `--head <fork-owner>:<branch>`.
 *
 * Best-effort throughout: clones to a throwaway temp dir and swallows every error so a failed
 * upstream contribution never affects the caller's own (already-succeeded) local flow.
 */
export async function openUpstreamContribPr(
  upstreamRepo: string,
  opts: { filePath: string; content: string; title: string; body: string; branchPrefix: string },
): Promise<{ url: string } | null> {
  const dest = join(tmpdir(), `agency-upstream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    const route = chooseContribRoute(await hasDirectPushAccess(upstreamRepo));
    let pushRepo = upstreamRepo;
    let forkOwner: string | null = null;
    if (route === "fork") {
      forkOwner = await ensureFork(upstreamRepo);
      if (!forkOwner) return null; // no write access anywhere — nothing safe to do
      pushRepo = `${forkOwner}/${upstreamRepo.split("/").pop()}`;
    }
    await cloneRepo(pushRepo, dest);
    const branch = `${opts.branchPrefix}-${Date.now()}`;
    await runGit(dest, ["checkout", "-b", branch]);
    const target = join(dest, opts.filePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, opts.content, "utf8");
    await runGit(dest, ["add", "--", opts.filePath]);
    await runGit(dest, [
      "-c", "user.email=agency@users.noreply.github.com",
      "-c", "user.name=dev-agency",
      "commit", "-m", opts.title,
    ]);
    await runGit(dest, ["push", "-u", "origin", branch]);
    const base = await repoBaseBranch(upstreamRepo);
    const head = forkOwner ? `${forkOwner}:${branch}` : branch;
    await gh([
      "pr", "create", "--repo", upstreamRepo, "--draft", "--base", base, "--head", head,
      "--title", opts.title, "--body", opts.body,
    ]);
    return await findPrForBranch(upstreamRepo, head);
  } catch (err) {
    console.warn(`[agency] upstream contribution PR to ${upstreamRepo} skipped:`, (err as Error).message);
    return null;
  } finally {
    await rm(dest, { recursive: true, force: true }).catch(() => {});
  }
}

/** Find an open PR whose head branch matches `branch`, if any. */
export async function findPrForBranch(repo: string, branch: string): Promise<PullRequest | null> {
  const out = await gh([
    "pr", "list",
    "--repo", repo,
    "--head", branch,
    "--state", "open",
    "--json", "number,url,isDraft",
    "--limit", "1",
  ]).catch(() => "[]");
  const raw = JSON.parse(out) as Array<{ number: number; url: string; isDraft: boolean }>;
  return raw.length > 0 ? raw[0] : null;
}

export interface MergeStatus {
  prNumber: number;
  state: string; // OPEN | MERGED | CLOSED
  /** "clean" = no conflicts & can merge; "conflict" = needs a merge/rebase; "unknown" otherwise. */
  mergeable: "clean" | "conflict" | "unknown";
  /** True if the PR was merged into the base branch (the dashboard hides the Merge button when set). */
  merged: boolean;
}

/**
 * Ask GitHub whether a branch's PR can merge cleanly (conflict detection). Used by the dashboard
 * to decide between "merge" vs "fix" — no agent/tokens, just one `gh` API read. Queries ALL states
 * (not just open) so a merged PR is detected — the dashboard hides the Merge button when merged=true.
 */
export async function prMergeStatus(repo: string, branch: string): Promise<MergeStatus | null> {
  const out = await gh([
    "pr", "list", "--repo", repo, "--head", branch, "--state", "all",
    "--json", "number,state,mergeable", "--limit", "1",
  ]).catch(() => "[]");
  const raw = JSON.parse(out) as Array<{ number: number; state: string; mergeable: string }>;
  if (raw.length === 0) return null;
  const p = raw[0];
  const state = (p.state || "").toUpperCase();
  const m = (p.mergeable || "").toUpperCase();
  const mergeable = m === "MERGEABLE" ? "clean" : m === "CONFLICTING" ? "conflict" : "unknown";
  return { prNumber: p.number, state, mergeable, merged: state === "MERGED" };
}



