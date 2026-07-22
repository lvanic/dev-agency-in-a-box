// EpicChecklist molecule — a checklist of every sub-issue of an epic (✓ done-when-merged / ○ open),
// each row linking to the child's detail and carrying its OWN model picker + play button, so you can
// route and start any sub-issue individually. ▶ Play works ALL sub-issues in order (each merge
// auto-starts the next); "Start next" runs just one; "Complete & close" appears when every child is
// done. Extracted from organisms/Detail.js (P6 split); logic unchanged.
import { html } from "/web/vendor/standalone.mjs";
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
  const setKidModel = (c, mo) => {
    c.model = mo || null; // optimistic
    api("/model-override", { repo, number: c.child, model: mo || null }).catch((err) => toast("Couldn't set the model: " + ((err && err.message) || ""), "error"));
  };
  const kidModelTrigger = (cur) => (cur && cur.logo)
    ? html`<span class="tip" data-tip=${cur.label} style="display:inline-flex"><${ProviderLogo} name=${cur.logo} size=${14}/></span>`
    : html`<span class="tip" data-tip="Default model" style="display:inline-flex"><${Icon} name="sparkles" size=${14}/></span>`;
  return html`<div class="epicbox">
    <div class="sec" style="margin:10px 2px 6px">Sub-issues ${epic.done}/${epic.total}${all ? html` · <span class="epicalldone">all done ✓</span>` : null}${epic.auto && !all ? html` · <span class="epicalldone">auto-running ▶</span>` : null}</div>
    <div class="epiclist">
      ${kids.map((c) => html`<div key=${c.child} style="display:flex;align-items:center;gap:6px">
        <button class="epicrow" style="flex:1" onClick=${() => onOpen(repo, c.child, c.title)} data-tip="Open sub-issue">
          <span class=${"epicck " + (isKidDone(c) ? "done" : "open")}><${Icon} name=${isKidDone(c) ? "check" : "planned"} size=${14}/></span>
          <span class="epicnum">#${c.child}</span>
          <span class="epictitle">${c.title || "#" + c.child}</span>
          <span class="substate" style="margin-left:auto;color:var(--ink-3);font-size:11px">${c.state || (c.closed ? "done" : "open")}</span>
        </button>
        ${html`<${ModelSelect} providers=${data && data.providers} data=${data} value=${c.model ? c.model.providerId + "/" + c.model.model : ""} emit="object" onChange=${(mo) => setKidModel(c, mo)} includeDefault=${true} defaultLabel="Default model" onSetUp=${onOpenModels} menuAlign="right" btnClass="iconbtn" trigger=${kidModelTrigger}/>`}
        ${!isKidDone(c) && act ? html`<button class=${"iconbtn tip" + (act.isBusy("start", repo, c.child) ? " busy" : "")} data-tip=${"Start #" + c.child + " now"} disabled=${act.isBusy("start", repo, c.child) || c.state === "working"} onClick=${() => act.start(repo, c.child)}>${c.state === "working" ? html`<${Spinner} size=${13}/>` : html`<${Icon} name="play" size=${13}/>`}</button>` : null}
      </div>`)}
    </div>
    ${!all && act ? html`<div style="display:flex;gap:8px;margin-top:9px">
      ${epic.auto
        ? html`<button class="btn" onClick=${() => act.epicPause(repo, epic.parent || 0)} style="flex:1;justify-content:center"><${Icon} name="planned" size=${15}/> Pause auto-run</button>`
        : html`<button class=${"btn green" + (playing ? " busy" : "")} disabled=${playing} onClick=${() => act.epicPlay(repo, epic.parent || 0)} data-tip="Work ALL sub-issues in order — each merge starts the next" style="flex:1;justify-content:center">${playing ? html`<${Spinner} size=${15}/> Starting…` : html`<${Icon} name="play" size=${15}/> Play all in order`}</button>`}
      <button class=${"btn primary" + (startingKids ? " busy" : "")} disabled=${startingKids} onClick=${() => act.startChildren(repo, epic.parent || 0)} style="flex:1;justify-content:center">${startingKids ? html`<${Spinner} size=${15}/> Starting…` : html`<${Icon} name="play" size=${15}/> Start next only`}</button>
    </div>` : null}
    ${all ? html`<button class="btn green" disabled=${closing} onClick=${onClose} style="margin-top:9px;width:100%;justify-content:center">${closing ? html`<${Spinner} size=${15}/> Closing…` : html`<${Icon} name="check" size=${15}/> Complete & close epic`}</button>` : null}
  </div>`;
}
