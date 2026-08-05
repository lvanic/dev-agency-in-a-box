/**
 * ANALYZER_API_KEY hardening (P5, docs/prime-time-plan.md #13).
 *
 * docker-compose.yml used to ship a real, checked-in default key so the vendored `analyzer`
 * sidecar worked with zero config out of the box. That's a secret checked into git — fine while it
 * only ever crossed the internal compose network, riskier the moment this repo (or a fork) is used
 * as a public template. This mirrors the MASTER_KEY auto-generation pattern (src/crypto.ts):
 *
 *   1. env ANALYZER_API_KEY, UNLESS it's still the retired checked-in default (a stale .env or an
 *      un-updated docker-compose.yml copied forward) — that's treated the same as "unset",
 *   2. a key generated on a previous boot and persisted in the DB (encrypted, like every other
 *      secret setting — see src/db/settings.ts's setSecretSetting/getSecretSetting),
 *   3. a freshly generated 32-byte random key, persisted for every future boot.
 *
 * Unlike MASTER_KEY (which must live outside the DB — it's the very thing that encrypts DB
 * secrets), ANALYZER_API_KEY can safely be DB-persisted because MASTER_KEY is already resolved by
 * the time anything asks for it.
 *
 * The vendored `analyzer` service in docker-compose.yml no longer gets this baked in — if you run
 * it, copy the generated key from Settings → General → Process Analyzer into your own
 * `ANALYZER_API_KEY` env var (used by BOTH services there) so they still agree. See COOLIFY.md and
 * analyzer/README.md.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getSecretSetting, setSecretSetting } from "./store.js";

/** The literal that used to be checked into docker-compose.yml. Never trust this as a real secret. */
export const RETIRED_DEFAULT_ANALYZER_KEY = "ae3d3a8af34d5086fb00146f529afe99fdffd9ea4d6e2fc158cdcbc63b2fb96";

const SETTING_KEY = "analyzer_api_key_generated";

/** True for a key that must NOT be trusted as configured: empty, or the retired checked-in default. */
export function isUntrustedAnalyzerKey(k: string | null | undefined): boolean {
  const v = (k || "").trim();
  return !v || v === RETIRED_DEFAULT_ANALYZER_KEY;
}

let cached: string | null = null;

/**
 * The effective ANALYZER_API_KEY, resolved once per process and cached (same shape as
 * `masterKeyRaw()`): a trustworthy env override wins; otherwise a DB-persisted generated key from a
 * previous boot; otherwise generate one now and persist it so it's stable across restarts.
 */
export function analyzerApiKey(): string {
  if (cached) return cached;
  const env = process.env.ANALYZER_API_KEY?.trim();
  if (env && !isUntrustedAnalyzerKey(env)) return (cached = env);
  const persisted = getSecretSetting(SETTING_KEY);
  if (persisted && !isUntrustedAnalyzerKey(persisted)) return (cached = persisted);
  const gen = randomBytes(32).toString("hex");
  setSecretSetting(SETTING_KEY, gen);
  console.log(
    "[agency] generated a new ANALYZER_API_KEY and stored it (Settings → General → Process Analyzer " +
      "to copy it into a standalone or vendored analyzer sidecar).",
  );
  return (cached = gen);
}

/**
 * Mirror the resolved key to a file on a shared volume so the BUNDLED analyzer sidecar (same
 * docker-compose) can read it with zero config — no hand-copying the auto-generated key into an env
 * var. Best-effort: a no-op unless ANALYZER_KEY_FILE points somewhere writable, and never throws
 * (the sidecar is optional, and a failed mirror must never hold up boot). Standalone deployments
 * leave ANALYZER_KEY_FILE unset and keep using the env var as before.
 */
export function mirrorAnalyzerKeyToShare(): void {
  const p = process.env.ANALYZER_KEY_FILE?.trim();
  if (!p) return;
  try {
    const key = analyzerApiKey();
    let cur = "";
    try { cur = readFileSync(p, "utf8").trim(); } catch { /* not written yet */ }
    if (cur === key) return;
    mkdirSync(dirname(p), { recursive: true });
    // 0o644, not 0o600: the sidecar container may run as a different UID and must still read it.
    // Safe here — this path is an INTERNAL compose volume, never mounted anywhere public.
    writeFileSync(p, key, { mode: 0o644 });
    console.log("[agency] mirrored ANALYZER_API_KEY to shared file for the bundled analyzer sidecar:", p);
  } catch (e) {
    console.warn("[agency] couldn't mirror ANALYZER_API_KEY to shared file:", (e as Error).message);
  }
}

/** Test-only: drop the in-process cache so a test can re-resolve after changing env/DB state. */
export function _resetAnalyzerApiKeyCacheForTests(): void {
  cached = null;
}
