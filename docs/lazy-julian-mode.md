# Lazy Julian Mode (experimental)

**Settings → General → Lazy Julian Mode.** Off by default. Turning it on hands the whole agency to
the Orchestrator: it decides what runs, in what order, answers the agents' questions itself, and
merges. The issue board fades into the background and the orchestrator chat becomes the interface.

The bet is simple: the Orchestrator already holds the overview the human was using to make those
calls — every issue's state, what's in flight, file ownership, epic structure, per-issue run digests,
and the agency's own memory (`recall`). If that's enough context to *advise* a human scheduler, it's
enough to *be* one.

## What it switches off

| Gate | Normally | Lazy Julian Mode |
|---|---|---|
| Plan sign-off (`awaitingApproval`) | you 👍 the proposal | the plan posts and builds straight through (`pipeline.ts`) |
| A workflow's `humanApproval` gate | you press Approve | cleared automatically, the run continues |
| Plan-only issues | park on your 👍 | land in Review; the autopilot decides what happens next |
| ▶ Start | you press it per issue | the autopilot starts work, ordered and capped by free run slots |
| Merge | you press it | auto-merge (review approved + checks green + no conflicts) |
| Stalled / parked work | you press Resume or Fix | auto-resume, bounded by `AUTO_MAX_ATTEMPTS` |
| Chat proposals | "Create N issues" button | created **and started** on the spot |

Auto-merge and auto-resume are the existing per-issue toggles (`db/auto.ts`) — lazy mode only changes
their **default**. An explicit `off` at issue, repo, or global scope still wins, so one repo can be
carved out of the autopilot without leaving it.

## The loop

`src/lazy.ts`, ticking every `lazy_interval_seconds` (default 180):

1. **Snapshot** (`lazySnapshot`) — pure DB reads: parked issues and the last thing each agent said,
   planned work, what's in flight, what's in review, free run slots, and any question already put to
   the human. No GitHub round-trip, no tokens.
2. **Gate** — if nothing is parked, planned, or in review, the tick returns without spending
   anything. A quiet agency is free. The snapshot also carries a fingerprint: an agency that hasn't
   moved since the last decision doesn't buy the same answer twice (re-checked anyway every 10th
   tick, so a decision that never landed can't leave the autopilot silent forever).
3. **Decide** (`askAutopilot`) — one Orchestrator turn over that snapshot, answering in a
   ` ```plan ` block of directives.
4. **Execute** (`executeDirectives`) — `start` / `resume` / `fix` / `stop` / `merge` / `close` /
   `answer` / `route` / `create` / `ask` / `wait`. Starts are capped at the free run slots; anything
   held back is reported, never silently dropped.
5. **Report** — the reasoning plus one line per action, appended to the agency-wide orchestrator
   thread (`repo = "*"`), and mirrored onto each issue's own activity feed.

## Elevation: asks come to the Orchestrator first

Every reason an issue would normally stop and wait for a human — `awaitingApproval`,
`awaitingAnswer`, `needsAttention`, `conflict`, `unverified` — is handed to the Orchestrator with the
agent's last message attached. It answers with `answer owner/repo#N: …`, which posts into the issue
thread **as the human** and re-engages the run. The agent that asked never knows the difference.

Only when the answer genuinely isn't the Orchestrator's to give (a credential, a product or priority
call, money) does it emit `ask …`. That question is stored as the pending ask, shown at the top of
the chat, and repeated back into the prompt as "already asked, do NOT ask again" until you reply —
any message you send in the chat clears it. One open question at a time.

## Cost and blast radius

- The tick is free when there's nothing to decide, and one turn otherwise.
- Starts never exceed free pool slots, so the autopilot can't flood the concurrency limit.
- The per-issue budget caps, `AUTO_MAX_ATTEMPTS`, revise-round limits, the file-lock scheduler, and
  the self-merge quiet window (`deploySafety.ts`) all still apply — lazy mode removes *human* gates,
  not safety ones.
- Issues are faded in the UI, never disabled. Opening one and pressing Stop takes the wheel back at
  any moment; switching the setting off restores every gate immediately.

## Why "experimental"

Nothing checks the Orchestrator's judgment before it spends tokens or merges code. It is the right
mode for a repo where a bad merge is cheap to revert, and the wrong one for anything where it isn't.
