// Settings tab — GitHub. Extracted from organisms/Settings.js (P6 split); logic unchanged.
// GitHubConnect (the OAuth device-flow login) is exported — Onboarding.js reuses it too.
import { html, useState, useEffect, useRef } from "/web/vendor/standalone.mjs";
import { Icon } from "../../atoms/Icon.js";
import { Spinner } from "../../atoms/Spinner.js";
import { SecretField } from "../../molecules/SecretField.js";
import { api } from "../../../lib/api.js";
import { toast } from "../../../lib/toast.js";

export function GithubSection({ secretKeys, github, reload }) {
  const [adv, setAdv] = useState(false);
  return html`<div>
    <${GitHubConnect} github=${github} reload=${reload}/>
    <button class="btn ghost" style="width:100%;justify-content:center;margin-top:12px" onClick=${() => setAdv((a) => !a)}><${Icon} name=${adv ? "chevdown" : "chevron"} size=${14}/> Advanced — paste tokens manually</button>
    ${adv ? html`<div style="margin-top:10px">
      <div class="muted" style="font-size:11.5px;margin-bottom:10px">Optional fallback to a fine-grained PAT if you'd rather not use the OAuth login above. One token covers everything — the agency commits, opens PRs and comments as this account. Stored encrypted; write-only.</div>
      <div><${SecretField} field=${{ key: "github_bot_token", label: "GitHub token", hint: "The account the agency acts as — commits, pull requests & comments. Needs repo scope." }} isSet=${secretKeys.includes("github_bot_token")} reload=${reload}/></div>
    </div>` : null}
  </div>`;
}

// One-click GitHub login via the OAuth device flow (unchanged behaviour; used by Onboarding too).
export function GitHubConnect({ github, reload }) {
  const [clientId, setClientId] = useState("");
  const [flow, setFlow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const pollRef = useRef(null);
  const connected = github && github.connected;
  const user = github && github.user;
  const needClientId = github && !github.clientIdSet;
  function stop() { if (pollRef.current) clearTimeout(pollRef.current); pollRef.current = null; }
  function copyCode(code) { try { if (navigator.clipboard) navigator.clipboard.writeText(code); } catch (e) {} }
  useEffect(() => stop, []);
  function poll(interval) {
    let secs = interval || 5;
    const tick = () => api("/gh-connect-poll", {}).then((r) => {
      if (r.ok) { stop(); setFlow(null); setBusy(false); toast("GitHub connected" + (r.user ? " as @" + r.user.login : "")); reload(); return; }
      if (r.error) { stop(); setFlow(null); setBusy(false); setErr(r.error); return; }
      if (r.interval) secs = r.interval;
      pollRef.current = setTimeout(tick, secs * 1000);
    }).catch(() => { pollRef.current = setTimeout(tick, secs * 1000); });
    pollRef.current = setTimeout(tick, secs * 1000);
  }
  function connect() {
    setErr(""); setBusy(true);
    api("/gh-connect", needClientId ? { value: clientId.trim() } : {}).then((d) => {
      if (d.error) { setErr(d.error); setBusy(false); return; }
      setFlow(d);
      copyCode(d.user_code); // auto-copy so the code is ready to paste; stay on this page (don't steal focus with a popup)
      toast("Code " + d.user_code + " copied to clipboard");
      poll(d.interval);
    }).catch((e) => { setErr((e && e.message) || "Couldn't start login"); setBusy(false); });
  }
  function disconnect() { api("/gh-disconnect", {}).then(() => { toast("Disconnected"); reload(); }); }
  if (connected) return html`<div>
    <div class="sec">GitHub</div>
    <div style="display:flex;align-items:center;gap:8px">
      <span class="statuschip s-ready"><${Icon} name="check" size=${12}/> Connected${user ? " as @" + user.login : ""}</span>
      <button class="btn ghost" style="margin-left:auto;padding:3px 10px;font-size:12px" onClick=${disconnect}>Disconnect</button>
    </div>
    <div class="muted" style="font-size:11.5px;margin-top:6px">One login runs everything — commits, PRs and issues are authored by this account. No separate bot needed.</div>
  </div>`;
  return html`<div>
    <div class="sec">GitHub</div>
    <div class="muted" style="font-size:12px;margin-bottom:8px">Connect once — replaces the bot + owner tokens. This instance uses <b>your own</b> GitHub OAuth App, so the GitHub screen shows <b>your</b> app name, not anyone else's.</div>
    ${needClientId ? html`<div class="cmdbox" style="flex-direction:column;align-items:flex-start;gap:6px;margin-bottom:10px">
      <div style="font-weight:600">First time? Create your GitHub OAuth App (≈1 min)</div>
      <div class="muted" style="font-size:11.5px">The <b>Application name</b> you pick is what users see on the Authorize screen — name it whatever you want (e.g. "Dev in a Box").</div>
      <ol style="margin:4px 0 0;padding-left:18px;font-size:12px;line-height:1.6">
        <li><a class="oblink" href="https://github.com/settings/applications/new" target="_blank" rel="noopener">Open the GitHub form <${Icon} name="link" size=${13}/></a> (register under an <b>org</b> to show a brand instead of your username)</li>
        <li>Homepage URL: this dashboard's URL. Callback URL: same (unused by device flow, but required)</li>
        <li>Create it, then on the app page tick <b>"Enable Device Flow"</b> and Save</li>
        <li>Copy the <b>Client ID</b> and paste it below</li>
      </ol>
    </div>
    <label>OAuth App client ID</label>
      <input placeholder="Iv1.… or Ov23… (your own GitHub OAuth App)" value=${clientId} onInput=${(e) => setClientId(e.target.value)}/>` : null}
    ${flow ? html`<div class="cmdbox" style="flex-direction:column;align-items:flex-start;gap:6px">
      <div>Your code (copied to clipboard): <code style="font-size:16px;letter-spacing:2px">${flow.user_code}</code></div>
      <button class="btn primary" style="width:100%;justify-content:center" onClick=${() => { copyCode(flow.user_code); toast("Code copied — paste it on GitHub"); try { window.open(flow.verification_uri, "_blank", "noopener"); } catch (e) {} }}><${Icon} name="link" size=${15}/> Copy to clipboard & open GitHub</button>
      <div class="muted" style="font-size:11px">Or open <a href=${flow.verification_uri} target="_blank" rel="noopener">${flow.verification_uri}</a> yourself and paste the code.</div>
      <div class="muted" style="font-size:11px;display:flex;align-items:center;gap:6px"><${Spinner} size=${12}/> waiting for you to authorize…</div>
    </div>` : html`<button class="btn primary" style="width:100%;justify-content:center" disabled=${busy || (needClientId && !clientId.trim())} onClick=${connect}>${busy ? html`<${Spinner} size=${15}/>` : html`<${Icon} name="link" size=${15}/>`} Connect GitHub</button>`}
    ${err ? html`<div class="testres bad" style="margin-top:6px">✗ ${err}</div>` : null}
  </div>`;
}
