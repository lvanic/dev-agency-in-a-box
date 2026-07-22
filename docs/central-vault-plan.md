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
2. **Migration is a one-off script, not a feature.** When the vault is online, a single
   script translates the *effective* legacy learned content (DB override if present, else
   disk file — via existing `readWithOverride`) into vault entries using the compress
   translator, prints the proposed entries, applies them, and is then deleted in the same
   PR series. No reusable migration tooling.
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

Guard at write time: reject `c` containing issue refs (`#\d+` with a repo context) or
run/PR URLs unless an explicit `allowIssueRef` flag is passed — issue artifacts stay out.

## Storage

- Table `vault(key TEXT PRIMARY KEY, entry TEXT, source TEXT, updated_ts)` — `entry` is
  the canonical single-line JSON; `source` ∈ `human | librarian | migration`.
- Table `vault_revisions(key, entry, source, ts)` — every write appends (same pattern as
  `agent_revisions`, see `src/db/agent_overrides.ts`).
- Module `src/db/vault.ts`: `upsertVaultEntry`, `getVaultEntry`, `listVault(scope?, role?)`,
  `deleteVaultEntry`, `listVaultRevisions`, strict `encodeVaultEntry`/`decodeVaultEntry`
  (follow `src/handoff.ts` validation style; reject unknown `v`/types).

## Translate tool (`src/vaultTranslate.ts`)

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

## Read path (prompt injection)

- New `vaultSlice(repo, role)` → global entries + scope-glob matches + role matches,
  ranked by `w` then recency, **hard budget ~250 tokens**, rendered as raw canonical
  lines under a one-line header explaining the format.
- Injected in `buildSystemPrompt` (`src/agents/roleAgent.ts`) where `loadLearned` output
  is injected today — this REPLACES the learned-doc injection.
- Unscoped `searchMemory` calls (`src/db/memory.ts`) route to the vault; repo-scoped
  recall unchanged (hard-filtered, per the cross-worktree fix).

## Write paths

- **Librarian fold** (`src/reflect.ts` `selfImprove`): unprocessed lessons →, per lesson,
  compress into a vault entry: repo-specific lesson → `s:"owner/repo"`; generic (reuse
  the `looksGeneric` gate from `src/upstream.ts`) → `s:"*"`; role-tagged (existing
  `splitLessonRole`) → sets `r`. Dedupe by key: compress() gets existing keys as hints;
  same-key results upsert (revision preserved). The learned-doc fold paths are deleted.
- **Upstream contribution hook** (P5/#191): repoint — a NEW global (`s:"*"`) vault entry
  that passes `looksGeneric` on its rendered form becomes the upstream draft-PR payload
  (rendered markdown, not raw shorthand) instead of the retired `_learned.md` fold.
- **Human**: Settings → Memory → Vault (below).

## UI (Settings → Memory → "Vault" group)

- Entry table: key · kind · scope · role · weight · updated · source.
- Editor, two tabs: **Readable** (render() output, editable) and **Raw** (canonical
  line, editable with strict validation). Saving from Readable runs compress() → shows
  canonical diff → confirm. Revisions list + one-click revert (reuse the P4 Memory-tab
  components/patterns in `web/components/organisms/settings/MemorySettings.js`).
- "+ Add" opens the same editor empty (Readable tab default).

## One-off migration (dies after use)

`scripts/migrate-learned-to-vault.mjs` (or a guarded boot step — script preferred):
1. Read effective `_learned.md` + every `<role>.learned.md` via `readWithOverride`
   (DB override wins, else disk).
2. compress() each doc (role docs pass `r` hint) → proposed entries; print them all.
3. `--dry-run` flag prints only; default applies via `upsertVaultEntry(source:"migration")`.
4. Verify count > 0 when source docs were non-empty; then the same PR series deletes:
   the script itself (follow-up commit once run in prod), `SHARED_LEARNED_PATH`,
   `roleLearnedPath`, `loadLearned`, the reflect fold-to-doc code, and the legacy docs
   (disk files + DB overrides via `deleteAgentOverride`).
5. Ops note in COOLIFY.md: run once in the container after deploy
   (`node scripts/migrate-learned-to-vault.mjs`), confirm entries in Settings → Memory →
   Vault, then next deploy removes the script.

## Phases (one reviewed PR each)

1. ☐ **Vault core**: schema + `src/db/vault.ts` + encode/decode + write-time guard +
   `vaultSlice` injection (replacing learned-doc injection) + unscoped-recall routing +
   tests (encode/decode strict, scope-glob matching, budget cap, guard).
2. ☐ **Translate tool + UI**: `src/vaultTranslate.ts` (deterministic render, model
   compress w/ cheapest-capable resolution) + agent tool registration + Settings → Memory
   Vault group (table, two-tab editor, canonical diff, revisions) + tests (render
   determinism, compress upsert-by-hint mocked, endpoint validation).
3. ☐ **Write paths + migration + legacy removal**: librarian fold → vault; upstream hook
   repoint; one-off migration script; delete learned-doc code paths + docs; tests
   (fold scoping matrix repo/global/role, migration dry-run on fixture docs).
   Post-deploy ops: run the script once, verify, follow-up commit deletes the script.

## Risks / notes

- **Coordination**: another worktree owns the `src/db/memory.ts` recall seam (hard
  repo-filter + reserved unscoped slot). Phase 1 must merge AFTER their fix is on main
  (verify `searchMemory` signature on main before starting) and must not touch their
  repo-scoped path. One owner builds the vault — this plan is the contract.
- compress() is an LLM call → nondeterministic keys possible; existing-key hints +
  canonical-diff-before-save keep humans in control; librarian folds log a run_msg line.
- Budget: injection hard-capped at ~250 tokens regardless of vault size; weight decides
  what makes the cut. UI shows which entries currently make the global cut (w:3 badge).
- Rollback: vault_revisions covers content; phase PRs are independently revertable;
  migration keeps legacy docs until the explicit deletion commit (same series, but
  ordered after verification).
