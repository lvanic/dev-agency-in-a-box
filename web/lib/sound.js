// Small sound helper — status chimes (wav) plus spoken avatar voices (Web Speech API).
// Off by default; a master toggle plus per-sound toggles live in Settings → Appearance
// (stored in localStorage). Chime files live in /web/audio (synthesized — see generate.py);
// avatar voices are spoken live by the browser, so each persona says a real line on hover.

const KEY = "dab_sound";        // master: "1" = on, anything else = off (default)
const PREFS_KEY = "dab_sound_prefs"; // JSON { attention, done, voices } — each per-sound toggle, default on
const BASE = "/web/audio/";
const cache = {}; // name -> HTMLAudioElement (preloaded, reused)

// The toggleable sound categories — drives both gating here and the Settings UI (config-driven).
export const SOUND_CUES = [
  { key: "attention", label: "Issue needs you", sample: "attention" },
  { key: "done", label: "Issue done", sample: "done" },
  { key: "voices", label: "Avatar voices — spoken (on hover)", sample: "voice-developer" },
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
// A "voice-<role>" name speaks the character's line; anything else fires the wav chime.
export function preview(name) {
  if (typeof name === "string" && name.indexOf("voice-") === 0) return speak(name.slice(6));
  fire(name);
}

// Status cue: "attention" (issue needs something) | "done" (issue finished). Gated per-sound.
export function playCue(kind) {
  if (!isSoundOn() || !isSoundKindOn(kind)) return;
  fire(kind);
}

// --- avatar voices: the personas actually TALK (Web Speech API) ---------------------------------
// Each role speaks a short, casual line ("yeah", "what's up", "on it") with its own pitch/rate and a
// distinct system voice, so every avatar sounds like an individual. Real speech — not a synth beep.
// (The app is always online; the old "no external samples" constraint that produced tone motifs is
// dropped.) Falls back to the /web/audio/voice-<role>.wav motif only where speechSynthesis is absent.
const VOICE_ROLES = ["planner", "decomposer", "architect", "developer", "reviewer", "tester", "librarian", "auditor", "analyzer"];
const VOICE_CFG = {
  planner:    { pitch: 1.0,  rate: 1.0,  lines: ["let's plan this", "here's the plan", "what's up"] },
  decomposer: { pitch: 1.3,  rate: 1.15, lines: ["breaking it down", "piece by piece", "yeah"] },
  architect:  { pitch: 0.8,  rate: 0.95, lines: ["big picture", "let's design this", "hmm, okay"] },
  developer:  { pitch: 1.1,  rate: 1.1,  lines: ["on it", "let's build", "yeah, coding now", "what's up"] },
  reviewer:   { pitch: 0.95, rate: 1.0,  lines: ["let me check", "looks good", "hold on"] },
  tester:     { pitch: 1.4,  rate: 1.2,  lines: ["does it work?", "testing", "let's see"] },
  librarian:  { pitch: 1.05, rate: 0.95, lines: ["noted", "filing this", "got it"] },
  auditor:    { pitch: 0.85, rate: 0.95, lines: ["let me audit", "checking the books", "yeah"] },
  analyzer:   { pitch: 1.2,  rate: 1.05, lines: ["analyzing", "crunching numbers", "what's up"] },
};

const hasSpeech = typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
// macOS/WebKit ships "novelty" voices (Bahh, Boing, …) that make joke NOISES instead of speaking —
// picking one would put us right back to beeps. Skip them; keep only real talking voices.
const NOVELTY = new Set([
  "albert", "bad news", "bahh", "bells", "boing", "bubbles", "cellos", "good news", "jester",
  "organ", "pipe organ", "superstar", "trinoids", "whisper", "wobble", "zarvox", "junior", "ralph",
  "kathy", "fred", "deranged", "hysterical", "princess", "bruce", "agnes",
]);
let voicesCache = null; // usable English speaking voices, lazily filled (getVoices() is empty until loaded)
function usableVoices() {
  if (!hasSpeech) return [];
  if (!voicesCache || !voicesCache.length) {
    const all = speechSynthesis.getVoices() || [];
    const en = all.filter((v) => /^en(-|_|$)/i.test(v.lang || ""));
    const good = en.filter((v) => !NOVELTY.has(String(v.name || "").toLowerCase()));
    voicesCache = good.length ? good : (en.length ? en : all);
  }
  return voicesCache;
}
if (hasSpeech) { try { speechSynthesis.onvoiceschanged = () => { voicesCache = null; }; } catch (e) {} }
// A stable, distinct voice per role (spread across the available speaking voices by role index).
function voiceFor(role) {
  const vs = usableVoices();
  if (!vs.length) return null;
  const i = VOICE_ROLES.indexOf(role);
  return vs[(i >= 0 ? i : 0) % vs.length];
}

const lineIdx = {}; // role -> rotating index so repeat hovers cycle through the lines
function speak(role) {
  const r = String(role || "").toLowerCase();
  const cfg = VOICE_CFG[r];
  if (!cfg) return;
  if (!hasSpeech) return fire("voice-" + r); // no Web Speech → old motif
  const n = (lineIdx[r] = (lineIdx[r] || 0) + 1);
  const text = cfg.lines[n % cfg.lines.length];
  try {
    speechSynthesis.cancel(); // a hover interrupts any in-flight line (no queue pile-up)
    const u = new SpeechSynthesisUtterance(text);
    u.pitch = cfg.pitch; u.rate = cfg.rate; u.volume = 0.9;
    const v = voiceFor(r); if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch (e) { fire("voice-" + r); }
}

// Avatar hover: the persona speaks its line, debounced per role so a hover can't machine-gun it.
const lastVoice = {}; // role -> last-played timestamp
export function playVoice(role) {
  if (!isSoundOn() || !isSoundKindOn("voices")) return;
  const r = String(role || "").toLowerCase();
  if (!VOICE_ROLES.includes(r)) return;
  const now = Date.now();
  if (lastVoice[r] && now - lastVoice[r] < 600) return; // debounce rapid re-hover
  lastVoice[r] = now;
  speak(r);
}
