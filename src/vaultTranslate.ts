/**
 * Central Vault — the translate tool (docs/central-vault-plan.md, Phase 2). Two directions, and it is
 * a TOOL (exposed to agents AND the Settings UI), not a formatter:
 *
 *   render(entries) → markdown    deterministic, NO LLM — the editor must never hallucinate what is
 *                                 stored. Grouped by kind, each field a labeled line.
 *   compress(text)  → entries[]   a cheap-model call that condenses human prose into canonical
 *                                 entries; existing key hints are passed so an edit becomes an upsert,
 *                                 not a duplicate. Nondeterministic → every caller shows the canonical
 *                                 diff before saving (the UI) or logs what it wrote (the librarian).
 *
 * The model call resolves the CHEAPEST capable model at tier `low` (P3 pricing policy) and runs a
 * single no-tools turn. Best-effort: a clear throw when no model is configured; callers degrade.
 */
import { decodeVaultEntry, type VaultEntry, type VaultInput, type VaultKind } from "./db/vault.js";
import { resolveChatExec, chatWorkdir, chatBaseEnv } from "./agents/chat.js";
import { resolveTierModel } from "./agents/pricing.js";
import { canonicalModel, MODELS } from "./agents/roles.js";
import { runLLM } from "./runners/exec.js";

const KIND_LABEL: Record<VaultKind, string> = {
  pref: "Preferences",
  know: "Knowledge",
  env: "Environment / tooling",
  gloss: "Glossary",
};
const KIND_ORDER: VaultKind[] = ["pref", "env", "know", "gloss"];

/** The exact canonical single line for a decoded entry (stable field order — matches encodeVaultEntry). */
export function canonicalLineOf(e: VaultEntry): string {
  const out: Record<string, unknown> = { v: e.v, k: e.k, t: e.t, s: e.s };
  if (e.r) out.r = e.r;
  out.c = e.c;
  out.w = e.w;
  return JSON.stringify(out);
}

/**
 * render(entries) → human-readable markdown. Deterministic template only — no model in this path.
 * Grouped by kind (stable order); each entry shows its key, scope, optional role, weight, and content.
 */
export function renderVault(entries: VaultEntry[]): string {
  if (!entries.length) return "_(vault is empty)_";
  const byKind = new Map<VaultKind, VaultEntry[]>();
  for (const e of entries) {
    const arr = byKind.get(e.t) ?? [];
    arr.push(e);
    byKind.set(e.t, arr);
  }
  const out: string[] = [];
  for (const kind of KIND_ORDER) {
    const group = byKind.get(kind);
    if (!group || !group.length) continue;
    out.push(`## ${KIND_LABEL[kind]}`);
    for (const e of [...group].sort((a, b) => b.w - a.w || a.k.localeCompare(b.k))) {
      const scope = e.s === "*" ? "global" : `\`${e.s}\``;
      const bits = [`scope ${scope}`, `weight ${e.w}`];
      if (e.r) bits.push(`role ${e.r}`);
      out.push(`- **${e.k}** — ${e.c}`);
      out.push(`  <sub>${bits.join(" · ")}</sub>`);
    }
    out.push("");
  }
  return out.join("\n").trim();
}

// ── cheap-model completion (tier low) ─────────────────────────────────────────────────────────────

/** Resolve exec (provider/model/auth) then swap the model to the cheapest capable tier-`low` one. */
function lowTierExec(): { model: string; provider: ReturnType<typeof resolveChatExec>["provider"]; authKind: "subscription" | "apiKey" } {
  const exec = resolveChatExec(""); // throws a clear "no model set up" if nothing is configured
  if (exec.provider) {
    const pick = resolveTierModel(exec.provider.id, "low");
    if (pick?.model) return { model: canonicalModel(pick.model), provider: exec.provider, authKind: exec.authKind };
    return exec;
  }
  // Claude-native (subscription): tier low = Haiku.
  return { model: MODELS.haiku, provider: null, authKind: exec.authKind };
}

/** One no-tools turn against the cheap model; returns the concatenated assistant text. */
export async function runVaultCompletion(systemPrompt: string, task: string): Promise<string> {
  const { model, provider, authKind } = lowTierExec();
  let text = "";
  await runLLM(
    {
      task,
      cwd: chatWorkdir("vault|translate"),
      model,
      provider,
      authKind,
      allowedTools: [],
      mcpServers: {},
      env: chatBaseEnv(),
      systemPrompt,
      abort: new AbortController(),
      maxTurns: 1,
      tokenCap: 0,
    },
    (message) => {
      const m = message as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) if (b.type === "text" && b.text) text += (text ? "\n" : "") + b.text;
      }
    },
  );
  return text.trim();
}

// ── compress: prose → canonical entries ───────────────────────────────────────────────────────────

const COMPRESS_SYSTEM = [
  "You convert human notes into the agency's Central Vault records. Output ONLY canonical records —",
  "one single-line JSON object per line, NOTHING else (no prose, no fences, no commentary).",
  "Each record: {\"v\":1,\"k\":\"kebab-key\",\"t\":\"pref|know|env|gloss\",\"s\":\"*\",\"c\":\"terse content\",\"w\":2}",
  "  k = stable kebab-case key (a-z 0-9 and dashes only).",
  "  t = pref (user preference) · know (durable knowledge) · env (environment/tooling fact) · gloss (term).",
  "  s = scope: \"*\" for global, or \"owner/repo\", or a prefix glob like \"reimedy-*\".",
  "  r = OPTIONAL role (developer/reviewer/…) — include only when the fact is that role's craft.",
  "  c = telegraphic, ≤ ~30 tokens. NO issue/PR references (#123) or run/PR URLs — those are banned.",
  "  w = weight 1–3 (3 = always inject, 1 = only when budget allows).",
  "Prefer FEW dense records over many. Reuse an existing key (given below) when a note refines it.",
].join("\n");

/** Pull canonical entries out of a model reply — tolerant of stray prose/fences around the lines. */
export function parseCompressOutput(text: string): VaultInput[] {
  const out: VaultInput[] = [];
  const seen = new Set<string>();
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
    if (!line.startsWith("{")) continue;
    const e = decodeVaultEntry(line);
    if (!e || seen.has(e.k)) continue;
    seen.add(e.k);
    const { v: _v, ...input } = e;
    out.push(input);
  }
  return out;
}

/**
 * compress(text, hints?) → canonical entries. `hints` are existing keys the model may reuse so an edit
 * upserts instead of duplicating. Returns validated VaultInput[]; the caller decides what to store
 * (the UI after a canonical-diff confirm; the librarian directly). Empty array on a model miss.
 */
export async function compressToEntries(text: string, hints: string[] = []): Promise<VaultInput[]> {
  const body = String(text || "").trim();
  if (!body) return [];
  const hintLine = hints.length ? `\n\nExisting keys you may reuse: ${hints.slice(0, 40).join(", ")}` : "";
  const reply = await runVaultCompletion(COMPRESS_SYSTEM, `Notes to store:\n${body}${hintLine}`);
  return parseCompressOutput(reply);
}

/**
 * explain(entry) → a short prose elaboration of one record (the UI's optional "Explain" button, never
 * automatic). Cheap model, best-effort — returns "" on any failure so the button just no-ops.
 */
export async function explainEntry(entry: VaultEntry): Promise<string> {
  try {
    return await runVaultCompletion(
      "Explain this stored knowledge record in 1–2 plain-English sentences for a human reviewer. No preamble.",
      canonicalLineOf(entry),
    );
  } catch {
    return "";
  }
}
