/**
 * Lazy Julian Mode (EXPERIMENTAL) — the full-autopilot mode.
 *
 * Normally the human is the scheduler: they approve each plan, press ▶ Start in the order they want,
 * answer an agent's question, and press Merge. Lazy Julian Mode hands ALL of that to the
 * Orchestrator — the one role that already holds the whole picture (every issue's state, what's in
 * flight, file ownership, run digests; see agents/orchestrator-chat.ts's repoContext).
 *
 * What changes when it's on:
 *   - the plan sign-off gate is skipped (pipeline.ts: no `awaitingApproval` pause),
 *   - auto-resume + auto-merge default to ON at every scope (db/auto.ts) — an explicit per-repo or
 *     per-issue "off" still wins, so you can carve out one repo,
 *   - a tick loop (below) asks the Orchestrator what to do next and executes its directives,
 *   - anything an agent would have asked the HUMAN is elevated to the Orchestrator first. It answers
 *     from the repo context if it can; only when it genuinely can't does it `ask` the user — and that
 *     question lands in the orchestrator chat, not on an issue card.
 *
 * The chat thread the autopilot reports into is the agency-wide one (repo `*`), because its remit
 * spans every watched repo. Everything it does is narrated there, so the chat window IS the UI.
 *
 * Cost control: the loop only spends a turn when there is genuinely something to decide (see
 * `actionable`). A quiet agency costs nothing.
 */
import type { Config } from "./config.js";
import { sBool, sNum } from "./settings.js";
import {
  recentIssues,
  getIssueStatus,
  getIssueDigest,
  listRunThread,
  listWatchedRepos,
  appendOrchMsg,
  getSetting,
  setSetting,
  recordRun,
  recordIssueStatus,
  recordOutgoingComment,
  setByAgent,
  setIssueWorkflow,
  clearReview,
  clearConflict,
} from "./store.js";
import { withStatus } from "./state.js";
import { inFlightKeys, poolStatus } from "./pool.js";
import { pushActivity, pushRunMsg } from "./activity.js";
import { commentAsHuman, closeIssue, createIssue } from "./github.js";
import { attemptSelfMerge } from "./deploySafety.js";
import { afterMerge } from "./merge_hooks.js";
import { isEpic, mergeEpic, onChildMerged } from "./epics.js";
import { resolveWorkflow } from "./workflow.js";
import { ghUserToken, ghBotToken } from "./creds.js";
import { resolveChatExec, chatBaseEnv, chatWorkdir } from "./agents/chat.js";
import { runLLM } from "./runners/exec.js";
import { recallWiring, RECALL_PROMPT } from "./agents/recall.js";
import type { Provider } from "./db/providers.js";

/** The agency-wide orchestrator thread — the autopilot's channel. */
export const LAZY_THREAD = "*";
const LAZY_ROLE = "lazy-orchestrator";
const PENDING_ASK_KEY = "lazy_pending_ask";

/** Is Lazy Julian Mode switched on? (Settings → General; `LAZY_MODE` env as the fallback.) */
export function lazyEnabled(): boolean {
  return sBool("lazy_mode", "LAZY_MODE", false);
}

/**
 * Should this issue's plan build without a human sign-off? True in lazy mode — the whole point is
 * that nothing waits on a click. Kept as its own predicate so the pipeline reads intentionally and
 * the behaviour is testable without the pipeline.
 */
export function lazyAutoApprove(): boolean {
  return lazyEnabled();
}

// ── directives ───────────────────────────────────────────────────────────────────────────────────

export type LazyDirective =
  | { kind: "start" | "resume" | "fix" | "stop" | "merge"; repo: string; number: number }
  | { kind: "close"; repo: string; number: number; note: string }
  | { kind: "answer"; repo: string; number: number; text: string }
  | { kind: "route"; repo: string; number: number; route: string }
  | { kind: "create"; repo: string; title: string; scope: string; route?: string }
  | { kind: "ask"; text: string }
  | { kind: "wait" };

const REF = String.raw`([\w.-]+\/[\w.-]+)?\s*#(\d+)`;
const SIMPLE: ReadonlyArray<LazyDirective["kind"]> = ["start", "resume", "fix", "stop", "merge"];

/** Pull an optional `{workflow: @x}` / `{agent: @y}` route off a directive tail. */
function takeRoute(s: string): { rest: string; route?: string } {
  const m = /\{\s*(?:agent|workflow)\s*:\s*(@[\w-]+)\s*\}/i.exec(s);
  if (!m) return { rest: s.trim() };
  return { rest: s.replace(m[0], "").trim(), route: m[1].toLowerCase() };
}

/**
 * Parse the Orchestrator's trailing ```plan block into executable directives. Deliberately tolerant
 * (models drift): unknown verbs are dropped, a missing `owner/repo` on an issue ref is filled in by
 * the caller's `defaultRepo` when there's exactly one candidate, and prose between directives is
 * ignored. One directive per line:
 *
 *   start acme/app#12
 *   resume|fix|stop|merge acme/app#12
 *   close acme/app#12 superseded by #14
 *   answer acme/app#14: use the existing FooBar helper — no new dependency
 *   route acme/app#15 {workflow: @build}
 *   create acme/app [Add dark mode] toggle in Settings, persisted {workflow: @build}
 *   ask which staging domain should previews point at?
 *   wait
 */
export function parseDirectives(text: string, defaultRepo?: string): LazyDirective[] {
  const m = /```plan\s*([\s\S]*?)```/i.exec(text || "");
  if (!m) return [];
  const out: LazyDirective[] = [];
  const repoOf = (r?: string): string => (r || defaultRepo || "").trim();
  for (const raw of m[1].split("\n")) {
    const line = raw.trim().replace(/^[-*]\s*/, "");
    if (!line) continue;
    if (/^wait\b/i.test(line)) { out.push({ kind: "wait" }); continue; }

    const ask = /^ask\b[:\s]+(.+)$/i.exec(line);
    if (ask) { out.push({ kind: "ask", text: ask[1].trim() }); continue; }

    const answer = new RegExp(String.raw`^answer\s+${REF}\s*[:\-]\s*(.+)$`, "i").exec(line);
    if (answer) {
      const repo = repoOf(answer[1]);
      if (repo && answer[3].trim()) out.push({ kind: "answer", repo, number: Number(answer[2]), text: answer[3].trim() });
      continue;
    }

    const route = new RegExp(String.raw`^route\s+${REF}\s+(.+)$`, "i").exec(line);
    if (route) {
      const repo = repoOf(route[1]);
      const r = takeRoute(route[3]);
      const handle = (r.route || r.rest.trim()).toLowerCase();
      if (repo && /^@[\w-]+$/.test(handle)) out.push({ kind: "route", repo, number: Number(route[2]), route: handle });
      continue;
    }

    const create = /^create\s+([\w.-]+\/[\w.-]+)\s*\[(.+?)\]\s*(.*)$/i.exec(line);
    if (create) {
      const r = takeRoute(create[3] || "");
      const title = create[2].trim();
      if (title) out.push({ kind: "create", repo: create[1], title, scope: r.rest, ...(r.route ? { route: r.route } : {}) });
      continue;
    }

    const close = new RegExp(String.raw`^close\s+${REF}\s*(.*)$`, "i").exec(line);
    if (close) {
      const repo = repoOf(close[1]);
      if (repo) out.push({ kind: "close", repo, number: Number(close[2]), note: (close[3] || "").trim() });
      continue;
    }

    const simple = new RegExp(String.raw`^(${SIMPLE.join("|")})\s+${REF}\s*$`, "i").exec(line);
    if (simple) {
      const repo = repoOf(simple[2]);
      if (repo) out.push({ kind: simple[1].toLowerCase() as "start", repo, number: Number(simple[3]) });
      continue;
    }
  }
  return out;
}

/** One-line human summary of a directive — what the chat reports back. */
export function describeDirective(d: LazyDirective): string {
  const at = (r: string, n: number): string => `${r.split("/").pop()}#${n}`;
  switch (d.kind) {
    case "ask": return `asked you: ${d.text}`;
    case "wait": return "nothing to do right now";
    case "answer": return `answered ${at(d.repo, d.number)}: ${d.text}`;
    case "route": return `routed ${at(d.repo, d.number)} to ${d.route}`;
    case "create": return `created **${d.title}** in ${d.repo.split("/").pop()}`;
    case "close": return `closed ${at(d.repo, d.number)}${d.note ? ` — ${d.note}` : ""}`;
    default: return `${d.kind} ${at(d.repo, d.number)}`;
  }
}

// ── the state the Orchestrator decides from ──────────────────────────────────────────────────────

/** A blocked reason that, in lazy mode, is the Orchestrator's problem rather than the human's. */
const ELEVATED = new Set(["awaitingApproval", "awaitingAnswer", "needsAttention", "conflict", "unverified"]);

export interface LazySnapshot {
  text: string;
  /** Issues the Orchestrator could act on right now (parked, planned, or plain idle). */
  actionable: number;
  freeSlots: number;
  /** Fingerprint of everything above. Identical signature = nothing has moved since the last
   *  decision, so re-asking would buy the same answer twice (see `lazyTick`). */
  sig: string;
}

/** The last thing an agent said on an issue — the question that got it parked, usually. */
function lastAgentSay(repo: string, number: number): string {
  const msgs = listRunThread(repo, number, 4).filter((m) => m.body?.trim());
  const last = msgs[msgs.length - 1];
  if (!last) return "";
  return last.body.replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * Build the deterministic state snapshot the autopilot reasons over. Pure DB reads — no GitHub
 * round-trip, no tokens. `actionable` is what gates spending an LLM turn at all.
 */
export function lazySnapshot(repos: string[]): LazySnapshot {
  const watched = new Set(repos.length ? repos : listWatchedRepos());
  const all = recentIssues(200).filter((i) => watched.has(i.repo));
  const live = new Set(inFlightKeys());
  const { max, running, queued } = poolStatus();
  const freeSlots = Math.max(0, max - running - queued);

  const parked: string[] = [], planned: string[] = [], flight: string[] = [], review: string[] = [];
  for (const i of all) {
    const st = getIssueStatus(i.repo, i.number);
    const key = `${i.repo}#${i.number}`;
    const label = `${i.repo}#${i.number} ${i.title}`;
    if (st.state === "done") continue;
    if (live.has(key)) { flight.push(`${label} — running now`); continue; }
    if (st.blocked && ELEVATED.has(st.blocked)) {
      const said = lastAgentSay(i.repo, i.number);
      parked.push(`${label} [${st.blocked}]${said ? `\n    last agent message: ${said}` : ""}`);
      continue;
    }
    if (st.state === "planned" || st.state === "notPlanned") { planned.push(`${label} [${st.state}]`); continue; }
    if (st.state === "review") { review.push(`${label} — ${getIssueDigest(i.repo, i.number) || "in review"}`); continue; }
    if (st.state === "working") flight.push(`${label} — working (no live run; may need a resume)`);
  }

  const sec = (title: string, rows: string[]): string => (rows.length ? `\n\n## ${title}\n${rows.map((r) => `- ${r}`).join("\n")}` : "");
  const pending = pendingAsk();
  const text =
    `Run slots: ${freeSlots} free of ${max} (${running} running, ${queued} queued).` +
    `\nWatched repos: ${[...watched].join(", ") || "(none)"}` +
    sec("Parked — these need YOUR decision (elevate to the user only as a last resort)", parked) +
    sec("Planned — not started yet", planned) +
    sec("In flight", flight) +
    sec("In review (auto-merge handles approved + green ones on its own)", review) +
    (pending ? `\n\n## Already asked the user (still unanswered — do NOT ask this again)\n- ${pending}` : "");

  // "working, no live run" rows are in `flight` but are genuinely actionable (a resume). Count the
  // sections that represent work the Orchestrator can move, not merely observe.
  const actionable = parked.length + planned.length + review.length;
  const sig = [freeSlots, pending, ...parked, ...planned, ...flight, ...review].join("|");
  return { text, actionable, freeSlots, sig };
}

// ── pending question to the human ────────────────────────────────────────────────────────────────

/** The question the autopilot is currently waiting on the user for ("" when none). */
export function pendingAsk(): string {
  return (getSetting(PENDING_ASK_KEY) || "").trim();
}
/** Clear it — any user message in the orchestrator chat counts as the answer. */
export function clearPendingAsk(): void {
  setSetting(PENDING_ASK_KEY, "");
}
function setPendingAsk(text: string): void {
  setSetting(PENDING_ASK_KEY, text.slice(0, 500));
}

/** Narrate into the agency-wide orchestrator chat — the autopilot's only human-facing surface. */
export function report(text: string, meta?: Record<string, unknown> | null): void {
  appendOrchMsg(LAZY_THREAD, "orchestrator", text, meta ?? null);
}

// ── executing directives ─────────────────────────────────────────────────────────────────────────

export interface LazyDeps {
  start(repo: string, number: number): Promise<void>;
  resume(repo: string, number: number): Promise<void>;
  fix(repo: string, number: number): Promise<void>;
  stop(repo: string, number: number): Promise<void>;
  /** False while the agency can't act at all (no GitHub credential yet, shutting down) — the tick
   *  then costs nothing instead of buying decisions it couldn't execute. */
  ready?(): boolean;
}

/**
 * Post an answer INTO an issue thread as if the human had typed it, then re-engage the run. This is
 * the "elevate the ask to the Orchestrator, let it answer" half of the mode: the agent that asked
 * gets a normal human reply and carries on, and the human never sees the question at all.
 */
async function answerIssue(repo: string, number: number, text: string, deps: LazyDeps): Promise<void> {
  const body = `${text}\n\n_— answered by the 🧭 Orchestrator (Lazy Julian Mode)._`;
  // DB first (the agent reads the conversation from here), GitHub mirror in the background.
  const id = recordOutgoingComment({ repo, number, author: "orchestrator", body, source: "human" });
  pushRunMsg(id, repo, number, `lazy-${Date.now()}`, "orchestrator", body, false);
  const tok = ghUserToken() || ghBotToken();
  if (tok) void commentAsHuman(repo, number, body, tok).catch(() => { /* mirror is best-effort */ });
  await deps.resume(repo, number);
}

/** Merge an issue's PR (or a whole epic) exactly the way the dashboard's Merge button does. */
async function mergeIssue(cfg: Config, repo: string, number: number, deps: LazyDeps): Promise<string> {
  if (isEpic(repo, number)) {
    const e = await mergeEpic(cfg, repo, number);
    return e.ok ? `merged epic ${repo}#${number}` : `couldn't merge epic ${repo}#${number}: ${e.msg}`;
  }
  const r = await attemptSelfMerge(cfg, repo, number, `agency/issue-${number}`);
  if (r.held) return `held ${repo}#${number} for the deploy queue (other runs in flight)`;
  if (!r.ok) return `couldn't merge ${repo}#${number}: ${r.msg ?? "unknown error"}`;
  afterMerge(repo, number, r.files);
  await closeIssue(repo, number, `🚀 Merged ${r.msg} — Lazy Julian Mode.`).catch(() => { /* mirror */ });
  recordIssueStatus(repo, number, withStatus("done"));
  clearReview(repo, number);
  clearConflict(repo, number);
  void onChildMerged(repo, number, (rp, n) => deps.start(rp, n)).catch(() => { /* epic bookkeeping */ });
  return `merged ${repo}#${number}`;
}

/** Open a new issue the Orchestrator decided on — Planned + by-agent + routed, ready to start. */
async function createDirectiveIssue(d: Extract<LazyDirective, { kind: "create" }>): Promise<number> {
  const tok = ghUserToken() || ghBotToken();
  if (!tok) throw new Error("no GitHub token — add one in Settings → credentials");
  const body = `${d.scope}\n\nOpened by the 🧭 Orchestrator running in Lazy Julian Mode.`;
  const c = await createIssue(d.repo, d.title, body, tok);
  if (!c.number) throw new Error("GitHub didn't return an issue number");
  recordIssueStatus(d.repo, c.number, withStatus("planned"), { title: d.title });
  setByAgent(d.repo, c.number, true);
  applyLazyRoute(d.repo, c.number, d.route);
  return c.number;
}

/** Pin a route (workflow trigger → workflow; anything else → single-agent role pin). */
export function applyLazyRoute(repo: string, number: number, route?: string): void {
  const r = (route || "").trim().toLowerCase();
  if (!r) return;
  const wf = resolveWorkflow(r);
  if (wf) setIssueWorkflow(repo, number, wf.id);
  else setSetting(`issue_role_pin.${repo}#${number}`, r);
}

/**
 * Run the Orchestrator's directives, newest capacity first. Returns the report lines. Starts are
 * capped at the number of free run slots so the autopilot can't flood the pool; everything dropped
 * is reported rather than silently skipped.
 */
export async function executeDirectives(
  cfg: Config,
  directives: LazyDirective[],
  deps: LazyDeps,
  freeSlots: number,
): Promise<string[]> {
  const lines: string[] = [];
  let slots = freeSlots;
  let dropped = 0;
  for (const d of directives.slice(0, 12)) {
    try {
      switch (d.kind) {
        case "wait":
          break;
        case "ask":
          setPendingAsk(d.text);
          lines.push(`❓ **I need you on this one:** ${d.text}`);
          break;
        case "start":
          if (slots <= 0) { dropped++; break; }
          slots--;
          await deps.start(d.repo, d.number);
          lines.push(`▶ started ${d.repo}#${d.number}`);
          break;
        case "resume":
          if (slots <= 0) { dropped++; break; }
          slots--;
          await deps.resume(d.repo, d.number);
          lines.push(`▶ resumed ${d.repo}#${d.number}`);
          break;
        case "fix":
          if (slots <= 0) { dropped++; break; }
          slots--;
          await deps.fix(d.repo, d.number);
          lines.push(`🔧 fixing ${d.repo}#${d.number}`);
          break;
        case "stop":
          await deps.stop(d.repo, d.number);
          lines.push(`⏹ stopped ${d.repo}#${d.number}`);
          break;
        case "answer":
          if (slots <= 0) { dropped++; break; }
          slots--;
          await answerIssue(d.repo, d.number, d.text, deps);
          lines.push(`💬 answered ${d.repo}#${d.number}: ${d.text}`);
          break;
        case "route":
          applyLazyRoute(d.repo, d.number, d.route);
          lines.push(`🎯 routed ${d.repo}#${d.number} → ${d.route}`);
          break;
        case "close":
          await closeIssue(d.repo, d.number, `✅ Closed by the Orchestrator — ${d.note || "no longer needed"}.`).catch(() => { /* mirror */ });
          recordIssueStatus(d.repo, d.number, withStatus("done"));
          lines.push(`✅ closed ${d.repo}#${d.number}${d.note ? ` — ${d.note}` : ""}`);
          break;
        case "create": {
          const n = await createDirectiveIssue(d);
          lines.push(`🆕 opened ${d.repo}#${n} — ${d.title}`);
          break;
        }
        case "merge":
          lines.push(`🚀 ${await mergeIssue(cfg, d.repo, d.number, deps)}`);
          break;
      }
      // Mirror the decision onto the issue's own live feed, so the card tells the same story as chat.
      if ("repo" in d) pushActivity(d.repo, "number" in d ? d.number : 0, "orchestrator", "text", `🧭 ${describeDirective(d)}`);
    } catch (err) {
      lines.push(`⚠ ${d.kind} failed — ${(err as Error).message}`);
    }
  }
  if (dropped) lines.push(`⏸ held back ${dropped} action(s) — no free run slots this round.`);
  return lines;
}

// ── the autopilot turn ───────────────────────────────────────────────────────────────────────────

const DIRECTIVE_SPEC = `
Reply with a SHORT paragraph of reasoning (what you're doing and why — the user reads this in chat),
then a final \`\`\`plan block with one directive per line. Valid directives:

  start owner/repo#N            begin a planned issue
  resume owner/repo#N           re-run a parked/stalled issue as-is
  fix owner/repo#N              address review feedback / failing checks on its PR
  stop owner/repo#N             halt a run that's going nowhere
  merge owner/repo#N            merge its PR (only when the review approved and checks are green)
  close owner/repo#N <why>      close without merging (obsolete, duplicate, not worth it)
  answer owner/repo#N: <text>   ANSWER a parked agent's question yourself, as if you were the user
  route owner/repo#N {workflow: @build}   re-route an issue to a workflow or single agent
  create owner/repo [Title] <scope> {workflow: @build}   open a new issue
  ask <question>                LAST RESORT — hand the question to the human in this chat
  wait                          nothing worth doing right now

Rules:
- You are the scheduler. Order the work: don't start two issues that would edit the same files.
- Never exceed the free run slots reported above.
- Prefer \`answer\` over \`ask\`. You have the repo state, the memory, and the run digests — a
  parked question about scope, naming, or an approach is YOURS to decide. Only \`ask\` when the
  answer depends on something only the human knows (a credential, a product/priority call, money).
- One \`ask\` at a time, and never repeat one that's already unanswered.
- Emit \`wait\` when the right move is to let running work finish.`;

// The autopilot resumes its own session so it remembers what it already tried — but a session that
// lives for days grows without bound and every tick pays for it. Rotate it periodically: the
// snapshot is self-contained, so a fresh session loses nothing but the accumulated transcript.
// Held in memory rather than agent_sessions because it's deliberately disposable (a redeploy
// starting the autopilot on a clean session is the desired behaviour, not a bug to fix).
const TICKS_PER_SESSION = 20;
let ticksOnSession = 0;
let lazySessionId: string | undefined;

/** Ask the Orchestrator what to do next. Returns its prose + the parsed directives.
 *  `defaultRepo` fills in a bare `#12` when exactly one repo is in scope. */
export async function askAutopilot(snapshot: LazySnapshot, defaultRepo?: string): Promise<{ text: string; directives: LazyDirective[] }> {
  const rc = recallWiring(LAZY_THREAD);
  const resolved = resolveChatExec(process.env.ORCHESTRATOR_MODEL || "");
  const model = resolved.model;
  const provider: Provider | null = resolved.provider;
  const systemPrompt =
    `You are the agency-wide Orchestrator running in **Lazy Julian Mode** — an EXPERIMENTAL full ` +
    `autopilot. There is no human in the loop right now: no one approves plans, presses Start, or ` +
    `merges. You decide, and the agency executes what you emit. Be decisive and conservative with ` +
    `the user's tokens: move work forward, don't re-litigate.\n\n${DIRECTIVE_SPEC}\n\n${RECALL_PROMPT}`;

  if (ticksOnSession >= TICKS_PER_SESSION) { lazySessionId = undefined; ticksOnSession = 0; }
  ticksOnSession++;

  let text = "";
  const r = await runLLM(
    {
      task: `### Current state of the agency\n${snapshot.text}\n\nDecide the next moves.`,
      cwd: chatWorkdir(`lazy|${LAZY_THREAD}`),
      model,
      provider,
      authKind: resolved.authKind,
      allowedTools: [...rc.tools],
      mcpServers: { ...rc.servers },
      env: chatBaseEnv(),
      systemPrompt,
      abort: new AbortController(),
      resumeId: lazySessionId,
      maxTurns: 8,
      tokenCap: 0,
    },
    (message) => {
      const sid = (message as { session_id?: string }).session_id;
      if (sid) lazySessionId = sid;
      if ((message as { type?: string }).type !== "assistant") return;
      const content = (message as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content;
      if (Array.isArray(content)) for (const b of content) if (b.type === "text" && b.text?.trim()) text += (text ? "\n\n" : "") + b.text.trim();
    },
  );
  recordRun(LAZY_THREAD, 0, LAZY_ROLE, model, r.turns, "lazy-tick", 0);
  return { text, directives: parseDirectives(text, defaultRepo) };
}

/** Strip the machine block — the chat shows the reasoning, not the directives. */
function proseOf(text: string): string {
  return text.replace(/```plan[\s\S]*?```/gi, "").trim();
}

let ticking = false;
let lastSig = "";
let ticksSinceDecision = 0;
// Re-decide on an unchanged agency at most this often. An issue that sits in review waiting on CI
// would otherwise fingerprint identically forever; this keeps the autopilot from going permanently
// silent if a decision it made never landed, without paying for a turn every tick.
const MAX_STALE_TICKS = 10;

/**
 * One autopilot round: snapshot → decide → execute → report. A no-op (and free) when the mode is
 * off, the agency is quiet, a previous round is still running, or nothing has changed since the
 * last decision.
 */
export async function lazyTick(cfg: Config, repos: string[], deps: LazyDeps): Promise<void> {
  if (!lazyEnabled() || ticking) return;
  if (deps.ready && !deps.ready()) return;
  const snap = lazySnapshot(repos);
  if (!snap.actionable) { lastSig = snap.sig; return; } // quiet agency — spend nothing
  if (snap.sig === lastSig && ++ticksSinceDecision < MAX_STALE_TICKS) return; // nothing moved
  lastSig = snap.sig;
  ticksSinceDecision = 0;
  ticking = true;
  try {
    const { text, directives } = await askAutopilot(snap, repos.length === 1 ? repos[0] : undefined);
    const real = directives.filter((d) => d.kind !== "wait");
    if (!real.length) {
      // Pure "wait" rounds are silent — narrating "nothing to do" every few minutes is noise.
      if (!directives.length && proseOf(text)) report(proseOf(text));
      return;
    }
    const lines = await executeDirectives(cfg, real, deps, snap.freeSlots);
    const prose = proseOf(text);
    report(`${prose ? `${prose}\n\n` : ""}${lines.map((l) => `- ${l}`).join("\n")}`, { lazy: true });
  } catch (err) {
    console.error("[agency] lazy-mode tick error:", (err as Error).message);
  } finally {
    ticking = false;
  }
}

/** Start the autopilot loop. Cheap when the mode is off — it just re-checks the setting each tick. */
export function startLazyMode(cfg: Config, repos: () => string[], deps: LazyDeps): void {
  const everyMs = Math.max(60, sNum("lazy_interval_seconds", "LAZY_INTERVAL_SEC", 180)) * 1000;
  setInterval(() => void lazyTick(cfg, repos(), deps).catch((e) => console.error("[agency] lazy-mode error:", (e as Error).message)), everyMs);
}
