# api

> A typed `/v1` HTTP transport uses JOY Media's own independent login (ADR-0017) and a transaction-backed PostgreSQL control plane.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §27, §28 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md) · Auth: [ADR-0017](../../docs/adr/0017-independent-media-login.md)

**Role.** JOY Media control plane: auth (own allow-list + OTP login), project metadata/revision sync, jobs, provider config handles, audit, review links. Modular monolith.

`/v1` (project/job/asset routes) stays disabled unless `JOY_MEDIA_DATABASE_URL` is set; `/v1/auth/*` (login) is always served, but only ever succeeds against an allow-listed contact once the database is configured.

- `JOY_MEDIA_DATABASE_URL` — Postgres connection string (control plane + auth tables)
- `JOY_MEDIA_SMTP_HOST` / `JOY_MEDIA_SMTP_PORT` / `JOY_MEDIA_SMTP_USER` / `JOY_MEDIA_SMTP_PASS` / `JOY_MEDIA_SMTP_FROM` — OTP email delivery (optional)
- `JOY_MEDIA_SMTP_FAMILY` — SMTP address family: `4` (default), `6`, or `auto`; `auto` tries resolved addresses in order and only falls back after connection-stage failures. Invalid values warn and use `4`. SMTP connects to resolved IPs while verifying TLS against the configured hostname.
- `JOY_MEDIA_SMTP_EHLO_NAME` — optional client hostname announced with EHLO (default `joyst.ir`); must be a valid hostname and does not change the SMTP TLS server name.
- `JOY_MEDIA_BOT_TOKEN` — dedicated Telegram bot for OTP delivery (optional; telegram login is silently unavailable without it)

At startup the durable adapter applies the idempotent schema (including the
`media_allowed_users` / `media_otp_codes` / `media_sessions` auth tables) and
uses transactions plus `FOR UPDATE SKIP LOCKED` for the queue lease. It
persists only Media project/job/Worker metadata, events, and its own
allow-list/session records; it never stores or accepts a JOY password,
session cookie, or identity signing key.

OTP requests use the same generic response for known and unknown contacts.
Email delivery runs after the response, and delivery errors are logged with a
short SHA-256 contact digest rather than the email address.

**Must not:** Heavy inference, frame rendering, large-media relay; one microservice per module.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
