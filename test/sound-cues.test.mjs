// Tests for the optional sound effects (#231): the soundEvent() status classifier and the
// sound.js helper (mute default, toggle, per-role voice debounce). Pure — no browser needed.
import test from "node:test";
import assert from "node:assert/strict";

const { soundEvent } = await import("../web/lib/issue-logic.js");

test("soundEvent classifies attention / done / none", () => {
  assert.equal(soundEvent({ state: "done" }), "done");
  for (const b of ["awaitingApproval", "awaitingAnswer", "needsAttention", "conflict"]) {
    assert.equal(soundEvent({ state: "working", blocked: b }), "attention");
  }
  assert.equal(soundEvent({ state: "working" }), null);
  assert.equal(soundEvent({ state: "planned" }), null);
  assert.equal(soundEvent({ state: "working", blocked: "rateLimited" }), null);
});

// Minimal localStorage + Audio stubs so sound.js runs under Node.
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
let plays = 0;
globalThis.Audio = class { constructor() { this.volume = 1; } play() { plays++; return { catch() {} }; } };

const sound = await import("../web/lib/sound.js");

test("sound is off by default and toggles via setSoundOn", () => {
  assert.equal(sound.isSoundOn(), false);
  sound.play("done");
  assert.equal(plays, 0, "muted → nothing plays");
  sound.setSoundOn(true);
  assert.equal(sound.isSoundOn(), true);
  sound.play("done");
  assert.equal(plays, 1, "enabled → plays");
});

test("playVoice ignores unknown roles and debounces repeats", () => {
  sound.setSoundOn(true);
  plays = 0;
  sound.playVoice("nobody");
  assert.equal(plays, 0, "unknown role → no sound");
  sound.playVoice("planner");
  assert.equal(plays, 1);
  sound.playVoice("planner"); // within debounce window
  assert.equal(plays, 1, "rapid re-hover debounced");
});

test("per-sound toggles gate playCue and playVoice", () => {
  sound.setSoundOn(true);
  plays = 0;
  // default on for every configured cue
  for (const c of sound.SOUND_CUES) assert.equal(sound.isSoundKindOn(c.key), true);
  sound.setSoundKindOn("done", false);
  assert.equal(sound.isSoundKindOn("done"), false);
  sound.playCue("done");
  assert.equal(plays, 0, "disabled cue → no sound");
  sound.playCue("attention");
  assert.equal(plays, 1, "other cue still plays");
  // voices toggle gates avatar voices
  sound.setSoundKindOn("voices", false);
  sound.playVoice("tester");
  assert.equal(plays, 1, "voices off → hover silent");
  sound.setSoundKindOn("voices", true);
});

test("preview plays regardless of toggles", () => {
  sound.setSoundOn(false);
  plays = 0;
  sound.preview("done");
  assert.equal(plays, 1, "preview ignores master mute");
});
