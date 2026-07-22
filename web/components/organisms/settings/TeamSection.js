// Settings tab — Team (admin only). Extracted from organisms/Settings.js (P6 split); logic unchanged.
import { html, useState } from "/web/vendor/standalone.mjs";
import { Icon } from "../../atoms/Icon.js";
import { api } from "../../../lib/api.js";
import { toast } from "../../../lib/toast.js";
import { useAutoSave, saved, failed } from "./shared.js";

export function TeamSection({ users, webhookSecretSet, reload }) {
  const later = useAutoSave();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [link, setLink] = useState("");
  function invite() { api("/invite-create", { email: email || null, role }).then((d) => { setLink(d.url || ""); setEmail(""); toast("Invite link created"); reload(); }).catch(() => toast("Couldn't create invite")); }
  return html`<div>
    <div class="sec">Team</div>
    ${users.map((u) => html`<div key=${u.id} style="display:flex;gap:8px;align-items:center;margin:4px 2px"><span style="flex:1">${u.username}</span><span class="muted" style="font-size:12px">${u.role}</span>
      <button class="btn ghost" style="padding:3px 8px;font-size:12px" onClick=${() => { const np = window.prompt("New password for " + u.username + " (8+ chars)"); if (np == null) return; if (np.length < 8) { toast("8+ characters"); return; } api("/set-password", { value: np, number: u.id }).then(() => toast("Reset " + u.username)).catch(() => toast("Couldn't reset")); }}><${Icon} name="lock" size=${13}/></button></div>`)}
    <label style="margin-top:10px">Invite a teammate</label>
    <div style="display:flex;gap:8px">
      <input placeholder="email (optional)" value=${email} onInput=${(e) => setEmail(e.target.value)}/>
      <select value=${role} onChange=${(e) => setRole(e.target.value)} style="width:auto"><option value="member">member</option><option value="admin">admin</option></select>
      <button class="btn" onClick=${invite}>Create</button>
    </div>
    ${link ? html`<div class="cmdbox"><code>${link}</code><button class="btn" onClick=${() => { if (navigator.clipboard) navigator.clipboard.writeText(link); toast("Copied"); }}>Copy</button></div>` : null}
    <label style="margin-top:14px">GitHub webhook secret ${webhookSecretSet ? html`<span class="statuschip s-ready"><${Icon} name="check" size=${12}/> set</span>` : null}</label>
    <div class="muted" style="font-size:11px;margin:0 2px 4px">Only if you use GitHub push webhooks. Stored encrypted; saves as you type.</div>
    <input type="password" autocomplete="off" placeholder=${webhookSecretSet ? "•••••• saved — type to replace" : "secret"} onInput=${(e) => { const v = e.target.value; later(() => { if (v.trim()) api("/settings", { webhookSecret: v.trim() }).then(saved).then(reload).catch(failed); }); }}/>
  </div>`;
}
