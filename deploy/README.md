# WP-12 deployment manifests

`joy-media.nginx.conf` serves the editor and maps public `/api/v1/*` to the
Node server's `/v1/*` route. `joy-media-api.override.conf` starts an immutable
`pnpm deploy --prod` API release and reads only `/etc/joy-media/api.env`.

The environment file is created on the VPS with mode `0600` and contains the
PostgreSQL URL plus issuer, audience, and JWKS URL. It is never committed.
The JOY identity key is generated on the VPS at
`/opt/joy-media/secrets/joy-media-identity.pem`, mode `0600`, and is exposed
only to the root-run `joy-wg-bot` service by its systemd drop-in. JOY Media
only receives the public JWKS URL.

Release order: backup `joymedia`; deploy the identity source and key; deploy
the built API/static editor; install the systemd/nginx manifests; validate
configuration; restart services; verify public health/JWKS and the signed
assertion path. Preserve the prior `/opt/joy-media/app` and each immutable
release for rollback.

On the VPS, use the lockfile to reconstruct the deployment dependency layout
before building: `CI=true npm_config_confirm_modules_purge=false pnpm install
--frozen-lockfile`. Build the API and static editor, then create the immutable
API release with `CI=true npm_config_confirm_modules_purge=false pnpm deploy
--legacy --prod`. Point the `current-api` and `web` symlinks at the new
release only after the checks pass. Rollback is a symlink change to the prior
immutable release followed by `systemctl restart joy-media@api`; keep the
database backup until the deployment gate is accepted.
