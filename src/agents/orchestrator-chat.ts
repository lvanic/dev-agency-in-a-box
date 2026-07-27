/**
 * The repo Orchestrator chat (v4). A per-repo, conversational front door: the user thinks out loud,
 * the Orchestrator grounds itself in the repo's memory + recent issues, and — when the user is ready
 * — proposes concrete work as a structured handoff the user confirms (it never creates issues
 * itself; that's the confirmed /orch-handoff route). DB-first: the thread lives in `orch_msg`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendOrchMsg, listOrchThread, recentIssues, getSession, setSession, recordRun, filesFor, listEpicChildren, recentChanges, getIssueDigest, listWatchedRepos } from "../store.js";
import { activeClaims } from "../locks.js";
import { resolveChatExec, chatBaseEnv, chatWorkdir } from "./chat.js";
import { runLLM } from "../runners/exec.js";
import type { Provider } from "../db/providers.js";
import { recallWiring, RECALL_PROMPT } from "./recall.js";

export interface HandoffIssue { title: string; scope: string; route?: string }
export interface HandoffProposal { workflow: string; issues: HandoffIssue[] }
export interface OrchQuestion { options: string[]; multi: boolean }
export interface OrchReply { reply: string; proposal: HandoffProposal | null; question: OrchQuestion | null }

const VALID_WF = new Set(["quick-fix", "full-build", "plan-only", "split"]);
const ORCH_ROLE = "orchestrator";

/** Pull an optional `{agent: @x}` / `{workflow: @y}` route recommendation off an issue line. */
function extractRoute(s: string): { scope: string; route?: string } {
  const m = /\{\s*(agent|workflow)\s*:\s*(@[\w-]+)\s*\}/i.exec(s);
  if (!m) return { scope: s.trim() };
  return { scope: s.replace(m[0], "").trim(), route: m[2].toLowerCase() };
}

/** Parse the trailing ```handoff block (if any) into a structured proposal; tolerant of small drift. */
export function parseHandoff(text: string): HandoffProposal | null {
  const m = text.match(/```handoff\s*([\s\S]*?)```/i);
  if (!m) return null;
  const lines = m[1].split("\n").map((l) => l.trim()).filter(Boolean);
  let workflow = "";
  const issues: HandoffIssue[] = [];
  for (const line of lines) {
    const wf = line.match(/^workflow\s*:\s*(.+)$/i);
    if (wf) { workflow = wf[1].trim().toLowerCase().replace(/\s+/g, "-"); continue; }
    const it = line.match(/^[-*]\s*\[(.+?)\]\s*(.*)$/);
    if (it) { const r = extractRoute(it[2]); issues.push({ title: it[1].trim(), scope: r.scope, ...(r.route ? { route: r.route } : {}) }); continue; }
    const bare = line.match(/^[-*]\s+(.+)$/);
    if (bare) { const r = extractRoute(bare[1]); issues.push({ title: r.scope.slice(0, 80), scope: r.scope, ...(r.route ? { route: r.route } : {}) }); }
  }
  if (!VALID_WF.has(workflow)) workflow = issues.length > 1 ? "split" : "full-build";
  if (!issues.length) return null;
  return { workflow, issues };
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
    `When you propose work, route it to files NOT already owned by open issues. If an idea must touch a file another issue owns, say so and propose to SEQUENCE it after that issue (so the second builds on the first's change) rather than running in parallel — two agents must never edit the same file at once.\n\n${RECALL_PROMPT}`;

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
