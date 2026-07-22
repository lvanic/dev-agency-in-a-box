// Settings tab — Memory (prime-time-plan P4.9): the human-readable/editable knowledge base.
// Lists the markdown that defines and teaches the agents (Constitution, personas, playbooks,
// learned notes) and edits them through the agent-editor API that already existed server-side
// with no UI reaching it — GET /agents (list), GET /agent?path= (content + revisions),
// POST /agent-save (live override, versioned), POST /agent-revert (drop override → on-disk
// default). Edits apply live (no redeploy); every change is kept in agent_revisions history.
// Relocated from organisms/MemorySettings.js into organisms/settings/ (P6 split); logic unchanged.
import { html, useState, useEffect, useRef } from "/web/vendor/standalone.mjs";
import { Icon } from "../../atoms/Icon.js";
import { Spinner } from "../../atoms/Spinner.js";
import { MarkdownArea } from "../../atoms/MarkdownArea.js";
import { api, getJSON } from "../../../lib/api.js";
import { toast } from "../../../lib/toast.js";

const GROUPS = [
  { k: "core", label: "Core" },
  { k: "persona", label: "Personas" },
  { k: "playbook", label: "Playbooks" },
  { k: "learning", label: "Learned" },
];

function timeAgo(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.round(hrs / 24) + "d ago";
}

export function MemorySection() {
  const [files, setFiles] = useState(null); // null = loading
  const [selected, setSelected] = useState(null); // path
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [revisions, setRevisions] = useState([]);
  const [loadingFile, setLoadingFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const taRef = useRef(null);

  const load = () => getJSON("/agents").then((d) => setFiles(d.files || [])).catch(() => setFiles([]));
  useEffect(() => { load(); }, []);

  function openFile(path) {
    setSelected(path);
    setLoadingFile(true);
    return getJSON("/agent?path=" + encodeURIComponent(path))
      .then((d) => { setContent(d.content || ""); setOriginal(d.content || ""); setRevisions(d.revisions || []); })
      .catch(() => { setContent(""); setOriginal(""); setRevisions([]); })
      .finally(() => setLoadingFile(false));
  }

  const dirty = Boolean(selected) && content !== original;

  function save() {
    if (!selected || !dirty || busy) return;
    setBusy(true);
    api("/agent-save", { path: selected, content })
      .then(() => { toast("Saved"); setOriginal(content); return load(); })
      .then(() => getJSON("/agent?path=" + encodeURIComponent(selected)))
      .then((d) => setRevisions((d && d.revisions) || []))
      .catch((e) => toast((e && e.message) || "Couldn't save", "error"))
      .finally(() => setBusy(false));
  }

  function revertToDefault() {
    if (!selected || busy) return;
    if (!window.confirm("Drop the live override and revert " + selected + " to its on-disk default?")) return;
    setBusy(true);
    api("/agent-revert", { path: selected })
      .then(() => { toast("Reverted to default"); return load(); })
      .then(() => openFile(selected))
      .catch((e) => toast((e && e.message) || "Couldn't revert", "error"))
      .finally(() => setBusy(false));
  }

  function restoreRevision(id) {
    if (!selected || busy) return;
    if (!window.confirm("Restore this version as the current content? (kept in history)")) return;
    setBusy(true);
    getJSON("/agent-revision?id=" + id)
      .then((d) => api("/agent-save", { path: selected, content: d.content || "" }))
      .then(() => { toast("Restored"); return load(); })
      .then(() => openFile(selected))
      .catch((e) => toast((e && e.message) || "Couldn't restore", "error"))
      .finally(() => setBusy(false));
  }

  if (!files) return html`<div class="muted" style="display:flex;align-items:center;gap:6px"><${Spinner} size=${12}/> Loading…</div>`;

  return html`<div>
    <div class="sec">Memory</div>
    <div class="muted" style="font-size:12px;margin-bottom:12px">The markdown that defines and teaches the agents — personas, playbooks, and what they've learned from real runs. Edits apply live (no redeploy); every change is kept in history.</div>
    <div class="memtab">
      <div class="memtab__list">
        ${GROUPS.map((g) => {
          const items = files.filter((f) => f.group === g.k);
          if (!items.length) return null;
          return html`<div key=${g.k}>
            <div class="memtab__group">${g.label}</div>
            ${items.map((f) => html`<button key=${f.path} class=${"memtab__file" + (selected === f.path ? " on" : "")} onClick=${() => openFile(f.path)}>
              <span class=${"memtab__badge" + (f.edited ? " on" : "")} data-tip=${f.edited ? "Has a live override (differs from the on-disk default)" : ""}></span>
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.label}</span>
            </button>`)}
          </div>`;
        })}
      </div>
      <div class="memtab__editor">
        ${!selected
          ? html`<div class="muted" style="font-size:12.5px;padding:20px 4px">Pick a file on the left to view or edit it.</div>`
          : loadingFile
          ? html`<div class="muted" style="display:flex;align-items:center;gap:6px;padding:20px 4px"><${Spinner} size=${12}/> Loading…</div>`
          : html`
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <div style="font-weight:600;font-size:12.5px;flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title=${selected}>${selected}</div>
              <button class="btn ghost" style="padding:3px 10px;font-size:12px" disabled=${busy} onClick=${revertToDefault}><${Icon} name="refresh" size=${13}/> Revert to default</button>
              <button class="btn primary" style="padding:3px 12px;font-size:12px" disabled=${busy || !dirty} onClick=${save}>${busy ? "Saving…" : "Save"}</button>
            </div>
            <${MarkdownArea} value=${content} taRef=${taRef} rows=${16} maxHeight=${480} placeholder="(empty)" onInput=${setContent} onKeyDown=${(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); save(); } }}/>
            ${revisions.length ? html`<div class="memtab__revs">
              <div class="memtab__group" style="margin-top:0">History</div>
              ${revisions.map((r) => html`<div key=${r.id} class="memtab__revrow">
                <span class="muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${timeAgo(r.created_at)} · ${r.source}${r.note ? " — " + r.note : ""}</span>
                <button class="btn ghost" style="padding:2px 8px;font-size:11px;white-space:nowrap" disabled=${busy} onClick=${() => restoreRevision(r.id)}><${Icon} name="history" size=${12}/> Restore</button>
              </div>`)}
            </div>` : null}
          `}
      </div>
    </div>
    <${VaultPanel}/>
  </div>`;
}

// ── Central Vault (docs/central-vault-plan.md, Phase 2) ────────────────────────────────────────────
// Durable machine-canonical shared knowledge, edited through the vault API: GET /vault (table),
// GET /vault-entry?key= (raw canonical + readable render + revisions), POST /vault-compress (prose →
// proposed canonical lines, cheap model), POST /vault-save (validate + upsert raw), POST /vault-delete.
const KIND_LABELS = { pref: "pref", know: "know", env: "env", gloss: "gloss" };
const BLANK_RAW = '{"v":1,"k":"new-key","t":"know","s":"*","c":"","w":2}';

function VaultPanel() {
  const [entries, setEntries] = useState(null); // null = loading
  const [sel, setSel] = useState(null); // { key } for existing, { key: null } for a new entry
  const [tab, setTab] = useState("readable"); // "readable" | "raw"
  const [raw, setRaw] = useState(""); // canonical line(s) — what actually gets saved
  const [prose, setProse] = useState(""); // Readable-tab draft fed to compress()
  const [preview, setPreview] = useState(null); // compressed canonical lines awaiting confirm
  const [revisions, setRevisions] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = () => getJSON("/vault").then((d) => setEntries(d.entries || [])).catch(() => setEntries([]));
  useEffect(() => { load(); }, []);

  function close() { setSel(null); setRaw(""); setProse(""); setPreview(null); setRevisions([]); }

  function openEntry(key) {
    setSel({ key }); setTab("raw"); setPreview(null); setProse("");
    return getJSON("/vault-entry?key=" + encodeURIComponent(key))
      .then((d) => { setRaw(d.raw || ""); setRevisions(d.revisions || []); })
      .catch(() => { setRaw(""); setRevisions([]); });
  }
  function openNew() { setSel({ key: null }); setTab("readable"); setRaw(BLANK_RAW); setProse(""); setPreview(null); setRevisions([]); }

  function saveRaw(rawText) {
    if (busy) return;
    setBusy(true);
    return api("/vault-save", { raw: rawText })
      .then(() => { toast("Saved"); setPreview(null); return load(); })
      .then(() => { close(); })
      .catch((e) => toast((e && e.message) || "Couldn't save", "error"))
      .finally(() => setBusy(false));
  }

  function compress() {
    if (busy || !prose.trim()) return;
    setBusy(true);
    const hints = (entries || []).map((e) => e.key);
    api("/vault-compress", { text: prose, hints })
      .then((d) => {
        const lines = (d && d.lines) || [];
        if (!lines.length) { toast("Nothing to store — try more detail", "error"); return; }
        setPreview(lines);
      })
      .catch((e) => toast((e && e.message) || "Compress failed", "error"))
      .finally(() => setBusy(false));
  }

  function del(key) {
    if (busy || !window.confirm("Delete vault entry " + key + "?")) return;
    setBusy(true);
    api("/vault-delete", { key })
      .then(() => { toast("Deleted"); return load(); })
      .then(() => close())
      .catch((e) => toast((e && e.message) || "Couldn't delete", "error"))
      .finally(() => setBusy(false));
  }

  if (!entries) return html`<div class="muted" style="display:flex;align-items:center;gap:6px;margin-top:20px"><${Spinner} size=${12}/> Loading vault…</div>`;

  return html`<div style="margin-top:24px;border-top:1px solid var(--line,#2a2a2a);padding-top:16px">
    <div style="display:flex;align-items:center;gap:8px">
      <div class="sec" style="flex:1">Vault</div>
      <button class="btn ghost" style="padding:3px 10px;font-size:12px" onClick=${openNew}><${Icon} name="plus" size=${13}/> Add</button>
    </div>
    <div class="muted" style="font-size:12px;margin-bottom:10px">Durable shared knowledge in the agency's compact canonical form (one JSON record per line) — preferences, environment facts, cross-project craft knowledge. This is what every agent reads; prose is a derived view.</div>
    ${!entries.length
      ? html`<div class="muted" style="font-size:12.5px;padding:8px 2px">No entries yet. They seed automatically from past runs; add one with <b>Add</b>.</div>`
      : html`<div class="memtab__revs" style="margin-top:0">
          <div class="vault-row vault-row--head">
            <span>key</span><span>kind</span><span>scope</span><span>role</span><span style="text-align:center">w</span><span>source</span>
          </div>
          ${entries.map((e) => html`<button key=${e.key} class=${"vault-row" + (sel && sel.key === e.key ? " on" : "")} onClick=${() => openEntry(e.key)}>
            <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis">${e.key}</span>
            <span class="muted">${KIND_LABELS[e.kind] || e.kind}</span>
            <span class="muted" style="overflow:hidden;text-overflow:ellipsis">${e.scope === "*" ? "global" : e.scope}</span>
            <span class="muted">${e.role || "—"}</span>
            <span style="text-align:center">${e.weight}</span>
            <span class="muted" style="overflow:hidden;text-overflow:ellipsis">${e.source}</span>
          </button>`)}
        </div>`}

    ${sel ? html`<div class="memtab__editor" style="margin-top:14px;border:1px solid var(--line,#2a2a2a);border-radius:8px;padding:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <div style="font-weight:600;font-size:12.5px;flex:1">${sel.key ? sel.key : "New entry"}</div>
        <div class="seg" style="display:flex;gap:4px">
          <button class=${"btn " + (tab === "readable" ? "primary" : "ghost")} style="padding:2px 10px;font-size:11.5px" onClick=${() => setTab("readable")}>Readable</button>
          <button class=${"btn " + (tab === "raw" ? "primary" : "ghost")} style="padding:2px 10px;font-size:11.5px" onClick=${() => setTab("raw")}>Raw</button>
        </div>
        ${sel.key ? html`<button class="btn ghost" style="padding:2px 10px;font-size:11.5px;color:var(--danger,#e5484d)" disabled=${busy} onClick=${() => del(sel.key)}><${Icon} name="trash" size=${12}/></button>` : null}
        <button class="btn ghost" style="padding:2px 8px;font-size:11.5px" onClick=${close}>Close</button>
      </div>

      ${tab === "raw"
        ? html`<div>
            <textarea class="ta" style="width:100%;min-height:88px;font-family:var(--mono,monospace);font-size:12px" value=${raw} onInput=${(e) => setRaw(e.target.value)} placeholder=${BLANK_RAW}></textarea>
            <div class="muted" style="font-size:11px;margin:4px 0 8px">One canonical record per line: {"v":1,"k":"…","t":"pref|know|env|gloss","s":"*","c":"…","w":1-3}. Issue/PR refs are rejected.</div>
            <button class="btn primary" style="padding:3px 12px;font-size:12px" disabled=${busy || !raw.trim()} onClick=${() => saveRaw(raw)}>${busy ? "Saving…" : "Save"}</button>
          </div>`
        : html`<div>
            <textarea class="ta" style="width:100%;min-height:88px;font-size:12.5px" value=${prose} onInput=${(e) => { setProse(e.target.value); setPreview(null); }} placeholder="Describe the knowledge in plain English — e.g. 'Always prefer pnpm over npm, lockfile v9, never yarn.' Then Compress to see the canonical record before saving."></textarea>
            <div style="display:flex;gap:8px;margin:6px 0">
              <button class="btn ghost" style="padding:3px 12px;font-size:12px" disabled=${busy || !prose.trim()} onClick=${compress}>${busy ? "Compressing…" : "Compress"}</button>
            </div>
            ${preview ? html`<div style="margin-top:4px">
              <div class="muted" style="font-size:11px;margin-bottom:4px">Will be stored (canonical diff — review before saving):</div>
              <pre class="vault-diff" style="background:var(--panel,#161616);border:1px solid var(--line,#2a2a2a);border-radius:6px;padding:8px;font-size:11.5px;overflow:auto;white-space:pre-wrap;word-break:break-all">${preview.join("\n")}</pre>
              <button class="btn primary" style="padding:3px 12px;font-size:12px;margin-top:6px" disabled=${busy} onClick=${() => saveRaw(preview.join("\n"))}>${busy ? "Saving…" : "Save these"}</button>
            </div>` : null}
          </div>`}

      ${revisions.length ? html`<div class="memtab__revs">
        <div class="memtab__group" style="margin-top:10px">History</div>
        ${revisions.map((r) => html`<div key=${r.id} class="memtab__revrow">
          <span class="muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${timeAgo(r.ts)} · ${r.source}</span>
          <button class="btn ghost" style="padding:2px 8px;font-size:11px;white-space:nowrap" disabled=${busy} onClick=${() => saveRaw(r.entry)}><${Icon} name="history" size=${12}/> Restore</button>
        </div>`)}
      </div>` : null}
    </div>` : null}
  </div>`;
}
