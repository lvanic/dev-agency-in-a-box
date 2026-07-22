// ThreadPane molecule — the Detail drawer's "Chat" pane: epic checklist, held/conflict banners, the
// conversation thread (GitHub-backed or run-thread), and the PR status bar.
// Extracted from organisms/Detail.js (P6 split); logic unchanged.
import { html } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { Spinner } from "../atoms/Spinner.js";
import { Comment } from "./Comment.js";
import { EpicChecklist } from "./EpicChecklist.js";

export function ThreadPane({
  issue, repo, number, act, data, onOpenIssue, onClose, onOpenModels,
  thread, loadThread, editComment, pendingComments,
  chatRef, onChatScroll, chatAtTop, chatAtBottom,
  running, review, pr, conflict, conflictFiles, armed, confirmAct,
}) {
  const bz = (a) => act.isBusy(a, repo, number);

  const prBar = issue.pr_url ? (() => {
    const ma = armed === "merge", mb = bz("merge");
    const prMergedBar = !!(pr && pr.merge && pr.merge.merged);
    return html`<div class="prbar">
      <span class="prbar-l"><${Icon} name="pr" size=${15}/> PR #${issue.pr_number}${prMergedBar ? html` · <span style="color:var(--green)">merged ✓</span>` : review === "approved" ? html` · <span style="color:var(--green)">approved</span>` : review === "changes" ? html` · <span style="color:var(--red)">changes requested</span>` : ""}</span>
      <a class="btn ghost" href=${issue.pr_url} target="_blank" rel="noopener"><${Icon} name="link" size=${14}/> Open on GitHub</a>
      ${conflict ? html`<span class="muted" style="font-size:12px">conflicts — resolve first</span>`
        : review === "changes" ? html`<button class=${"btn " + (bz("fix") ? "" : "primary")} disabled=${bz("fix")} onClick=${() => act.fix(repo, number).then(onClose)}>${bz("fix") ? html`<${Spinner} size=${14}/>` : html`<${Icon} name="wrench" size=${14}/>`} Fix</button>` : null}
      ${!conflict && !prMergedBar ? html`<button class=${"btn green" + (mb ? " busy" : "")} disabled=${mb} onClick=${() => confirmAct("merge", () => act.merge(repo, number).then(onClose))}>${mb ? html`<${Spinner} size=${14}/> Merging…` : html`<${Icon} name="merge" size=${14}/> ${ma ? "Confirm merge" : review === "changes" ? "Merge anyway" : "Merge"}`}</button>` : null}
    </div>`;
  })() : null;

  const conflictBox = conflict ? html`<div class="conflictbox">
    <div class="conflictbox-h"><${Icon} name="merge" size=${15}/> Merge conflicts with main</div>
    <div class="conflictbox-b">This PR can't be merged until the conflicts are resolved.${conflictFiles.length ? html` ${conflictFiles.length} conflicting file${conflictFiles.length > 1 ? "s" : ""}:` : ""}</div>
    ${conflictFiles.length ? html`<ul class="conflictbox-files">${conflictFiles.map((f) => html`<li key=${f}><a href=${"https://github.com/" + repo + "/blob/agency/issue-" + number + "/" + f} target="_blank" rel="noopener"><${Icon} name="link" size=${11}/> ${f}</a></li>`)}</ul>` : null}
    <button class=${"btn primary" + (bz("fix") ? " busy" : "")} disabled=${bz("fix")} onClick=${() => act.fix(repo, number)}>${bz("fix") ? html`<${Spinner} size=${14}/> Resolving…` : html`<${Icon} name="wrench" size=${14}/> Fix merge conflicts`}</button>
  </div>` : null;

  return html`<div class="dpane chat" ref=${chatRef} onScroll=${onChatScroll}>
    ${!chatAtTop ? html`<div class="scroll-fab-wrap top"><button class="iconbtn scroll-fab" title="Scroll to top" onClick=${() => { chatRef.current.scrollTop = 0; }}><${Icon} name="chevup" size=${16}/></button></div>` : null}
    ${issue.epic ? html`<${EpicChecklist} epic=${{ ...issue.epic, parent: number }} repo=${repo} onOpen=${onOpenIssue} onClose=${() => act.close(repo, number).then(onClose)} closing=${act.isBusy("close", repo, number)} act=${act} data=${data} onOpenModels=${onOpenModels}/>` : null}
    ${conflictBox}
    ${issue.blocked === "held" ? html`<div class="heldbar">
      <span class="heldbar__l"><${Icon} name="clock" size=${15}/> Workflow on hold${(issue.steers && issue.steers.length) ? html` · ${issue.steers.length} steer${issue.steers.length > 1 ? "s" : ""} queued` : ""}</span>
      <button class=${"btn primary" + (bz("resume") ? " busy" : "")} disabled=${bz("resume")} onClick=${() => act.resume(repo, number)}>${bz("resume") ? html`<${Spinner} size=${14}/>` : html`<${Icon} name="play" size=${14}/>`} Resume</button>
    </div>` : null}
    <div class="sec">Conversation</div>
    ${thread === null ? html`<div class="muted">Loading…</div>`
      : thread._err ? html`<div class="muted" style="color:var(--red);display:flex;align-items:center;gap:8px">${thread._err} <button class="btn" onClick=${loadThread}>Retry</button></div>`
      : html`<div>
        ${thread.body ? html`<${Comment} author=${thread.author} createdAt=${thread.createdAt} body=${thread.body} isAgency=${false}/>` : null}
        ${(() => {
          const cs = thread.comments || [];
          // Index of the LAST human (non-agency) comment — only that one is editable.
          let lastHumanIdx = -1;
          for (let n = 0; n < cs.length; n++) if (!cs[n].isAgency) lastHumanIdx = n;
          // How many agent comments follow that last human comment.
          const agentsAfter = lastHumanIdx >= 0 ? cs.slice(lastHumanIdx + 1).filter((x) => x.isAgency).length : 0;
          return cs.map((c, n) => {
            const isLastHuman = n === lastHumanIdx;
            // Editable only on the last human comment, and only while ≤1 agent has replied after it.
            const editable = isLastHuman && agentsAfter <= 1;
            // If exactly one agent replied, editing must halt that agent. If >1, no edit — only stop.
            const onEditFn = editable ? editComment : null;
            const onStop = (isLastHuman && agentsAfter >= 1 && running) ? (() => act.stop(repo, number)) : null;
            // editable+1-agent: saving the edit should also halt that one agent so it re-reads the edit.
            return html`<${Comment} key=${c.localId || c.id || c.createdAt} id=${c.id} author=${c.author} createdAt=${c.createdAt} body=${c.body} isAgency=${c.isAgency} incoming=${c.incoming} avatars=${(data && data.config && data.config.avatars) !== "off"} onEdit=${onEditFn} editable=${editable} agentsAfter=${isLastHuman ? agentsAfter : 0} onStopAgent=${onStop}/>`;
          });
        })()}
        ${pendingComments.map((p) => html`<${Comment} key=${"skel-" + p.id} author=${p.author} createdAt=${p.createdAt} body=${p.body} isAgency=${false} isSkel=${true}/>`)}
      </div>`}
    ${!chatAtBottom ? html`<div class="scroll-fab-wrap"><button class="iconbtn scroll-fab" title="Scroll to bottom" onClick=${() => { chatRef.current.scrollTop = chatRef.current.scrollHeight; }}><${Icon} name="chevdown" size=${16}/></button></div>` : null}
    ${prBar}
  </div>`;
}
