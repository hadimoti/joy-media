# WP-12 deployment manifests

`joy-media.nginx.conf` serves the editor and maps public `/api/v1/*` to the
Node server's `/v1/*` route. `joy-media-api.override.conf` starts an immutable
`pnpm deploy --prod` API release and reads only `/etc/joy-media/api.env`.

**Domain (as of 2026-07-30):** `joyst.ir` is the canonical public domain,
proxied through Cloudflare (SSL/TLS mode: Full, self-signed origin cert at
`/etc/ssl/joyst/`). `media.joyteam.ir` is kept alive purely as a 301 redirect
to `joyst.ir` so the joy-vps super-app launcher's `media.joyteam.ir` link
never had to change. See `joy-media.nginx.conf` for both server blocks.

The environment file is created on the VPS with mode `0600` and contains (see
[ADR-0017](../docs/adr/0017-independent-media-login.md)):

- `JOY_MEDIA_DATABASE_URL` — the shared Postgres instance
- `JOY_MEDIA_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` / `_FROM` — dedicated
  SMTP account for OTP email, independent of joy-vps's mailer
- `JOY_MEDIA_BOT_TOKEN` — dedicated Telegram bot token for OTP delivery,
  independent of the `joy-wg-bot` token
- `JOY_MEDIA_MISTRAL_API_KEY` — optional, dedicated JOY Media Mistral key for
  the server-side `llm.complete` provider. Leave it absent until the owner
  provisions one; never reuse, print, or copy the Hermes credential.
- `JOY_MEDIA_PROVIDER_APPROVAL_SIGNING_KEY_ID` — non-secret id for the active
  provider-approval signing key
- `JOY_MEDIA_PROVIDER_APPROVAL_SIGNING_SECRET` — runtime-only HMAC secret for
  provider approvals; do not commit or log it
- `JOY_MEDIA_RELEASE_COMMIT_SHA` — the exact Git commit of the immutable release
- `JOY_MEDIA_RELEASE_TREE_HASH` — the exact Git tree id used to build the release
- `JOY_MEDIA_RELEASE_LOCKFILE_SHA256` — SHA-256 of the committed `pnpm-lock.yaml`
- `JOY_MEDIA_RELEASE_SCHEMA_VERSION` — positive integer for the deployed control-plane schema
- `JOY_MEDIA_TRUSTED_PROXY_ADDRESSES` — comma-separated exact IP addresses of the reverse-proxy
  peers permitted to supply `X-Forwarded-For`. Add only the address actually used to reach the API;
  when omitted, the API deliberately keys abuse controls by the direct socket peer.

The four release-identity values are generated from the source-bound release
manifest during deployment and are safe to expose through `/ready`. Do not
hand-edit them or copy values from a different checkout: the API intentionally
fails readiness when the identity is missing or malformed.

It is never committed. Keep `/etc/joy-media/api.env` mode `0600`. The API
persists only approval signing-key metadata (the key id), grants, budget
reservations/reconciliations, and redacted audit rows; the secret remains in
the runtime environment. If either approval variable is absent, grant
issuance and remote provider paths requiring approval fail closed with HTTP
503 `PROVIDER_APPROVAL_UNAVAILABLE`. A restart with the same database and key
configuration verifies existing grants; a changed key id or secret rejects
them.

The joy-vps admin panel's "Joy Media" tab connects directly to this same
Postgres instance to manage the `media_allowed_users` allow-list, using a
separate, least-privileged database role scoped to that one table (see
joy-vps's `bot/joy_media_db.py` and `docs/JOY-MEDIA-ADMIN-DB-ROLE.md`).

Release order: generate and verify the source-bound release manifest (including
the four `JOY_MEDIA_RELEASE_*` values); back up `joymedia`; deploy the built API/static editor; install
the systemd/nginx manifests; validate configuration; restart services; verify
public health and the OTP login path end to end (request + verify code by
Gmail and by Telegram). Preserve the prior `/opt/joy-media/app` and each
immutable release for rollback.

On the VPS, use the lockfile to reconstruct the deployment dependency layout
before building: `CI=true npm_config_confirm_modules_purge=false pnpm install
--frozen-lockfile`. Build the API and static editor, then create the immutable
API release with `CI=true npm_config_confirm_modules_purge=false pnpm deploy
--legacy --prod`. Point the `current-api` and `web` symlinks at the new
release only after the checks pass. Rollback is a symlink change to the prior
immutable release followed by `systemctl restart joy-media@api`; keep the
database backup until the deployment gate is accepted.

Static web release permissions are part of the deployment gate: nginx must be
able to traverse every release directory and read every bundle. After copying
the editor build, set release directories to `0755` and files to `0644` before
switching the `web` symlink; otherwise `try_files` can fall back to
`index.html`, making JavaScript/CSS asset requests return HTML and blanking the
editor in strict browsers.

## 1.0 prerequisites and rollback

Run `pnpm check`, the three application builds, `pnpm test:release`, and the non-deploying
`pnpm release:gate` before requesting deployment. Back up the database and object-store metadata;
retain the prior immutable API/web releases. Deployment is a separately approved action. Roll back
by pointing `current-api` and `web` at the previous release directories, restarting the affected
service, and re-running health plus authenticated browser smoke. Never place secrets in gate output.
