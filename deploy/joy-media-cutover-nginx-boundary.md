# joyst.ir Nginx boundary — cutover proposal (wave 6)

**Status: PROPOSAL ONLY. This is not the live config and this worktree has not applied it.**
`joy-media.nginx.conf` in this same directory documents the _current_ live boundary (full
editor SPA + all `/api/*` proxied); this file proposes the _target_ end-state boundary once the
desktop app is the primary editing surface, per the lead brief: "`joyst.ir` is reduced to OTP
login, installer/download page, account/subscription panel, and release metadata."

Applying this is a real deploy (new static site build, a new Nginx config, a restart) — exactly
the kind of action this worktree's lead brief reserves for Codex after independent checks. Nothing
here is wired to any build step or deploy script. Treat it as a reviewable target, not a patch to
apply blindly: page routing, static asset paths, and the exact account-panel build output will
depend on whatever `apps/editor-web` (or a new, smaller `apps/account-web`) actually ships.

## What changes

Operational note for the gateway deployment scripts: `JOY_MEDIA_EDGE_ADDR` must be set to
the IP literal on which the joyst.ir TLS server block listens (currently expected to be
`82.115.8.224`). Smoke and curl probes resolve `joyst.ir` to that address while preserving
joyst.ir for TLS SNI and HTTP Host. Set `JOY_MEDIA_CA_FILE` (or `NODE_EXTRA_CA_CERTS`) to the
origin CA certificate when it is not at `/etc/ssl/joyst/origincertificate.pem`. All curl
probes use that CA and a 20 second maximum. The automated Nginx script patches only the
`/api/v1/agent/` location, backs up the active file and validates it with `nginx -t`; it does
not install this entire illustrative server block.

The old `--pre-cutover` check has been removed. `deploy-cutover.sh` creates and immediately
activates its immutable release, with startup migrations and the systemd credential contract
tied to that activation. There is no supported independent staging service/credential profile
in this flow, so probing the current live release beforehand tested the wrong version. The
control-plane script now validates the edge address, CA and active Nginx syntax before it
builds or swaps account-web, then runs bounded edge checks after cutover and restores both the
API pointer and Nginx file if step 6 fails.

| Today (full editor)                                                                                                            | Target (reduced site)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root /opt/joy-media/web` serves the whole editor SPA (motion/effects/timeline/agent bundles, fonts, worklets, transitions, …) | `root` serves a much smaller static site: OTP login, installer/download page, account/subscription panel. The editor SPA build stays on disk for the desktop app's own use (or is retired entirely — a later, separate decision) but is no longer served at `joyst.ir`.                                                                                                                                                                                 |
| `location ^~ /api/` proxies **every** `/v1/*` route, including project/media/job/worker-pair                                   | `location ^~ /api/` proxies only the routes the reduced site (and the desktop app's own network calls) still need: `/v1/auth/*`, `/v1/devices*`, `/v1/account/*`, `/v1/entitlements/*`, `/v1/releases/*`, and — once wave 5's checkout is actually enabled — `/v1/billing/*`. Everything else 404s at the edge, in addition to (not instead of) `hosted-route-retirement.ts`'s and `legacy-editor-retirement.ts`'s application-level `410`/auth-denial. |
| Static asset regex covers editor bundle paths (`assets`, `effects`, `transitions`, `workers?`, `worklets?`, …)                 | Narrows to whatever the reduced site's own build actually emits — likely just `assets`/`fonts` for a small login/download/account page.                                                                                                                                                                                                                                                                                                                 |

## Proposed target config (illustrative — adjust paths to the real reduced-site build output)

```nginx
server {
    listen 80;
    listen 82.115.8.224:443 ssl;
    listen 46.249.103.142:443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name joyst.ir www.joyst.ir;

    ssl_certificate     /etc/ssl/joyst/origincertificate.pem;
    ssl_certificate_key /etc/ssl/joyst/privatekey.pem;

    # No more large media uploads through this host once project/media routes are retired.
    client_max_body_size 10m;

    root /opt/joy-media/account-web;   # the reduced site's build output, not the editor bundle

    location ~* ^/(?:assets|fonts)/ {
        try_files $uri =404;
        add_header X-Content-Type-Options nosniff always;
    }

    location ~* \.(?:css|ico|js|json|mjs|map|png|svg|webmanifest|webp|woff2?)$ {
        try_files $uri =404;
        add_header X-Content-Type-Options nosniff always;
    }

    # The signed Windows installer itself is not served from this host directly unless the
    # owner decides otherwise — /v1/releases/:channel returns a downloadUrl, which may point
    # at a CDN/object-store URL instead. If it is served from here, add an explicit,
    # narrowly-scoped location for it (checksum-verified on the client regardless).

    location / {
        try_files $uri $uri/ /index.html;
        add_header X-Content-Type-Options nosniff always;
    }

    # Narrowed from "proxy everything" to exactly the surfaces wave 4/5 kept:
    # OTP, device/account/subscription, entitlements, release metadata, and (once enabled)
    # USDC billing. Every other /v1/* path 404s here, before it ever reaches the API process.
    location ~ ^/api/v1/(?:auth|devices|account|entitlements|releases|billing)(?:/|$) {
        rewrite ^/api/(.*)$ /$1 break;
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 180;
        proxy_send_timeout 180;
    }

    location = /api/health {
        proxy_pass http://127.0.0.1:8790/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        access_log off;
    }

    location = /live {
        proxy_pass http://127.0.0.1:8790/live;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        access_log off;
    }

    location = /ready {
        proxy_pass http://127.0.0.1:8790/ready;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        access_log off;
    }

    location = /health/ready {
        proxy_pass http://127.0.0.1:8790/health/ready;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        access_log off;
    }
}

server {
    listen 80;
    listen 443 ssl;
    http2 on;
    server_name media.joyteam.ir;

    ssl_certificate     /etc/ssl/joyteamir/origincertificate.pem;
    ssl_certificate_key /etc/ssl/joyteamir/privatekey.pem;

    return 301 https://joyst.ir$request_uri;
}
```

## Sequencing (do not skip ahead)

1. `apps/editor-web`/desktop must actually stop depending on the narrowed-away hosted routes
   for any live user before this is applied — the wave 2/4 deferred items (project-store IPC
   wiring, an `apps/editor-web` account panel) land first.
2. `hosted-route-retirement.ts`'s per-route flags and/or `legacy-editor-retirement.ts`'s coarse
   flag are enabled server-side **first**, and verified (every retired route returns `410`/401
   as expected) **before** this Nginx boundary is narrowed — the application-level fail-closed
   response is the safety net; Nginx narrowing is defense-in-depth on top of it, not a
   replacement for it.
3. The archive/export tooling (`tooling/archive`) is used to give every affected owner a
   reversible, encrypted, checksummed export **before** any hosted project/media route stops
   being reachable, per the locked "do not silently migrate or delete customer data" decision.
4. Apply this config as a real, reviewed VPS change, with a rollback plan (revert to
   `joy-media.nginx.conf`'s current content) — the same discipline
   `docs/joy-media-final-migration-backup-restore-runbook.md` describes for the API/DB side.
