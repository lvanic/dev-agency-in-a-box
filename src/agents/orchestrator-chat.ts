/**
 * The repo Orchestrator chat (v4). A per-repo, conversational front door: the user thinks out loud,
 * the Orchestrator grounds itself in the repo's memory + recent issues, and — when the user is ready
 * — proposes concrete work as a structured handoff the user confirms (it never creates issues
 * itself; that's the confirmed /orch-handoff route). DB-first: the thread lives in `orch_msg`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendOrchMsg, listOrchThread, recentIssues, getSession, setSession, recordRun, filesFor, listEpicChildren, recentChanges, getIssueDigest, listWatchedRepos, recordIssueStatus, setByAgent, setIssueWorkflow, setSetting, addEpicChild } from "../store.js";
import { activeClaims } from "../locks.js";
import { withStatus } from "../state.js";
import { createIssue } from "../github.js";
import { resolveWorkflow } from "../workflow.js";
import { resolveChatExec, chatBaseEnv, chatWorkdir } from "./chat.js";
import { runLLM } from "../runners/exec.js";
import type { Provider } from "../db/providers.js";
import { recallWiring, RECALL_PROMPT } from "./recall.js";
import { lazyEnabled } from "../lazy.js";

export interface HandoffIssue {
  title: string;
  scope: string;
  route?: string;
  /** Target repository, when the proposal came from the agency-wide (`*`) thread and has to say
   *  which repo each slice belongs to. Falls back to the proposal's, then the caller's. */
  repo?: string;
}
export interface HandoffProposal {
  workflow: string;
  issues: HandoffIssue[];
  /** Set when the slices are ordered and dependent: the title of the parent EPIC to create them
   *  under. An epic auto-advances (▶ Play starts the next sub-issue as each one merges), whereas
   *  flat issues make the user start and merge every part by hand. */
  epic?: string;
  /** Block-level target repository — the default for every issue that doesn't name its own. */
  repo?: string;
}
export interface OrchQuestion { options: string[]; multi: boolean }
export interface OrchReply { reply: string; proposal: HandoffProposal | null; question: OrchQuestion | null }

const VALID_WF = new Set(["quick-fix", "full-build", "plan-only", "split"]);
const ORCH_ROLE = "orchestrator";
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Heading that marks the verbatim original request inside a generated issue body. Agents and the
 *  reviewer look for exactly this string — keep the two in sync (see SPEC_GATE in pipeline.ts). */
export const SPEC_ANCHOR_HEADING = "### SPEC — the original request (binding)";

/**
 * How to SHAPE the work, injected into every Orchestrator turn.
 *
 * Splitting is not free: each issue pays a fresh plan → dev → test → review pipeline, and every
 * agent re-reads the repo from cold. A benchmark build split into 4 ordered issues cost ~4x the
 * tokens of the same app built in one pass, and the tail issue spent ~190k tokens to move one file
 * and write a README. So the default is ONE issue, and splitting has to earn itself.
 */
export const ROUTING_GUIDE = [
  "## Choosing the shape of the work (this drives cost — get it right)",
  "Every issue you propose pays a full plan → build → test → review pipeline, and each agent starts",
  "cold. Splitting work that one agent could do in a single pass multiplies the cost with no gain, so",
  "ONE issue is the default and a split must earn itself. Pick the cheapest shape that fits:",
  "- **One `full-build` issue** — the default for a feature or a small greenfield app, even when it",
  "  spans several files and layers. One agent holding the whole spec also drifts from it far less",
  "  than several agents each holding a slice.",
  "- **`quick-fix`** — a bug or a change of a file or two, where planning adds nothing.",
  "- **Split into an EPIC with sub-issues** — only when the slices are genuinely independent (they",
  "  touch disjoint files and could run in parallel), or the whole is too big for one run. Ordered,",
  "  dependent slices belong in ONE epic, never as separate top-level issues: an epic auto-advances",
  "  from one sub-issue to the next, whereas separate issues make the user start and merge each by hand.",
  "  To create one, add an `epic: <parent title>` line to the handoff block alongside the issue lines —",
  "  the parts then become its sub-issues. Use it whenever your parts are numbered or say \"then\"/\"after\".",
  "- **`plan-only`** — the goal is genuinely unclear and exploration IS the deliverable.",
  "Purely mechanical work — moving/renaming/deleting files — should not become its own agent issue.",
  "Put it in an `ops` fenced block inside that issue's scope and the agency applies it with code",
  "before any agent starts, for no tokens. One op per line, repo-relative paths only:",
  "```ops",
  "move routes/links.test.js -> test/links.test.js",
  "delete src/old-helper.js",
  "mkdir test",
  "```",
  "Only use ops for work with exactly one right answer. Anything needing judgement is the developer's.",
  "State which shape you chose and why in one line of prose before the handoff block, so the user can",
  "overrule you. When the choice is genuinely close, offer it as a `question` block instead of guessing.",
].join("\n");

/**
 * The user's own words from the orchestrator chat, to be pinned onto every issue the handoff
 * creates.
 *
 * Slicing a chat into issues is lossy: in a live benchmark the orchestrator silently dropped a
 * required field and rewrote a response shape, and because every downstream role validated against
 * the *sliced issue text*, four reviewers approved work that missed the spec. Carrying the request
 * verbatim gives each agent — and the reviewer's gate — the actual goal to check against, not a
 * paraphrase of it.
 *
 * Only `user` turns are kept (the orchestrator's own replies are the paraphrase we don't trust), and
 * the result is capped so a long conversation can't blow up every issue body.
 */
export function specAnchor(repo: string, limit = 4000): string {
  const said = listOrchThread(repo)
    .filter((m) => m.role === "user")
    .map((m) => m.text.trim())
    .filter(Boolean);
  if (!said.length) return "";
  const joined = said.join("\n\n");
  return joined.length > limit ? joined.slice(0, limit) + "\n\n…(truncated)" : joined;
}

/** Pull the optional `{agent: @x}` / `{workflow: @y}` route and `{repo: owner/name}` target off an
 *  issue line. The repo annotation only matters in the agency-wide (`*`) thread, where a proposal
 *  has to name which repository each issue belongs to. */
function extractRoute(s: string): { scope: string; route?: string; repo?: string } {
  let scope = s;
  let route: string | undefined, repo: string | undefined;
  const r = /\{\s*(agent|workflow)\s*:\s*(@[\w-]+)\s*\}/i.exec(scope);
  if (r) { scope = scope.replace(r[0], ""); route = r[2].toLowerCase(); }
  const rp = /\{\s*repo\s*:\s*([\w.-]+\/[\w.-]+)\s*\}/i.exec(scope);
  if (rp) { scope = scope.replace(rp[0], ""); repo = rp[1]; }
  return { scope: scope.trim(), ...(route ? { route } : {}), ...(repo ? { repo } : {}) };
}

/** Parse the trailing ```handoff block (if any) into a structured proposal; tolerant of small drift. */
export function parseHandoff(text: string): HandoffProposal | null {
  const m = text.match(/```handoff\s*([\s\S]*?)```/i);
  if (!m) return null;
  const lines = m[1].split("\n").map((l) => l.trim()).filter(Boolean);
  let workflow = "";
  let repo: string | undefined;
  let epic = "";
  const issues: HandoffIssue[] = [];
  for (const line of lines) {
    const wf = line.match(/^workflow\s*:\s*(.+)$/i);
    if (wf) { workflow = wf[1].trim().toLowerCase().replace(/\s+/g, "-"); continue; }
    const rp = line.match(/^repo\s*:\s*(.+)$/i);
    if (rp) { const v = rp[1].trim(); if (REPO_RE.test(v)) repo = v; continue; }
    const ep = line.match(/^epic\s*:\s*(.+)$/i);
    if (ep) { epic = ep[1].trim(); continue; }
    const it = line.match(/^[-*]\s*\[(.+?)\]\s*(.*)$/);
    if (it) { const r = extractRoute(it[2]); issues.push({ title: it[1].trim(), scope: r.scope, ...(r.route ? { route: r.route } : {}), ...(r.repo ? { repo: r.repo } : {}) }); continue; }
    const bare = line.match(/^[-*]\s+(.+)$/);
    if (bare) { const r = extractRoute(bare[1]); issues.push({ title: r.scope.slice(0, 80), scope: r.scope, ...(r.route ? { route: r.route } : {}), ...(r.repo ? { repo: r.repo } : {}) }); }
  }
  if (!VALID_WF.has(workflow)) workflow = issues.length > 1 ? "split" : "full-build";
  if (!issues.length) return null;
  // An "epic" of one is just an issue — don't wrap a single slice in a parent that adds a click.
  return { workflow, issues, ...(epic && issues.length > 1 ? { epic } : {}), ...(repo ? { repo } : {}) };
}

const HANDLE_FOR_WF: Record<string, string> = { "quick-fix": "@quickfix", "full-build": "@build", "plan-only": "@planonly", "split": "@split" };

export interface CreatedIssue { repo: string; number: number; title: string; url: string }

export interface CreateProposalOpts {
  /** The chat thread the proposal came from — where the verbatim spec anchor is read. */
  threadRepo: string;
  /** Target for any issue the proposal didn't tag with its own repo ("" in the agency-wide thread,
   *  where an untagged issue is skipped rather than guessed at). */
  fallbackRepo: string;
  token: string;
  /** Provenance line appended to every body. */
  note?: string;
}

/**
 * Turn a confirmed proposal into real issues: PLANNED, tagged by-agent, carrying the user's verbatim
 * request (the spec anchor), and routed STRUCTURALLY (issue #140 — a workflow/role pin in the DB,
 * never an @-handle in the body). Ordered slices are wrapped in an EPIC parent so ▶ Play advances
 * them automatically.
 *
 * Shared by the dashboard's "Create issues" button (/orch-handoff) and Lazy Julian Mode, which skips
 * the button entirely.
 */
export async function createProposalIssues(proposal: HandoffProposal, opts: CreateProposalOpts): Promise<CreatedIssue[]> {
  const { threadRepo, fallbackRepo, token } = opts;
  const note = opts.note ?? "Proposed by the 🧭 Orchestrator from a chat.";
  const fallbackRoute = HANDLE_FOR_WF[proposal.workflow] ?? "@build";
  const issues = proposal.issues ?? [];
  const repoFor = (it?: HandoffIssue): string => (it?.repo || proposal.repo || fallbackRepo || "").trim();

  // The user's own words, pinned onto EVERY issue this handoff creates. Slicing is lossy — the scope
  // lines are the Orchestrator's paraphrase — so each agent (and the reviewer's spec gate) needs the
  // original request to check against. Read once, outside the loop.
  const anchor = specAnchor(threadRepo);
  const anchorBlock = anchor
    ? `\n\n${SPEC_ANCHOR_HEADING}\nThis issue is one slice of the request below. Your work must satisfy the part of it that falls in this issue's scope — if the scope and this spec disagree, the spec wins, and say so rather than silently narrowing.\n\n<details><summary>Original request</summary>\n\n${anchor}\n\n</details>`
    : "";

  const created: CreatedIssue[] = [];
  // Ordered, dependent slices become ONE epic instead of N top-level issues: the epic's ▶ Play starts
  // the next sub-issue as each one merges (onChildMerged). An epic lives in a single repository, so a
  // proposal that spans repos stays flat rather than forcing unrelated work under one parent.
  const epicTitle = (proposal.epic ?? "").trim();
  const epicRepo = repoFor(issues[0]);
  const sameRepo = issues.every((it) => repoFor(it) === epicRepo);
  let epicParent = 0;
  if (epicTitle && issues.length > 1 && sameRepo && REPO_RE.test(epicRepo)) {
    const parts = issues.map((it, n) => `${n + 1}. ${(it.title ?? "").trim()}`).join("\n");
    const par = await createIssue(epicRepo, epicTitle, `Epic — built as ${issues.length} sub-issues, in order:\n\n${parts}${anchorBlock}\n\n${note}`, token);
    if (par.number) {
      epicParent = par.number;
      recordIssueStatus(epicRepo, par.number, withStatus("planned"), { title: epicTitle });
      setByAgent(epicRepo, par.number, true);
      created.push({ repo: epicRepo, number: par.number, title: epicTitle, url: par.url });
    }
  }

  for (let n = 0; n < issues.length; n++) {
    const it = issues[n];
    const title = (it.title ?? "").trim();
    const repo = repoFor(it);
    if (!title || !REPO_RE.test(repo)) continue; // no target repo → skip rather than guess
    const pos = issues.length > 1 ? `\n\n— Part ${n + 1} of ${issues.length}.` : "";
    const parentRef = epicParent ? `\n\nPart of epic #${epicParent}.` : "";
    const c = await createIssue(repo, title, `${(it.scope ?? "").trim()}${pos}${parentRef}${anchorBlock}\n\n${note}`, token);
    if (!c.number) continue;
    if (epicParent) addEpicChild(epicRepo, epicParent, c.number, title);
    recordIssueStatus(repo, c.number, withStatus("planned"), { title });
    setByAgent(repo, c.number, true);
    const route = (it.route || fallbackRoute).trim().toLowerCase();
    const wf = resolveWorkflow(route);
    if (wf) setIssueWorkflow(repo, c.number, wf.id);
    else setSetting(`issue_role_pin.${repo}#${c.number}`, route);
    created.push({ repo, number: c.number, title, url: c.url });
  }
  return created;
}

/** Strip the handoff block from the user-facing reply (the proposal is surfaced as a UI card). */
function stripHandoff(text: string): string {
  return text.replace(/```handoff[\s\S]*?```/gi, "").trim();
}

const MAX_Q_OPTS = 6;
/**
 * Parse an optional trailing ```question block into clickable answer choices. Shape:
 *   ```question
 *   multi: false
 *   - Pivot to Flutter
 *   - Keep Expo
 *   ```
 * The question text itself stays in the prose reply (shown above the buttons); this only carries the
 * choices. Returns null when absent/empty — the reply then renders as plain prose.
 */
export function parseQuestion(text: string): OrchQuestion | null {
  const m = text.match(/```question\s*([\s\S]*?)```/i);
  if (!m) return null;
  let multi = false;
  const options: string[] = [];
  for (const raw of m[1].split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const mm = line.match(/^multi\s*:\s*(true|yes|1)\b/i);
    if (mm) { multi = true; continue; }
    if (/^multi\s*:/i.test(line)) continue; // multi: false
    const opt = line.replace(/^[-*\d.)\]]+\s*/, "").trim();
    if (opt) options.push(opt.slice(0, 120));
  }
  const uniq = [...new Set(options)].slice(0, MAX_Q_OPTS);
  return uniq.length ? { options: uniq, multi } : null;
}

/** Strip the question block from the user-facing reply (the choices are surfaced as clickable UI). */
function stripQuestion(text: string): string {
  return text.replace(/```question[\s\S]*?```/gi, "").trim();
}

function loadPersona(): string {
  for (const p of ["memory/central/agents/orchestrator.md", join(process.cwd(), "memory/central/agents/orchestrator.md")]) {
    try { return readFileSync(p, "utf8"); } catch { /* try next */ }
  }
  return "You are the repo Orchestrator: converse with the user, ground answers in the repo, and propose concrete work when they're ready.";
}

const AGENCY = "*";
function repoContext(repo: string): string {
  const all = repo === AGENCY ? recentIssues(200) : recentIssues(160).filter((i) => i.repo === repo);
  if (!all.length) return repo === AGENCY ? "No issues tracked across any repo yet." : "No issues tracked for this repo yet.";
  const recent = all.slice(0, 25).map((i) => {
    const f = filesFor(repo, i.number);
    return `#${i.number} [${i.state}${i.blocked ? "/" + i.blocked : ""}] ${i.title}${f.length ? ` — files: ${f.slice(0, 8).join(", ")}` : ""}`;
  }).join("\n");

  // What's running RIGHT NOW + which files each run has live-claimed (the overwrite-protection
  // registry). This is how the Orchestrator knows what's in flight without reading the repo.
  const claims = activeClaims(repo);
  const inflight = all.filter((i) => i.state === "working").map((i) => {
    const live = claims.find((c) => c.number === i.number);
    return `#${i.number} ${i.title}${live && live.files.length ? ` — editing: ${live.files.join(", ")}` : ""}`;
  });
  const liveBlock = inflight.length ? `\n\nIn flight right now (don't propose work that fights these):\n${inflight.join("\n")}` : "";

  // Epics and their planned sub-issues (the "handoff codes") so you know how big work was split.
  // Epic-ness is the epics table (isEpic()), not a lifecycle state (docs/adr/0003).
  const epics = listEpicChildren ? all.flatMap((i) => {
    const kids = (listEpicChildren(repo, i.number) || []).map((c) => `#${c.child} ${c.title}`);
    if (!kids.length) return [];
    return [`#${i.number} ${i.title} → ${kids.join(", ")}`];
  }) : [];
  const epicBlock = epics.length ? `\n\nEpics & their sub-issues:\n${epics.join("\n")}` : "";

  // File ownership across all open work — so a proposal can route to disjoint files and avoid clashes.
  const owners: string[] = [];
  for (const i of all) {
    if (i.state === "done") continue;
    const f = filesFor(repo, i.number);
    for (const path of f) owners.push(`${path} ← #${i.number}`);
  }
  const ownBlock = owners.length ? `\n\nDeclared file footprints (avoid proposing edits that overlap these unless you sequence them):\n${[...new Set(owners)].slice(0, 40).join("\n")}` : "";

  // Recently MERGED changes (real state, from the change journal) — what actually landed + why.
  const merged = recentChanges(repo, 10).map((c) => `#${c.number} ${c.title}${c.files.length ? ` — ${c.files.slice(0, 6).map((f) => f.path).join(", ")}` : ""}`);
  const mergedBlock = merged.length ? `\n\nRecently merged (real state — build on these, not on unmerged branches):\n${merged.join("\n")}` : "";

  // Per-issue digests (P1, prime-time-plan): a deterministic, no-LLM one-liner upserted on every
  // run_msg append (state/verdict/files). This is how the Orchestrator "genuinely knows" every run
  // without re-reading whole GitHub threads — restricted to issues actually in flight or awaiting
  // review, since a done/planned issue has nothing live to report.
  const active = all.filter((i) => i.state === "working" || i.state === "review").slice(0, 20);
  const digestLines = active
    .map((i) => { const dg = getIssueDigest(i.repo, i.number); return dg ? `#${i.number} ${i.title}: ${dg}` : null; })
    .filter((l): l is string => Boolean(l));
  const digestBlock = digestLines.length ? `\n\nRun digests (live, DB-first — no GitHub round-trip):\n${digestLines.join("\n")}` : "";

  // Agency-wide thread ("*"): a per-repo rollup line (one digest per repo, its most active issue) so
  // the top-level Orchestrator sees every repo's state at a glance instead of one giant issue list.
  let repoRollupBlock = "";
  if (repo === AGENCY) {
    const byRepo = new Map<string, typeof all>();
    for (const i of all) { const list = byRepo.get(i.repo) ?? []; list.push(i); byRepo.set(i.repo, list); }
    const watched = new Set(listWatchedRepos());
    for (const r of watched) if (!byRepo.has(r)) byRepo.set(r, []); // watched-but-idle repos still get a line
    const lines = [...byRepo.entries()].map(([r, list]) => {
      const live = list.find((i) => i.state === "working") ?? list[0];
      const dg = live ? getIssueDigest(r, live.number) : null;
      return `${r}: ${dg ? `#${live!.number} ${dg}` : list.length ? `${list.length} tracked issue(s), nothing live` : "no runs yet"}`;
    });
    repoRollupBlock = lines.length ? `\n\nPer-repo rollup (live digests):\n${lines.join("\n")}` : "";
  }

  return recent + liveBlock + epicBlock + ownBlock + mergedBlock + digestBlock + repoRollupBlock;
}

/**
 * Run one turn of the repo Orchestrator over its thread. Persists the user message and the reply,
 * and returns the reply text (handoff block stripped) plus the parsed proposal, if any.
 */
export async function runOrchestratorChat(repo: string, userText: string): Promise<OrchReply> {
  appendOrchMsg(repo, "user", userText);
  const history = listOrchThread(repo, 40)
    .map((m) => `${m.role === "user" ? "User" : "Orchestrator"}: ${m.text}`)
    .join("\n\n");

  let model = "", provider = null as Provider | null, authKind = "subscription" as "subscription" | "apiKey";
  const workdir = chatWorkdir(`orch|${repo}`);
  const rc = recallWiring(repo);
  const systemPrompt =
    `${loadPersona()}\n\n` +
    (repo === "*"
      ? `You are the **agency-wide Orchestrator** spanning ALL repositories. Reason across repos; when proposing work, name the target repo.\n\n`
      : `You are the Orchestrator for the repository **${repo}**.\n\n`) +
    `## Live repo state (issues, what's in flight, epics, file ownership)\n${repoContext(repo)}\n\n` +
    `When you propose work, route it to files NOT already owned by open issues. If an idea must touch a file another issue owns, say so and propose to SEQUENCE it after that issue (so the second builds on the first's change) rather than running in parallel — two agents must never edit the same file at once.\n\n` +
    (lazyEnabled()
      ? `## Lazy Julian Mode is ON (experimental)\nThere is no approve/start/merge button in play: anything you put in a \`handoff\` block is created AND started immediately, plans build without sign-off, and PRs auto-merge once reviewed and green. So propose only what you're prepared to have run right now, and tag every issue with its target repository — \`{repo: owner/name}\` on the line, or a single \`repo: owner/name\` line in the block. Between messages you also drive the work yourself on a timer; keep this chat as the running report.\n\n`
      : "") +
    RECALL_PROMPT;

  const resumeId = getSession(repo, 0, ORCH_ROLE) || undefined;
  let text = "";
  let turns = 0;
  // resolveChatExec throws when no model is configured — propagate so the caller surfaces it
  // (better than silently invoking Claude with no credential).
  const resolved = resolveChatExec(process.env.ORCHESTRATOR_MODEL || "");
  model = resolved.model; provider = resolved.provider; authKind = resolved.authKind;
  const r = await runLLM(
    {
      task:
        `### Conversation so far\n${history || "(this is the first message)"}\n\n` +
        `The user just said:\n${userText}\n\n` +
        `Respond as the Orchestrator. Discuss and advise conversationally; only append a \`handoff\` block if the user is ready to create work. ` +
        `In the handoff block, RECOMMEND the route per issue: end each issue line with \`{workflow: @build}\` (or another workflow trigger) for multi-step work, or \`{agent: @dev}\` / \`{agent: @review}\` / another single agent when one specialist suffices.\n\n` +
        ROUTING_GUIDE + "\n\n" +
        `When you ask the user to CHOOSE between discrete options, write the question in prose AND append a \`question\` fenced block so they can click instead of type — one option per line as a \`- \` bullet, ` +
        `and a \`multi: true\` line only when several may be picked at once (omit it for a single pick). Example:\n` +
        "```question\nmulti: false\n- Pivot to Flutter\n- Keep Expo\n- Something else\n```\n" +
        `Use it for real either/or decisions, not for open-ended questions.`,
      cwd: workdir,
      model,
      provider,
      authKind,
      allowedTools: [...rc.tools],
      mcpServers: { ...rc.servers },
      env: chatBaseEnv(),
      systemPrompt,
      abort: new AbortController(),
      resumeId,
      maxTurns: 12,
      tokenCap: 0,
    },
    (message) => {
      const sid = (message as { session_id?: string }).session_id;
      if (sid) setSession(repo, 0, ORCH_ROLE, sid);
      const m = message as { type?: string; delta?: string };
      if (m.type === "assistant") {
        const content = (message as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content;
        if (Array.isArray(content)) for (const b of content) if (b.type === "text" && b.text?.trim()) text += (text ? "\n\n" : "") + b.text.trim();
      } else if (m.type === "stream_delta" && typeof m.delta === "string") {
        // partial text not persisted — the final assistant text wins (mirrors chat.ts)
      }
    },
  );
  turns = r.turns;

  const proposal = parseHandoff(text);
  const question = parseQuestion(text);
  const reply = stripQuestion(stripHandoff(text)) || "(no response)";
  const meta = (proposal || question) ? { ...(proposal ? { proposal } : {}), ...(question ? { question } : {}) } : null;
  appendOrchMsg(repo, "orchestrator", reply, meta);
  recordRun(repo, 0, ORCH_ROLE, model, turns, "chat", 0);
  return { reply, proposal, question };
}
