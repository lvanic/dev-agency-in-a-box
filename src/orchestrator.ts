/**
 * The orchestrator's decision core (Phase 3) — pure, deterministic, zero-token "what next?".
 *
 * The old flow ran a fixed planner→dev→test→review chain with the branching logic tangled into the
 * loop body. This extracts the decisions into one function over a compact handoff state, so the
 * controller does the cheap thinking in code instead of paying an agent to re-derive it. A failing
 * test loops back to the (warm) developer with just the errors; a no-op stops; approval finalizes.
 */

export type Phase = "developed" | "tested" | "reviewed" | "revised";
export type Action = "test" | "review" | "revise" | "finalize" | "stop";
/** P3 (prime-time-plan): a recommendation for which model TIER the next revise run should use,
 *  relative to whatever tier is currently assigned. Only ever set on an action:"revise" Decision. */
export type ModelHint = "escalate" | "same" | "downshift";

export interface HandoffState {
  phase: Phase;
  /** Did the last developer turn actually change anything (HEAD moved / tree dirty)? */
  devChanged: boolean;
  /** Did the last test run pass? (undefined before any test) */
  testPass?: boolean;
  /** Latest reviewer verdict. (undefined before any review) */
  reviewVerdict?: "approved" | "changes";
  /** Completed revise rounds so far. */
  round: number;
  /** Max revise rounds before we stop auto-revising and hand back to the human. */
  maxRounds: number;
  /**
   * P3: files touched by the change under test/review, when known — a proxy for "how big is this
   * diff" used (conservatively) by the downshift model hint. Undefined when not measured; a large or
   * unknown diff never downshifts.
   */
  filesChanged?: number;
  /**
   * P3: true ONLY when the caller can positively confirm the tester/reviewer's ask that triggered
   * this decision was purely mechanical (lint/formatting/nit-level, no logic change needed) — the
   * other downshift signal, alongside a small `filesChanged`. Conservative: omit/false means "don't
   * downshift" — this must never be inferred loosely, since downshifting a genuinely hard fix to a
   * weaker model would just burn another round.
   */
  trivialFeedback?: boolean;
  /**
   * P3: true when the round most recently completed ALSO ended in failure (test-fail or
   * changes-requested) — i.e. the failure driving THIS decision is a REPEAT, not the first one seen.
   * Combined with `round >= 1`, this is the escalate signal. The caller derives it from its own loop
   * state (in this codebase's build loop, reaching a new failure decision with round >= 1 always
   * means the just-completed revise round failed to prevent it — see pipeline.ts). Additive/optional
   * and conservative: omit/false never escalates on its own.
   */
  prevRoundFailed?: boolean;
}

export interface Decision {
  action: Action;
  /** Short machine-ish reason (for logs / the handoff trail), not necessarily human-facing. */
  reason: string;
  /** True when finalizing with the reviewer still wanting changes (park as "ready, needs changes"). */
  stillChanges?: boolean;
  /** P3: only set when action === "revise" — see ModelHint. */
  modelHint?: ModelHint;
}

/**
 * P3 (prime-time-plan): recommend escalate/downshift/same for the NEXT revise run.
 *   - escalate: round >= 1 (at least one revise already completed) AND the caller confirms the just-
 *     completed round ALSO failed — the 2nd (or later) consecutive failure signal (test-fail or
 *     changes-requested, in any mix) — persistent trouble, worth a stronger model. Only reachable
 *     when maxRounds allows a 2nd+ revise (maxRounds >= 2); with the default maxRounds = 1 there is
 *     only ever one revise-eligible round (round 0), so this never fires — same/downshift only.
 *   - downshift: ONLY on a fresh (round === 0) revise whose trigger was confirmed trivial AND touched
 *     at most one file — a cheaper model should manage a lint-level fix-up.
 *   - same: everything else (the conservative default).
 */
function pickModelHint(s: HandoffState): ModelHint {
  if (s.round >= 1 && s.prevRoundFailed === true) return "escalate";
  if (s.round === 0 && s.trivialFeedback === true && (s.filesChanged == null || s.filesChanged <= 1)) return "downshift";
  return "same";
}

/** Decide the next move from the current handoff state. Pure — no I/O, fully unit-testable. */
export function decideNext(s: HandoffState): Decision {
  switch (s.phase) {
    case "developed":
      return { action: "test", reason: "fresh code → run checks" };

    case "revised":
      if (!s.devChanged) return { action: "stop", reason: "revise produced no change" };
      return { action: "test", reason: "revised code → re-run checks" };

    case "tested":
      if (s.testPass === false) {
        if (s.round < s.maxRounds) return { action: "revise", reason: "tests failed → fix (errors only)", modelHint: pickModelHint(s) };
        return { action: "finalize", reason: "tests failing, out of rounds → park", stillChanges: true };
      }
      return { action: "review", reason: "tests passed → review" };

    case "reviewed":
      if (s.reviewVerdict === "approved") return { action: "finalize", reason: "approved" };
      if (s.round < s.maxRounds) return { action: "revise", reason: "changes requested → fix", modelHint: pickModelHint(s) };
      return { action: "finalize", reason: "changes requested, out of rounds → park", stillChanges: true };

    default:
      return { action: "finalize", reason: "unknown phase → finalize" };
  }
}
