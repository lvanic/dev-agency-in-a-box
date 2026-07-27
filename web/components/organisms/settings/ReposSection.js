// Settings tab — Repositories. Extracted from organisms/Settings.js (P6 split); logic unchanged.
// Add/remove watched repos + per-repo (and global) auto-resume/auto-merge — moved here from the
// TopBar dropdown, which now only picks the active repo filter (issue: the auto pills + trash icon
// crowded that dropdown and truncated repo names).
import { html } from "/web/vendor/standalone.mjs";
import { Icon } from "../../atoms/Icon.js";
import { RepoPicker } from "../../molecules/RepoPicker.js";

export function ReposSection({ repos, reload, auto, autoRepos, setAuto, repoBranches }) {
  const gpill = (kind) => { const on = ((auto || {})[kind] || "") === "on"; const tip = "Auto-" + kind + " for all repos — " + (on ? "ON" : "OFF"); return html`<button class=${"apill " + (on ? "on" : "off")} aria-label=${tip} data-tip=${tip} onClick=${() => setAuto(kind, on ? "off" : "on")}><${Icon} name=${kind === "resume" ? "refresh" : "merge"} size=${12}/> <span class="apill-label">${kind}</span></button>`; };
  return html`<div>
    <div class="sec">Repositories</div>
    <div class="muted" style="font-size:12px;margin-bottom:8px">Watched repos, auto-resume / auto-merge (global or per-repo), and each repo's <b>staging</b> / <b>production</b> branches. Agents open PRs against staging; leave blank to use the repo's default branch. Promote staging → production from the top menu.</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <div style="flex:1;display:flex;align-items:center;gap:6px"><${Icon} name="layers" size=${14}/> All repos</div>
      ${gpill("resume")}${gpill("merge")}
    </div>
    <${RepoPicker} repos=${repos} reload=${reload} showAuto=${true} autoRepos=${autoRepos} setAuto=${setAuto} repoBranches=${repoBranches || {}} filterable=${true}/>
  </div>`;
}
