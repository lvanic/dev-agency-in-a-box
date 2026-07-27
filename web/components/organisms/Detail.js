// Organism — Detail. Extracted from web/detail.js; logic unchanged. Split further in P6 into
// molecules with clear seams: RunHeader (title/toolbar/tabs), ThreadPane (conversation), StreamPane
// (live activity), ComposerDock (reply box), DetailTimeline (workflow step timeline), EpicChecklist
// and RunApp — this file keeps the STATE and business logic (thread loading, toolbar action-button
// construction, SSE-driven live updates) and composes those molecules for the render.
//
// The issue detail pane: conversation thread, live activity stream, toolbar actions, per-step
// model pickers on the timeline, and the new-issue composer (now organisms/IssueComposer.js).
import { html, useState, useEffect, useRef } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { Spinner } from "../atoms/Spinner.js";
import { ProviderLogo } from "../atoms/ProviderLogo.js";
import { RunApp } from "../molecules/RunApp.js";
import { RunHeader } from "../molecules/RunHeader.js";
import { ThreadPane } from "../molecules/ThreadPane.js";
import { StreamPane } from "../molecules/StreamPane.js";
import { ComposerDock } from "../molecules/ComposerDock.js";
import { DetailTimeline } from "../molecules/DetailTimeline.js";
import { timelineModel } from "../molecules/Timeline.js";
import { api, getJSON } from "../../lib/api.js";
import { toast } from "../../lib/toast.js";
import { isDone } from "../../lib/issue-logic.js";
import { defaultModelLabel } from "../../lib/model-logic.js";
import { agentOnlyOptions } from "../../lib/agent-options.js";

// ---------- Detail ----------
export function Detail({ issue, activity, act, isDesktop, startError, onClose, onOpenIssue, data, isOnline = true, onQueueComment, docked = false, onOpenModels }) {
  const [tab, setTab] = useState("chat"); // mobile sub-tab: chat | stream
  const [thread, setThread] = useState(null);
  const [pr, setPr] = useState(null);
  const [appInfo, setAppInfo] = useState(null);
  const [reply, setReply] = useState("");
  const [replyAgent, setReplyAgent] = useState(""); // address a specific agent in chat (user-chosen)
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(""); // two-tap confirm: which destructive action is armed
  const [moreOpen, setMoreOpen] = useState(false); // toolbar "More" overflow menu
  const [modelOverride, setModelOverride] = useState(
    issue.modelOverride ? issue.modelOverride.providerId + "/" + issue.modelOverride.model : ""
  );
  const providers = data?.providers || [];
  // The route (workflow OR single agent) + model + play now live in the RunSelector molecule.
  const defModelLabel = defaultModelLabel(data);
  const modelTrigger = (cur) => (cur && cur.logo)
    ? html`<span class="tip" data-tip=${cur.label} style="display:inline-flex"><${ProviderLogo} name=${cur.logo} size=${16}/></span>`
    : html`<span class="tip" data-tip=${"Default model · " + defModelLabel} style="display:inline-flex"><${Icon} name="sparkles" size=${16}/></span>`;
  const agentSelOpts = [{ value: "", label: "Just comment", icon: "messages" }].concat(agentOnlyOptions(data && data.agentDefs));
  // The picker option that addresses the planner — so when a plan is up for approval a reply is
  // routed to the Plan agent to REVISE it, not dropped as a bystander comment.
  const planHandle = (agentSelOpts.find((x) => x.value === "@plan" || x.avatar === "planner" || /^plan/i.test(x.label || "")) || {}).value || "";
  const [pendingComments, setPendingComments] = useState([]); // optimistic skeleton comments
  const [chatAtBottom, setChatAtBottom] = useState(true);
  const [chatAtTop, setChatAtTop] = useState(true);
  const [streamAtBottom, setStreamAtBottom] = useState(true);
  const armRef = useRef(null);
  const streamRef = useRef(null);
  const stickRef = useRef(true);
  const chatRef = useRef(null);
  const taRef = useRef(null); // compose textarea (auto-grows with content)
  const didScrollRef = useRef(false); // scroll the conversation to the newest message once, on open
  const updateModelOverride = (mo) => {
    setModelOverride(mo ? mo.providerId + "/" + mo.model : "");
    issue.modelOverride = mo || null;
    api("/model-override", { repo, number, model: mo || null }).catch((err) => {
      toast("Failed to save model override: " + err.message);
    });
  };
  const repo = issue.repo, number = issue.number;
  // Persist the reply draft per-issue so it survives navigating away and reopening.
  const draftKey = "draft:reply:" + repo + "#" + number;
  useEffect(() => { try { setReply(localStorage.getItem(draftKey) || ""); } catch (e) {} }, [draftKey]);
  useEffect(() => { try { if (reply) localStorage.setItem(draftKey, reply); else localStorage.removeItem(draftKey); } catch (e) {} }, [reply, draftKey]);
  useEffect(() => {
    if (thread && !didScrollRef.current && chatRef.current) {
      didScrollRef.current = true;
      requestAnimationFrame(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; });
    }
  }, [thread]);
  function confirmAct(key, fn) {
    if (armed === key) { clearTimeout(armRef.current); setArmed(""); fn(); return; }
    setArmed(key); clearTimeout(armRef.current); armRef.current = setTimeout(() => setArmed(""), 3000);
  }
  function onChatScroll(e) {
    const el = e.target;
    setChatAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
    setChatAtTop(el.scrollTop < 60);
  }

  // Legacy path: the GitHub-backed thread (reconciles with GitHub, local_comment-cached). Kept ONLY
  // as the fallback for issues that predate the run thread (no run_msg rows yet) — see loadThread.
  function loadGithubThread() {
    getJSON("/thread?repo=" + encodeURIComponent(repo) + "&number=" + number)
      .then((t) => {
        if (t && Array.isArray(t.comments)) {
          setThread(t);
        } else {
          const errMsg = (t && t.error) || "No thread data received from GitHub — the issue may not exist yet or the token lacks access.";
          setThread({ _err: errMsg });
          toast(errMsg);
        }
      })
      .catch((e) => {
        const errMsg = (e && e.message) || "Couldn't load thread. Check network and GitHub token.";
        setThread((prev) => prev || { _err: errMsg });
        toast(errMsg);
      });
  }
  // P1 (prime-time-plan): the DB-first run thread — one fetch, no polling. New messages arrive live
  // over the shared /events SSE stream (see the appliedMsgRef effect below); GitHub is only consulted as
  // a one-time fallback for issues from before this table existed (hasRunMsgs === false).
  function loadThread() {
    getJSON("/run-thread?repo=" + encodeURIComponent(repo) + "&number=" + number)
      .then((t) => {
        if (t && Array.isArray(t.comments) && t.hasRunMsgs) setThread(t);
        else loadGithubThread();
      })
      .catch(loadGithubThread);
  }
  useEffect(() => {
    setModelOverride(issue.modelOverride ? issue.modelOverride.providerId + "/" + issue.modelOverride.model : "");
  }, [issue.modelOverride?.providerId, issue.modelOverride?.model]);
  // When a plan is waiting on you, pre-address the composer to the Plan agent so a reply revises the
  // plan (with the approve bar telling you a reply changes it). Any other state stays "Just comment".
  useEffect(() => {
    setReplyAgent(issue.blocked === "awaitingApproval" && planHandle ? planHandle : "");
  }, [repo, number, issue.blocked, planHandle]);
  useEffect(() => {
    setThread(null); setPr(null); setAppInfo(null); setPendingComments([]); stickRef.current = true;
    if (issue._audit) return; // the audit has no GitHub thread/PR — stream-only view below
    loadThread();
    if (issue.pr_number) getJSON("/pr-status?repo=" + encodeURIComponent(repo) + "&number=" + number).then(setPr).catch(() => {});
    getJSON("/app-info?repo=" + encodeURIComponent(repo) + "&number=" + number).then(setAppInfo).catch(() => setAppInfo({ kind: "unknown" }));
    // No poll: the run thread follows live via the appliedMsgRef effect below (SSE "run_msg" events).
  }, [repo, number, issue._audit, issue.pr_number]);

  // Live conversation updates: append (never re-fetch) new "run_msg" SSE events onto the loaded
  // thread — de-duped by their run_msg/local_comment row id, so a message already in the initial
  // /run-thread load is never doubled once its SSE echo arrives.
  const appliedMsgRef = useRef(new Set());
  useEffect(() => {
    if (!thread || !Array.isArray(thread.comments)) return;
    const news = activity.filter((a) => a.kind === "run_msg" && a.repo === repo && a.number === number);
    if (!news.length) return;
    const additions = [];
    for (const a of news) {
      const key = "rm-" + (a.msgId || (a.runId + "|" + a.ts));
      if (appliedMsgRef.current.has(key)) continue;
      appliedMsgRef.current.add(key);
      additions.push({ id: 0, localId: key, author: a.isAgency === false ? (a.role || "you") : "dev-agency", body: a.text, createdAt: new Date(a.ts).toISOString(), isAgency: a.isAgency !== false, incoming: false });
    }
    if (additions.length) {
      setThread((prev) => (prev && Array.isArray(prev.comments) ? { ...prev, comments: prev.comments.concat(additions) } : prev));
      // Our own reply echoes back as a live "run_msg" almost immediately (see POST /comment in
      // webhook.ts) — clear its optimistic skeleton the moment that echo arrives (matched on body),
      // instead of always waiting out sendFull's fixed 800ms timeout, so the two never double-render.
      setPendingComments((ps) => ps.filter((p) => !news.some((a) => a.isAgency === false && (a.text || "").trim() === (p.body || "").trim())));
    }
  }, [activity, thread, repo, number]);

  // Coalesce consecutive "delta" fragments (live partial-text "typing") from the same role into one
  // growing line so the stream reads as a paragraph, not 50 single-token rows. Non-delta events pass through.
  const stream = (() => {
    // "run_msg" events are the Conversation pane's live feed (see the appliedMsgRef effect above),
    // not the raw thought/tool stream — keep them out of this pane so nothing shows twice.
    const raw = activity.filter((a) => a.repo === repo && a.number === number && a.kind !== "run_msg");
    const out = [];
    for (const a of raw) {
      const prev = out[out.length - 1];
      if (a.kind === "delta" && prev && prev.kind === "delta" && prev.role === a.role) {
        out[out.length - 1] = { ...prev, text: (prev.text || "") + (a.text || "") };
      } else out.push(a);
    }
    return out.slice(-60);
  })();
  useEffect(() => { const el = streamRef.current; if (el && stickRef.current) el.scrollTop = el.scrollHeight; });
  function onStreamScroll(e) {
    const el = e.target;
    const atB = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    stickRef.current = atB;
    setStreamAtBottom(atB);
  }

  const review = (pr && pr.review && pr.review.verdict) || issue.review || null;
  // Live conflict signal once /pr-status loads; before that, fall back to the stored flag from /data
  // so the box shows immediately on open.
  const conflict = pr ? Boolean(pr.merge && pr.merge.mergeable === "conflict") : Boolean(issue.conflict);
  const conflictFiles = (pr && pr.conflict && pr.conflict.files) || (issue.conflict && issue.conflict.files) || [];
  const needsFix = review === "changes";
  const done = isDone(issue);
  const st = issue.state || "";
  const running = !!(issue.running || issue.active || issue.queued); // a Claude run is executing right now

  // Send the composed reply (the shared ChatComposer already folded attachment markdown into
  // `full`). The chosen agent travels as a STRUCTURED field — never an "@handle " text prefix.
  function sendFull(full) {
    const mo = modelOverride ? (() => { const parts = modelOverride.split("/"); return { providerId: parts[0], model: parts.slice(1).join("/") }; })() : null;
    if (!isOnline) {
      if (onQueueComment) onQueueComment({ type: "comment", repo, number, body: full, agent: replyAgent || null, model: mo || null });
      toast("Queued offline — will send when back online");
      setReply("");
      return Promise.resolve();
    }
    setBusy(true);
    const skelId = Date.now();
    setPendingComments((ps) => ps.concat({ _skel: true, id: skelId, author: "you", createdAt: new Date().toISOString(), body: full }));
    requestAnimationFrame(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; });
    return api("/comment", { repo, number, body: full, ...(replyAgent ? { agent: replyAgent } : {}), ...(mo ? { model: mo } : {}) })
      .then(() => {
        setReply("");
        toast(running ? "Queued — the agent will pick it up when the run finishes" : "Sent");
        setTimeout(() => { setPendingComments((ps) => ps.filter((p) => p.id !== skelId)); loadThread(); }, 800);
      })
      .catch((e) => {
        if (e instanceof TypeError) {
          if (onQueueComment) onQueueComment({ type: "comment", repo, number, body: full, model: mo || null });
          toast("Network error — comment queued offline");
        } else {
          toast((e && e.message) || "Couldn’t send", "error");
        }
        setPendingComments((ps) => ps.filter((p) => p.id !== skelId));
      })
      .finally(() => setBusy(false));
  }
  function editComment(id, body) {
    return api("/comment-edit", { repo, number, commentId: id, body })
      .then(() => { toast("Comment updated"); setTimeout(loadThread, 400); });
  }

  // toolbar actions. Text labels show on desktop (and on a confirm-armed destructive button).
  const lbl = (t) => html`<span class="tlabel">${t}</span>`;
  const au = issue.auto || {};
  // Obvious ON/OFF toggle switch. Reflects the effective state; clicking flips it (explicit on/off).
  const autoToggle = (kind) => {
    const on = kind === "resume" ? au.resume : au.merge;
    const busy = act.isBusy("auto-" + kind, repo, number);
    return html`<button class=${"menu-item" + (busy ? " busy" : "")} disabled=${busy} onClick=${() => act.setAuto(kind, on ? "off" : "on", repo, number)}>
      <${Icon} name=${kind === "resume" ? "refresh" : "merge"} size=${15}/><span class="mi-label">Auto-${kind}</span>
      <span class=${"mi-switch" + (on ? " on" : "")}><span class="mi-knob"></span></span>
    </button>`;
  };
  const tb = []; // info buttons (left)
  const tbLeft = []; // destructive actions (stop / cancel / park)
  const tbRight = []; // positive CTAs (start / approve / fix / merge / …)
  // A toolbar icon that swaps to a spinner + disables while its action is in flight.
  const bz = (a) => act.isBusy(a, repo, number);
  const tico = (a, name) => bz(a) ? html`<${Spinner} size=${18}/>` : html`<${Icon} name=${name}/>`;
  // Run-the-app actions live in the issue toolbar (was a separate "Run the app" tile).
  const runAppBtns = html`<${RunApp} repo=${repo} number=${number} appInfo=${appInfo} issue=${issue} done=${done} repoBranches=${data && data.repoBranches}/>`;
  // Compact icon-only links (tooltips carry the meaning) so the toolbar stays uncluttered.
  if (issue.pr_url) tb.push(html`<a class="tbtn" data-tip="Open PR" href=${issue.pr_url} target="_blank" rel="noopener"><${Icon} name="pr"/></a>`);
  if (issue.previewUrl) tb.push(html`<a class="tbtn primary" data-tip="Open preview" href=${issue.previewUrl} target="_blank" rel="noopener"><${Icon} name="globe"/></a>`);
  // Re-pull this single issue (title + whole conversation) from GitHub.
  if (!done) {
    // Decide actions from FACTS, not the (possibly stale) state label:
    //  • running  — something is actually executing right now (live registry), so the only
    //               meaningful action is Stop. A restart can leave the label "in-progress" while
    //               nothing runs — that must NOT show Stop.
    //  • hasPr    — a PR exists → the goal is Merge (or Fix/Resolve if blocked). Never Create PR/Close.
    //  • approved — reviewer approved but no PR yet → Create PR (token-free).
    const hasPr = !!issue.pr_number;
    // A merged PR (from /pr-status) takes precedence over the DB state label — the merge webhook
    // may lag, but GitHub knows immediately. Hide all merge/fix actions once merged.
    const prMerged = !!(pr && pr.merge && pr.merge.merged);
    const parked = !st || st === "notPlanned" || st === "planned";
    const awaiting = issue.blocked === "awaitingApproval";
    const approved = review === "approved";

    const parts = modelOverride ? modelOverride.split("/") : [];
    const mo = parts.length >= 2 ? { providerId: parts[0], model: parts.slice(1).join("/") } : null;

    const bStop = () => html`<button class=${"tbtn warn" + (bz("stop") ? " busy" : "")} disabled=${bz("stop")} data-tip="Stop & halt — parks at needs-attention (press Resume to continue; Cancel resets to Planned)" onClick=${() => act.stop(repo, number)}>${tico("stop", "stop")}${lbl(bz("stop") ? "Stopping…" : "Stop")}</button>`;
    const bApprove = () => html`<button class=${"tbtn primary" + (bz("approve") ? " busy" : "")} disabled=${bz("approve")} data-tip="Approve the plan & build" onClick=${() => act.approve(repo, number, mo).then(onClose)}>${tico("approve", "check")}${lbl("Approve")}</button>`;
    const bResume = () => html`<button class=${"tbtn" + (bz("resume") ? " busy" : "")} disabled=${bz("resume")} data-tip="Re-run the agent on this issue" onClick=${() => act.resume(repo, number, mo)}>${tico("resume", "refresh")}${lbl(bz("resume") ? "Resuming…" : "Resume")}</button>`;
    const bFix = () => html`<button class=${"tbtn primary" + (bz("fix") ? " busy" : "")} disabled=${bz("fix")} data-tip=${conflict ? "Resolve merge conflicts" : "Address the review's requested changes"} onClick=${() => act.fix(repo, number, mo).then(onClose)}>${tico("fix", "wrench")}${lbl(conflict ? "Resolve" : "Fix")}</button>`;
    const bCreatePr = () => html`<button class=${"tbtn green" + (bz("createPr") ? " busy" : "")} disabled=${bz("createPr")} data-tip="Open a PR from the approved branch (no AI / no tokens)" onClick=${() => act.createPr(repo, number)}>${tico("createPr", "pr")}${lbl(bz("createPr") ? "Opening PR…" : "Create PR")}</button>`;
    const bMerge = (anyway) => { const ma = armed === "merge", mb = bz("merge"); return html`<button class=${"tbtn green" + (ma ? " armed" : "") + (mb ? " busy" : "")} disabled=${mb} data-tip=${ma ? "Tap again to merge" : anyway ? "Merge despite requested changes" : "Merge the PR & close the issue"} onClick=${() => confirmAct("merge", () => act.merge(repo, number).then(onClose))}>${mb ? html`<${Spinner} size=${18}/>` : html`<${Icon} name="merge"/>`}${(isDesktop || ma) ? html`<span class="tlabel">${mb ? "Merging…" : ma ? "Confirm merge" : anyway ? "Merge anyway" : "Merge"}</span>` : null}</button>`; };
    const bClose = (epic) => { const ca = armed === "close", cb = bz("close"); const epicAllDone = issue.epic && issue.epic.done >= issue.epic.total; const clabel = ca ? "Confirm" : cb ? "Closing…" : epic ? (epicAllDone ? "Complete" : "Close epic") : "Close"; return html`<button class=${"tbtn" + (epic ? " green" : "") + (ca ? " armed" : "") + (cb ? " busy" : "")} disabled=${cb} data-tip=${ca ? "Tap again to close" : epic ? "Merge any remaining sub-PRs & close this epic" : "Close this issue (mark it done, no PR)"} onClick=${() => confirmAct("close", () => act.close(repo, number).then(onClose))}>${cb ? html`<${Spinner} size=${18}/>` : html`<${Icon} name="check"/>`}${(isDesktop || ca) ? html`<span class="tlabel">${clabel}</span>` : null}</button>`; };

    // Cancel → reset to Planned even when there's a PR / work in flight (the branch/PR stays on GitHub).
    const bCancel = () => html`<button class=${"tbtn warn" + (bz("cancel") ? " busy" : "")} disabled=${bz("cancel")} data-tip="Reset to Planned — discards the agency state but keeps the branch/PR on GitHub" onClick=${() => act.cancel(repo, number).then(onClose)}>${tico("cancel", "planned")}${lbl(bz("cancel") ? "Cancelling…" : "Cancel")}</button>`;

    // KISS: ONE state-relevant PRIMARY action stays in the bar. Everything secondary (reset-to-Planned,
    // close & archive, create-PR, update, run-checks, budget, delete) lives in the hamburger.
    if (running) {
      tbRight.push(bStop()); // a run is executing → the only meaningful action is Stop
    } else if (prMerged) {
      // PR already merged on GitHub — no merge/fix/approve action, just let the DB catch up.
      tbRight.push(bResume());
    } else if (awaiting) {
      tbRight.push(bApprove()); // awaiting plan approval — MUST come before the parked branch below
    } else if (hasPr) {
      if (conflict) tbRight.push(bFix());
      else if (needsFix) tbRight.push(bFix());
      else tbRight.push(bMerge(false));
    } else if (parked) {
      tbRight.push(bResume()); // a started-but-parked issue continues with Resume (no Start/Play)
    } else if (issue.epic) {
      tbRight.push(bClose(true));
    } else if (approved) {
      tbRight.push(bCreatePr());
    } else {
      tbRight.push(bResume());
    }
  }
  // Less-frequent controls live behind a "More" menu so the bar stays tidy.
  const da = armed === "del", db = bz("del");
  const moreItems = [];
  const ca2 = armed === "close", cb2 = bz("close");
  // Secondary actions (KISS): the bar shows one primary action; everything else lives here.
  if (!done) moreItems.push(html`<button class=${"menu-item" + (bz("runChecks") ? " busy" : "")} disabled=${bz("runChecks")} onClick=${() => act.runChecks(repo, number, issue.title)}>${bz("runChecks") ? html`<${Spinner} size=${15}/>` : html`<${Icon} name="flask" size=${15}/>`}<span class="mi-label">Run checks</span></button>`);
  moreItems.push(html`<button class=${"menu-item" + (bz("update") ? " busy" : "")} disabled=${bz("update")} onClick=${() => act.updateIssue(repo, number).then(loadThread)}>${bz("update") ? html`<${Spinner} size=${15}/>` : html`<${Icon} name="refresh" size=${15}/>`}<span class="mi-label">${bz("update") ? "Updating…" : "Update from GitHub"}</span></button>`);
  if (!done) { moreItems.push(autoToggle("resume")); moreItems.push(autoToggle("merge")); }
  moreItems.push({ sep: true });
  // Reset to Planned — discards agency state, keeps the branch/PR.
  if (!done) moreItems.push(html`<button class=${"menu-item" + (bz("cancel") ? " busy" : "")} disabled=${bz("cancel")} onClick=${() => act.cancel(repo, number).then(onClose)}>${bz("cancel") ? html`<${Spinner} size=${15}/>` : html`<${Icon} name="planned" size=${15}/>`}<span class="mi-label">${bz("cancel") ? "Resetting…" : "Reset to Planned"}</span></button>`);
  // Full reset — wipe ALL progress (activity, plan, session, overrides) back to initial state.
  if (!done) moreItems.push(html`<button class=${"menu-item" + (bz("reset") ? " busy" : "")} disabled=${bz("reset")} onClick=${() => { if (!window.confirm("Wipe ALL progress for this issue (activity, plan, session, model overrides)? The branch/PR stays on GitHub.")) return; act.resetIssue(repo, number).then(onClose); }}>${bz("reset") ? html`<${Spinner} size=${15}/>` : html`<${Icon} name="refresh" size=${15}/>`}<span class="mi-label">${bz("reset") ? "Resetting…" : "Full reset"}</span></button>`);
  // Close & archive — close the issue (NOT a merge); archive icon makes that clear.
  if (!done) moreItems.push(html`<button class=${"menu-item" + (cb2 ? " busy" : "")} disabled=${cb2} onClick=${() => confirmAct("close", () => act.close(repo, number).then(onClose))}>${cb2 ? html`<${Spinner} size=${15}/>` : html`<${Icon} name="archive" size=${15}/>`}<span class="mi-label">${cb2 ? "Closing…" : ca2 ? "Tap again to close" : "Close & archive"}</span></button>`);
  // Per-issue budget (#67) — ONE control: unlimited / a $ cap / default, set from a single prompt.
  const isUnlimited = !!issue.budget?.unlimited;
  const budgetVal = isUnlimited ? "Unlimited" : (issue.budget?.maxCostUsd != null ? "$" + issue.budget.maxCostUsd : "Default");
  const setBudget = () => {
    const v = prompt("Per-issue budget — a max in USD (e.g. 5), \"unlimited\", or blank for the global default:", isUnlimited ? "unlimited" : (issue.budget?.maxCostUsd ?? ""));
    if (v == null) return;
    const t = v.trim().toLowerCase();
    const budget = t === "unlimited" ? { unlimited: true } : t === "" ? {} : (() => { const n = Number(t.replace(/^\$/, "")); return Number.isFinite(n) && n >= 0 ? { maxCostUsd: n } : {}; })();
    api("/issue-budget", { repo, number, budget }).then(() => { toast("Budget updated"); loadThread(); }).catch(() => toast("Couldn’t set budget", "error"));
  };
  moreItems.push(html`<button class="menu-item" onClick=${setBudget}><${Icon} name="chart" size=${15}/><span class="mi-label">Budget</span><span class="mi-val">${budgetVal}</span></button>`);
  moreItems.push({ sep: true });
  moreItems.push(html`<button class=${"menu-item danger" + (db ? " busy" : "")} disabled=${db} onClick=${() => confirmAct("del", () => act.del(repo, number))}>${db ? html`<${Spinner} size=${15}/>` : html`<${Icon} name="trash" size=${15}/>`}<span class="mi-label">${db ? "Deleting…" : da ? "Tap again to delete" : "Delete"}</span></button>`);

  const streamPane = html`<${StreamPane} startError=${startError} stream=${stream} streamRef=${streamRef} streamAtBottom=${streamAtBottom} onScroll=${onStreamScroll}/>`;

  const chatPane = html`<${ThreadPane}
    issue=${issue} repo=${repo} number=${number} act=${act} data=${data}
    onOpenIssue=${onOpenIssue} onClose=${onClose} onOpenModels=${onOpenModels}
    thread=${thread} loadThread=${loadThread} editComment=${editComment} pendingComments=${pendingComments}
    chatRef=${chatRef} onChatScroll=${onChatScroll} chatAtTop=${chatAtTop} chatAtBottom=${chatAtBottom}
    running=${running} review=${review} pr=${pr} conflict=${conflict} conflictFiles=${conflictFiles}
    armed=${armed} confirmAct=${confirmAct}
  />`;

  return html`<div class=${"detail on" + (docked ? " docked" : "")}>
    <${RunHeader}
      issue=${issue} repo=${repo} number=${number} onClose=${onClose} data=${data} act=${act}
      running=${running} modelOverride=${modelOverride} onModelChange=${updateModelOverride} onOpenModels=${onOpenModels}
      tb=${tb} tbLeft=${tbLeft} runAppBtns=${runAppBtns} tbRight=${tbRight} moreItems=${moreItems}
      moreOpen=${moreOpen} setMoreOpen=${setMoreOpen} isDesktop=${isDesktop} tab=${tab} setTab=${setTab}
    />
    <div class="dpanes">
      ${isDesktop ? html`${chatPane}${streamPane}` : tab === "chat" ? chatPane : streamPane}
    </div>
    ${timelineModel(issue).started ? html`<div class="dtl-timeline"><${DetailTimeline} issue=${issue} data=${data} onOpenModels=${onOpenModels}/></div>` : null}
    <${ComposerDock}
      reply=${reply} setReply=${setReply} taRef=${taRef} repo=${repo} number=${number}
      running=${running} busy=${busy} sendFull=${sendFull}
      replyAgent=${replyAgent} setReplyAgent=${setReplyAgent} agentSelOpts=${agentSelOpts}
      providers=${providers} data=${data} modelOverride=${modelOverride} updateModelOverride=${updateModelOverride}
      modelTrigger=${modelTrigger} defModelLabel=${defModelLabel} onOpenModels=${onOpenModels} act=${act}
    />
  </div>`;
}
