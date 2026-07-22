// Settings tab — Account. Extracted from organisms/Settings.js (P6 split); logic unchanged.
import { html } from "/web/vendor/standalone.mjs";
import { Icon } from "../../atoms/Icon.js";
import { api } from "../../../lib/api.js";
import { toast } from "../../../lib/toast.js";

export function AccountSection({ data, reload, onClose }) {
  function changePw() { const np = window.prompt("New password (8+ characters)"); if (np == null) return; if (np.length < 8) { toast("8+ characters"); return; } api("/set-password", { value: np }).then(() => toast("Password changed")).catch((e) => toast((e && e.message) || "Couldn't change", "error")); }
  return html`<div>
    <div class="sec">Account</div>
    ${data.user ? html`<div class="muted" style="margin-bottom:8px">Signed in as <b>${data.user.username}</b> · ${data.user.role}</div>` : null}
    <div style="display:flex;gap:8px">
      <button class="btn ghost" style="flex:1;justify-content:center" onClick=${changePw}><${Icon} name="lock" size=${15}/> Change password</button>
      <a class="btn ghost" href="/logout" style="flex:1;justify-content:center"><${Icon} name="arrowleft" size=${15}/> Sign out</a>
    </div>
    <div class="sec" style="margin-top:18px">Setup</div>
    <div class="muted" style="font-size:12px;margin-bottom:7px">Re-run the guided walkthrough to add or update tokens, models, and repos.</div>
    <button class="btn" style="width:100%;justify-content:center" onClick=${() => api("/onboarded", { value: "0" }).then(() => { onClose(); reload(); })}><${Icon} name="play" size=${15}/> Run the setup wizard</button>
  </div>`;
}
