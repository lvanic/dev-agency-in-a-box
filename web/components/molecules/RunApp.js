// RunApp molecule — the "run the app" toolbar controls in the Detail toolbar: a one-liner clone/
// checkout/launch copy button for a Tauri app, or start/open/stop controls for a web preview.
// Extracted from organisms/Detail.js (P6 split); logic unchanged.
import { html } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { api } from "../../lib/api.js";
import { toast } from "../../lib/toast.js";

export function RunApp({ repo, number, appInfo, issue, done }) {
  if (!appInfo || appInfo.kind === "unknown" || appInfo.kind === "none") return null;
  const kind = appInfo.kind, app = issue.app;
  function copyRun() {
    const nm = repo.split("/").pop();
    const checkout = done ? "(git checkout main 2>/dev/null || git checkout master) && git pull -q" : "gh pr checkout " + number;
    const cmd = 'd=~/.devagency/' + nm + '; gh repo clone ' + repo + ' "$d" 2>/dev/null; cd "$d" && git fetch -q && ' + checkout + ' && { corepack enable 2>/dev/null; PM=npm; [ -f pnpm-lock.yaml ]&&PM=pnpm; [ -f yarn.lock ]&&PM=yarn; $PM install && ($PM run tauri:dev || $PM tauri dev || $PM run dev); }';
    (navigator.clipboard ? navigator.clipboard.writeText(cmd) : Promise.reject()).then(() => toast("Copied — paste in Terminal & Enter"), () => toast("Copy failed"));
  }
  return html`${kind === "tauri" ? html`<button class="tbtn tip" data-tip="Run on my Mac — copies a one-liner to clone, checkout & launch this branch" onClick=${copyRun}><${Icon} name="laptop"/><span class="tlabel">Run on my Mac</span></button>` : null}
    ${app && app.status === "running" ? html`<a class="tbtn tip" data-tip="Open the running app" href=${app.url} target="_blank" rel="noopener"><${Icon} name="monitor"/><span class="tlabel">Open app</span></a><button class="tbtn tip" data-tip="Stop the app" onClick=${() => api("/app-stop", { repo, number }).then(() => toast("Stopped"))}><${Icon} name="stop"/></button>`
      : app && (app.status === "installing" || app.status === "starting") ? html`<span class="tbtn" style="pointer-events:none">⏳ ${app.status}…</span>`
      : kind === "web" ? html`<button class="tbtn tip" data-tip="Run a web preview" onClick=${() => api("/app-run", { repo, number }).then((r) => toast(r && r.error ? r.error : "Starting preview…")).catch(() => toast("Couldn’t start", "error"))}><${Icon} name="play"/><span class="tlabel">Run preview</span></button>` : null}`;
}
