// Piper TTS server module (#231): role→voice map + graceful soft-fail. No piper binary needed —
// these assert the contract the /tts route and the client fallback depend on.
import test from "node:test";
import assert from "node:assert/strict";

const { TTS_ROLES, ROLE_VOICES, VOICE_GENDER, synth } = await import("../dist/tts.js");

test("every agent role has a distinct voice configured", () => {
  const expected = ["planner", "decomposer", "architect", "developer", "reviewer", "tester", "librarian", "auditor", "analyzer"];
  assert.deepEqual(TTS_ROLES.sort(), [...expected].sort());
  const names = TTS_ROLES.map((r) => ROLE_VOICES[r].name);
  assert.equal(new Set(names).size, names.length, "each role maps to a unique piper voice");
  for (const r of TTS_ROLES) {
    const c = ROLE_VOICES[r];
    assert.ok(["low", "medium", "high"].includes(c.quality), `${r} quality valid`);
    assert.ok(c.speed > 0.5 && c.speed < 2, `${r} speed sane`);
  }
});

test("each role's voice gender matches its agent persona's gender", () => {
  for (const r of TTS_ROLES) {
    const c = ROLE_VOICES[r];
    const vg = VOICE_GENDER[c.name];
    assert.ok(vg, `${c.name} missing from VOICE_GENDER map`);
    assert.equal(vg, c.gender, `${r}: voice gender ${vg} != agent gender ${c.gender}`);
  }
});

test("synth soft-fails (returns null) for an unknown role", async () => {
  assert.equal(await synth("nobody", "hi"), null);
  assert.equal(await synth("developer", ""), null, "empty text → null");
});
