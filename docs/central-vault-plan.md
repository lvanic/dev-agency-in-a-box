# Central Vault — machine-canonical shared knowledge

Status legend: ☐ todo · ◐ in progress · ☑ done
Created 2026-07-22. Decisions below are settled (user-approved); a builder should be able to start from this file alone.

## What it is

One durable knowledge store for everything agents and humans should remember across runs:
user preferences, environment facts, tooling conventions, glossary, per-repo durable
knowledge, per-role craft knowledge. The **canonical stored form is compact machine
shorthand** (single-line JSON, same philosophy as the P2 Handoff envelope in
`src/handoff.ts`); human-readable text is a **derived view produced by a translate tool**,
never the storage format. Issue artifacts (plans, reviews, run threads, issue text) are
repo-private and NEVER enter the vault — the hard repo-filter added to
`src/db/memory.ts` `searchMemory` stays; the vault fills exactly the **unscoped-recall
slot** that filter reserved.

## Settled decisions

1. **No legacy ballast.** `memory/central/playbooks/_learned.md` (shared learned doc) and
   `central/agents/<role>.learned.md` (per-role learned docs) are **retired**, together
   with their loaders (`loadLearned` in `src/memory.ts`) and the reflect fold paths that
   write them. The vault replaces them completely. Personas, playbooks other than
   `_learned`, and the CONSTITUTION are behavior config, not learnings — they stay
   markdown, editable in Settings → Memory as today.
2. **Migration runs automatically on deploy, not as a manual step** (user decision,
   2026-07-22: "this should run on deploy when this PR is finished"). It is a guarded,
   run-once boot step (`migrateLearnedToVault`, settings flag `vault_migration_v1`) that
   seeds the vault from the *effective* legacy learned content (DB override if present,
   else disk — via existing `readWithOverride`) BEFORE the first agent run after the
   deploy, so switching prompt injection from learned-docs to the vault leaves **no dark
   window**. Phase 1 ships a **deterministic** seed (bullet-split, no LLM — safe in the
   boot path); a later phase's compress() translator upserts richer entries by the same
   keys. No reusable migration tooling.
3. **`lessons` table survives as the intake queue only** (it already has repo + role
   columns). Reflection keeps writing lessons; the self-improve fold now targets the
   vault (scoped entries) instead of learned docs. `recentLessons` ride-along in prompts
   stays (fresh, unfolded observations).
4. **Human-editable** in Settings → Memory (new "Vault" group), with the same revision +
   revert UX as agent files (P4/#189).
5. **Machine shorthand is what agents read**; prose is on-demand.

## Entry format (canonical)

One entry = one single-line JSON record, strict-parsed like the Handoff envelope:

```
{"v":1,"k":"pkg-manager","t":"pref","s":"*","c":"pnpm>npm always; lockfile v9; never yarn","w":3}
{"v":1,"k":"reimedy-stack","t":"env","s":"reimedy-*","c":"tauri2+flutter; win-check via toolchain vm","w":2}
{"v":1,"k":"review-craft","t":"know","s":"*","r":"reviewer","c":"always run tests before verdict; diff>500 lines -> ask split","w":2}
```

| field | meaning |
|---|---|
| `v` | schema version (1) |
| `k` | unique key-slug (kebab, stable identity; upsert target) |
| `t` | kind: `pref` (user preference) · `know` (knowledge) · `env` (environment/tooling fact) · `gloss` (glossary/term) |
| `s` | scope glob: `"*"` global · `"owner/repo"` · prefix glob `"reimedy-*"` |
| `r` | optional role (`developer`, `reviewer`, …) — entry only injected for that role |
| `c` | terse telegraphic content (target ≤ ~30 tokens; text, not coded enums — knowledge is open-domain) |
| `w` | weight 1–3 (3 = always inject, 1 = only when budget allows) |

Guard at write time: reject `c` containing issue refs (`#\d+`) or run/PR URLs unless an
explicit `allowIssueRef` flag is passed — issue artifacts stay out. (`encodeVaultEntry`
throws; `decodeVaultEntry` is a read-side check and does NOT re-apply the guard, so a
stored line always decodes.)

## Storage

- Table `vault(key TEXT PRIMARY KEY, entry TEXT, source TEXT, updated_ts)` — `entry` is
  the canonical single-line JSON; `source` ∈ `human | librarian | migration`.
- Table `vault_revisions(id, key, entry, source, ts)` — every write appends (same pattern
  as `agent_revisions`, see `src/db/agent_overrides.ts`).
- Module `src/db/vault.ts`: `upsertVaultEntry`, `getVaultEntry`, `listVault({scope?,role?})`,
  `deleteVaultEntry`, `listVaultRevisions`, strict `encodeVaultEntry`/`decodeVaultEntry`,
  `scopeMatches`, `contentHasArtifactRef` (follows `src/handoff.ts` validation style;
  rejects unknown `v`/types).

## Translate tool (`src/vaultTranslate.ts`) — Phase 2

Two directions; it is a tool (exposed to agents AND the UI), not a formatter:

- **render(entries) → markdown**: deterministic template — grouped by kind, fields as
  labeled sections. No LLM in the default path (the editor must never hallucinate).
  Optional `explain(entry)` uses the cheapest capable model (resolve via the P3 pricing
  policy, tier low) for prose elaboration — separate button, never automatic.
- **compress(text, hints?) → entries[]**: cheap-model call that condenses human prose
  into canonical entries (existing key hints passed so edits become upserts, not dupes).
  UI always shows the **canonical diff before save** — what will actually be stored.
- Registered as an agent tool alongside `recall()` (see `src/agents/recall.ts` wiring)
  so any role can translate when prose is genuinely needed.

## Read path (prompt injection) — ☑ Phase 1

- `vaultSlice(repo, role)` (`src/vault.ts`) → global entries + scope-glob matches + role
  matches, ranked by `w` then recency, **hard budget ~250 tokens**, rendered as raw
  canonical lines under a two-line header explaining the format.
- Injected in `buildSystemPrompt` (`src/agents/roleAgent.ts`) where `loadLearned` output
  was injected — this REPLACES the learned-doc injection. Best-effort (`""` on any error).
- Unscoped `searchMemory` calls (`src/db/memory.ts`) route to the vault; repo-scoped
  recall unchanged (hard-filtered, per the cross-worktree fix).

## Write paths

- ☑ **Librarian fold** (`src/reflect.ts` `selfImprove`) — **Phase 3**: unprocessed lessons are
  bucketed by (scope, role) via the pure `bucketLessonsForVault` (generic per `looksGeneric` →
  `s:"*"`; else the lesson's own `s:"owner/repo"`; `splitLessonRole` tag → `r`), each bucket
  compressed TOGETHER into canonical entries (WE set s/r; the model shapes k/t/c/w). Dedupe by
  key: compress() gets existing vault keys as hints; same-key results upsert (revision preserved).
  A bucket that compresses to nothing / throws leaves its lessons queued for retry. The old
  learned-doc fold (shared + per-role `setAgentOverride`) is deleted.
- ☑ **Upstream contribution hook** (P5/#191) — **Phase 3**: repointed — the GENERIC (`s:"*"`) vault
  additions of a fold become the upstream draft-PR payload as `renderVault()` markdown (not raw
  shorthand), via the unchanged `maybeContributeLearnedUpstream` (re-checks `looksGeneric`), instead
  of the retired `_learned.md` fold.
- **Human**: Settings → Memory → Vault (Phase 2).

## UI (Settings → Memory → "Vault" group) — Phase 2

- Entry table: key · kind · scope · role · weight · updated · source.
- Editor, two tabs: **Readable** (render() output, editable) and **Raw** (canonical
  line, editable with strict validation). Saving from Readable runs compress() → shows
  canonical diff → confirm. Revisions list + one-click revert (reuse the P4 Memory-tab
  components/patterns in `web/components/organisms/settings/MemorySettings.js`).
- "+ Add" opens the same editor empty (Readable tab default).

## Migration (auto, run-once on boot) — ☑ Phase 1

`migrateLearnedToVault()` in `src/vault.ts`, called from `main()` boot in `src/runner.ts`
alongside the other `seed*()` steps; guarded by settings flag `vault_migration_v1`:
1. Read effective `_learned.md` + every `<role>.learned.md` via `readAgentFile`
   (DB override wins, else disk).
2. Deterministically split each doc into bullet points → one `know` entry each
   (`s:"*"`, role docs also set `r`, `w:2`). Bullets carrying an issue/PR ref are skipped
   (the write-time guard would reject them anyway). No LLM in the boot path.
3. Idempotent: the flag is set even when the docs are empty; a second boot is a no-op.
   Phase 3's compress()-based fold later upserts richer entries by the same keys.
4. **Legacy removal is Phase 3** (after the vault has proven out in prod): delete
   `SHARED_LEARNED_PATH`, `roleLearnedPath`, `loadLearned`, the reflect fold-to-doc code,
   and the legacy docs (disk files + DB overrides via `deleteAgentOverride`).
5. Ops (COOLIFY.md): nothing manual — it runs on the first boot after deploy; verify
   entries in Settings → Memory → Vault once the Phase 2 UI ships.

## Phases (one reviewed PR each)

1. ☑ **Vault core** (this PR): schema (`vault` + `vault_revisions`) + `src/db/vault.ts`
   (encode/decode + guard + upsert/get/list/delete/revisions + `scopeMatches`) +
   `vaultSlice` injection (replacing learned-doc injection) + unscoped-recall routing +
   auto boot migration (deterministic seed, no dark window) + tests (encode/decode strict,
   guard, scope-glob matching, budget cap, upsert+revisions, unscoped routing, migration).
2. ☑ **Translate tool + UI**: `src/vaultTranslate.ts` (deterministic `renderVault`, cheap-model
   `compressToEntries`/`explainEntry` w/ tier-low `resolveTierModel` resolution, tolerant
   `parseCompressOutput`) + `vault_prose` agent tool (`src/agents/vaultTool.ts`, wired in
   roleAgent) + webhook endpoints (`/vault`, `/vault-entry`, `/vault-save`, `/vault-delete`,
   `/vault-compress`) + Settings → Memory Vault group (entry table, two-tab Readable/Raw
   editor, canonical-diff-before-save, revisions, +Add, delete) + tests (render determinism,
   parse tolerance/dedup). Endpoints smoke-verified live (list/save/guard-reject/detail/UI).
3. ☑ **Write paths + legacy removal**: librarian fold → vault (`selfImprove` rewritten to
   compress scoped/role buckets, upstream hook repointed to rendered global entries); deleted
   `loadLearned`/`SHARED_LEARNED_PATH`/`roleLearnedPath` + the "learning" file group (UI + memory.ts)
   + the learned-doc fold code; guarded run-once purge of the dead learned-doc DB overrides
   (`purgeAgentOverride`, boot step after the migration reads them). No learned docs existed on
   disk/in git (they were DB-override-only), so nothing to `git rm`. The Phase-1 boot migration is
   KEPT (self-contained, guarded no-op) rather than deleted — preserves no-dark-window for any
   instance upgrading straight through. Skipped re-folding migration entries via compress (churns
   keys; the librarian fold refines them over time). Tests: `test/vault-fold.test.mjs` (scoping
   matrix generic/repo/role + bucket collapse + override purge).

## Risks / notes

- **Coordination**: the `src/db/memory.ts` recall seam (hard repo-filter + reserved
  unscoped slot) landed on main in `f1bfa34` — Phase 1 built on top of it and does not
  touch the repo-scoped path. Verified `searchMemory` signature on main before starting.
- **CRITICAL blast radius on `buildSystemPrompt`** (every agent run flows through it): the
  Phase-1 edit only swaps the injected *section* (learned-doc → `vaultSlice`); signature +
  contract unchanged, and `vaultSlice` is best-effort (`""` on any error), so a vault fault
  degrades gracefully to "no vault section" rather than breaking a run.
- compress() (Phase 2/3) is an LLM call → nondeterministic keys possible; existing-key
  hints + canonical-diff-before-save keep humans in control; librarian folds log a run_msg
  line. Phase 1's deterministic seed sidesteps this entirely for the boot path.
- Budget: injection hard-capped at ~250 tokens regardless of vault size; weight decides
  what makes the cut. UI (Phase 2) shows which entries currently make the global cut.
- Rollback: vault_revisions covers content; phase PRs are independently revertable; the
  boot migration keeps legacy docs untouched (they are only deleted in Phase 3, after
  verification), so reverting Phase 1 restores the learned-doc injection cleanly.
