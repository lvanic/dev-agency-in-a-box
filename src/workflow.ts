/**
 * Workflow resolution. A workflow's trigger handle (e.g. "@build") is a STRUCTURED identifier the
 * dashboard/dealer passes in — it is never scanned out of issue or comment text (issue #140). The
 * trigger resolves to the workflow; full-build runs the proven pipeline, everything else runs the
 * step engine.
 */
import { listWorkflows, type Workflow } from "./store.js";
import type { RoleName } from "./agents/roles.js";

// full-build leads as DEVELOPER: that routes runPipeline into runDeveloperPipeline — the proven
// plan → approve → build → test/review chain. "planner" here sent it into the solo-planner
// conversational flow instead, which re-planned + re-parked on every Approve and never built (#152).
const LEAD_ROLE: Record<string, RoleName> = { "full-build": "developer", "quick-fix": "developer", "plan-only": "planner", "review-only": "reviewer" };
const HANDLE_ROLE: Record<string, RoleName> = { "@dev": "developer", "@plan": "planner", "@split": "decomposer", "@arch": "architect", "@review": "reviewer", "@test": "tester" };
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The role that leads a workflow's run (v1: maps to an existing flow via its first step). */
export function workflowLeadRole(wf: Workflow): RoleName {
  if (LEAD_ROLE[wf.id]) return LEAD_ROLE[wf.id];
  return HANDLE_ROLE[(wf.steps[0]?.agent || "").toLowerCase()] || "developer";
}

/**
 * The role of the agent that actually SPEAKS/works first in a workflow — its real first step,
 * NOT the control-flow lead. For full-build the lead is `developer` (it routes runPipeline into
 * runDeveloperPipeline), but the planner runs first; the run-start chat/activity must announce the
 * planner so it agrees with the timeline (#233). Use this for display only, never for routing.
 */
export function workflowFirstAgentRole(wf: Workflow): RoleName {
  return HANDLE_ROLE[(wf.steps[0]?.agent || "").toLowerCase()] || workflowLeadRole(wf);
}

/** Resolve the workflow whose trigger the text mentions (first match), or null. */
export function resolveWorkflow(text: string): Workflow | null {
  const t = text || "";
  for (const w of listWorkflows()) {
    const h = w.trigger || "";
    if (h && new RegExp(esc(h) + "(?![a-zA-Z0-9_-])", "i").test(t)) return w;
  }
  return null;
}
