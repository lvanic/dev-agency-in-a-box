// RunHeader molecule — the Detail drawer's header cluster: title/breadcrumb/status/heat row, the
// action toolbar (route›model›play + info/destructive/positive buttons + "More" overflow menu), and
// the mobile Chat/Stream tab switch. Extracted from organisms/Detail.js (P6 split); logic unchanged.
// The toolbar's button arrays (tb/tbLeft/tbRight/moreItems) stay built in Detail — they're deeply
// tied to its local busy/armed state — this molecule only lays them out.
import { html } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { Breadcrumb } from "../atoms/Breadcrumb.js";
import { RunSelector } from "./RunSelector.js";
import { fmtTok, tokHeat, usageTitle, ghUrl } from "../../lib/format.js";
import { statusChip } from "../../lib/issue-logic.js";

export function RunHeader({
  issue, repo, number, onClose, data, act, running, modelOverride, onModelChange, onOpenModels,
  tb, tbLeft, runAppBtns, tbRight, moreItems, moreOpen, setMoreOpen, isDesktop, tab, setTab,
}) {
  return html`
    <div class="dhead dh">
      <div class="dh__t">
        <div class="dh__title">${issue.title || "#" + number}</div>
        <div class="dh__meta dmeta">
          <${Breadcrumb} repo=${repo} number=${number} parent=${issue.epic && issue.epic.parent}/>
          ${(() => { const sc = statusChip(issue); return html`<span class=${"da-status " + sc.cls}><span class="da-status__dot"></span>${sc.label}</span>`; })()}
          ${(() => {
            const h = tokHeat(issue);
            if (!h.tokens) return null;
            return html`<span class="heat tip" data-tip=${usageTitle(issue.usage)}>
              <span class="heat__track"><span class="heat__fill" style=${"width:" + h.pct + "%;background:" + h.color}></span></span>
              <span class="heat__lbl" style=${"color:" + (h.over ? "var(--red)" : "var(--ink-2)")}>${fmtTok(h.tokens)}</span>
            </span>`;
          })()}
          <a href=${ghUrl(repo, number)} target="_blank" rel="noopener" onClick=${(e) => e.stopPropagation()} class="dh__gh" style="display:inline-flex;align-items:center;gap:3px">GitHub<${Icon} name="link" size=${12}/></a>
        </div>
      </div>
      <button class="iconbtn ghost dclose" aria-label="Close" data-tip="Close" onClick=${onClose}><${Icon} name="x" size=${18}/></button>
    </div>
    <div class="dtoolbar">
      ${html`<${RunSelector} issue=${issue} data=${data} act=${act} running=${running} modelOverride=${modelOverride} onModelChange=${onModelChange} onOpenModels=${onOpenModels}/>`}
      <span class="dtoolbar__sep"></span>
      ${tb}
      ${tbLeft}
      <span style="flex:1"></span>
      ${runAppBtns}
      ${tbRight}
      ${moreItems.length ? html`<span class="dropwrap">
        <button class="tbtn" data-tip="More actions" onClick=${() => setMoreOpen((o) => !o)}><${Icon} name=${moreOpen ? "x" : "menu"}/></button>
        ${moreOpen ? html`<div class="dropscrim" onClick=${() => setMoreOpen(false)}></div><div class="dropmenu menu">${moreItems.map((it, i) => it && it.sep ? html`<div key=${i} class="menu-sep"></div>` : html`<span key=${i}>${it}</span>`)}</div>` : null}
      </span>` : null}
    </div>
    ${!isDesktop ? html`<div class="segwrap"><div class="segctl">
      <button class=${"segbtn" + (tab === "chat" ? " on" : "")} onClick=${() => setTab("chat")}>Chat</button>
      <button class=${"segbtn" + (tab === "stream" ? " on" : "")} onClick=${() => setTab("stream")}>Stream</button>
    </div></div>` : null}`;
}
