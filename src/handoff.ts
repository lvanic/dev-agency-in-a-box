/**
 * Handoff (P2, prime-time-plan) — CONTEXT.md: "The compact machine state passed between the
 * orchestrator and an agent (and between agents): branch, changed files, last test, review verdict,
 * open questions. Replaces re-feeding the whole thread every turn."
 *
 * This is the wire format for that state: a single-line JSON envelope with short keys and
 * single-char enums where unambiguous. Finishes docs/orchestrator-v2-plan.md's "push a tiny handoff;
 * pull detail on demand" — `recall()` (src/agents/recall.ts) is the pull side; this is the push side
 * that replaces stitching the accumulated GitHub/run thread into every role's task (src/pipeline.ts).
 *
 * Target size: ≤ ~60 tokens serialized (roughly 240 chars) — encodeHandoff() drops empty/undefined
 * fields and caps the ones that could otherwise grow unbounded (`files`, `q`).
 */
import { filesFor, getReview } from "./store.js";

export const HANDOFF_VERSION = 1 as const;

/**
 * Where the work stands. A superset of orchestrator.ts's `Phase` (which only covers the
 * developed/tested/reviewed/revised build loop): this also covers "plan" — the planner deciding
 * whether to ask, propose, or build immediately — since the SAME envelope carries the planner's
 * decision (see pipeline.ts's parsePlannerDecision).
 */
export type HandoffPhase = "plan" | "dev" | "test" | "review" | "revise" | "done";
const PHASES: ReadonlySet<string> = new Set(["plan", "dev", "test", "review", "revise", "done"]);

/** p = tests passed, f = tests failed. Omitted = not run yet. */
export type HandoffTest = "p" | "f";
/** a = approved, c = changes requested. Omitted = no verdict yet. */
export type HandoffVerdict = "a" | "c";

export interface Handoff {
  v: 1;
  phase: HandoffPhase;
  /** Working branch, when one exists. */
  br?: string;
  /** Changed/footprint files — a pointer, not the diff (recall() has the rest). Capped, see MAX_FILES. */
  files?: string[];
  test?: HandoffTest;
  verdict?: HandoffVerdict;
  /** Completed revise rounds so far. */
  round?: number;
  /** A short open question or note (e.g. the planner's clarifying ask). Capped, see MAX_Q_LEN. */
  q?: string;
  /** Clickable answer choices for `q` (renders as buttons/checkboxes in the run thread). Capped, see MAX_OPTS. */
  opts?: string[];
  /** True → `opts` is a multi-select (checkboxes + submit); false/omitted → single-pick buttons. */
  multi?: boolean;
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set(["v", "phase", "br", "files", "test", "verdict", "round", "q", "opts", "multi"]);
const MAX_FILES = 12;
const MAX_Q_LEN = 240;
const MAX_OPTS = 6;
const MAX_OPT_LEN = 120;

/** Input to encodeHandoff/buildHandoff — every field but `phase` is optional (and dropped when empty). */
export type HandoffInput = Partial<Omit<Handoff, "v" | "phase">> & { phase: HandoffPhase };

/**
 * Encode a Handoff as its single-line JSON wire form. Drops undefined/falsy/empty fields so the
 * envelope stays minimal — that's the entire point (see the token-budget note above) — and caps
 * `files`/`q` so a runaway footprint or question text can never blow the budget.
 */
export function encodeHandoff(h: HandoffInput): string {
  const out: Record<string, unknown> = { v: HANDOFF_VERSION, phase: h.phase };
  if (h.br) out.br = h.br;
  if (h.files && h.files.length) out.files = h.files.slice(0, MAX_FILES);
  if (h.test) out.test = h.test;
  if (h.verdict) out.verdict = h.verdict;
  if (typeof h.round === "number" && Number.isFinite(h.round) && h.round > 0) out.round = h.round;
  if (h.q && h.q.trim()) out.q = h.q.trim().slice(0, MAX_Q_LEN);
  if (h.opts && h.opts.length) {
    const opts = h.opts.map((o) => String(o).trim()).filter(Boolean).slice(0, MAX_OPTS).map((o) => o.slice(0, MAX_OPT_LEN));
    if (opts.length) { out.opts = opts; if (h.multi) out.multi = true; }
  }
  return JSON.stringify(out);
}

/**
 * Decode + STRICTLY validate a Handoff wire string. Rejects unknown `v`, any key outside the
 * schema, and any field with the wrong type/shape — never coerces or guesses, since a mis-parsed
 * Handoff would silently steer the orchestrator/agent on garbage. Returns null on anything invalid;
 * every caller in this codebase treats null as "fall back to the legacy parser", never a hard failure.
 */
export function decodeHandoff(s: string): Handoff | null {
  if (typeof s !== "string" || !s.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(s);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!ALLOWED_KEYS.has(k)) return null;
  if (o.v !== HANDOFF_VERSION) return null;
  if (typeof o.phase !== "string" || !PHASES.has(o.phase)) return null;
  const out: Handoff = { v: 1, phase: o.phase as HandoffPhase };
  if (o.br !== undefined) {
    if (typeof o.br !== "string") return null;
    out.br = o.br;
  }
  if (o.files !== undefined) {
    if (!Array.isArray(o.files) || !o.files.every((f) => typeof f === "string")) return null;
    out.files = o.files as string[];
  }
  if (o.test !== undefined) {
    if (o.test !== "p" && o.test !== "f") return null;
    out.test = o.test;
  }
  if (o.verdict !== undefined) {
    if (o.verdict !== "a" && o.verdict !== "c") return null;
    out.verdict = o.verdict;
  }
  if (o.round !== undefined) {
    if (typeof o.round !== "number" || !Number.isFinite(o.round) || o.round < 0) return null;
    out.round = o.round;
  }
  if (o.q !== undefined) {
    if (typeof o.q !== "string") return null;
    out.q = o.q;
  }
  if (o.opts !== undefined) {
    if (!Array.isArray(o.opts) || !o.opts.every((x) => typeof x === "string")) return null;
    const opts = (o.opts as string[]).map((x) => x.trim()).filter(Boolean);
    if (opts.length) out.opts = opts;
  }
  if (o.multi !== undefined) {
    if (typeof o.multi !== "boolean") return null;
    if (o.multi) out.multi = true;
  }
  return out;
}

/** The tag a role's structured first line carries: `HANDOFF {...}`. */
export const HANDOFF_TAG = "HANDOFF";
// Tolerant on purpose: models drift toward wrapping the line in backticks (even though the
// instruction strings below now explicitly say not to) and toward tacking on trailing prose after
// the JSON on the SAME line. Both must still match so the line gets stripped before any fallback
// parser runs on it — see extractHandoffLine's "always strip the tagged line" contract.
//   - `{0,3}`         optional leading backtick-fence (1-3 backticks)
//   - (\{.*?\})        group 1: the JSON object, captured NON-GREEDILY up to its first "}" — safe
//                       because the Handoff schema is flat (no nested {} — arrays use [], never objects)
//   - \s*`{0,3}`       optional closing backtick-fence
//   - (.*)$            group 2: anything trailing on the SAME line — kept (not discarded) by
//                       extractHandoffLine below, since it's real human-facing prose, not the tag
const LINE_RE = /^\s*`{0,3}\s*HANDOFF\s*[:\-]?\s*(\{.*?\})\s*`{0,3}(.*)$/i;
const FENCE_RE = /```(?:json|handoff)?\s*\n?\s*(\{[^\n`]*\})\s*\n?```/i;

/** Render a Handoff as the exact line a role should emit / the orchestrator embeds in a task. */
export function renderHandoffLine(h: HandoffInput | Handoff): string {
  return `${HANDOFF_TAG} ${encodeHandoff(h)}`;
}

/**
 * The "structured status → templated prose" translate (token-optimization-plan-2026-07-27): turn the
 * compact machine Handoff into ONE readable human status line, deterministically and at zero token
 * cost. This is what lets an agent emit only the terse HANDOFF envelope (cheap) while the human still
 * gets a clean sentence — so no agent tokens are spent narrating "tests passed, moving to review".
 */
export function renderHandoffStatus(h: Handoff): string {
  const round = typeof h.round === "number" && h.round > 0 ? ` (round ${h.round})` : "";
  const files = h.files && h.files.length ? ` · ${h.files.length} file${h.files.length > 1 ? "s" : ""}` : "";
  switch (h.phase) {
    case "plan":
      return h.q ? `❓ Needs your input: ${h.q}` : "📋 Plan ready for your approval.";
    case "dev":
      return `🔨 Building${h.br ? ` on \`${h.br}\`` : ""}${files}.`;
    case "test":
      return h.test === "f" ? `❌ Tests failed${round}.` : h.test === "p" ? `✅ Tests passed${round}.` : `🧪 Running tests${round}.`;
    case "review":
      return h.verdict === "a" ? `✅ Reviewed — approved${round}.`
        : h.verdict === "c" ? `📝 Reviewed — changes requested${round}.`
        : `🔍 Reviewing${round}.`;
    case "revise":
      return `🔧 Addressing feedback${round}${files}.`;
    case "done":
      return "🎉 Done.";
    default:
      return h.phase;
  }
}

/**
 * Pull a structured Handoff out of an agent's reply: the first non-blank line (`HANDOFF {...}`) or a
 * fenced single-line JSON block — whichever is present and valid. Returns the parsed Handoff (or null
 * if missing/malformed — the caller falls back to its own regex/keyword parser, per pipeline.ts's
 * "never hard-fail on a parse miss" rule) and `rest`: the reply with that line/fence stripped, i.e.
 * what a human should actually read (the GitHub mirror never shows the machine line).
 */
export function extractHandoffLine(text: string): { handoff: Handoff | null; rest: string } {
  const src = text ?? "";
  const lines = src.split("\n");
  let idx = 0;
  while (idx < lines.length && lines[idx].trim() === "") idx++;
  if (idx < lines.length) {
    const m = LINE_RE.exec(lines[idx].trim());
    if (m) {
      // The line carries the HANDOFF tag either way — strip JUST the tag+JSON(+backticks) before
      // falling back, so a malformed envelope (bad JSON) doesn't also poison the legacy keyword/regex
      // fallback parser, which looks at the (now-clean) first remaining line. Any trailing prose the
      // model tacked on AFTER the JSON on that same line is real human-facing content — keep it
      // (as its own line) rather than discarding the whole line.
      const trailing = (m[2] || "").trim();
      const rest = [...lines.slice(0, idx), ...(trailing ? [trailing] : []), ...lines.slice(idx + 1)].join("\n").trim();
      const h = decodeHandoff(m[1]);
      return { handoff: h, rest };
    }
  }
  const fm = FENCE_RE.exec(src);
  if (fm) {
    const h = decodeHandoff(fm[1]);
    if (h) return { handoff: h, rest: src.replace(fm[0], "").trim() };
  }
  return { handoff: null, rest: src.trim() };
}

/**
 * Compose the CURRENT Handoff from what's already recorded in the DB (file footprint, latest review
 * verdict) plus whatever the caller knows locally — `phase`, `br`, `round`, `test`, `q` — the
 * loop-local bits that live only in pipeline.ts's in-flight state, not the DB. Pure read, no writes.
 */
export function buildHandoff(repo: string, number: number, phase: HandoffPhase, extra?: Partial<Omit<Handoff, "v" | "phase">>): Handoff {
  const files = filesFor(repo, number);
  const rev = getReview(repo, number);
  const input: HandoffInput = {
    phase,
    files: files.length ? files : undefined,
    verdict: rev ? (rev.verdict === "approved" ? "a" : "c") : undefined,
    ...extra,
  };
  // Re-encode/decode to normalize + apply the same caps a wire-received Handoff would have.
  return decodeHandoff(encodeHandoff(input))!;
}

/**
 * Told to the Reviewer alongside its task: how to encode its verdict as the structured first line.
 * Deliberately shows the JSON as PLAIN TEXT, not wrapped in backticks/a code fence — models otherwise
 * tend to copy that inline-code styling literally into their reply, and a backtick-wrapped line, while
 * still tolerated by extractHandoffLine()'s parser, is a needless way to invite a parse miss.
 */
export const REVIEWER_HANDOFF_INSTRUCTION =
  "Start your reply with exactly one line — plain text, NOT wrapped in backticks or a code fence — " +
  'that is exactly this JSON: {"v":1,"phase":"review","verdict":"a"} if you approve, or ' +
  '{"v":1,"phase":"review","verdict":"c"} if you want changes. Put your notes (for the human) in ' +
  "prose on the lines after it.";

/** Told to the Planner alongside its task: how to encode QUESTIONS / PLAN / PLAN-AUTO as the
 *  structured first line (replaces the old "signal with the first word" convention). Same plain-text,
 *  no-backticks note as REVIEWER_HANDOFF_INSTRUCTION above. */
export const PLANNER_HANDOFF_INSTRUCTION =
  "Start your reply with exactly one line — plain text, NOT wrapped in backticks or a code fence — " +
  'that is exactly this JSON: {"v":1,"phase":"plan","q":"<short question>"} if you need clarification ' +
  "(keep q short — a few words; ask in full below); " +
  '{"v":1,"phase":"dev"} if this is small enough to build right away with no approval step (your ' +
  'default); or {"v":1,"phase":"plan"} if you have a plan that should be proposed for approval first ' +
  "(large or cross-cutting change). Put the full questions/plan in prose on the lines after it. " +
  "When your question has DISCRETE answer choices, add them so the human can click instead of type: " +
  'set `"opts"` to the list of choices (max 6, short labels), e.g. ' +
  '{"v":1,"phase":"plan","q":"Flutter or Expo?","opts":["Pivot to Flutter","Keep Expo","Something else"]}. ' +
  'Add `"multi":true` only when the human may pick SEVERAL choices at once (select-all-that-apply); ' +
  "omit it for a single pick. Still write the full question in prose below the line.";
