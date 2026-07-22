// Settings tab — Environments (language toolchains). Extracted from organisms/Settings.js (P6
// split); logic unchanged. Install SDKs (Flutter, Rust…) persistently so agents can verify those
// app types in-agency. Agents that hit a missing toolchain pause their issue and raise a request
// that shows up here.
import { html, useState, useEffect } from "/web/vendor/standalone.mjs";
import { Icon } from "../../atoms/Icon.js";
import { Spinner } from "../../atoms/Spinner.js";
import { api, getJSON } from "../../../lib/api.js";
import { toast } from "../../../lib/toast.js";
import { failed } from "./shared.js";

export function EnvironmentsSection({ admin }) {
  const [tc, setTc] = useState(null);
  const [busy, setBusy] = useState({});
  const [live, setLive] = useState({}); // id -> { pct, phase, log:[] } from the SSE stream
  const load = () => getJSON("/toolchains").then((d) => {
    setTc(d);
    // Seed the bar from the snapshot so opening the tab mid-install shows progress at once.
    setLive((prev) => {
      const next = { ...prev };
      (d.toolchains || []).forEach((t) => { if (t.progress && !next[t.id]) next[t.id] = { pct: t.progress.pct, phase: t.progress.phase, log: t.progress.log || [] }; });
      return next;
    });
  }).catch(() => setTc({ toolchains: [], dir: "" }));
  useEffect(() => { load(); }, []);
  // Live install stream: progress %, log lines, and the terminal status (→ reload for version).
  useEffect(() => {
    let es;
    try {
      es = new EventSource("/toolchain-events");
      es.onmessage = (ev) => {
        try {
          const e = JSON.parse(ev.data);
          if (!e || !e.id) return;
          if (e.kind === "progress") setLive((p) => ({ ...p, [e.id]: { ...(p[e.id] || { log: [] }), pct: e.pct, phase: e.phase } }));
          else if (e.kind === "log") setLive((p) => { const cur = p[e.id] || { pct: 0, phase: "", log: [] }; return { ...p, [e.id]: { ...cur, log: cur.log.concat(e.line).slice(-120) } }; });
          else if (e.kind === "status" && (e.status === "ready" || e.status === "failed")) { if (e.status === "ready") toast(e.id + " installed"); load(); }
        } catch (err) {}
      };
    } catch (err) {}
    return () => { try { es && es.close(); } catch (err) {} };
  }, []);
  const install = (id) => {
    setBusy((b) => ({ ...b, [id]: true }));
    setLive((p) => ({ ...p, [id]: { pct: 0, phase: "Starting…", log: [] } }));
    api("/install-toolchain", { id })
      .then(() => toast("Installing " + id + "…"))
      .then(load)
      .catch(failed)
      .finally(() => setBusy((b) => ({ ...b, [id]: false })));
  };
  const remove = (id) => api("/toolchain-remove", { id }).then(() => { toast("Removed"); load(); }).catch(failed);
  if (!tc) return html`<div class="muted" style="display:flex;align-items:center;gap:6px"><${Spinner} size=${12}/> Loading…</div>`;
  const list = tc.toolchains || [];
  const presets = list.filter((t) => !t.custom), custom = list.filter((t) => t.custom);
  const rowProps = (t) => ({ t, admin, busy: busy[t.id], live: live[t.id], onInstall: () => install(t.id), onRemove: () => remove(t.id) });
  return html`<div>
    <div class="sec">Environments</div>
    <div class="muted" style="font-size:12px;margin-bottom:12px">Install language toolchains so agents can run checks for these app types in-agency. When a run needs one that isn't here, it pauses the issue and asks — no PR until the checks actually run. Installed to <code>${tc.dir}</code> (persists across redeploys).</div>
    ${presets.map((t) => TcRow(rowProps(t)))}
    ${custom.length ? html`<div class="sec" style="margin-top:18px">Custom (installed by hand)</div>${custom.map((t) => TcRow(rowProps(t)))}` : null}
    ${admin ? html`<${AddEnv} sharedBin=${tc.sharedBin} onAdded=${load}/>` : html`<div class="muted" style="font-size:12px;margin-top:10px">Only an admin can install environments.</div>`}
  </div>`;
}
function TcRow({ t, admin, busy, live, onInstall, onRemove }) {
  const ready = t.status === "ready", installing = t.status === "installing", failed = t.status === "failed";
  const prog = installing ? (live || t.progress) : null;
  const chip = ready
    ? html`<span class="statuschip s-ready"><${Icon} name="check" size=${12}/> ready</span>`
    : installing
    ? html`<span class="statuschip" style="display:inline-flex;align-items:center;gap:5px"><${Spinner} size=${12}/> installing…</span>`
    : failed
    ? html`<span class="statuschip s-changes"><${Icon} name="alert" size=${12}/> failed</span>`
    : html`<span class="statuschip s-attn">not installed</span>`;
  const reqs = t.requestedBy || [];
  return html`<div key=${t.id} style="display:flex;align-items:flex-start;gap:10px;padding:11px 0;border-top:1px solid var(--line,rgba(128,128,128,.18))">
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:8px;font-weight:600">${t.label} ${chip}</div>
      <div class="muted" style="font-size:12px;margin-top:2px">${t.note}</div>
      ${ready && t.version ? html`<div class="muted" style="font-size:11px;margin-top:2px">${t.version}</div>` : null}
      ${failed && t.error ? html`<div style="font-size:11px;margin-top:3px;color:var(--bad,#c33)">${t.error}</div>` : null}
      ${reqs.length ? html`<div style="font-size:11.5px;margin-top:5px">⏸ Requested by ${reqs.map((r) => (r.repo.split("/").pop()) + " #" + r.number).join(", ")}</div>` : null}
      ${prog ? html`<div style="margin-top:8px">
        <div class="muted" style="display:flex;justify-content:space-between;font-size:11px"><span>${prog.phase || "Working…"}</span><span>${prog.pct || 0}%</span></div>
        <div style="height:5px;border-radius:3px;background:var(--line,rgba(128,128,128,.2));overflow:hidden;margin-top:3px"><div style=${"height:100%;width:" + (prog.pct || 0) + "%;background:var(--accent,#3b82f6);transition:width .3s"}></div></div>
        ${prog.log && prog.log.length ? html`<pre style="margin:6px 0 0;max-height:110px;overflow:auto;font-size:10.5px;line-height:1.45;background:var(--code-bg,rgba(128,128,128,.08));border-radius:5px;padding:6px 8px;white-space:pre-wrap;word-break:break-all">${prog.log.slice(-8).join("\n")}</pre>` : null}
      </div>` : null}
    </div>
    ${admin ? html`<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
      <button class=${"btn" + (ready ? " ghost" : " primary")} style="padding:4px 12px;font-size:12px;white-space:nowrap" disabled=${busy || installing} onClick=${onInstall}>${installing ? "Installing…" : ready ? "Reinstall" : reqs.length ? "Install now" : "Install"}</button>
      ${t.custom && !installing ? html`<button class="btn ghost" style="padding:2px 10px;font-size:11px" onClick=${onRemove}>Remove</button>` : null}
    </div>` : null}
  </div>`;
}
// "Install by hand": run a raw terminal command on the host to provision an environment we don't ship.
function AddEnv({ sharedBin, onAdded }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ label: "", install: "", check: "", binary: "", note: "", start: true });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = () => {
    if (!f.label.trim() || !f.install.trim()) return toast("Name and install command are required", "error");
    setBusy(true);
    api("/toolchain-add", f)
      .then(() => { toast("Environment added"); setF({ label: "", install: "", check: "", binary: "", note: "", start: true }); setOpen(false); onAdded(); })
      .catch(failed).finally(() => setBusy(false));
  };
  if (!open) return html`<button class="btn ghost" style="margin-top:14px;font-size:12px" onClick=${() => setOpen(true)}><${Icon} name="plus" size=${13}/> Add environment by hand</button>`;
  return html`<div style="margin-top:14px;border:1px solid var(--line,rgba(128,128,128,.2));border-radius:8px;padding:12px">
    <div style="font-weight:600">Custom environment</div>
    <div class="muted" style="font-size:11.5px;margin:2px 0 10px">Runs your command on the agency host as the <code>node</code> user. Drop the binary into <code>${sharedBin || "$TOOLCHAINS_DIR/bin"}</code> (already on PATH) so agents can use it. Everything under the data volume persists across redeploys.</div>
    <label>Name</label>
    <input value=${f.label} onInput=${set("label")} placeholder="e.g. Zig"/>
    <label style="margin-top:8px">Install command (bash)</label>
    <textarea rows="4" value=${f.install} onInput=${set("install")} placeholder="set -e&#10;curl -fsSL … -o \"$TOOLCHAINS_DIR/bin/zig\" && chmod +x \"$TOOLCHAINS_DIR/bin/zig\"" style="width:100%;box-sizing:border-box;font-family:ui-monospace,monospace;font-size:11.5px"></textarea>
    <div style="display:flex;gap:10px;margin-top:8px">
      <div style="flex:1"><label>Binary (optional)</label><input value=${f.binary} onInput=${set("binary")} placeholder="zig"/></div>
      <div style="flex:1"><label>Check command (optional)</label><input value=${f.check} onInput=${set("check")} placeholder="command -v zig"/></div>
    </div>
    <label style="margin-top:8px">What it unlocks (optional)</label>
    <input value=${f.note} onInput=${set("note")} placeholder="Zig projects — zig build test"/>
    <label class="ckline" style="margin-top:10px"><input type="checkbox" checked=${f.start} onChange=${(e) => setF((x) => ({ ...x, start: e.target.checked }))}/> Install now</label>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn primary" disabled=${busy} onClick=${submit}>${busy ? "Adding…" : "Add environment"}</button>
      <button class="btn ghost" onClick=${() => setOpen(false)}>Cancel</button>
    </div>
  </div>`;
}
