// Small sound helper — preload + play short effects, respecting persisted mute settings.
// Off by default; a master toggle plus per-sound toggles live in Settings → Appearance
// (stored in localStorage). Files live in /web/audio (synthesized, royalty-free — see generate.py).

const KEY = "dab_sound";        // master: "1" = on, anything else = off (default)
const PREFS_KEY = "dab_sound_prefs"; // JSON { attention, done, voices } — each per-sound toggle, default on
const BASE = "/web/audio/";
const cache = {}; // name -> HTMLAudioElement (preloaded, reused)

// The toggleable sound categories — drives both gating here and the Settings UI (config-driven).
export const SOUND_CUES = [
  { key: "attention", label: "Issue needs you", sample: "attention" },
  { key: "done", label: "Issue done", sample: "done" },
  { key: "voices", label: "Avatar voices (on hover)", sample: "voice-developer" },
];

export function isSoundOn() {
  try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; }
}
export function setSoundOn(on) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (e) {}
}

function loadPrefs() {
  try { const raw = localStorage.getItem(PREFS_KEY); if (raw) return JSON.parse(raw) || {}; } catch (e) {}
  return {};
}
// A per-sound category is on unless explicitly disabled (default on when master is on).
export function isSoundKindOn(kind) { return loadPrefs()[kind] !== false; }
export function setSoundKindOn(kind, on) {
  const p = loadPrefs(); p[kind] = !!on;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) {}
}

function el(name) {
  if (typeof Audio === "undefined") return null;
  let a = cache[name];
  if (!a) { a = new Audio(BASE + name + ".wav"); a.preload = "auto"; a.volume = 0.5; cache[name] = a; }
  return a;
}

// Fire the actual audio, ungated. Never throws (browsers reject autoplay before a gesture).
function fire(name) {
  const a = el(name);
  if (!a) return;
  try { a.currentTime = 0; const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}

// Play a named effect if the master toggle is on.
export function play(name) {
  if (!isSoundOn()) return;
  fire(name);
}

// Preview a sound from Settings — plays regardless of toggles (the user asked to hear it).
export function preview(name) { fire(name); }

// Status cue: "attention" (issue needs something) | "done" (issue finished). Gated per-sound.
export function playCue(kind) {
  if (!isSoundOn() || !isSoundKindOn(kind)) return;
  fire(kind);
}

// Character voice sample for an avatar, debounced per role so a hover can't machine-gun it.
const VOICE_ROLES = ["planner", "decomposer", "architect", "developer", "reviewer", "tester", "librarian", "auditor", "analyzer"];
const lastVoice = {}; // role -> last-played timestamp
export function playVoice(role) {
  if (!isSoundOn() || !isSoundKindOn("voices")) return;
  const r = String(role || "").toLowerCase();
  if (!VOICE_ROLES.includes(r)) return;
  const now = Date.now();
  if (lastVoice[r] && now - lastVoice[r] < 600) return; // debounce rapid re-hover
  lastVoice[r] = now;
  fire("voice-" + r);
}
