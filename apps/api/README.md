# api

> A typed `/v1` HTTP transport uses JOY Media's own independent login (ADR-0017) and a transaction-backed PostgreSQL control plane.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §27, §28 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md) · Auth: [ADR-0017](../../docs/adr/0017-independent-media-login.md)

**Role.** JOY Media control plane: auth (own allow-list + OTP login), project metadata/revision sync, jobs, provider config handles, audit, review links. Modular monolith.

`/v1` (project/job/asset routes) stays disabled unless `JOY_MEDIA_DATABASE_URL` is set; `/v1/auth/*` (login) is always served, but only ever succeeds against an allow-listed contact once the database is configured.

- `JOY_MEDIA_DATABASE_URL` — Postgres connection string (control plane + auth tables)
- `JOY_MEDIA_PROVIDER_APPROVAL_SIGNING_KEY_ID` — non-secret signing-key metadata id
- `JOY_MEDIA_PROVIDER_APPROVAL_SIGNING_SECRET` — provider-approval HMAC secret; runtime environment only
- `JOY_MEDIA_SMTP_HOST` / `JOY_MEDIA_SMTP_PORT` / `JOY_MEDIA_SMTP_USER` / `JOY_MEDIA_SMTP_PASS` / `JOY_MEDIA_SMTP_FROM` — OTP email delivery (optional; gmail login is silently unavailable without it)
- `JOY_MEDIA_BOT_TOKEN` — dedicated Telegram bot for OTP delivery (optional; telegram login is silently unavailable without it)

At startup the durable adapter applies the idempotent schema (including the
`media_allowed_users` / `media_otp_codes` / `media_sessions` auth tables and
the provider approval grants, budget reservations/reconciliations, signing-key
metadata, and audit tables) and
uses transactions plus `FOR UPDATE SKIP LOCKED` for the queue lease. It
persists only Media project/job/Worker metadata, events, and its own
allow-list/session records; it never stores or accepts a JOY password,
session cookie, or identity signing key.

**Must not:** Heavy inference, frame rendering, large-media relay; one microservice per module.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.

## Release evidence

The API release gate requires a successful build and durable-auth evidence. PostgreSQL-backed media
auth fails closed without `JOY_MEDIA_AUTH_HASH_KEYS`; keep keys and database credentials in the
deployment environment, never in release reports or source control.

Provider approval is fail-closed in server mode: grant issuance and any remote
provider request requiring approval return HTTP 503 (`PROVIDER_APPROVAL_UNAVAILABLE`)
until both approval variables are present. Persist the deployment environment
file with mode `0600`; do not place either value in source, migrations, logs, or
audit rows. Only the key id is persisted with a grant, so a restarted API with
the same database and key configuration can verify prior grants; changing the
key id or secret rejects them.
