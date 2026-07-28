// Small sound helper — preload + play short effects, respecting a persisted mute setting.
// Off by default; toggled in Settings → Appearance and stored in localStorage.
// Files live in /web/audio (synthesized, royalty-free — see web/audio/generate.py).

const KEY = "dab_sound"; // "1" = on, anything else = off (default)
const BASE = "/web/audio/";
const cache = {}; // name -> HTMLAudioElement (preloaded, reused)

export function isSoundOn() {
  try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; }
}
export function setSoundOn(on) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (e) {}
}

function el(name) {
  if (typeof Audio === "undefined") return null;
  let a = cache[name];
  if (!a) { a = new Audio(BASE + name + ".wav"); a.preload = "auto"; a.volume = 0.5; cache[name] = a; }
  return a;
}

// Play a named effect if sound is on. Never throws (browsers reject autoplay before a gesture).
export function play(name) {
  if (!isSoundOn()) return;
  const a = el(name);
  if (!a) return;
  try { a.currentTime = 0; const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}

// Status cue: "attention" (issue needs something) | "done" (issue finished).
export function playCue(kind) { play(kind); }

// Character voice sample for an avatar, debounced per role so a hover can't machine-gun it.
const VOICE_ROLES = ["planner", "decomposer", "architect", "developer", "reviewer", "tester", "librarian", "auditor", "analyzer"];
const lastVoice = {}; // role -> last-played timestamp
export function playVoice(role) {
  if (!isSoundOn()) return;
  const r = String(role || "").toLowerCase();
  if (!VOICE_ROLES.includes(r)) return;
  const now = Date.now();
  if (lastVoice[r] && now - lastVoice[r] < 600) return; // debounce rapid re-hover
  lastVoice[r] = now;
  play("voice-" + r);
}
