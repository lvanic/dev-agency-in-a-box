// EpicChecklist molecule — every sub-issue of an epic (✓ done-when-merged / ○ open), each row
// linking to the child's detail and carrying its OWN model picker + play button, so you can route
// and start any sub-issue individually. ▶ Play works ALL sub-issues in order (each merge
// auto-starts the next); "Next" runs just one; "Complete & close" appears when every child is done.
// Rendered by Detail as a full-width section ABOVE the conversation (never inside its scroll), with
// a fold toggle so it stays reachable without eating the chat — folded it's a one-line summary.
import { html, useState } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { Spinner } from "../atoms/Spinner.js";
import { ProviderLogo } from "../atoms/ProviderLogo.js";
import { ModelSelect } from "./ModelSelect.js";
import { api } from "../../lib/api.js";
import { toast } from "../../lib/toast.js";

export function EpicChecklist({ epic, repo, onOpen, onClose, closing, act, data, onOpenModels }) {
  const isKidDone = (c) => Boolean(c.closed) || c.state === "done";
  const all = epic.total > 0 && epic.done >= epic.total;
  const kids = (epic.children || []).slice().sort((a, b) => (isKidDone(a) === isKidDone(b) ? a.child - b.child : isKidDone(a) ? 1 : -1));
  const startingKids = act && act.isBusy && act.isBusy("startChildren", repo, epic.parent || 0);
  const playing = act && act.isBusy && act.isBusy("epicPlay", repo, epic.parent || 0);
  // Fold state persists per epic; an all-done epic starts folded (it's history, not work).
  const foldKey = "epicfold:" + repo + "#" + (epic.parent || 0);
  const [folded, setFolded] = useState(() => { try { const v = localStorage.getItem(foldKey); return v != null ? v === "1" : all; } catch (e) { return all; } });
  const setFold = (f) => { setFolded(f); try { localStorage.setItem(foldKey, f ? "1" : "0"); } catch (e) {} };
  const setKidModel = (c, mo) => {
    c.model = mo || null; // optimistic
    api("/model-override", { repo, number: c.child, model: mo || null }).catch((err) => toast("Couldn't set the model: " + ((err && err.message) || ""), "error"));
  };
  const kidModelTrigger = (cur) => (cur && cur.logo)
    ? html`<span class="tip" data-tip=${cur.label} style="display:inline-flex"><${ProviderLogo} name=${cur.logo} size=${14}/></span>`
    : html`<span class="tip" data-tip="Default model" style="display:inline-flex"><${Icon} name="sparkles" size=${14}/></span>`;
  const pct = epic.total > 0 ? Math.round((epic.done / epic.total) * 100) : 0;
  return html`<div class="epicsec">
    <div class="epicsec-h" onClick=${() => setFold(!folded)}>
      <${Icon} name=${folded ? "chevright" : "chevdown"} size=${15}/>
      <span class="epicsec-t">Sub-issues</span>
      <span class="epicsec-n">${epic.done}/${epic.total}</span>
      <span class="epicprog"><span class="epicprog-fill" style=${"width:" + pct + "%"}></span></span>
      ${all ? html`<span class="epicalldone">all done ✓</span>` : epic.auto ? html`<span class="epicalldone">auto-running ▶</span>` : null}
      <span class="epicsec-act" onClick=${(e) => e.stopPropagation()}>
        ${!all && act ? (epic.auto
          ? html`<button class="btn" onClick=${() => act.epicPause(repo, epic.parent || 0)}><${Icon} name="planned" size=${14}/> Pause</button>`
          : html`<button class=${"btn green" + (playing ? " busy" : "")} disabled=${playing} onClick=${() => act.epicPlay(repo, epic.parent || 0)} data-tip="Work ALL sub-issues in order — each merge starts the next">${playing ? html`<${Spinner} size=${14}/>` : html`<${Icon} name="play" size=${14}/>`} Play all</button>`) : null}
        ${!all && act ? html`<button class=${"btn" + (startingKids ? " busy" : "")} disabled=${startingKids} onClick=${() => act.startChildren(repo, epic.parent || 0)} data-tip="Start just the next open sub-issue">${startingKids ? html`<${Spinner} size=${14}/>` : html`<${Icon} name="play" size=${14}/>`} Next</button>` : null}
        ${all ? html`<button class="btn green" disabled=${closing} onClick=${onClose}>${closing ? html`<${Spinner} size=${14}/> Closing…` : html`<${Icon} name="check" size=${14}/> Complete & close`}</button>` : null}
      </span>
    </div>
    ${!folded ? html`<div class="epiclist">
      ${kids.map((c) => html`<div key=${c.child} class="epicrow-w">
        <button class="epicrow" onClick=${() => onOpen(repo, c.child, c.title)} data-tip="Open sub-issue">
          <span class=${"epicck " + (isKidDone(c) ? "done" : "open")}><${Icon} name=${isKidDone(c) ? "check" : "planned"} size=${14}/></span>
          <span class="epicnum">#${c.child}</span>
          <span class="epictitle">${c.title || "#" + c.child}</span>
          <span class="substate">${c.state || (c.closed ? "done" : "open")}</span>
        </button>
        ${html`<${ModelSelect} providers=${data && data.providers} data=${data} value=${c.model ? c.model.providerId + "/" + c.model.model : ""} emit="object" onChange=${(mo) => setKidModel(c, mo)} includeDefault=${true} defaultLabel="Default model" onSetUp=${onOpenModels} menuAlign="right" btnClass="iconbtn" trigger=${kidModelTrigger}/>`}
        ${!isKidDone(c) && act ? html`<button class=${"iconbtn tip" + (act.isBusy("start", repo, c.child) ? " busy" : "")} data-tip=${"Start #" + c.child + " now"} disabled=${act.isBusy("start", repo, c.child) || c.state === "working"} onClick=${() => act.start(repo, c.child)}>${c.state === "working" ? html`<${Spinner} size=${13}/>` : html`<${Icon} name="play" size=${13}/>`}</button>` : null}
      </div>`)}
    </div>` : null}
  </div>`;
}
