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
  </div>`;
}
