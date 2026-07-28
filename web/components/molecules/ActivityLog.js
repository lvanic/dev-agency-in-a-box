// ActivityLog molecule — the agent's live thought/tool stream, folded INSIDE the conversation as
// part of the agent's answer block (replaces the old StreamPane side pane + mobile "Stream" tab).
// Collapsed to a one-line summary by default; the header carries a live spinner + the latest event
// while the agent works, so progress stays visible without expanding. Click to unfold the full
// terminal log (setup-progress bar, timestamps, tool lines, typing deltas).
import { html, useState } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { Spinner } from "../atoms/Spinner.js";
import { getSetupProgress } from "../../lib/setup-progress.js";

export function ActivityLog({ stream, running, startError, streamRef, streamAtBottom, onScroll, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const evs = stream || [];
  const last = evs.length ? evs[evs.length - 1] : null;
  const sp = getSetupProgress(evs);
  // Collapsed one-liner: the most urgent thing first — error > setup phase > newest event.
  const preview = startError ? "⚠ " + startError
    : sp ? sp.phase + (sp.percent != null ? " · " + sp.percent + "%" : "")
    : last ? (last.text || "") : running ? "Starting…" : "No live activity yet.";
  return html`<div class=${"actlog" + (open ? " open" : "")}>
    <button class="actlog-h" aria-expanded=${open} onClick=${() => setOpen((o) => !o)}>
      ${running ? html`<${Spinner} size=${13}/>` : html`<${Icon} name="zap" size=${13}/>`}
      <span class="actlog-t">${running ? "Working" : "Activity"}</span>
      ${open ? html`<span style="flex:1"></span>` : html`<span class="actlog-last">${preview}</span>`}
      <${Icon} name=${open ? "chevup" : "chevdown"} size=${14}/>
    </button>
    ${open ? html`<div class="actlog-b">
      ${startError ? html`<div class="secbanner">⚠ ${startError}</div>` : null}
      ${sp ? html`<div class="setupbar" title=${sp.phase}><div class="setupbar-track"><div class="setupbar-fill" style=${sp.percent == null ? "width:100%" : "width:" + sp.percent + "%"}></div></div><span class="setupbar-lbl">${sp.percent == null ? html`<${Spinner} size=${11}/> ` : sp.percent + "% · "}${sp.phase}</span></div>` : null}
      <div class="dstream" ref=${streamRef} onScroll=${onScroll}>
        ${evs.length ? evs.map((a, idx) => { const ts = a.ts || (a.created_at ? new Date(a.created_at).getTime() : 0); const tstr = ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "";
          // "progress" = a single self-updating meter row (SSE replaces same-label ticks upstream).
          if (a.kind === "progress") return html`<div key=${idx} class="l tool lprog">${tstr ? html`<span class="l-ts">${tstr}</span> ` : null}<span class="lprog-lbl">${a.text}</span><span class="lprog-track"><span class="lprog-fill" style=${"width:" + (a.pct || 0) + "%"}></span></span><span class="lprog-pct">${a.pct != null ? a.pct + "%" : ""}</span></div>`;
          return html`<div key=${idx} class=${"l " + (a.kind === "tool" ? "tool" : a.kind === "start" || a.kind === "done" ? "muted" : a.kind === "delta" ? "delta" : "")}>${tstr ? html`<span class="l-ts">${tstr}</span> ` : null}${a.text}</div>`; }) : html`<div class="l muted">${startError ? "Failed to start." : "No live activity yet."}</div>`}
        ${!streamAtBottom ? html`<div class="scroll-fab-wrap"><button class="iconbtn scroll-fab" title="Scroll to bottom" onClick=${() => { const el = streamRef.current; if (el) el.scrollTop = el.scrollHeight; }}><${Icon} name="chevdown" size=${14}/></button></div>` : null}
      </div>
    </div>` : null}
  </div>`;
}
