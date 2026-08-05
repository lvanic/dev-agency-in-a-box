# Deploy on Coolify

Dev Agency runs as one container. You set **no environment variables** — everything is configured in the browser after deploy.

1. **New resource.** Coolify → **+ New → Resource → Docker Compose**. Source = this repo, branch **`main`**. Coolify auto-detects `docker-compose.yml`.
2. **Route the domain to port 3000.** Set your domain on the resource and point it at container port **`3000`** — the app only listens on 3000.
3. **Keep the data volume.** Leave the named volume mounted at `/app/data`. It holds the database and the auto-generated encryption key, so logins and saved tokens survive redeploys. (A separate staging copy needs its own volume.)
4. **Deploy.** Click **Deploy** and wait for the logs to show `listening on :3000`.
5. **Create the admin account.** Open your domain → the first-run screen creates your admin login.
6. **Onboarding.** Pick your model and paste your token — a Claude subscription token from `claude setup-token`, or an `sk-ant-…` API key — then click **Save & test**.
7. **Add a repo** and open an issue pinning **`@dev`**. The agency plans → builds → reviews → opens a PR.

**Updating:** push to `main` and redeploy (or enable Coolify's GitHub auto-deploy — recommended).

**Self-merges auto-deploy too.** Coolify's GitHub-webhook auto-deploy skips any push whose commit message contains `[skip ci]`/`[ci skip]`. The agency tags its commits with `[skip ci]` (SKIP_CI, on by default) to save GitHub Actions minutes on watched product repos — but it **never** tags its own repo, because that tag would leak into the squash-merge commit on `main` and make Coolify skip the deploy. So once GitHub auto-deploy is enabled, the agency's own self-improvement merges redeploy exactly like your manual merges — no API token, no extra config.

### Deploys vs running tasks

Merging into this repo redeploys the container (see above) — but the agency may still be mid-build on OTHER issues when that happens. Three layers keep that safe, no manual babysitting required:

1. **Self-merge quiet window (holds the trigger).** Before merging a PR against the agency's own repo, it checks whether any other issue is currently in flight. If so, the merge is **held** in a small queue instead of firing immediately — the dashboard shows an **"Update ready"** chip. Clicking it opens a confirm dialog listing what's running and offers **Deploy now** (merge immediately, accepting the interruption — those runs auto-resume per layer 3 below) or **Wait**. If you do nothing, it flushes on its own the moment the pool goes fully quiet (0 running, 0 queued) — no human needed for the easy case. Toggle: Settings → Operations → **"Hold self-merges until other runs finish"** (`self_merge_hold`, on by default; off restores immediate self-merging).
2. **Graceful shutdown drain (softens the impact).** Once a deploy does land, `SIGTERM` stops new dispatches and drains in-flight runs for up to `graceful_shutdown_ms` (~9.5 min, matching `docker-compose.yml`'s `stop_grace_period`) before exiting — a run shorter than the grace window simply finishes and is never interrupted at all.
3. **Auto-resume after redeploy (the backstop).** Anything still running when the grace window expires gets a small DB marker before the process exits. On the next boot, the agency reads that marker and automatically re-invokes the same Resume path the dashboard's ▶ Resume button uses — posting "▶ auto-resumed after deploy" — instead of parking the issue at needs-attention. It's capped at one automatic attempt per interruption: if the SAME issue gets interrupted again before that marker is ever cleared (a crash loop, not a normal redeploy), it parks at needs-attention like before, same as any other stuck run.

**The Central Vault seeds itself on first boot.** When this deploy lands, a guarded run-once boot step (`vault_migration_v1`) folds the legacy learned docs (`_learned.md` + each `<role>.learned.md`, effective override-or-disk) into the vault before the first agent run, so the switch of prompt injection from learned-docs to the vault leaves no gap. It's deterministic (no model call), idempotent, and best-effort — nothing manual to run. Once the Phase 2 UI ships you can confirm the entries in **Settings → Memory → Vault**.

**The Process Analyzer's key auto-generates too.** `ANALYZER_API_KEY` used to ship as a real, checked-in default in `docker-compose.yml` so the vendored `analyzer` sidecar worked out of the box. It no longer does: if you leave `ANALYZER_API_KEY` unset, the agency generates a strong random key on first boot and persists it in the database (same pattern as `MASTER_KEY`, just DB-backed instead of file-backed since `MASTER_KEY` is already available to encrypt it). That's enough for the agency's own `/telemetry` + `/analyzer-issue` APIs.

The **vendored** `analyzer` service from this repo's `docker-compose.yml` is now zero-config: the agency mirrors that key to a file on a shared `analyzer-key` volume and the sidecar reads it from the same volume, so you don't have to copy anything — leave `ANALYZER_API_KEY` unset and deploy. (Setting `ANALYZER_API_KEY` explicitly still works and overrides the shared file for both services.)

If instead you deploy `dev-agency-analyzer` as its **own** Coolify resource, the volume isn't shared — set the key explicitly there: reveal it at **Settings → General → Process Analyzer** on the agency and set it as `ANALYZER_API_KEY` (agency) / `AGENCY_API_KEY` (analyzer), or pin your own on both before first boot.

A **standalone** `dev-agency-analyzer` deployment always needs this manual copy step — it never shared a database with the agency in the first place.

**Controlled upstream contribution (opt-in, off by default).** Settings → General → "Contribute upstream" lets a fork also propose its GENERIC self-improvement folds and Process Analyzer advisories to the canonical project (`upstream_repo`, defaults to `ArneNostitz/dev-agency`) — always as a draft PR/issue, never auto-merged, and only for findings that don't reference any of the fork's own watched repos. Two gates, both required: the `upstream_contrib_enabled` toggle (off by default) AND a non-empty `upstream_repo`.
