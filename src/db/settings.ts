import { getDb } from "./connection.js";
import { encryptSecret, tryDecrypt } from "../crypto.js";

export function getSetting(key: string): string | null {
  const d = getDb();
  if (!d) return null;
  try {
    const row = d.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: string): void {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
      key,
      value,
    );
  } catch {
    /* best effort */
  }
}

export function setSecretSetting(key: string, plaintext: string): void {
  if (!plaintext) {
    setSetting(`secret.${key}`, "");
    return;
  }
  try {
    setSetting(`secret.${key}`, encryptSecret(plaintext));
  } catch {
    /* no MASTER_KEY — can't store securely; ignore */
  }
}

export function getSecretSetting(key: string): string | null {
  const v = getSetting(`secret.${key}`);
  return v ? tryDecrypt(v) : null;
}

/**
 * Per-repo credentials (issue #263). The raw `KEY=value` block a human pastes in Settings is
 * stored ENCRYPTED at rest, reusing the same secret/crypto path as every other secret — one key
 * per repo (`repo_creds.<owner/name>`). Repo-scoped only; never a global set. Parsing + masking
 * live in the logic layer (creds.ts) so this stays a thin store.
 */
export function setRepoCreds(repo: string, rawText: string): void {
  setSecretSetting(`repo_creds.${repo}`, rawText || "");
}
export function getRepoCreds(repo: string): string | null {
  return getSecretSetting(`repo_creds.${repo}`);
}
