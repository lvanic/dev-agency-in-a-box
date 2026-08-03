// Small sound helper — status chimes (wav) plus spoken avatar voices.
// Off by default; a master toggle plus per-sound toggles live in Settings → Appearance
// (stored in localStorage). Chime files live in /web/audio (synthesized — see generate.py).
// Avatar voices are neural speech: server-side Piper (GET /tts) is the primary path — real,
// individual per-role voices with distinct character — falling back to the browser Web Speech
// API, then a /web/audio/voice-<role>.wav motif, so it always degrades gracefully.

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
  if (typeof name === "string" && name.indexOf("voice-") === 0) {
    const r = name.slice(6);
    const lines = HOVER_LINES[r] || ["yeah, what's up"];
    return voiceLine(r, lines[0]);
  }
  fire(name);
}

// Status cue on a poll transition. `kind` = "attention" | "done"; `number`/`role`/`blocked` come
// from the issue so the agent SPEAKS it ("review ready, issue 234"). The short wav chime and the
// spoken line are gated independently (chime by its own key, speech by "voices").
export function playCue(kind, number, role, blocked) {
  if (!isSoundOn()) return;
  // Only attention/done carry a brief chime wav; "working" is spoken-only (it fires often, and a
  // ding each time an issue starts would be noisy — the agent speaking "building now" is the cue).
  if (kind !== "working" && isSoundKindOn(kind)) fire(kind);
  if (isSoundKindOn("voices") && number != null) voiceLine(announcer(role, kind), statusLine(kind, blocked, number));
}

// --- avatar voices: the personas actually TALK -------------------------------------------------
// Primary path is server-side Piper neural TTS (GET /tts?role=&text=) — real, individual voices with
// per-role character (timbre + speed live in src/tts.ts; the PHRASING lives here). The browser Web
// Speech API is the fallback when /tts is unavailable (piper not installed yet, model still warming,
// offline), and the /web/audio/voice-<role>.wav motif is the last resort. So it degrades, never breaks.
const VOICE_ROLES = ["planner", "decomposer", "architect", "developer", "reviewer", "tester", "librarian", "auditor", "analyzer"];

// Casual hover lines (no issue context) — each role's personality shows in word choice + its voice.
const HOVER_LINES = {
  planner:    ["let's plan this out", "here's the plan", "what's up"],
  decomposer: ["breaking it down", "piece by piece", "yeah, splitting this up"],
  architect:  ["thinking big picture", "let's design this right", "hmm, let me think"],
  developer:  ["yeah, what's up", "on it", "let's build something", "coding now"],
  reviewer:   ["let me take a look", "looks good to me", "hold on, reviewing"],
  tester:     ["does it work?", "let me test that", "running the tests"],
  librarian:  ["noted", "filing this away", "got it"],
  auditor:    ["let me audit that", "checking the books", "digging in"],
  analyzer:   ["analyzing", "crunching the numbers", "scanning now"],
};

// Who announces a status change, and the line they speak (with the issue number). Each transition
// has a voice + phrasing: the issue's own agent speaks in its gender-matched voice.
function announcer(role, kind) {
  const r = String(role || "").toLowerCase();
  if (VOICE_ROLES.indexOf(r) >= 0) return r;
  return kind === "attention" ? "reviewer" : "developer"; // unknown role: reviewer flags review, developer builds/ships
}
function statusLine(kind, blocked, n) {
  const N = "issue " + n;
  if (kind === "done") return pick([N + " complete, ready to merge", "shipped " + N, N + ", done and dusted"]);
  if (kind === "working") return pick(["building now", "on it, " + N, N + ", coding now", "let's build"]);
  if (blocked === "awaitingApproval" || blocked === "awaitingAnswer") return pick(["review ready, " + N, N + " is ready for review", N + ", take a look"]);
  return pick([N + " needs you", "heads up, " + N + " needs a look", N + ", your call"]); // needsAttention / conflict
}
let pickN = 0;
function pick(arr) { return arr[(pickN++) % arr.length]; }

// --- Web Speech fallback (per-role pitch/rate + a distinct system voice) ---
const SS_CFG = {
  planner: { pitch: 1.1, rate: 1.0 }, decomposer: { pitch: 0.95, rate: 1.15 }, architect: { pitch: 0.8, rate: 0.95 },
  developer: { pitch: 1.15, rate: 1.1 }, reviewer: { pitch: 0.9, rate: 1.0 }, tester: { pitch: 1.0, rate: 1.2 },
  librarian: { pitch: 1.1, rate: 0.95 }, auditor: { pitch: 0.85, rate: 0.95 }, analyzer: { pitch: 0.95, rate: 1.05 },
};
const hasSpeech = typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
// macOS/WebKit ships "novelty" voices (Bahh, Boing, …) that make joke NOISES, not words — skip them.
const NOVELTY = new Set([
  "albert", "bad news", "bahh", "bells", "boing", "bubbles", "cellos", "good news", "jester",
  "organ", "pipe organ", "superstar", "trinoids", "whisper", "wobble", "zarvox", "junior", "ralph",
  "kathy", "fred", "deranged", "hysterical", "princess", "bruce", "agnes",
]);
let voicesCache = null;
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
function ssVoiceFor(role) {
  const vs = usableVoices();
  if (!vs.length) return null;
  const i = VOICE_ROLES.indexOf(role);
  return vs[(i >= 0 ? i : 0) % vs.length];
}
function speakLocal(role, text) {
  if (!hasSpeech) return fire("voice-" + role); // no Web Speech at all → old motif
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const c = SS_CFG[role] || {}; u.pitch = c.pitch || 1; u.rate = c.rate || 1; u.volume = 0.9;
    const v = ssVoiceFor(role); if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch (e) { fire("voice-" + role); }
}

// --- Piper (server) primary path ---
// Play /tts audio; resolve true if it started, false on error/timeout (so we fall back once). A slow
// first hit (model still downloading server-side) times out to the fallback and keeps warming — the
// next call is cached and instant.
function ttsPlay(role, text) {
  return new Promise((resolve) => {
    if (typeof Audio === "undefined") return resolve(false);
    let a;
    try { a = new Audio("/tts?role=" + encodeURIComponent(role) + "&text=" + encodeURIComponent(text)); a.volume = 0.9; }
    catch (e) { return resolve(false); }
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; if (!ok) { try { a.pause && a.pause(); a.src = ""; } catch (e) {} } resolve(ok); };
    if (typeof a.addEventListener === "function") {
      a.addEventListener("error", () => done(false));
      a.addEventListener("playing", () => done(true));
      a.addEventListener("ended", () => done(true));
    }
    try { const p = a.play(); if (p && p.catch) p.catch(() => done(false)); } catch (e) { return done(false); }
    setTimeout(() => done(false), 3500);
  });
}
// Speak one line for a role: Piper first, Web Speech fallback.
function voiceLine(role, text) {
  const r = String(role || "").toLowerCase();
  return ttsPlay(r, text).then((ok) => { if (!ok) speakLocal(r, text); });
}

// Avatar hover: the persona speaks a casual line, debounced per role so a hover can't machine-gun it.
const lineIdx = {}; // role -> rotating index so repeat hovers cycle through the lines
const lastVoice = {}; // role -> last-played timestamp
export function playVoice(role) {
  if (!isSoundOn() || !isSoundKindOn("voices")) return;
  const r = String(role || "").toLowerCase();
  if (VOICE_ROLES.indexOf(r) < 0) return;
  const now = Date.now();
  if (lastVoice[r] && now - lastVoice[r] < 700) return; // debounce rapid re-hover
  lastVoice[r] = now;
  const lines = HOVER_LINES[r] || ["yeah"];
  const n = (lineIdx[r] = (lineIdx[r] || 0) + 1);
  voiceLine(r, lines[n % lines.length]);
}
