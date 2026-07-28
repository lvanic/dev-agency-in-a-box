// Piper neural TTS — the agents actually talk, each with an individual voice + character.
//
// Server-side by design (ADR-friendly: the dashboard is always online, and the container already
// hosts long-running work): the /tts route (webhook.ts) calls synth() with a role + a line of text;
// we pick that role's Piper voice + speed, run the piper binary once, and cache the wav on the data
// volume keyed by (role, text). The client just plays the audio. If piper or a model is unavailable
// the caller returns a soft failure and the browser falls back to the Web Speech API — never a hard
// error. Voice models are downloaded lazily on first use (nothing is baked into the image).
//
// Character comes from three levers: the VOICE (timbre — a distinct Piper speaker per role), the
// SPEED (length_scale — "fast" agents talk quicker, "thinking" ones slower), and the PHRASING
// (chosen client-side, e.g. "yeah, on it — issue 234!"). This module owns voice + speed; the client
// owns phrasing.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export type Quality = "low" | "medium" | "high";
export interface VoiceCfg {
  /** Piper voice name under rhasspy/piper-voices en/en_US/<name>/<quality>/… */
  name: string;
  quality: Quality;
  /** length_scale: >1 slower (thinking), <1 faster (snappy). Character lever #2. */
  speed: number;
  /** Human note on the intended character — documentation only. */
  character: string;
}

// One distinct voice + character per role. Mixed quality (high for the two "flagship" roles the
// user hears most, medium elsewhere; danny only ships "low"). Names verified against
// huggingface.co/rhasspy/piper-voices (en_US).
export const ROLE_VOICES: Record<string, VoiceCfg> = {
  planner:    { name: "lessac",     quality: "high",   speed: 1.12, character: "measured, thinking out loud" },
  decomposer: { name: "amy",        quality: "medium", speed: 0.92, character: "brisk, breaks things down fast" },
  architect:  { name: "ryan",       quality: "high",   speed: 1.15, character: "deep, deliberate, big-picture" },
  developer:  { name: "joe",        quality: "medium", speed: 0.95, character: "upbeat, eager, a little tacky" },
  reviewer:   { name: "hfc_male",   quality: "medium", speed: 1.0,  character: "dry, matter-of-fact" },
  tester:     { name: "hfc_female", quality: "medium", speed: 0.85, character: "chipper, quick, curious" },
  librarian:  { name: "kristin",    quality: "medium", speed: 1.05, character: "soft, tidy, precise" },
  auditor:    { name: "kusal",      quality: "medium", speed: 1.15, character: "serious, slow, weighs things" },
  analyzer:   { name: "danny",      quality: "low",    speed: 0.9,  character: "clipped, robotic, rapid" },
};

export const TTS_ROLES = Object.keys(ROLE_VOICES);

const HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US";

/** The piper binary. Baked into the image at /opt/piper/piper (Dockerfile WITH_PIPER), or on PATH. */
function piperBin(): string {
  const env = process.env.PIPER_BIN?.trim();
  if (env) return env;
  if (existsSync("/opt/piper/piper")) return "/opt/piper/piper";
  return "piper"; // PATH fallback
}

/** Data-volume root for models + cache. Derives from DB_PATH's dir so it lands on the same volume. */
function ttsDir(): string {
  const base = process.env.PIPER_DIR?.trim() || join(dirname(process.env.DB_PATH?.trim() || "data/agency.db"), "piper");
  return base;
}

let availabilityCache: boolean | null = null;
/** True if the piper binary exists (checked once). Model presence is handled lazily per voice. */
export function ttsAvailable(): boolean {
  if (availabilityCache !== null) return availabilityCache;
  const bin = piperBin();
  // An absolute path we can stat, or trust PATH resolution (spawn will error → soft-fail per call).
  availabilityCache = bin === "piper" ? true : existsSync(bin);
  return availabilityCache;
}

function modelPaths(cfg: VoiceCfg): { onnx: string; json: string; base: string } {
  const file = `en_US-${cfg.name}-${cfg.quality}`;
  const dir = join(ttsDir(), "voices");
  return { onnx: join(dir, `${file}.onnx`), json: join(dir, `${file}.onnx.json`), base: file };
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  writeFileSync(tmp, buf);
  renameSync(tmp, dest); // atomic: a reader never sees a half-written model
}

const modelLocks = new Map<string, Promise<void>>();
/** Ensure a role's voice model (.onnx + .onnx.json) is on disk. Deduped per voice; downloads once. */
async function ensureModel(cfg: VoiceCfg): Promise<{ onnx: string; json: string }> {
  const p = modelPaths(cfg);
  if (existsSync(p.onnx) && existsSync(p.json) && statSync(p.onnx).size > 0) return p;
  const key = p.base;
  if (!modelLocks.has(key)) {
    const task = (async () => {
      const urlBase = `${HF_BASE}/${cfg.name}/${cfg.quality}/${p.base}`;
      await download(`${urlBase}.onnx.json`, p.json); // small first
      await download(`${urlBase}.onnx`, p.onnx);
    })().finally(() => modelLocks.delete(key));
    modelLocks.set(key, task);
  }
  await modelLocks.get(key);
  return p;
}

/** Keep text to a single short spoken line — bounds abuse and piper runtime. */
function cleanText(text: string): string {
  return String(text || "").replace(/[\r\n]+/g, " ").replace(/[^\p{L}\p{N} ,.!?'\-]/gu, "").trim().slice(0, 240);
}

function cacheFile(role: string, text: string): string {
  const sha = createHash("sha256").update(`${role}|${text}`).digest("hex").slice(0, 32);
  return join(ttsDir(), "cache", `${sha}.wav`);
}

function runPiper(onnx: string, out: string, speed: number, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["--model", onnx, "--output_file", out, "--length_scale", String(speed), "--sentence_silence", "0.15"];
    const ps = spawn(piperBin(), args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    ps.stderr.on("data", (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    ps.on("error", reject); // ENOENT etc. → soft-fail upstream
    ps.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`piper exit ${code}: ${err.slice(-300)}`))));
    ps.stdin.write(cleanText(text) + "\n");
    ps.stdin.end();
  });
}

const inFlight = new Map<string, Promise<Buffer | null>>();

/**
 * Synthesize a role's spoken line to a wav Buffer (cached). Returns null on any soft failure
 * (unknown role, piper missing, model download failed) so the caller can fall back gracefully.
 */
export async function synth(role: string, text: string): Promise<Buffer | null> {
  const r = String(role || "").toLowerCase();
  const cfg = ROLE_VOICES[r];
  const line = cleanText(text);
  if (!cfg || !line || !ttsAvailable()) return null;

  const out = cacheFile(r, line);
  if (existsSync(out) && statSync(out).size > 0) return readFileSync(out);

  const key = out;
  if (!inFlight.has(key)) {
    const task = (async (): Promise<Buffer | null> => {
      try {
        const { onnx } = await ensureModel(cfg);
        mkdirSync(dirname(out), { recursive: true });
        const tmp = `${out}.${process.pid}.part`;
        await runPiper(onnx, tmp, cfg.speed, line);
        renameSync(tmp, out); // atomic publish into the cache
        return readFileSync(out);
      } catch (e) {
        console.warn(`[agency] tts synth failed (${r}): ${(e as Error).message.slice(0, 200)}`);
        return null;
      }
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, task);
  }
  return inFlight.get(key)!;
}
