/**
 * In-process activity bus: agents emit their streamed thoughts + tool uses here as they
 * work. The dashboard reads recent activity (persisted in SQLite) and subscribes for a live
 * feed over SSE. Everything is keyed by repo+issue so it's correct under parallel runs.
 */
import { recordActivity } from "./store.js";

export interface ActivityEvent {
  ts: number;
  repo: string;
  number: number;
  role: string;
  // "delta" = a live partial-text fragment for the streaming UI. Broadcast to SSE subscribers
  // for the "typing" feel, but NOT persisted — the authoritative record is the final "text" event.
  // "progress" = a live updating meter (e.g. clone %): same-text events REPLACE each other in the
  // UI (one progress bar, not a line per tick) and are NOT persisted — the caller records one
  // final "tool" line when the work completes.
  // "run_msg" = a per-issue run-thread message (pipeline.ts say()/sayAs()) — already durably stored
  // in `run_msg` by the caller BEFORE this broadcasts, so (unlike the other kinds) it's never also
  // written to the ephemeral `activity` table here; see pushRunMsg below.
  kind: "start" | "text" | "tool" | "done" | "delta" | "progress" | "run_msg";
  text: string;
  pct?: number; // 0–100, only on kind "progress"
  runId?: string; // "run_msg" only — groups messages from the same press-Start/Resume
  msgId?: number; // "run_msg" only — the run_msg row id, so the client can de-dupe against its initial load
  isAgency?: boolean; // "run_msg" only — agent (badge-prefixed, avatar) vs. human reply
}

// Units of work currently running (concurrent → can be several at once).
export interface ActiveWork {
  repo: string;
  number: number;
  kind: "issue" | "pr";
  role: string;
  title: string;
  since: number;
}
const akey = (repo: string, number: number) => `${repo}#${number}`;
const active = new Map<string, ActiveWork>();
export function setActive(repo: string, number: number, kind: "issue" | "pr", role: string, title = ""): void {
  active.set(akey(repo, number), { repo, number, kind, role, title, since: Date.now() });
}
export function updateActiveRole(repo: string, number: number, role: string): void {
  const a = active.get(akey(repo, number));
  if (a) a.role = role;
}
export function clearActive(repo: string, number: number): void {
  active.delete(akey(repo, number));
}
export function getActive(): ActiveWork[] {
  return [...active.values()].sort((a, b) => a.since - b.since);
}

const buffer: ActivityEvent[] = [];
const MAX = 300;
const subscribers = new Set<(e: ActivityEvent) => void>();

export function pushActivity(
  repo: string,
  number: number,
  role: string,
  kind: ActivityEvent["kind"],
  text: string,
  pct?: number,
): void {
  if (kind === "start") updateActiveRole(repo, number, role);
  const event: ActivityEvent = { ts: Date.now(), repo, number, role, kind, text, ...(pct != null ? { pct } : {}) };
  if (kind !== "delta" && kind !== "progress") {
    buffer.push(event);
    if (buffer.length > MAX) buffer.shift();
    recordActivity(repo, number, role, kind, text);
  }
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch {
      /* ignore a bad subscriber */
    }
  }
}

export function subscribe(fn: (e: ActivityEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Broadcast a run-thread message live over the SAME /events SSE stream as everything else, so the
 *  Detail run-thread panel needs no polling. The row is already durable (run_msg, written by the
 *  caller first per ADR-0001), so — unlike pushActivity — this ONLY notifies subscribers; it never
 *  touches the `activity` table or its bounded in-memory buffer. */
export function pushRunMsg(msgId: number, repo: string, number: number, runId: string, role: string, text: string, isAgency = true): void {
  const event: ActivityEvent = { ts: Date.now(), repo, number, role, kind: "run_msg", text, runId, msgId, isAgency };
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch {
      /* ignore a bad subscriber */
    }
  }
}

/** Wipe all activity for an issue (the buffer + DB rows). Used by the "reset issue" action. */
export function clearActivity(repo: string, number: number): void {
  // Drop in-memory buffer entries for this issue.
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].repo === repo && buffer[i].number === number) buffer.splice(i, 1);
  }
  clearActive(repo, number);
  try {
    const { getDb } = require("./store.js");
    const d = getDb();
    if (d) d.prepare("DELETE FROM activity WHERE repo = ? AND number = ?").run(repo, number);
  } catch { /* best effort */ }
}
