/**
 * Coolify redeploy trigger.
 *
 * Why this exists: when the agency merges its OWN self-improvement PR into `main`, Coolify's native
 * git-webhook auto-deploy does NOT fire — the squash-merge commit inherits the branch's `[skip ci]`
 * tag (SKIP_CI, on by default) and Coolify skips deployments whose commit message contains
 * `[skip ci]`/`[ci skip]`. So the running container keeps serving the old build after a self-merge.
 *
 * This module hits Coolify's deploy API directly, bypassing the commit-message gate entirely. It is
 * used two ways:
 *   1. Automatically after a successful merge of the agency's own repo (opt-in, on by default).
 *   2. Manually from the dashboard's Deploy settings ("Redeploy now").
 *
 * Config lives in the DB (dashboard-managed, no redeploy to change):
 *   coolify_base_url   — e.g. https://coolify.example.com (no trailing /api)
 *   coolify_uuid       — the resource UUID of THIS agency deployment
 *   coolify_token      — a Coolify API token with `deploy` permission (encrypted)
 *   coolify_auto_redeploy — "on"/"off" auto-fire after a self-merge (default on when configured)
 */
import { getSetting, setSetting, getSecretSetting, setSecretSetting } from "./store.js";
import { sStr } from "./settings.js";

export type DeployResult = { ok: boolean; message: string; deploymentUuid?: string };

/** True when the base URL + uuid + token are all set (a token is required by Coolify's API). */
export function coolifyConfigured(): boolean {
  return Boolean(coolifyBaseUrl() && getSetting("coolify_uuid")?.trim() && getSecretSetting("coolify_token")?.trim());
}

export function coolifyBaseUrl(): string {
  // Trim a trailing slash and an accidentally-pasted /api suffix so we can build /api/v1/deploy.
  return (sStr("coolify_base_url", "COOLIFY_BASE_URL", "").trim()).replace(/\/+$/, "").replace(/\/api$/, "");
}

/** Auto-redeploy after a self-merge — defaults ON once Coolify is configured, explicit off wins. */
export function autoRedeployEnabled(): boolean {
  const s = getSetting("coolify_auto_redeploy");
  if (s === "off" || s === "false" || s === "0") return false;
  if (s === "on" || s === "true" || s === "1") return true;
  return coolifyConfigured(); // unset → on when we actually have somewhere to deploy to
}

/** Status snapshot for the dashboard (never leaks the token). */
export function coolifyStatus(): {
  configured: boolean;
  baseUrl: string;
  uuidSet: boolean;
  tokenSet: boolean;
  autoRedeploy: boolean;
  lastAt: string | null;
  lastOk: boolean | null;
  lastMessage: string | null;
} {
  const lastOkRaw = getSetting("coolify_last_ok");
  return {
    configured: coolifyConfigured(),
    baseUrl: coolifyBaseUrl(),
    uuidSet: Boolean(getSetting("coolify_uuid")?.trim()),
    tokenSet: Boolean(getSecretSetting("coolify_token")?.trim()),
    autoRedeploy: autoRedeployEnabled(),
    lastAt: getSetting("coolify_last_at") || null,
    lastOk: lastOkRaw == null ? null : lastOkRaw === "1",
    lastMessage: getSetting("coolify_last_message") || null,
  };
}

function recordDeploy(ok: boolean, message: string): void {
  setSetting("coolify_last_at", new Date().toISOString());
  setSetting("coolify_last_ok", ok ? "1" : "0");
  setSetting("coolify_last_message", message.slice(0, 300));
}

/**
 * Trigger a Coolify deployment of this resource. `force` skips the build cache (Coolify's
 * `?force=true`). Returns a structured result; never throws — callers surface `message`.
 */
export async function triggerCoolifyDeploy(force = false, reason = "manual"): Promise<DeployResult> {
  const base = coolifyBaseUrl();
  const uuid = getSetting("coolify_uuid")?.trim() || "";
  const token = getSecretSetting("coolify_token")?.trim() || "";
  if (!base || !uuid || !token) {
    const message = "Coolify is not configured — set the base URL, resource UUID and API token in Settings → General → Deploy.";
    recordDeploy(false, message);
    return { ok: false, message };
  }
  const url = `${base}/api/v1/deploy?uuid=${encodeURIComponent(uuid)}&force=${force ? "true" : "false"}`;
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      const message = `Coolify responded ${r.status}: ${text.slice(0, 200) || r.statusText}`;
      recordDeploy(false, message);
      return { ok: false, message };
    }
    // Coolify returns { deployments: [{ message, deployment_uuid, resource_uuid }] }.
    let deploymentUuid: string | undefined;
    try {
      const d = JSON.parse(text) as { deployments?: Array<{ deployment_uuid?: string }> };
      deploymentUuid = d.deployments?.[0]?.deployment_uuid;
    } catch { /* non-JSON success body — still a 2xx, treat as accepted */ }
    const message = `Redeploy queued (${reason})${deploymentUuid ? ` — ${deploymentUuid}` : ""}.`;
    recordDeploy(true, message);
    console.log(`[coolify] ${message}`);
    return { ok: true, message, deploymentUuid };
  } catch (e) {
    const message = `Could not reach Coolify: ${(e as Error).message.slice(0, 200)}`;
    recordDeploy(false, message);
    return { ok: false, message };
  }
}

/** The agency's own repo, resolved the same way config.ts does (setting → env → owner-prefixed). */
function agencyRepoResolved(): string {
  const raw = sStr("agency_repo", "AGENCY_REPO", "dev-agency").trim();
  if (raw.includes("/")) return raw;
  const owner = sStr("github_owner", "GITHUB_OWNER", "").trim();
  return owner ? `${owner}/${raw}` : raw;
}

/**
 * Fire an auto-redeploy after a PR merged into `mergedRepo`, but only when it is the agency's OWN
 * repo and auto-redeploy is enabled. Fire-and-forget: logs, never throws, never blocks the merge.
 * Matches on the repo name too (owner-less) so it works even before GITHUB_OWNER is set.
 */
export function maybeRedeployAfterMerge(mergedRepo: string): void {
  const agency = agencyRepoResolved();
  const nameOf = (r: string) => r.split("/").pop();
  if (mergedRepo !== agency && nameOf(mergedRepo) !== nameOf(agency)) return;
  if (!autoRedeployEnabled() || !coolifyConfigured()) return;
  void triggerCoolifyDeploy(false, `self-merge of ${mergedRepo}`).catch((e) =>
    console.warn(`[coolify] auto-redeploy failed: ${(e as Error).message}`),
  );
}

/** Save Coolify deploy settings from the dashboard. `token` of "" clears it; undefined leaves it. */
export function saveCoolifySettings(p: {
  baseUrl?: string;
  uuid?: string;
  token?: string;
  autoRedeploy?: "on" | "off";
}): void {
  if (p.baseUrl !== undefined) setSetting("coolify_base_url", p.baseUrl.trim().replace(/\/+$/, "").replace(/\/api$/, ""));
  if (p.uuid !== undefined) setSetting("coolify_uuid", p.uuid.trim());
  if (p.token !== undefined) setSecretSetting("coolify_token", p.token.trim());
  if (p.autoRedeploy === "on" || p.autoRedeploy === "off") setSetting("coolify_auto_redeploy", p.autoRedeploy);
}
