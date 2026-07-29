# WP-12 deployment manifests

`joy-media.nginx.conf` serves the editor and maps public `/api/v1/*` to the
Node server's `/v1/*` route. `joy-media-api.override.conf` starts an immutable
`pnpm deploy --prod` API release and reads only `/etc/joy-media/api.env`.

The environment file is created on the VPS with mode `0600` and contains (see
[ADR-0017](../docs/adr/0017-independent-media-login.md)):

- `JOY_MEDIA_DATABASE_URL` — the shared Postgres instance
- `JOY_MEDIA_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` / `_FROM` — dedicated
  SMTP account for OTP email, independent of joy-vps's mailer
- `JOY_MEDIA_BOT_TOKEN` — dedicated Telegram bot token for OTP delivery,
  independent of the `joy-wg-bot` token

It is never committed. There is no signing key or JWKS endpoint to provision
any more — the JWT identity bridge from the now-superseded ADR-0016 is
retired, along with `/opt/joy-media/secrets/joy-media-identity.pem` and its
`joy-wg-bot` systemd drop-in.

The joy-vps admin panel's "Joy Media" tab connects directly to this same
Postgres instance to manage the `media_allowed_users` allow-list, using a
separate, least-privileged database role scoped to that one table (see
joy-vps's `bot/joy_media_db.py` and `docs/JOY-MEDIA-ADMIN-DB-ROLE.md`).

Release order: backup `joymedia`; deploy the built API/static editor; install
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
