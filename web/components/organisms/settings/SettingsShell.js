// Organism — SettingsShell (issue #139). ONE full settings surface: section list on the LEFT,
// detail on the RIGHT, every control AUTO-SAVES on change (no Save step), a single ✕ closes.
// The old stacked sheet + separate GitHub/Models modals are folded in as sections. Atomic design:
// atoms (Icon/Select/Modal-free), molecules (ModelSelect/SecretField/ProviderSearchSelect), lib.
//
// P6 split: each section is its own file under this settings/ directory (GeneralSection,
// ModelsSection, GithubSection, ReposSection, EnvironmentsSection, MemorySettings, TeamSection,
// AccountSection) — this file is just the shell (nav + section switch).
import { html, useState } from "/web/vendor/standalone.mjs";
import { Icon } from "../../atoms/Icon.js";
import { GeneralSection } from "./GeneralSection.js";
import { ModelsSection } from "./ModelsSection.js";
import { GithubSection } from "./GithubSection.js";
import { ReposSection } from "./ReposSection.js";
import { EnvironmentsSection } from "./EnvironmentsSection.js";
import { MemorySection } from "./MemorySettings.js";
import { TeamSection } from "./TeamSection.js";
import { AccountSection } from "./AccountSection.js";

// ---------- the shell ----------
export function SettingsShell({ data, onClose, reload, section: initial, openWorkflows, repos, auto, autoRepos, setAuto }) {
  const admin = Boolean(data.user && data.user.role === "admin");
  const [section, setSection] = useState(initial || "general");
  const NAV = [
    { k: "general", label: "General", icon: "sliders" },
    { k: "models", label: "Models & providers", icon: "flask" },
    { k: "github", label: "GitHub", icon: "link" },
    { k: "repos", label: "Repositories", icon: "layers" },
    { k: "environments", label: "Environments", icon: "laptop" },
    { k: "memory", label: "Memory", icon: "sparkles" },
    ...(admin ? [{ k: "team", label: "Team", icon: "users" }] : []),
    { k: "account", label: "Account", icon: "lock" },
  ];
  return html`<div class="setshell">
    <div class="setshell__panel">
      <button class="iconbtn ghost setshell__x" aria-label="Close" data-tip="Close — everything saves as you change it" onClick=${onClose}><${Icon} name="x" size=${18}/></button>
      <div class="setshell__nav">
        <div class="setshell__title"><${Icon} name="sliders" size=${16}/> Settings</div>
        ${NAV.map((n) => html`<button key=${n.k} class=${"setshell__navitem" + (section === n.k ? " on" : "")} onClick=${() => setSection(n.k)}><${Icon} name=${n.icon} size=${15}/> ${n.label}</button>`)}
        <div class="setshell__navsep"></div>
        <button class="setshell__navitem" onClick=${() => { onClose(); openWorkflows && openWorkflows(); }}><${Icon} name="layers" size=${15}/> Workflows & agents <${Icon} name="chevron" size=${12} cls="setshell__navgo"/></button>
        <span style="flex:1"></span>
        <div class="setshell__hint">Changes save automatically</div>
      </div>
      <div class="setshell__body">
        ${section === "general" ? html`<${GeneralSection} data=${data} reload=${reload} admin=${admin}/>` : null}
        ${section === "models" ? html`<${ModelsSection} reload=${reload} secretKeys=${data.secretKeys || []}/>` : null}
        ${section === "github" ? html`<${GithubSection} secretKeys=${data.secretKeys || []} github=${data.github} reload=${reload}/>` : null}
        ${section === "repos" ? html`<${ReposSection} repos=${repos} reload=${reload} auto=${auto} autoRepos=${autoRepos} setAuto=${setAuto}/>` : null}
        ${section === "environments" ? html`<${EnvironmentsSection} admin=${admin}/>` : null}
        ${section === "memory" ? html`<${MemorySection}/>` : null}
        ${section === "team" && admin ? html`<${TeamSection} users=${data.users || []} webhookSecretSet=${data.webhookSecretSet} reload=${reload}/>` : null}
        ${section === "account" ? html`<${AccountSection} data=${data} reload=${reload} onClose=${onClose}/>` : null}
      </div>
    </div>
  </div>`;
}
