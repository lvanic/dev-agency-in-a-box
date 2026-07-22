// Organism — IssueComposer (exported as `Composer`). Extracted from organisms/Detail.js (P6 split);
// logic unchanged. The "New issue" modal: repo/agent/model pickers, per-step model overrides for a
// selected workflow, title, and the markdown body composer with attachments.
import { html, useState, useEffect, useRef } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { ProviderLogo } from "../atoms/ProviderLogo.js";
import { Select } from "../atoms/Select.js";
import { Modal } from "../atoms/Modal.js";
import { MarkdownArea } from "../atoms/MarkdownArea.js";
import { ModelSelect } from "../molecules/ModelSelect.js";
import { AttachmentThumbs } from "../molecules/AttachmentThumbs.js";
import { stepModelTargets } from "../molecules/DetailTimeline.js";
import { toast, readAttach } from "../../lib/toast.js";
import { defaultModelLabel, parseModelRef } from "../../lib/model-logic.js";
import { agentOptions } from "../../lib/agent-options.js";

export function Composer({ repos, repo, setRepo, onClose, onCreate, data, onOpenModels }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const ndraftKey = "draft:newissue:" + (repo || "_");
  useEffect(() => { try { const d = JSON.parse(localStorage.getItem(ndraftKey) || "{}"); if (d.title) setTitle(d.title); if (d.body) setBody(d.body); } catch (e) {} }, [ndraftKey]);
  useEffect(() => { try { if (title || body) localStorage.setItem(ndraftKey, JSON.stringify({ title, body })); else localStorage.removeItem(ndraftKey); } catch (e) {} }, [title, body, ndraftKey]);
  const [role, setRole] = useState((data && data.config && data.config.newIssueDefault) || "@dev");
  const [atts, setAtts] = useState([]);
  const providers = data?.providers || [];
  const anyModels = providers.some((p) => (p.models || []).length);
  // Issue model: "" = default (resolves per agent's own setting), "@individual" = per-agent pickers,
  // else a concrete providerId/model that overrides the WHOLE issue. Default is "" so the picker reads
  // "Default" (not a pinned provider) — each step then uses its own configured model.
  const [model, setModel] = useState("");
  // Per-step model overrides when a WORKFLOW is selected — keyed by the step's resolution key
  // (built-in role name, or a custom agent's handle without @), matching resolveAssignment on the server.
  const selWf = (role || "").startsWith("@") ? (data && data.workflows || []).find((w) => w.trigger === role) : null;
  const wfSteps = selWf ? stepModelTargets(selWf, data && data.agentDefs, data) : [];
  const individual = model === "@individual";
  const [stepModels, setStepModels] = useState({});
  const taRef = useRef(null);
  function submit(start) {
    if (!repo || !title.trim()) { toast("Repo + title needed"); return; }
    // A concrete whole-issue model wins; "Default"/"Individual" leave it unset (per-agent settings apply).
    let modelOverride = null;
    if (model && !individual) {
      const [providerId, mName] = model.split("/");
      modelOverride = { providerId, model: mName };
    }
    // Per-agent picks only when "Individual" is chosen; collect for THIS workflow's steps (dedup by key).
    const agentModels = {};
    if (individual) for (const s of wfSteps) { const v = stepModels[s.key]; if (v) agentModels[s.key] = v; }
    onCreate(repo, role, title.trim(), body.trim(), start, atts.map((a) => ({ dataUrl: a.d, name: a.name, refId: a.refId })), modelOverride, Object.keys(agentModels).length ? agentModels : null);
    try { localStorage.removeItem(ndraftKey); } catch (e) {}
  }
  function pick(e) { const fs = e.target.files || []; for (let i = 0; i < fs.length; i++) readAttach(fs[i], (a) => setAtts((x) => x.concat(a))); e.target.value = ""; }
  function onPaste(e) {
    const items = (e.clipboardData || {}).items || [];
    const files = [];
    for (let i = 0; i < items.length; i++) if (items[i].kind === "file") { const f = items[i].getAsFile(); if (f) files.push(f); }
    if (!files.length) return; // plain text paste — let the browser handle it
    // Handle the file(s) ourselves; stop the browser ALSO pasting the clipboard's text/plain (the
    // local file PATH from tools like Clop), which raced our token and corrupted the caret.
    e.preventDefault();
    for (const file of files) {
      if (/^image\//.test(file.type)) {
        const imgNum = atts.filter((a) => a.img).length + 1;
        const refId = "image " + imgNum;
        const ta = taRef.current;
        if (ta) {
          const start = ta.selectionStart || 0, end = ta.selectionEnd || 0;
          const token = "[" + refId + "]";
          setBody((prev) => prev.slice(0, start) + token + prev.slice(end));
          requestAnimationFrame(() => { if (ta) { const pos = start + token.length; ta.selectionStart = ta.selectionEnd = pos; ta.focus(); } });
        }
        readAttach(file, (a) => setAtts((x) => x.concat(Object.assign({}, a, { name: refId, refId }))));
      } else {
        readAttach(file, (a) => setAtts((x) => x.concat(a)));
      }
    }
  }
  const footer = html`
    <label class="composer-icon tip" data-tip="Attach a file" style="margin-right:auto"><${Icon} name="paperclip" size=${18}/><input type="file" multiple style="display:none" onChange=${pick}/></label>
    <button class="btn" onClick=${() => submit(false)}>Add to Planned</button>
    <button class="btn primary" onClick=${() => submit(true)}><${Icon} name="play" size=${15}/> Start now</button>`;
  return html`<${Modal} title="New issue" size="lg" onClose=${onClose} footer=${footer}>
    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <${Select} value=${repo || ""} options=${repos.map((r) => ({ value: r, label: r.split("/").pop() }))} onChange=${setRepo}/>
      <${Select} value=${role} options=${agentOptions(data && data.agentDefs, data && data.workflows)} onChange=${setRole}/>
      ${html`<${ModelSelect} providers=${providers} data=${data} value=${model} btnClass="iconbtn-sm" onChange=${setModel} onSetUp=${onOpenModels}
        includeDefault=${true} defaultLabel="Default model"
        extraOptions=${selWf ? [{ value: "@individual", label: "Individual per agent", hint: "set each step", icon: "users" }] : []}
        trigger=${(cur) => (cur && cur.logo)
          ? html`<span class="tip" data-tip=${cur.label} style="display:inline-flex"><${ProviderLogo} name=${cur.logo} size=${16}/></span>`
          : (cur && cur.icon === "users")
          ? html`<span class="tip" data-tip="Individual model per agent" style="display:inline-flex"><${Icon} name="users" size=${16}/></span>`
          : html`<span class="tip" data-tip=${"Default model · " + defaultModelLabel(data)} style="display:inline-flex"><${Icon} name="sparkles" size=${16}/></span>`}/>`}
    </div>
    ${individual && wfSteps.length && anyModels ? html`<div class="setgrp" style="margin-bottom:10px">
      <div class="muted" style="font-size:12px;margin-bottom:10px">Model per step — the dot opens the picker; blank keeps each agent’s configured model.</div>
      <div style="display:flex;flex-wrap:wrap;gap:16px;justify-content:flex-start">
      ${wfSteps.map((s) => {
        const curVal = stepModels[s.key] || "";
        const curRef = curVal ? parseModelRef(curVal) : null;
        const curProvider = curRef ? (providers.find((p) => p.id === curRef.providerId) || {}).name : "";
        // Override picked → show that; else the agent's own configured model; else true default.
        const effProvider = curProvider || s.dfltProvider;
        const effShort = curRef ? curRef.model : (s.dfltShort || "Default");
        return html`<div key=${s.key} style="display:flex;flex-direction:column;align-items:center;gap:4px;width:88px;text-align:center">
          <${ModelSelect} providers=${providers} data=${data} value=${curVal} menuAlign="left" btnClass="iconbtn-sm" onSetUp=${onOpenModels}
            includeDefault=${true} defaultLabel=${s.dflt || "Default"} defaultHint=${s.dfltProvider || defaultModelLabel(data)}
            onChange=${(v) => setStepModels((m) => Object.assign({}, m, { [s.key]: v }))}
            trigger=${() => effProvider
              ? html`<span class="tip" data-tip=${effShort} style="display:inline-flex"><${ProviderLogo} name=${effProvider} size=${16}/></span>`
              : html`<span class="tip" data-tip=${s.dflt || ("Default · " + defaultModelLabel(data))} style="display:inline-flex"><${Icon} name="sparkles" size=${16}/></span>`}/>
          <span style="font-size:12px;font-weight:600;line-height:1.2">${s.label}</span>
          <span style="font-size:11px;color:var(--ink-3);line-height:1.2;word-break:break-word">${effShort}</span>
        </div>`;
      })}
      </div>
    </div>` : null}
    <input value=${title} onInput=${(e) => setTitle(e.target.value)} placeholder="What should it do?" style="margin-bottom:10px;font-size:15px;padding:10px 12px"/>
    <div class="composer composer-lg">
      <${AttachmentThumbs} atts=${atts} onReorder=${setAtts} onRemove=${(idx) => setAtts((x) => x.filter((_, j) => j !== idx))}/>
      <${MarkdownArea} value=${body} taRef=${taRef} rows=${6} maxHeight=${400} placeholder="Details, context, acceptance criteria…  (Cmd+Enter starts, paste image to embed)" onInput=${(v) => setBody(v)} onPaste=${onPaste} onKeyDown=${(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(true); } }}/>
    </div>
  <//>`;
}
