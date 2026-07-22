// StreamPane molecule — the Detail drawer's live activity/thought stream (the "Stream" mobile tab /
// desktop side pane): setup-progress bar, then the raw agent thought/tool/progress log.
// Extracted from organisms/Detail.js (P6 split); logic unchanged.
import { html } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { Spinner } from "../atoms/Spinner.js";
import { getSetupProgress } from "../../lib/setup-progress.js";

export function StreamPane({ startError, stream, streamRef, streamAtBottom, onScroll }) {
  return html`<div class="dpane side">
    ${startError ? html`<div class="secbanner">⚠ ${startError}</div>` : null}
    ${(() => { const sp = getSetupProgress(stream); if (!sp) return null; const pct = sp.percent == null ? null : sp.percent; return html`<div class="setupbar" title=${sp.phase}><div class="setupbar-track"><div class="setupbar-fill" style=${pct == null ? "width:100%" : "width:" + pct + "%"}></div></div><span class="setupbar-lbl">${pct == null ? html`<${Spinner} size=${11}/> ` : pct + "% · "}${sp.phase}</span></div>`; })()}
    <div class="dstream" ref=${streamRef} onScroll=${onScroll}>
      ${stream.length ? stream.map((a, idx) => { const ts = a.ts || (a.created_at ? new Date(a.created_at).getTime() : 0); const tstr = ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "";
        // "progress" = a single self-updating meter row (SSE replaces same-label ticks upstream).
        if (a.kind === "progress") return html`<div key=${idx} class="l tool lprog">${tstr ? html`<span class="l-ts">${tstr}</span> ` : null}<span class="lprog-lbl">${a.text}</span><span class="lprog-track"><span class="lprog-fill" style=${"width:" + (a.pct || 0) + "%"}></span></span><span class="lprog-pct">${a.pct != null ? a.pct + "%" : ""}</span></div>`;
        return html`<div key=${idx} class=${"l " + (a.kind === "tool" ? "tool" : a.kind === "start" || a.kind === "done" ? "muted" : a.kind === "delta" ? "delta" : "")}>${tstr ? html`<span class="l-ts">${tstr}</span> ` : null}${a.text}</div>`; }) : html`<div class="l muted">${startError ? "Failed to start." : "No live activity yet."}</div>`}
      ${!streamAtBottom ? html`<div class="scroll-fab-wrap"><button class="iconbtn scroll-fab" title="Scroll to bottom" onClick=${() => { const el = streamRef.current; if (el) el.scrollTop = el.scrollHeight; }}><${Icon} name="chevdown" size=${14}/></button></div>` : null}
    </div>
  </div>`;
}
