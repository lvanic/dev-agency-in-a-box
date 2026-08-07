# 🤖 Dev Agency

A fully autonomous team of AI agents you operate from one dashboard — app-first, with
GitHub as the code host and mirror. You file an issue (dashboard **+ New**, or on GitHub);
the agency routes it to the right agent, plans, asks if it must, waits for your 👍, builds
on a branch, tests, reviews, and hands you a draft PR. You test locally and tap **Merge**
on the dashboard. It runs 24/7 on Coolify (Docker), reacts instantly to webhooks, heals its
own PRs, learns from every run, and folds improvements into its own playbooks.

**Status (v1.2.0):** mobile-first dashboard (installable PWA, light/dark), multi-user login with
encrypted per-user credentials, a guided onboarding wizard, kanban with auto-resume/auto-merge,
and the self-evolving loop. Full design: [`../dev-agency-architecture.md`](../dev-agency-architecture.md).

---

## Quick start

1. **Deploy on Coolify** (Docker Compose from this repo) — **zero env vars required**. A
   `MASTER_KEY` is auto-generated and persisted on the data volume on first boot; everything else
   is configured in-app. Just make the domain route to **container port 3000** and keep the
   `agency-data` volume. Full steps + troubleshooting: [`COOLIFY.md`](COOLIFY.md).
2. **Open the dashboard** → create the admin account (first-run screen).
3. **Onboarding wizard** walks you through the rest: pick your models (Claude subscription/API,
   GLM, DeepSeek…), paste each token with step-by-step "where to get it" instructions, and add
   your first repo. No tokens in env — it's all in the dashboard, stored encrypted.
4. **Use it**: open an issue (or **+ New**) and the agency plans → builds → reviews → opens a PR.

Dev/prod split and staging: [`DEPLOY.md`](DEPLOY.md).

---

## Daily use (the only part you need)

### Start work

File an issue — dashboard **+ New** (with a route/agent picker and model override), the
repo's **Orchestrator chat** (describe an idea; it proposes scoped issues you create with
one click), or plain GitHub. No magic syntax: the **dealer** reads a fresh issue and routes
it to the right workflow or agent (a one-file fix → the developer solo; a fuzzy idea → the
planner). You can always re-route from the issue's card.

The full pipeline: Planner researches & proposes → you approve → Developer builds → Tester
runs checks → Reviewer reviews → draft PR. Small/obvious tasks skip the approval gate
entirely (`PLAN AUTO`). Every run opens with a `model=… because …` line — the cost-aware
picker chooses the cheapest capable model per step.

**Conversation just works** — reply anywhere (dashboard inline reply or GitHub), no tags
needed. Any comment re-engages the thread, even after you've merged and the issue/PR is closed:

- Reply on an **open issue** → it continues / replans with your note.
- Reply on a **plan** → 👍 (or `ok`) to build, or write the change to refine it.
- Comment on the **PR** → it pushes the fix to that PR.
- Comment on a **closed/merged issue or PR** → it reopens, builds your fix on a fresh branch
  off the latest `main`, and opens a new PR. No more reopening things by hand.

(Pure "thanks / lgtm / 👍" comments are ignored so they don't trigger a pointless build.)

### Approve, steer, merge

- **Approve a plan**: 👍 the proposal comment, or reply `ok` (also: `go`, `lgtm`, `yes`, `build it`…).
- **Change a plan**: just reply with the change — the planner answers with the delta only.
- **Answer questions**: reply normally; the pipeline resumes on its own.
- **Merge**: tap **Merge** on the card in the dashboard (Review column) —
  squash-merges the PR, deletes the branch, closes the issue.
- **Retrigger / resume an issue**: press **Resume** on its card.
- **Mute an issue**: toggle **Ignore** on its card.

### Work with PRs

- **Request changes**: just comment what to change — on the card's reply box or on the PR itself.
- **Self-healing**: failing CI or merge conflicts are fixed automatically (max 2 attempts,
  then it asks you for a hint).
- **Test locally**: `./scripts/checkout-issue.sh <owner/repo> <issue-number>`
  (or `git fetch origin && git checkout agency/issue-N`). PRs are draft on purpose —
  you mark ready / just tap **Merge** on the dashboard.

### Manage repos from the dashboard

Settings → Repos:

- **Add repo** — start watching a repo by `owner/name` (bot is auto-invited, webhook auto-registered)
- The watched-repos list is right there — no separate "list" step needed

### Labels (optional mirror)

The dashboard is the source of truth for issue state. If you like seeing state on GitHub,
turn on the outbound `agency:*` label mirror in Settings — it's write-only and **off by
default**; the agency never reads labels back (see `docs/adr/0001`).

### Dashboard (mobile-first)

Your Coolify domain serves a password-protected, light, **mobile-first kanban**, grouped by
repo then state (Working · Waiting on you · Ready · Needs attention · Merged). Tap a card to
open a detail drawer with:

- **Direct links** to the issue and the PR, plus **Open preview ↗** (the PR running live, no
  merge — see COOLIFY.md to enable).
- **Run checks ▶** — runs the tests on the branch and reports back, no merge.
- The **live agent stream** for that card, and the full **GitHub conversation** (markdown).
- An **inline reply** box that posts straight to GitHub — which re-engages the agency. So you
  can drive the whole thing from your phone without leaving the board.

`/history` has the full firehose, every run with its cost, and archive buttons.

### Lazy Julian Mode (experimental)

**Settings → General.** Off by default. Turn it on and the Orchestrator runs the whole agency:
plans build with no sign-off, it decides what starts and in what order, answers the agents'
questions itself, and merges green PRs. The board fades back and the orchestrator chat becomes the
interface — say what you want, and it opens, starts, and ships the work, reporting each move in the
chat. Questions only reach you when the answer is genuinely yours (a credential, a priority call,
money), and even then they arrive in the chat rather than on an issue card. Every gate returns the
moment you switch it off. Details: **[docs/lazy-julian-mode.md](docs/lazy-julian-mode.md)**.

---

## How it stays good and cheap

**Models** — cheapest capable, chosen at run time: each role resolves to a capability tier,
then the cheapest priced model in that tier (prices editable in Settings → Models; your
explicit per-role or per-issue picks always win). The choice and its reason are the first
line of every run; revise loops escalate to a stronger model after repeated failures and
downshift for trivial fix-ups.

**Cost guardrails** — every run's cost + turns land in the ledger. Per-issue budget
(default $15 / 800 turns across all runs) parks runaways at needs-attention instead of
burning more; per-run `maxTurns` stops loops. Flag an issue **Unlimited** on its card to
exempt it. Budgets are tuned in Settings → Operations.

**Self-evolving loop** — after each finished build a 📚 Librarian distills 0–3 non-obvious
lessons ("repo X needs pnpm", "tests want DATABASE_URL"); same-repo lessons ride along in
every agent's prompt immediately. Once enough pile up, they're folded live into the shared
and per-role **Learned** docs — versioned, browsable, and editable in **Settings → Memory**
(revert any revision). Optionally, generic learnings can also be proposed upstream to the
original project as draft PRs (Settings → General → Contribute upstream, off by default).

**Engineering harness** — every agent is bound by `memory/central/`: the CONSTITUTION plus
playbooks (atomic design, separation of concerns, KISS, reuse-before-create, central theme,
config-driven organisms, test & review standards). Edit the markdown, push, redeploy =
new rules. New projects start from a companion `project-template` repo that ships the same
harness as a working skeleton.

---

## Setup (once)

Runs on Coolify as a Docker Compose resource — step-by-step in **[COOLIFY.md](COOLIFY.md)**.
The short version:

1. Create a Docker Compose resource from this repo; set the domain (container port 3000).
2. Deploy — **no env vars required.** A `MASTER_KEY` auto-generates and persists on the
   `agency-data` volume. (Everything that used to be env — GitHub/Claude tokens, owner, repos,
   run mode, budgets — is now set in-app via the onboarding wizard and Settings → Operations.)
3. Open the dashboard → create the admin account → run onboarding to add your tokens + first repo,
   then file your first issue (**+ New**). That's it.

**Optional env overrides** (none required): `MASTER_KEY` (pin instead of auto-gen — keep it
stable), `RUN_MODE` (`watch`/`webhook`/`once`), `AGENCY_ENV=development` (DEV badge),
`ADMIN_USERNAME`/`ADMIN_PASSWORD` (seed the admin headlessly), `RESET_ADMIN_PASSWORD` (password
recovery), `GITHUB_WEBHOOK_SECRET` (webhook mode).

**Lost / rotating the encryption key?** Run `node scripts/reset-master-key.mjs` in the container
terminal — it wipes the stored (now-undecryptable) secrets + sessions and regenerates the key;
re-run onboarding afterwards.

Watched repos live in `config/repos.txt` (plus dashboard **Settings → Repos** additions in the DB volume);
handles in `config/team.txt`. Local/macOS run: `scripts/setup-macos.sh`, `scripts/run-local.sh`.

---

## Under the hood

```
src/
├── runner.ts      scan GitHub -> dispatch to a bounded worker pool (AGENCY_CONCURRENCY=3)
├── pipeline.ts    plan -> approve -> build -> test -> review -> PR (+ reflection)
├── agents/        roles (model + tools + persona), the Agent SDK runner
├── reflect.ts     librarian lessons + live playbook folding (+ optional upstream PRs)
├── budget.ts      cost guardrails
├── github.ts      gh CLI wrappers, labels, reactions, webhooks, collaborator invites
├── commands.ts    repo watch-list + access provisioning, orphan recovery
├── store.ts       SQLite ledger (issues, runs+cost, plans, lessons, activity)
├── webhook.ts     event server + dashboard routes (+ safety poll)
└── dashboard.ts   live status + /history
memory/central/    CONSTITUTION, playbooks, personas  <- the agency's editable brain
```

Issues/PRs are worked **in parallel** (default 3 at once), each in its own clone. Agent
runs use `bypassPermissions` inside the container (non-root), with the bot's git identity.
`npm test` runs the unit suite.
