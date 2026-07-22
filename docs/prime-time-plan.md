# Prime-Time Plan — investor-ready dev-agency

Status legend: ☐ todo · ◐ in progress · ☑ done
Created 2026-07-22 from a full-repo deep dive (orchestrator, comms, model selection, analyzer, knowledge base, UI, hygiene). Work top-to-bottom; each item is an independently shippable PR.

## Findings snapshot (what's true today)

- **Two disconnected "orchestrators"**: a deterministic per-issue `decideNext()` (`src/orchestrator.ts`) inside the build loop, and a per-repo/agency conversational chat (`src/agents/orchestrator-chat.ts`, DB table `orch_msg`). No per-issue agent chat object; repo chat reads issue *metadata*, never run conversations.
- **Agent comms = verbose GitHub Markdown comments**; every role re-reads the whole thread (O(N) tokens/turn). The compact-`Handoff` design exists in CONTEXT.md + `docs/orchestrator-v2-plan.md` but is not shipped; `recall()` MCP tool exists.
- **Model selection = static per-role table** (`src/agents/roles.ts`), tier resolution in `roleAgent.ts`. No cost-aware pick, no logged rationale, no re-evaluation on revise loops (same model every round; budget is only a $15 kill switch).
- **Analyzer**: vendored thin HTTP client (`analyzer/`), least-privilege (no LLM/GitHub creds), one-compose Coolify deploy with zero required env vars. Works. No fork→upstream feedback channel; self-improve PRs target the instance's own repo.
- **Knowledge base**: learning loop IS live (reflect → `lessons` → self-improve → `_learned.md` override → injected into prompts). Gaps: per-role `*.learned.md` never written; DB overrides never sync to git markdown; agent-editor **backend exists with no UI**; per-repo memory is a `.gitkeep` comment; lessons are global (no repo scoping).
- **UI**: atomic design dirs already exist and layering is clean; `web/core.js` (921 lines) is a half-migrated legacy monolith (few helpers still imported, rest dead incl. a duplicate `avatarFile`). Detail thread polls every 6 s while activity uses SSE. Breakpoints scattered (560/680/760/879/880/900). Orchestrator had no avatar (borrowed the auditor's).
- **Hygiene**: stale `Inventory.md`/`Plan.md`/`Tasks.md`, orphaned `scripts/agency-run.sh`, stale README `/classic` mention, untracked `.devagency/attachments/` (2.3 MB screenshots).
- **Open issues overlap**: #84 (orchestrator-first workspace) and #85 (cross-issue coordination) are the roadmap homes for P1/P2 below.

## P0 — Quick wins (today)

- ☑ **Orchestrator avatar = bald guy with beard.** New `web/avatars/orchestrator.svg` + `heads/orchestrator.svg`; registered in `Avatar.js` (`ROLE_AVATAR/EMOJI/ICON`); `Orchestrator.js` bubbles no longer wear the auditor's face.
- ☑ **Delete stale files**: `Inventory.md`, `Plan.md`, `Tasks.md`, `scripts/agency-run.sh`; README `/classic` fiction removed.
- ☐ **User action**: delete untracked `.devagency/attachments/` locally (2.3 MB dev screenshots; agent won't remove untracked files unasked).

## P1 — Orchestrator communication (issue #84 home)

1. ☐ **Per-issue run thread (central agent chat).** New DB table `run_msg (repo, number, run_id, agent, kind, body, meta, ts)`. Every `say()`/`sayAs()` in `pipeline.ts` writes here *first*; GitHub comment becomes a mirror (existing outbound-label philosophy, ADR-0001). Detail view reads this thread over SSE instead of polling GitHub every 6 s.
2. ☐ **Issue-orchestrator rollup.** On every run-thread append, upsert a compact per-issue digest (state, phase, last verdict, open questions ≤ ~50 tokens). `repoContext()` in `orchestrator-chat.ts` consumes digests, so the repo orchestrator chat genuinely "knows" every run.
3. ☐ **Repo → agency rollup.** Agency-wide thread (`"*"`) gets per-repo digest lines the same way. Result: agent → issue thread → repo orchestrator → main orchestrator, all queryable in one UI.

## P2 — Machine-code agent comms (cheapest deterministic protocol)

4. ☐ **Ship the compact Handoff envelope** (finishes orchestrator-v2 plan). Single-line JSON between roles: `{v,phase,br,files,test,verdict,round,q}` — short keys, enums as single chars where unambiguous (`test:"p"|"f"`, verdict `"a"|"c"`). Target ≤ 60 tokens vs. current full-thread re-feed. Roles pull detail on demand via existing `recall()`. Humans keep readable prose only at the GitHub mirror boundary. Parsers: strict JSON schema, not regex (replaces `changesRequested()` regex + `parsePlannerDecision()` keyword sniffing).
5. ☐ **Kill thread re-feeding** in `pipeline.ts` role prompts (`plan()`, revise/review sites): pass issue header + Handoff + digest, never the concatenated comment thread.

## P3 — Cost-aware model selection

6. ☐ **Price-annotated catalog.** Extend discovered provider models (`src/db/providers.ts`) with $/Mtok in+out (static price map per known model id, editable in Settings → Models). 
7. ☐ **Selection = cheapest capable.** Replace static role→model table with policy: task complexity score (issue size, kind, prior failures) → capability tier → cheapest model in tier by price. Log decision as first run event: `model=X role=dev reason="tier M, cheapest capable ($0.8/M), fresh issue"` — shown at top of the run in UI.
8. ☐ **Re-evaluate on loop-back.** In `decideNext()` (already the loop brain): on `revise`, include model recommendation — escalate tier after ≥2 failed rounds or large diff; de-escalate to haiku-class for trivial fix-ups (small diff, single file, lint-level). `runRole` honors it; rationale logged to run thread.

## P4 — Knowledge base management

9. ☐ **Memory tab in Settings** (backend `/agents`, `/agent-save`, `/agent-revert` already works): list personas/playbooks/learned docs, markdown editor, revision history + revert. This is the human-readable/editable KB.
10. ☐ **Close the loop holes**: write per-role `<role>.learned.md` in self-improve (or delete the dead read path); sync DB overrides back to git-tracked `memory/*.md` via existing `agentFileRepoPath` (currently zero callers) so files never silently drift.
11. ☐ **Per-repo scoping.** `recentLessons()` prefers same-repo lessons (columns already exist), falls back to global; implement `memory/projects/<repo>/` or delete the aspirational `.gitkeep`.

## P5 — Analyzer / upstream feedback

12. ☐ **"Contribute upstream" channel (controlled).** New setting `upstream_repo` (default `ArneNostitz/dev-agency`). When self-improve or analyzer produces a *generic* (non-instance-specific) improvement, open a draft PR/issue on upstream instead of the instance repo — always draft, never auto-merge, so the original repo stays curated. Answers "forks improve the original without messing it up."
13. ☐ **Rotate the checked-in `ANALYZER_API_KEY` default** in `docker-compose.yml` before any public showing; generate on first boot like `MASTER_KEY`.

## P6 — UI polish & code cleanup

14. ☐ **Retire `web/core.js`**: extract the still-imported helpers (`ghUrl`, `commentBadge`, `roleFromComment`, `stripBadge`, `mdOverlay`, `continueMarkdownList`) into `web/lib/`, delete the remaining ~800 dead lines (incl. duplicate `avatarFile`).
15. ☐ **SSE everywhere** (per house rule "always stream"): Detail GitHub-thread 6 s poll and app.js 5 s tick → server-pushed events; single breakpoint scale (e.g. 560/760/880 tokens documented in `shell.ts`), audit Detail/Board/Settings on 375 px.
16. ☐ **Split `Detail.js`** (693 lines) into molecules (RunHeader, ThreadPane, ComposerDock); `Settings.js` (539) per-tab files. Onboarding pass: verify Flutter/Tauri toolchain steps + model-pick copy still match current Settings → Environments.

## Sequencing today

P0 ✅ ship now → P1.1+1.2 (run thread + digest; unlocks the "central chat" demo) → P3.7 (model rationale line at run start; visible wow) → P4.9 (Memory tab; visible wow) → P2 → rest.
