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

**The Process Analyzer's key auto-generates too.** `ANALYZER_API_KEY` used to ship as a real, checked-in default in `docker-compose.yml` so the vendored `analyzer` sidecar worked out of the box. It no longer does: if you leave `ANALYZER_API_KEY` unset, the agency generates a strong random key on first boot and persists it in the database (same pattern as `MASTER_KEY`, just DB-backed instead of file-backed since `MASTER_KEY` is already available to encrypt it). That's enough for the agency's own `/telemetry` + `/analyzer-issue` APIs.

If you also run the **vendored** `analyzer` service from this repo's `docker-compose.yml`, it's a separate container with no shared database, so it can't see that auto-generated value on its own. Either:
- set `ANALYZER_API_KEY` yourself in Coolify's environment for this resource (used by both services), or
- leave it unset, then after first boot open **Settings → General → Process Analyzer** on the agency, reveal the generated key, and set it as `ANALYZER_API_KEY` in Coolify for both services, then redeploy.

A **standalone** `dev-agency-analyzer` deployment always needs this manual copy step — it never shared a database with the agency in the first place.

**Controlled upstream contribution (opt-in, off by default).** Settings → General → "Contribute upstream" lets a fork also propose its GENERIC self-improvement folds and Process Analyzer advisories to the canonical project (`upstream_repo`, defaults to `ArneNostitz/dev-agency`) — always as a draft PR/issue, never auto-merged, and only for findings that don't reference any of the fork's own watched repos. Two gates, both required: the `upstream_contrib_enabled` toggle (off by default) AND a non-empty `upstream_repo`.
