// RunApp molecule — the "run the app" toolbar controls in the Detail toolbar: a one-liner clone/
// checkout/launch copy button for a Tauri app, or start/open/stop controls for a web preview.
// A target picker chooses which branch to run: this issue's branch (default), staging, or production
// — so you can preview the live integration env, not just the isolated issue branch.
import { html, useState } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { api } from "../../lib/api.js";
import { toast } from "../../lib/toast.js";

export function RunApp({ repo, number, appInfo, issue, done, repoBranches }) {
  const [target, setTarget] = useState("issue"); // issue | staging | production
  if (!appInfo || appInfo.kind === "unknown" || appInfo.kind === "none") return null;
  const kind = appInfo.kind, app = issue.app;
  const br = (repoBranches || {})[repo] || {};
  // The named branch for a target, or "" when it should follow the repo's default (resolved in the
  // shell one-liner via `main || master`). The web preview resolves this server-side instead.
  const namedBranch = target === "staging" ? (br.staging || "") : target === "production" ? (br.production || "") : "";

  function copyRun() {
    const nm = repo.split("/").pop();
    let checkout;
    if (target === "issue") {
      checkout = done ? "(git checkout main 2>/dev/null || git checkout master) && git pull -q" : "gh pr checkout " + number;
    } else if (namedBranch) {
      checkout = 'git fetch -q origin "' + namedBranch + '" && git checkout "' + namedBranch + '" && git reset --hard "origin/' + namedBranch + '"';
    } else {
      // staging/production with no override → the repo's default branch.
      checkout = "(git checkout main 2>/dev/null || git checkout master) && git pull -q";
    }
    const cmd = 'd=~/.devagency/' + nm + '; gh repo clone ' + repo + ' "$d" 2>/dev/null; cd "$d" && git fetch -q && ' + checkout + ' && { corepack enable 2>/dev/null; PM=npm; [ -f pnpm-lock.yaml ]&&PM=pnpm; [ -f yarn.lock ]&&PM=yarn; $PM install && ($PM run tauri:dev || $PM tauri dev || $PM run dev); }';
    (navigator.clipboard ? navigator.clipboard.writeText(cmd) : Promise.reject()).then(() => toast("Copied — paste in Terminal & Enter"), () => toast("Copy failed"));
  }

  const picker = html`<select class="tbtn tip" data-tip="Which branch to run" aria-label="Run target"
    value=${target} onChange=${(e) => setTarget(e.target.value)} style="padding:4px 6px;font-size:12px">
    <option value="issue">this issue</option>
    <option value="staging">staging</option>
    <option value="production">production</option>
  </select>`;

  const running = app && app.status === "running";
  const busy = app && (app.status === "installing" || app.status === "starting");
  return html`${picker}
    ${kind === "tauri" ? html`<button class="tbtn tip" data-tip="Run on my Mac — copies a one-liner to clone, checkout & launch the selected branch" onClick=${copyRun}><${Icon} name="laptop"/><span class="tlabel">Run on my Mac</span></button>` : null}
    ${running ? html`<a class="tbtn tip" data-tip="Open the running app" href=${app.url} target="_blank" rel="noopener"><${Icon} name="monitor"/><span class="tlabel">Open app</span></a><button class="tbtn tip" data-tip="Stop the app" onClick=${() => api("/app-stop", { repo, number }).then(() => toast("Stopped"))}><${Icon} name="stop"/></button>`
      : busy ? html`<span class="tbtn" style="pointer-events:none">⏳ ${app.status}…</span>`
      : kind === "web" ? html`<button class="tbtn tip" data-tip="Run a web preview of the selected branch" onClick=${() => api("/app-run", { repo, number, target }).then((r) => toast(r && r.error ? r.error : "Starting preview…")).catch(() => toast("Couldn’t start", "error"))}><${Icon} name="play"/><span class="tlabel">Run preview</span></button>` : null}`;
}
