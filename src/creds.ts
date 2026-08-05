/**
 * Resolve the credentials the agency runs with. Interim single-identity model: the first admin's
 * encrypted, dashboard-stored secrets drive execution, falling back to env vars. (Becomes truly
 * per-user/per-repo with the rest of task 28.) Read live so setting a token in the dashboard takes
 * effect without a redeploy.
 */
import { listUsers, getUserSecret, getRepoCreds } from "./store.js";
import { sStr } from "./settings.js";

/**
 * No client id is shipped: each deployment registers its OWN GitHub OAuth App and sets the id in
 * Settings → GitHub (or via GITHUB_OAUTH_CLIENT_ID). This is what makes the GitHub "Authorize"
 * screen show the operator's OWN app/owner name instead of someone else's — and keeps every
 * instance on its own OAuth App, rate limits and control.
 */
export const DEFAULT_GITHUB_OAUTH_CLIENT_ID = "";

function agencyAdminId(): number | null {
  try {
    const admin = listUsers().find((u) => u.role === "admin");
    return admin ? admin.id : null;
  } catch {
    return null;
  }
}
function adminSecret(key: string): string | null {
  const id = agencyAdminId();
  return id ? getUserSecret(id, key) : null;
}

/** Single OAuth-device-flow token. When present it IS the bot AND the owner — no separate bot. */
export function githubOAuthToken(): string {
  return adminSecret("github_oauth_token") || process.env.GITHUB_OAUTH_TOKEN?.trim() || "";
}
/** The OAuth App client id for the device flow (public). Setting/env override the shipped default. */
export function githubOAuthClientId(): string {
  return sStr("github_oauth_client_id", "GITHUB_OAUTH_CLIENT_ID", DEFAULT_GITHUB_OAUTH_CLIENT_ID).trim();
}
/** The connected account, for the "connected as" label + commit attribution (author = its noreply). */
export function githubIdentity(): { login: string; name: string; id: string } | null {
  const login = sStr("github_user_login", "", "").trim();
  if (!login) return null;
  return { login, name: sStr("github_user_name", "", login).trim() || login, id: sStr("github_user_id", "", "").trim() };
}
/** Bot token for the agency's own GitHub actions (commits, PRs, labels). OAuth token wins. */
export function ghBotToken(): string {
  return githubOAuthToken() || adminSecret("github_bot_token") || process.env.GITHUB_TOKEN?.trim() || "";
}
/**
 * "Acts as you" owner token. With OAuth the single token is both. For manual-PAT setups we now use
 * ONE token: fall back to the bot token (and GITHUB_TOKEN) so a single pasted PAT covers both the
 * "acts as the agency" and "acts as you" roles — no more two confusing token fields.
 */
export function ghUserToken(): string {
  return (
    githubOAuthToken() ||
    adminSecret("github_user_token") ||
    adminSecret("github_bot_token") ||
    process.env.ADMIN_GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    ""
  );
}
/** Claude subscription token for the Agent SDK (subscription auth). */
export function claudeToken(): string {
  return adminSecret("claude_token") || process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || "";
}
/** Anthropic pay-as-you-go API key (alternative to the subscription token). */
export function anthropicApiKey(): string {
  return adminSecret("anthropic_api_key") || process.env.ANTHROPIC_API_KEY?.trim() || "";
}
export function ghOwner(): string {
  return sStr("github_owner", "GITHUB_OWNER", "");
}

/**
 * Per-repo credentials (issue #263). A human pastes secrets as `KEY=value` lines in Settings; they
 * are stored encrypted (see db/settings.setRepoCreds) and injected into an agent run's ENV only at
 * run time — so the model can use them (by name) without ever seeing our storage, and we never
 * write a `.env` file or log a value.
 *
 * Pure parser: one `KEY=value` per line. Blank lines and `#` comments are ignored. A leading
 * `export ` is stripped (so pasting a shell-style `.env` works). Surrounding quotes on the value
 * are removed and whitespace trimmed. Keys must be valid env names ([A-Za-z_][A-Za-z0-9_]*);
 * malformed lines are skipped rather than throwing. Later lines win on a duplicate key.
 */
export function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = body.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Mask a secret value for display — never reveals the plaintext (fixed-width bullets by length). */
export function maskCredValue(value: string): string {
  const n = Math.min(8, Math.max(4, value.length));
  return "•".repeat(n);
}

/** The decrypted per-repo credential env for a run. Values are NEVER logged. Repo-scoped only. */
export function repoCredentials(repo: string): Record<string, string> {
  if (!repo) return {};
  return parseEnvLines(getRepoCreds(repo) || "");
}

/** Key NAMES + masked placeholders for the dashboard — never the plaintext values. */
export function repoCredentialKeys(repo: string): Array<{ key: string; masked: string }> {
  return Object.entries(repoCredentials(repo)).map(([key, value]) => ({ key, masked: maskCredValue(value) }));
}
/** True once we have a GitHub token to act with — gates all GitHub work + scanning. */
export function githubReady(): boolean {
  return Boolean(ghBotToken());
}
