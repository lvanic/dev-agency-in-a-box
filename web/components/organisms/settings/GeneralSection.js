// Settings tab — General. Extracted from organisms/Settings.js (P6 split); logic unchanged.
import { html, useState } from "/web/vendor/standalone.mjs";
import { Select } from "../../atoms/Select.js";
import { api } from "../../../lib/api.js";
import { toast } from "../../../lib/toast.js";
import { agentOptions } from "../../../lib/agent-options.js";
import { useAutoSave, saved, failed } from "./shared.js";
import { isSoundOn, setSoundOn, isSoundKindOn, setSoundKindOn, preview, SOUND_CUES } from "../../../lib/sound.js";

export function GeneralSection({ data, reload, admin }) {
  const cfg = data.config || {};
  const ops = data.ops || {};
  const later = useAutoSave();
  const [maxTok, setMaxTok] = useState(cfg.maxTokensPerRun || 600000);
  const [avatarsOn, setAvatarsOn] = useState(cfg.avatars !== "off");
  const [soundOn, setSoundOnState] = useState(isSoundOn());
  const [soundKinds, setSoundKinds] = useState(() => SOUND_CUES.reduce((m, c) => { m[c.key] = isSoundKindOn(c.key); return m; }, {}));
  const [selfImprove, setSelfImprove] = useState(ops.self_improve != null ? !!ops.self_improve : true);
  const [selfMergeHold, setSelfMergeHold] = useState(ops.self_merge_hold != null ? !!ops.self_merge_hold : true);
  const [newDefault, setNewDefault] = useState(cfg.newIssueDefault || "@dev");
  const [analyzerOn, setAnalyzerOn] = useState(ops.analyzer_enabled != null ? !!ops.analyzer_enabled : true);
  const [analyzerRepo, setAnalyzerRepo] = useState(ops.analyzer_repo || "");
  const [keyRevealed, setKeyRevealed] = useState(false);
  const analyzerKey = (data.analyzer && data.analyzer.keyForAdmin) || "";
  const [lazyOn, setLazyOn] = useState(ops.lazy_mode != null ? !!ops.lazy_mode : false);
  const [upstreamOn, setUpstreamOn] = useState(ops.upstream_contrib_enabled != null ? !!ops.upstream_contrib_enabled : false);
  const [upstreamRepo, setUpstreamRepo] = useState(ops.upstream_repo != null ? ops.upstream_repo : "ArneNostitz/dev-agency");
  const put = (body) => api("/settings", body).then(saved).then(reload).catch(failed);
  return html`<div>
    <div class="sec">Appearance</div>
    <label class="ckline"><input type="checkbox" checked=${avatarsOn} onChange=${(e) => { setAvatarsOn(e.target.checked); put({ avatars: e.target.checked ? "on" : "off" }); }}/> Show agent avatars (cards & comments)</label>
    <label class="ckline"><input type="checkbox" checked=${soundOn} onChange=${(e) => { const on = e.target.checked; setSoundOnState(on); setSoundOn(on); if (on) preview("done"); }}/> Sound effects (status chimes &amp; avatar voices)</label>
    <div class="muted" style="font-size:12px;margin-bottom:4px">Chimes when an issue needs you or finishes; hovering an avatar plays its character voice. Off by default; stored in this browser.</div>
    ${soundOn ? html`<div style="margin:2px 0 4px 20px">${SOUND_CUES.map((c) => html`
      <div class="ckline" style="display:flex;align-items:center;gap:8px">
        <label style="flex:1;margin:0"><input type="checkbox" checked=${soundKinds[c.key]} onChange=${(e) => { const on = e.target.checked; setSoundKinds((s) => ({ ...s, [c.key]: on })); setSoundKindOn(c.key, on); if (on) preview(c.sample); }}/> ${c.label}</label>
        <button type="button" class="btn" title="Preview" onClick=${() => preview(c.sample)}>▶</button>
      </div>`)}</div>` : null}

    <div class="sec" style="margin-top:18px">Run defaults</div>
    <label>New-issue default</label>
    <div class="muted" style="font-size:12px;margin-bottom:4px">What a new issue is assigned to when you open the composer.</div>
    <${Select} value=${newDefault} options=${agentOptions(data && data.agentDefs, data && data.workflows)} onChange=${(v) => { setNewDefault(v); put({ newIssueDefault: v }); }}/>
    <label style="margin-top:10px">Max tokens per run (0 = off)</label>
    <input type="number" min="0" step="50000" value=${maxTok} onInput=${(e) => { setMaxTok(e.target.value); later(() => put({ maxTokensPerRun: Number(e.target.value) || 0 })); }}/>

    ${admin ? html`<div class="sec" style="margin-top:18px">Lazy Julian Mode <span class="xbadge">experimental</span></div>
      <div class="muted" style="font-size:12px;margin-bottom:6px">Hands the whole agency to the Orchestrator: plans build without your sign-off, it decides what runs and in what order, answers agents' questions itself from the repo context, and merges green PRs. Issues fade into the background and this chat becomes the interface — it only comes back to you when the answer is genuinely yours to give (a credential, a priority call, money). Turn it off and every gate returns.</div>
      <label class="ckline"><input type="checkbox" checked=${lazyOn} onChange=${(e) => { setLazyOn(e.target.checked); put({ ops: { lazy_mode: e.target.checked } }); }}/> Let the Orchestrator run everything</label>

      <div class="sec" style="margin-top:18px">Automation</div>
      <label class="ckline"><input type="checkbox" checked=${selfImprove} onChange=${(e) => { setSelfImprove(e.target.checked); put({ ops: { self_improve: e.target.checked } }); }}/> Allow self-improvement PRs</label>
      <div class="muted" style="font-size:12px;margin:6px 0 4px">When this repo's own PR is ready to merge while other issues are still running, hold it (dashboard shows an "Update ready" chip) instead of self-merging immediately — merging redeploys the container mid-run. Off restores immediate self-merging.</div>
      <label class="ckline"><input type="checkbox" checked=${selfMergeHold} onChange=${(e) => { setSelfMergeHold(e.target.checked); put({ ops: { self_merge_hold: e.target.checked } }); }}/> Hold self-merges until other runs finish</label>

      <div class="sec" style="margin-top:18px">Process Analyzer</div>
      <div class="muted" style="font-size:12px;margin-bottom:6px">Self-improvement watchdog — reads aggregate telemetry (no secrets/issue bodies), opens advisory GitHub issues you approve. Needs the standalone <code>analyzer</code> service running (vendored in <code>./analyzer</code>, or its own deploy) and <code>ANALYZER_API_KEY</code> set.</div>
      <label class="ckline"><input type="checkbox" checked=${analyzerOn} onChange=${(e) => { setAnalyzerOn(e.target.checked); put({ ops: { analyzer_enabled: e.target.checked } }); }}/> Enable the Process Analyzer</label>
      <label style="margin-top:10px">Analyzer issues → repo</label>
      <div class="muted" style="font-size:12px;margin-bottom:4px">Where its advisory issues get created. Blank = this agency's own repo (its default target — these are reports on ITS operational health, not any one watched product repo).</div>
      <input placeholder="owner/repo (blank = agency's own repo)" value=${analyzerRepo} onInput=${(e) => { setAnalyzerRepo(e.target.value); later(() => put({ ops: { analyzer_repo: e.target.value.trim() } })); }}/>
      <div class="muted" style="font-size:12px;margin-top:6px">Model: the Analyzer role uses your global/Claude default until you configure per-role models — same as every other agent here.</div>
      <label style="margin-top:14px">Analyzer API key</label>
      <div class="muted" style="font-size:12px;margin-bottom:4px">Auto-generated and persisted on first boot (same idea as the server's master key) — no secret ships checked into the repo anymore. Copy it into a standalone or vendored analyzer sidecar's own <code>ANALYZER_API_KEY</code>/<code>AGENCY_API_KEY</code> env var if you run one.</div>
      <div class="cmdbox"><code>${analyzerKey ? (keyRevealed ? analyzerKey : "•".repeat(24)) : "…"}</code>
        <button class="btn" disabled=${!analyzerKey} onClick=${() => setKeyRevealed((v) => !v)}>${keyRevealed ? "Hide" : "Reveal"}</button>
        <button class="btn" disabled=${!analyzerKey} onClick=${() => { if (navigator.clipboard) navigator.clipboard.writeText(analyzerKey); toast("Copied"); }}>Copy</button>
      </div>

      <div class="sec" style="margin-top:18px">Contribute upstream</div>
      <div class="muted" style="font-size:12px;margin-bottom:6px">Controlled, opt-in channel: when a self-improvement fold or Process Analyzer advisory looks GENERIC (it doesn't name any of this instance's own watched repos), also propose it to the upstream project below as a <code>[from fork]</code> draft PR/issue — always draft, never auto-merged. Instance-specific findings keep the behavior above only.</div>
      <label class="ckline"><input type="checkbox" checked=${upstreamOn} onChange=${(e) => { setUpstreamOn(e.target.checked); put({ ops: { upstream_contrib_enabled: e.target.checked } }); }}/> Contribute generic improvements upstream</label>
      <label style="margin-top:10px">Upstream repo</label>
      <div class="muted" style="font-size:12px;margin-bottom:4px">Blank disables the channel even with the toggle on.</div>
      <input placeholder="owner/repo (blank = disabled)" value=${upstreamRepo} onInput=${(e) => { setUpstreamRepo(e.target.value); later(() => put({ ops: { upstream_repo: e.target.value.trim() } })); }}/>` : null}
  </div>`;
}
