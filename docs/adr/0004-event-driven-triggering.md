# ADR 0004 — Event-driven triggering: keep `watch` as the default (for now)

Status: Accepted (investigation + recommendation — no runtime default change in this ADR)
Date: 2026-07-28
Context issue: #161 (Process Analyzer finding: "replace scan polling with event-driven triggering", ~3/24 reports)

## Context

The Process Analyzer flagged that some runaway re-run / rate-limit incidents may be rooted in
**polling itself** — a loop that re-scans GitHub on a fixed interval — rather than any single
call site. It asked whether the flagged incidents happened under pure polling and, if so, whether
defaulting to webhook mode would address this class of finding directly.

### What the code actually does today

Run mode is `RUN_MODE` (`src/config.ts:84`), parsed to one of three values — **there is no
`poll` mode**; the issue's `RUN_MODE=poll` refers to the default, which is `watch`:

- **`once`** — one pass, then exit.
- **`watch`** (default, `parseRunMode` → `"watch"`) — `runWatch` loops forever, calling
  `processAllRepos` then sleeping `pollIntervalSeconds` (default **60s**, min 10s). This is the
  "pure polling" the finding describes.
- **`webhook`** — `runWebhook` starts an HTTP server that GitHub calls on events and triggers a
  processing pass **instantly**, coalescing bursts (`src/webhook.ts:222` `trigger`).

Key detail: **both `watch` and `webhook` run the HTTP server, and `webhook` STILL polls.**
`runWebhook` keeps a `safetyPollMs = max(30, pollIntervalSeconds) * 1000` interval
(`src/webhook.ts:215`, `:2311`) that fires `trigger("safety-poll")` — because GitHub does not
webhook everything (e.g. 👍 reactions) and deliveries can be missed. So webhook mode is
**event-triggered + a slow safety poll**, not poll-free.

### So: were the incidents "pure poll"?

Almost certainly yes — the flagged repos ran under the **`watch`** default (no webhook secret
configured ⇒ no deliveries ⇒ the only trigger is the 60s poll). But that does **not** mean
webhook mode removes the loop the analyzer worried about:

- Webhook mode still runs the same `processAllRepos`/scan on every safety poll.
- A runaway re-run loop (issue re-planned/re-checked N times — the `#161` loop-budget finding)
  is driven by **auto-mode re-queuing a stuck issue**, not by the scan cadence. Event vs poll
  triggering changes *when* a scan starts, not whether a stuck issue keeps being retried.
- The rate-limit pressure comes from **how many GitHub calls each scan makes** (the field-scoping
  / per-endpoint-count finding), which is identical under both modes.

Webhook mode's real win is **latency and idle cost**: instant reaction to events, and on a quiet
repo the safety poll can be much slower than a 60s watch loop, so fewer idle scans. It is a good
thing to enable — it just isn't the lever that fixes the runaway-loop / rate-limit class.

## Decision

**Keep `watch` as the zero-config default. Do not flip the runtime default to `webhook` in this
issue.** Reasons:

1. Webhook mode needs a configured webhook secret + a publicly reachable URL. Defaulting to it
   would silently degrade any deployment that lacks those (it would fall back to the safety poll
   anyway — i.e. effectively `watch`, but with more moving parts and a confusing "mode: webhook"
   log line for an install that isn't actually receiving events).
2. Changing the agency-wide run-mode default is a behavior change with its own blast radius and
   deserves an explicit, separate decision — not a side effect of a low-priority bundle.
3. The runaway-loop and rate-limit findings are addressed **directly** and independently of run
   mode by the other two changes in #161 (loop-budget parking; per-endpoint call observability +
   field scoping). Those fixes apply under `watch` and `webhook` alike.

## Recommendation

- **Prefer `webhook` for production deployments** that have a public URL: set a webhook secret and
  `RUN_MODE=webhook` for instant reaction and lower idle-scan cost. This is an operator opt-in,
  documented, not a default flip.
- **Revisit defaulting to webhook** only after: (a) auto-provisioning of the webhook secret/URL so
  the default can't silently degrade, and (b) evidence that idle-scan cost (not runaway loops) is a
  material contributor to rate-limit pressure — measurable now via the new
  `github-endpoint-hot` incident + `apiCallStats()` per-endpoint counters added in #161.
- Treat run mode as a **latency/idle-cost** lever, not a **loop-safety** lever. Loop safety lives
  in the auto-mode budget guard; call-cost lives in field scoping + per-endpoint counting.
