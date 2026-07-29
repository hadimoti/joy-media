# ADR-0017: Independent JOY Media login and allow-list

Status: Accepted
Date: 2026-07-29

## Context

ADR-0016 deliberately gave JOY Media no login of its own: it verified
short-lived signed assertions minted by the sibling `joy-vps` repository's
identity issuer (`bot/joy_media_identity.py`), gated by a
`joymedia_allowed` flag on existing JOY accounts. That design optimized for a
single shared sign-in and avoided a second password.

The owner has since decided the opposite trade-off is what they actually
want: JOY Media should have its own user database (a small allow-list of
Gmail addresses / Telegram IDs) and its own login page, independent of
joy-vps's accounts service, so that access to Media can be managed
separately from the rest of the JOY product. The joy-vps admin panel keeps a
management view into that allow-list, but reads and writes it directly
against JOY Media's own Postgres tables rather than through joy-vps's
accounts service — the two are separate services on the same VPS, and the
allow-list is intentionally the only thing joy-vps's admin panel touches in
JOY Media's database.

## Decision

1. JOY Media owns three new Postgres tables it manages itself:
   `media_allowed_users` (gmail / telegram_id / telegram_username / enabled),
   `media_otp_codes` (hashed, 5-minute TTL, max 3 active per contact), and
   `media_sessions` (hashed 30-day bearer tokens). See
   `apps/api/src/postgres-schema.ts` and `apps/api/src/media-auth.ts`.
2. JOY Media sends its own OTP codes — a dedicated SMTP account
   (`JOY_MEDIA_SMTP_*` env vars, `apps/api/src/media-mailer.ts`) and a
   dedicated Telegram bot (`JOY_MEDIA_BOT_TOKEN`,
   `apps/api/src/media-telegram.ts`) — with no runtime dependency on
   joy-vps's mailer or bot process.
3. `apps/editor-web` gets its own login UI (`LoginGate.tsx`): the real editor
   is always mounted but blurred and non-interactive behind a login card
   until an allow-listed contact completes OTP verification. This replaces
   the previous behavior of linking out to `joyteam.ir` to sign in.
4. The joy-vps admin panel's new "Joy Media" tab
   (`bot/webapp/admin/index.js`, routes in `bot/webapp_server.py`) manages
   the allow-list by connecting directly to JOY Media's Postgres instance,
   as a distinct, least-privileged database role scoped to
   `media_allowed_users` only (see joy-vps's `bot/joy_media_db.py`). It does
   not go through JOY Media's HTTP API and does not touch any other table.
5. The JWT identity bridge from ADR-0016 is retired: `joy-identity.ts` (JOY
   Media side), `joy_media_identity.py`, the `/api/identity/joy-media` and
   `/api/identity/jwks.json` routes, and `accounts_service.joymedia_access_allowed`
   (joy-vps side) are deleted, along with the signing-key systemd drop-in.
   The `joymedia_allowed` field on JOY accounts and its Users-tab toggle are
   left in place rather than torn out of that shared feature-flag UI — they
   are now inert (nothing reads them to gate access any more), and removing
   them would mean reworking a live, unrelated part of the Users tab for no
   functional gain.

## Consequences

- JOY Media access is now fully independent of a person's JOY account —
  someone can be allow-listed for Media without any other JOY entitlement,
  and vice versa. This directly reverses ADR-0016's Q10 requirement; that
  requirement is superseded by this decision.
- Two new pieces of operational secret-management are needed on the VPS that
  didn't exist before: a dedicated SMTP account and a dedicated Telegram bot
  token for JOY Media, plus a scoped Postgres role for joy-vps's admin tab.
- The `/api/identity/joy-media` and `/api/identity/jwks.json` endpoints, the
  `joy-media-identity.pem` signing key, and the `joymedia_allowed` accounts
  flag are dead; any external caller still depending on them will break.

## Alternatives rejected

- **Keep the JWT bridge and only add the allow-list UI on top.** Rejected
  per the owner's explicit direction — the goal is to decouple Media login
  from joy-vps entirely, not to keep the shared-session dependency running
  alongside a new admin view.
- **Reach the allow-list through a JOY Media HTTP API instead of direct DB
  access.** Considered and explicitly declined in favor of direct database
  access, since both services run on the same VPS and a scoped Postgres role
  is simpler than standing up and authenticating a second internal API
  surface for what is a single table.
