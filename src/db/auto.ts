import { getSetting, setSetting } from "./settings.js";

export type AutoKind = "resume" | "merge";

export type AutoValue = "on" | "off" | ""; // "" = inherit (or, at global level, default off)

function autoKey(kind: AutoKind, repo?: string, number?: number): string {
  if (repo && number) return `auto.${kind}.${repo}#${number}`;
  if (repo) return `auto.${kind}.${repo}`;
  return `auto.${kind}`;
}

export function getAutoRaw(kind: AutoKind, repo?: string, number?: number): AutoValue {
  const v = getSetting(autoKey(kind, repo, number));
  return v === "on" || v === "off" ? v : "";
}

export function setAuto(kind: AutoKind, value: AutoValue, repo?: string, number?: number): void {
  setSetting(autoKey(kind, repo, number), value === "on" || value === "off" ? value : "");
}

/**
 * Lazy Julian Mode's default for auto-resume/auto-merge. Read raw here rather than through
 * settings.ts's sBool so this leaf module keeps its single dependency (db/settings) and can't form
 * an import cycle — src/lazy.ts owns the user-facing predicate.
 */
function lazyDefaultsOn(): boolean {
  const v = getSetting("lazy_mode");
  return v === "on" || v === "true" || v === "1";
}

/**
 * Resolve auto-<kind> for an issue: issue → repo → global → (Lazy Julian Mode ? on : off). An
 * explicit "off" at ANY scope still wins over lazy mode, so one repo or issue can be carved out of
 * the autopilot without leaving it.
 */
export function autoEnabled(kind: AutoKind, repo: string, number: number): boolean {
  const i = getAutoRaw(kind, repo, number);
  if (i) return i === "on";
  const r = getAutoRaw(kind, repo);
  if (r) return r === "on";
  const g = getAutoRaw(kind);
  if (g) return g === "on";
  return lazyDefaultsOn();
}

export function autoAttempts(repo: string, number: number): number {
  return Number(getSetting(`auto.attempts.${repo}#${number}`)) || 0;
}

export function bumpAutoAttempts(repo: string, number: number): number {
  const n = autoAttempts(repo, number) + 1;
  setSetting(`auto.attempts.${repo}#${number}`, String(n));
  return n;
}

export function resetAutoAttempts(repo: string, number: number): void {
  setSetting(`auto.attempts.${repo}#${number}`, "0");
  clearAutoParked(repo, number); // reached a good state → allow future auto-runs (and re-park) again
}

/**
 * "Parked for a human" latch. Set once when an issue exhausts its auto-attempts so we post the
 * structured give-up summary exactly ONCE instead of every auto-mode tick. Cleared by
 * resetAutoAttempts when the issue reaches a good state (so a later regression can re-park + re-notify).
 */
export function isAutoParked(repo: string, number: number): boolean {
  return getSetting(`auto.parked.${repo}#${number}`) === "1";
}

export function markAutoParked(repo: string, number: number): void {
  setSetting(`auto.parked.${repo}#${number}`, "1");
}

export function clearAutoParked(repo: string, number: number): void {
  setSetting(`auto.parked.${repo}#${number}`, "");
}
