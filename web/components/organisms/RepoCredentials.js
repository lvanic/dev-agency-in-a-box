// Organism — RepoCredentials (issue #263). Per-repo secrets the agents can USE without ever seeing
// where they're stored: paste `KEY=value` lines, they're encrypted at rest and injected into the
// agent run's env at run time. This component is UI only — parsing, encryption and masking all live
// server-side (creds.ts / db/settings.ts); it just posts the raw block to `/repo-creds` and renders
// the key NAMES + masked values the route returns. Plaintext is never sent back or shown again.
import { html, useState } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { Select } from "../atoms/Select.js";
import { api } from "../../lib/api.js";
import { toast } from "../../lib/toast.js";

export function RepoCredentials({ repos, repoCreds, reload }) {
  const list = repos || [];
  const [repo, setRepo] = useState(list[0] || "");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const active = list.includes(repo) ? repo : (list[0] || "");
  const keys = ((repoCreds || {})[active]) || [];

  function save() {
    if (!active || busy) return;
    setBusy(true);
    api("/repo-creds", { repo: active, creds: draft })
      .then((r) => { toast("Credentials saved for " + active); setDraft(""); reload(); return r; })
      .catch((e) => toast((e && e.message) || "Couldn’t save credentials", "error"))
      .then(() => setBusy(false));
  }

  if (!list.length) return null;
  return html`<div style="margin-top:18px">
    <div class="sec">Credentials</div>
    <div class="muted" style="font-size:12px;margin-bottom:8px">Secrets the agents can use for this repo (API keys, service logins, <b>.env</b> values) — one <code>KEY=value</code> per line. Stored <b>encrypted</b> and injected into the agent's environment at run time. The agent uses them by name; it never sees the values, and they’re never shown here again or written to chat.</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <${Icon} name="lock" size=${14}/>
      <${Select} value=${active} onChange=${setRepo} options=${list.map((r) => ({ value: r, label: r, icon: "pr" }))}/>
    </div>
    ${keys.length ? html`<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
      ${keys.map((k) => html`<span key=${k.key} class="apill off" style="cursor:default" data-tip="Set — value hidden"><${Icon} name="lock" size=${11}/> <span class="apill-label">${k.key}</span> <span class="muted">${k.masked}</span></span>`)}
    </div>` : html`<div class="muted" style="font-size:11.5px;margin-bottom:8px">No credentials yet for this repo.</div>`}
    <textarea class="ta" style="width:100%;min-height:96px;font-family:var(--mono,monospace);font-size:12px" placeholder=${"OPENAI_API_KEY=sk-…\nDATABASE_URL=postgres://…"} value=${draft} onInput=${(e) => setDraft(e.target.value)}></textarea>
    <div style="display:flex;justify-content:flex-end;margin-top:6px">
      <button class="btn primary" disabled=${busy || !draft.trim()} onClick=${save}><${Icon} name="lock" size=${13}/> Save credentials</button>
    </div>
  </div>`;
}
