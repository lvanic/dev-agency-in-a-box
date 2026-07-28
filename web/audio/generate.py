#!/usr/bin/env python3
# Generates the small, royalty-free sound effects used by the dashboard (web/lib/sound.js).
# Pure synthesis (sine + envelope) — no external samples, no dependencies. Re-run to regenerate:
#   python3 web/audio/generate.py
import math, struct, wave, os

SR = 8000  # 8 kHz mono keeps files tiny (~a few KB each)
HERE = os.path.dirname(os.path.abspath(__file__))


def write(name, samples):
    path = os.path.join(HERE, name + ".wav")
    with wave.open(path, "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, int(s * 32767)))) for s in samples))


def tone(freq, dur, vib=0.0, vibhz=6.0, vol=0.6):
    n = int(SR * dur); out = []
    for i in range(n):
        t = i / SR
        f = freq * (1 + vib * math.sin(2 * math.pi * vibhz * t))
        env = min(1.0, t / 0.01, (dur - t) / 0.03)  # short attack, gentle release
        out.append(vol * env * math.sin(2 * math.pi * f * t))
    return out


def seq(*notes):
    out = []
    for note in notes:
        out += tone(*note)
    return out


# --- status cues ---
write("attention", seq((880, 0.14), (660, 0.20)))          # gentle two-tone "ding-dong"
write("done", seq((523, 0.10), (659, 0.10), (784, 0.22)))  # rising C-E-G success arpeggio

# --- per-character "voice" motifs: each role a distinct pitch + vibrato so it feels individual ---
VOICES = {
    "planner":    [(392, 0.18, 0.03)],
    "decomposer": [(330, 0.10), (494, 0.14, 0.04)],
    "architect":  [(261, 0.22, 0.02)],
    "developer":  [(587, 0.10), (440, 0.12, 0.05)],
    "reviewer":   [(494, 0.14, 0.06)],
    "tester":     [(659, 0.08), (659, 0.12, 0.08)],
    "librarian":  [(349, 0.20, 0.03, 4.0)],
    "auditor":    [(311, 0.16, 0.05)],
    "analyzer":   [(440, 0.09), (554, 0.09), (659, 0.12, 0.04)],
}
for role, notes in VOICES.items():
    write("voice-" + role, seq(*notes))

print("generated", len(VOICES) + 2, "wav files in", HERE)
