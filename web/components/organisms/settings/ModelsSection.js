// Settings tab — Models & providers. Extracted from organisms/Settings.js (P6 split); logic
// unchanged. Provider list (with per-model checkmarks, tiers, live discovery) + the global
// default/fallback-chain routing controls + the inline "Add provider" flow.
import { html, useState, useEffect } from "/web/vendor/standalone.mjs";
import { Icon } from "../../atoms/Icon.js";
import { Spinner } from "../../atoms/Spinner.js";
import { Select } from "../../atoms/Select.js";
import { ProviderLogo } from "../../atoms/ProviderLogo.js";
import { ModelSelect } from "../../molecules/ModelSelect.js";
import { ProviderSearchSelect } from "../../molecules/ProviderSearchSelect.js";
import { api, getJSON } from "../../../lib/api.js";
import { sortModelsByRecency } from "../../../lib/model-recency.js";
import { toast } from "../../../lib/toast.js";
import { OB_PROVIDERS } from "../../../data/providers.js";
import { useAutoSave, saved, failed } from "./shared.js";

export function ModelsSection({ reload, secretKeys }) {
  const [providers, setProvidersState] = useState([]);
  const [autoSwitch, setAutoSwitch] = useState(false);
  const [chain, setChain] = useState([]);
  const [globalModel, setGlobalModel] = useState(null);
  const [open, setOpen] = useState(""); // expanded provider id
  const [adding, setAdding] = useState(false);
  function refresh() {
    getJSON("/models").then((d) => {
      setProvidersState(d.providers || []);
      setAutoSwitch(d.autoSwitchOnLimit || false);
      setChain(d.fallbackChain || []);
      setGlobalModel(d.globalModel || null);
    }).catch(() => {});
  }
  useEffect(refresh, []);
  // Auto-save: any provider-list mutation persists the whole list (the server stores it wholesale).
  function saveProviders(list) {
    setProvidersState(list);
    return api("/models", { providers: list.map(stripAuth) }).then(saved).then(() => { reload(); }).catch(failed);
  }
  const stripAuth = (p) => { const { auth, ...rest } = p; return rest; };
  function patchProvider(id, patch) { saveProviders(providers.map((p) => (p.id === id ? { ...p, ...patch } : p))); }
  function removeProvider(p) {
    if (!window.confirm("Remove " + p.name + "?")) return;
    saveProviders(providers.filter((x) => x.id !== p.id));
  }
  function saveRouting(patch) {
    api("/models", patch).then(saved).catch(failed);
  }
  const globalDefaultLabel = (globalModel && globalModel.model) ? "Default (role defaults)" : "Default (set up a provider first)";
  return html`<div>
    <div class="sec">Providers</div>
    <div class="muted" style="font-size:12px;margin-bottom:8px">Every provider — Claude included — carries its full discovered catalog. Tick the models you want offered in pickers; untick to hide. Edits save instantly.</div>
    ${providers.map((p) => html`<${ProviderCard} key=${p.id} p=${p} open=${open === p.id} onToggle=${() => setOpen(open === p.id ? "" : p.id)} onPatch=${(patch) => patchProvider(p.id, patch)} onRemove=${() => removeProvider(p)} onDiscovered=${refresh}/>`)}
    ${!providers.length ? html`<div class="muted" style="font-size:12.5px;padding:8px 2px">No providers yet — add one below (or add a Claude credential under Add provider).</div>` : null}
    ${adding
      ? html`<${AddProvider} existing=${providers} onClose=${() => setAdding(false)} onSaved=${() => { setAdding(false); refresh(); reload(); }}/>`
      : html`<button class="btn primary" style="width:100%;justify-content:center;margin:10px 0 4px" onClick=${() => setAdding(true)}><${Icon} name="plus" size=${15}/> Add provider</button>`}
    ${secretKeys.includes("claude_token") || secretKeys.includes("anthropic_api_key") ? html`<div class="muted" style="font-size:11px;margin-top:4px">Claude credential: ${secretKeys.includes("claude_token") ? "subscription token" : "API key"} saved — manage it under GitHub? No: remove via Add provider → Claude, or Account.</div>` : null}

    <div class="sec" style="margin-top:20px">Global default & rate limit</div>
    <label style="margin-top:4px;display:block">Global default model</label>
    <div style="margin-bottom:10px"><${ModelSelect} providers=${providers} value=${globalModel} includeDefault=${true} defaultLabel=${globalDefaultLabel} defaultIcon="flask" emit="object" onChange=${(v) => { setGlobalModel(v); saveRouting({ globalModel: v }); }}/></div>
    <label class="ckline"><input type="checkbox" checked=${autoSwitch} onChange=${(e) => { setAutoSwitch(e.target.checked); saveRouting({ autoSwitchOnLimit: e.target.checked }); }}/> Auto-switch to fallback model on usage limit</label>
    <label style="margin-top:8px">Fallback chain (tried in order when the primary is rate-limited)</label>
    ${chain.map((entry, idx) => html`<div key=${idx} style="display:flex;gap:6px;align-items:center;margin-bottom:5px">
      <${ModelSelect} providers=${providers} value=${entry} onChange=${(v) => { if (!v) return; const parts = v.split("/"); const next = chain.map((e, i) => (i === idx ? { providerId: parts[0], model: parts.slice(1).join("/") } : e)); setChain(next); saveRouting({ fallbackChain: next }); }}/>
      <button class="iconbtn" title="Remove" onClick=${() => { const next = chain.filter((_, i) => i !== idx); setChain(next); saveRouting({ fallbackChain: next }); }}><${Icon} name="trash" size=${15}/></button>
    </div>`)}
    <button class="btn ghost" style="margin-bottom:4px" onClick=${() => {
      const first = providers.find((p) => (p.models || []).length);
      if (!first) { toast("Add a provider first"); return; }
      const next = chain.concat({ providerId: first.id, model: (first.activeModels && first.activeModels[0]) || first.models[0] });
      setChain(next); saveRouting({ fallbackChain: next });
    }}><${Icon} name="plus" size=${14}/> Add fallback</button>
  </div>`;
}

// One provider row: header (logo, name, active/total counts) + expandable detail with the API key,
// the model CHECKMARK list (activate/deactivate per model), tier slots, and live re-discovery.
function ProviderCard({ p, open, onToggle, onPatch, onRemove, onDiscovered }) {
  const later = useAutoSave();
  const [discovering, setDiscovering] = useState(false);
  const [newModel, setNewModel] = useState("");
  const models = sortModelsByRecency(p.models || []); // newest first
  const active = p.activeModels || null; // null = all active, [] = none ("Untick all")
  const isActive = (m) => !active || active.indexOf(m) >= 0;
  const claudeNative = !p.apiKey && !p.piKey;
  function toggleModel(m) {
    const cur = active || models.slice();
    const next = isActive(m) ? cur.filter((x) => x !== m) : cur.concat(m);
    // All ticked → store nothing (= all), so newly discovered models arrive active by default.
    onPatch({ activeModels: next.length >= models.length ? undefined : next });
  }
  function addModel() {
    const m = newModel.trim();
    if (!m || models.indexOf(m) >= 0) { setNewModel(""); return; }
    onPatch({ models: models.concat(m), ...(active ? { activeModels: active.concat(m) } : {}) });
    setNewModel("");
  }
  function discover() {
    if (discovering) return;
    setDiscovering(true);
    api("/discover-models", { id: p.id }).then((r) => {
      if (r && r.ok) { toast("Discovered " + (r.models || []).length + " models"); onDiscovered(); }
      else toast((r && r.error) || "Couldn't discover models", "error");
    }).catch(() => toast("Couldn't discover models", "error")).finally(() => setDiscovering(false));
  }
  const tiers = p.tiers || {};
  const TIER_OPTS = [{ value: "", label: "(none)" }].concat(models.map((m) => ({ value: m, label: m })));
  const setTier = (t, v) => {
    const next = { ...(p.tiers || {}) };
    if (v) next[t] = { model: v }; else delete next[t];
    onPatch({ tiers: Object.keys(next).length ? next : undefined });
  };
  const activeCount = active ? active.length : models.length;
  return html`<div class="provcard">
    <button class="provcard__h" onClick=${onToggle}>
      <${ProviderLogo} name=${p.name} size=${16}/> <b>${p.name}</b>
      <span class="muted" style="font-size:11px">${activeCount}/${models.length} model${models.length === 1 ? "" : "s"} active${claudeNative ? " · subscription" : ""}</span>
      <span style="flex:1"></span>
      <${Icon} name="chevdown" size=${14} cls=${open ? "rot180" : ""}/>
    </button>
    ${open ? html`<div class="provcard__body">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div><label>Name</label><input value=${p.name || ""} onInput=${(e) => later(() => onPatch({ name: e.target.value }))}/></div>
        ${claudeNative
          ? html`<div><label>Credential</label><div class="muted" style="font-size:12px;padding-top:9px">Claude subscription / Anthropic key (Account section)</div></div>`
          : html`<div><label>API key</label><input type="password" autocomplete="off" placeholder=${p.apiKey ? "•••••• saved — type to replace" : "paste key"} onInput=${(e) => later(() => onPatch({ apiKey: e.target.value }))}/></div>`}
      </div>
      <div class="sec" style="margin-top:14px;display:flex;align-items:center;gap:8px"><span>Models</span>
        <span class="muted" style="text-transform:none;font-weight:400;font-size:11px">tick = offered in pickers · newest first</span>
        <button class="btn ghost" style="padding:3px 10px;font-size:12px;margin-left:auto" disabled=${!activeCount} onClick=${() => onPatch({ activeModels: [] })}>Untick all</button>
        <button class="btn ghost" style="padding:3px 10px;font-size:12px" disabled=${activeCount >= models.length} onClick=${() => onPatch({ activeModels: undefined })}>Tick all</button>
        <button class="btn ghost" style="padding:3px 10px;font-size:12px" disabled=${discovering} onClick=${discover}>${discovering ? html`<${Spinner} size=${12}/> Discovering…` : html`<${Icon} name="refresh" size=${12}/> Refresh catalog`}</button>
      </div>
      <div class="provmodels">
        ${models.map((m) => html`<label key=${m} class=${"ckline provmodel" + (isActive(m) ? "" : " off")}>
          <input type="checkbox" checked=${isActive(m)} onChange=${() => toggleModel(m)}/> <span class="provmodel__id">${m}</span>
          <button class="iconbtn provmodel__del tip" data-tip="Delete from the list" onClick=${(e) => { e.preventDefault(); onPatch({ models: models.filter((x) => x !== m), ...(active ? { activeModels: active.filter((x) => x !== m) } : {}) }); }}><${Icon} name="x" size=${11}/></button>
        </label>`)}
        ${!models.length ? html`<div class="muted" style="font-size:12px;padding:4px 2px">No models yet — Refresh catalog, or add one below.</div>` : null}
      </div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <input style="flex:1" placeholder="add a model id manually…" value=${newModel} onInput=${(e) => setNewModel(e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter") addModel(); }}/>
        <button class="btn" onClick=${addModel}><${Icon} name="plus" size=${13}/> Add</button>
      </div>
      <div class="sec" style="margin-top:14px">Tiers <span class="muted" style="text-transform:none;font-weight:400">— High / Medium / Low slots for the per-agent picker</span></div>
      ${["high", "medium", "low"].map((t) => html`<div key=${t} style="display:grid;grid-template-columns:64px 1fr;gap:8px;align-items:center;margin-bottom:6px">
        <span style="text-transform:capitalize;font-size:13px;color:var(--ink-2)">${t}</span>
        <${Select} value=${(tiers[t] || {}).model || ""} options=${TIER_OPTS} onChange=${(v) => setTier(t, v)}/>
      </div>`)}
      <button class="btn ghost" style="margin-top:10px;color:var(--red)" onClick=${onRemove}><${Icon} name="trash" size=${14}/> Remove provider</button>
    </div>` : null}
  </div>`;
}

// Add a provider inline (no nested modal): search-pick it, paste its key. Claude credentials are
// stored as secrets; the Claude provider row then appears automatically with the full catalog.
function AddProvider({ existing, onClose, onSaved }) {
  const [pid, setPid] = useState("");
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const def = OB_PROVIDERS.find((p) => p.id === pid);
  const opts = OB_PROVIDERS.map((p) => ({ id: p.id, label: p.label, logo: p.label }));
  function save() {
    if (!def || busy) return;
    setBusy(true);
    if (def.kind === "secret") {
      if (!val.trim()) { toast("Paste the token"); setBusy(false); return; }
      api("/user-secret", { key: def.secretKey, value: val.trim() }).then(() => { toast("Saved " + def.label); onSaved(); }).catch(() => toast("Couldn't save", "error")).finally(() => setBusy(false));
      return;
    }
    if (!def.piKey || !val.trim()) { toast("Pick a provider and paste its key"); setBusy(false); return; }
    const prov = { id: def.id + "-" + Date.now().toString(36), name: def.label, piKey: def.piKey, apiKey: val.trim(), models: [] };
    api("/models", { providers: (existing || []).map(({ auth, ...r }) => r).concat(prov) }).then(() => {
      toast("Added " + prov.name + " — discovering models…");
      api("/discover-models", { id: prov.id })
        .then((r) => toast(r && r.ok ? "Discovered " + (r.models || []).length + " models" : (r && r.error) || "No models discovered", r && r.ok ? "" : "error"))
        .catch(() => toast("Couldn't discover models", "error"))
        .finally(() => { setBusy(false); onSaved(); });
    }).catch(() => { toast("Couldn't save", "error"); setBusy(false); });
  }
  return html`<div class="provcard" style="padding:12px">
    <div class="sec" style="margin-top:0">Add provider</div>
    <${ProviderSearchSelect} value=${pid} options=${opts} onChange=${(v) => { setPid(v); setVal(""); }}/>
    ${def ? html`
      <label style="margin-top:10px">${def.kind === "secret" ? "Token" : "API key"}</label>
      <div style="display:flex;gap:8px">
        <input type="password" autocomplete="off" style="flex:1" placeholder=${def.placeholder || "key"} value=${val} onInput=${(e) => setVal(e.target.value)}/>
        ${def.link ? html`<button class="btn" onClick=${() => window.open(def.link, "_blank", "noopener")}><${Icon} name="link" size=${14}/> Get key</button>` : null}
      </div>
      ${def.how ? html`<div class="muted" style="font-size:11px;margin-top:8px;white-space:pre-wrap">${def.how}</div>` : null}` : html`<div class="muted" style="font-size:12px;margin-top:8px">Search for a provider (Claude, Gemini, GLM, DeepSeek, OpenAI…).</div>`}
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn" style="flex:1;justify-content:center" onClick=${onClose}>Cancel</button>
      <button class="btn primary" style="flex:1;justify-content:center" disabled=${!def || busy} onClick=${save}>${busy ? html`<${Spinner} size=${14}/>` : "Add"}</button>
    </div>
  </div>`;
}
