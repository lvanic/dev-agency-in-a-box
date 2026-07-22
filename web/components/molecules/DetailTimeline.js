// DetailTimeline molecule — the workflow step timeline at the bottom of the Detail drawer.
// Extracted from organisms/Detail.js (P6 split); logic unchanged.
//
// Same status convention as the List/Board timeline (WorkflowTimelineImpl): only the step actually
// running or parked shows a face — a live spinner while the agent works, its avatar while blocked on
// it. Every other dot is a plain status icon (check = done, alert = attention, empty = pending), not
// a wall of avatars (#152: the first restore showed every step's face always, since `s.role` is set
// on every step regardless of state). On a WORKFLOW issue every dot is STILL the trigger of a model
// picker — including pending steps — so you can pre-set a future step's model before it runs; that
// interactive variant was lost in the 41d0f88/28055d3 refactors and is restored here.
import { html } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { Avatar } from "../atoms/Avatar.js";
import { Spinner } from "../atoms/Spinner.js";
import { ModelSelect } from "./ModelSelect.js";
import { timelineModel } from "./Timeline.js";
import { api } from "../../lib/api.js";
import { toast } from "../../lib/toast.js";
import { cap, shortModel } from "../../lib/format.js";
import { providerModelOptions } from "../../lib/model-logic.js";
import { resolveAgentModel } from "../../lib/agent-options.js";

// Map a workflow's steps to per-step model targets — the storage KEY each step routes by must match
// the server's resolveAssignment (built-in handle → role name; custom agent → handle without @), all
// lowercased. Deduped so a role used in two steps shows one picker (the store is per-agent, not per-step).
const STEP_ROLE_KEY = { "@dev": "developer", "@plan": "planner", "@arch": "architect", "@review": "reviewer", "@test": "tester", "@split": "decomposer" };
export function stepModelTargets(wf, agentDefs, data) {
  const defs = agentDefs || [];
  const rm = (data && data.roleModels) || {};
  const seen = new Set(); const out = [];
  for (const s of (wf && wf.steps || [])) {
    const handle = (s.agent || "").toLowerCase();
    if (!handle) continue;
    const builtin = STEP_ROLE_KEY[handle];
    // The editable agentDef driving this step: match by handle, else (for a built-in handle) by the
    // role NAME — so @test finds the "tester" agent and uses ITS configured model, not the app default.
    const def = defs.find((d) => (d.handle || ("@" + d.name)).toLowerCase() === handle || d.name.toLowerCase() === handle.replace(/^@/, ""))
      || (builtin ? defs.find((d) => d.name.toLowerCase() === builtin) : null);
    // Storage key the server resolves by (built-in role name, or a custom agent's handle w/o @).
    const key = (builtin || (def ? (def.handle || ("@" + def.name)).replace(/^@/, "") : handle.replace(/^@/, ""))).toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    const name = def ? def.name : (builtin || handle.replace(/^@/, ""));
    // The model this step resolves to absent a per-issue override — step.model → agent's model →
    // per-role model (Settings → Models) → global. Tier words resolve to concrete models for display.
    const roleM = rm[key] && rm[key].model ? { ref: rm[key].providerId + "/" + rm[key].model, short: shortModel(rm[key].model), provider: ((data.providers || []).find((p) => p.id === rm[key].providerId) || {}).name } : null;
    // The effective raw model source (step override → agent definition → role), to detect a bare tier
    // word so the default label reads "default: Medium" rather than the resolved model name.
    const rawModel = (s.model && String(s.model).trim()) || (def && def.model && String(def.model).trim()) || (rm[key] && rm[key].model ? rm[key].providerId + "/" + rm[key].model : "");
    const tierHit = rawModel && ["high", "medium", "low"].indexOf(String(rawModel).toLowerCase()) >= 0 ? String(rawModel).toLowerCase() : "";
    const m = resolveAgentModel(s.model, data) || resolveAgentModel(def && def.model, data) || roleM || null;
    // Default label: "default: <Tier|modelName>" — a tier pick shows the tier word, else the model name.
    const dfltLabel = tierHit ? "default: " + cap(tierHit) : (m ? "default: " + m.short : "");
    out.push({ key, label: cap(name), dfltRef: m ? m.ref : "", dflt: dfltLabel, dfltShort: m ? m.short : "", dfltProvider: m ? m.provider : "" });
  }
  return out;
}

// Write a per-step model override for this issue (live, via /issue-agent-model). Updates the local
// issue object optimistically so the timeline reflects it immediately.
function setStepModel(issue, key, value) {
  if (!issue.agentModels) issue.agentModels = {};
  if (value) issue.agentModels[key] = value; else delete issue.agentModels[key];
  api("/issue-agent-model", { repo: issue.repo, number: issue.number, agent: key, model: value || "" })
    .catch((err) => toast("Couldn't set step model: " + ((err && err.message) || ""), "error"));
}

export function DetailTimeline({ issue, data, onOpenModels }) {
  const m = timelineModel(issue);
  if (m.epic || !m.started || !m.steps) return null;
  const wf = ((data && data.workflows) || []).find((w) => w.id === issue.workflowId);
  const targets = wf && m.workflow ? stepModelTargets(wf, data && data.agentDefs, data) : [];
  const agentModels = issue.agentModels || {};
  const providers = (data && data.providers) || [];
  const modelOpts = providerModelOptions(providers, { short: true });
  const live = !!(issue.active || issue.running);
  return html`<div class="flow">
    ${m.steps.map((s, idx) => {
      const done = s.st === "done";
      const current = idx === m.current && !done;
      const blocked = s.st === "attention";
      const cls = done ? "done" : current ? (blocked ? "blocked" : "current") : blocked ? "blocked" : "pending";
      // Match the timeline step to its model target by ROLE KEY (both sides are the lowercased role
      // name) — more robust than matching display labels, which can differ (ws.name vs agentDef name).
      const roleKey = String(s.role || s.k || "").toLowerCase();
      const target = targets.find((t) => t.key === roleKey) || targets.find((t) => (t.label || "").toLowerCase() === roleKey);
      // The live per-issue override for this step's agent (if any), else its resolved default.
      const curRef = target ? (agentModels[target.key] || target.dfltRef) : "";
      const curOpt = curRef ? modelOpts.find((o) => o.value === curRef) : null;
      const curLabel = curOpt ? curOpt.label : (target && target.dflt ? target.dflt : "");
      const tip = cap(s.role || s.k) + (curLabel ? " · " + curLabel : "") + (target ? " — click to change model" : "");
      const showSpin = current && live; // actually running right now
      const showFace = current && !showSpin; // parked/blocked ON this step — show who
      const icon = showSpin
        ? html`<${Spinner} size=${16}/>`
        : showFace
          ? html`<span class="flow__face"><${Avatar} role=${s.role || issue.role} size=${20} crop="head"/></span>`
          : done
            ? html`<${Icon} name="check" size=${11}/>`
            : blocked
              ? html`<${Icon} name="alert" size=${11}/>`
              : null;
      const dot = html`<span class=${"flow__dot" + (showSpin ? " pulse" : "") + (showFace ? " flow__dot--face" : "")}>${icon}</span>`;
      return html`
        ${idx ? html`<span class=${"flow__line" + (idx <= m.current ? " on" : "")}></span>` : null}
        <span class=${"flow__step " + cls}>
          ${target
            ? html`<span class="tip" data-tip=${tip}><${ModelSelect}
                providers=${providers}
                data=${data}
                value=${curRef}
                includeDefault=${true}
                defaultLabel="Default"
                defaultHint=${target.dflt || "default"}
                onSetUp=${onOpenModels}
                btnClass="flow__pick"
                menuAlign=${idx >= m.steps.length - 2 ? "right" : "left"}
                trigger=${() => dot}
                onChange=${(v) => setStepModel(issue, target.key, v)}
              /></span>`
            : dot}
          <span class="flow__lbl">${s.label}</span>
        </span>`;
    })}
  </div>`;
}
