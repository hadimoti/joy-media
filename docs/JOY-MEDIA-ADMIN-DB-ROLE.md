# Scoped Postgres role for joy-vps's "Joy Media" admin tab

Per [ADR-0017](./adr/0017-independent-media-login.md), joy-vps's admin panel
manages JOY Media's `media_allowed_users` allow-list by connecting directly
to JOY Media's Postgres instance — but it must never get access to
`projects`, `jobs`, `media_assets`, or any other JOY Media table. Run once on
the VPS, against the same database `JOY_MEDIA_DATABASE_URL` points at:

```sql
CREATE ROLE joyvps_media_admin WITH LOGIN PASSWORD '<generate-a-strong-password>';
GRANT SELECT, INSERT, UPDATE, DELETE ON media_allowed_users TO joyvps_media_admin;
GRANT USAGE, SELECT ON SEQUENCE media_allowed_users_id_seq TO joyvps_media_admin;
```

Do **not** grant this role anything else — no other table, no schema-level
`CREATE`, no superuser. The JOY Media API's own role (used by
`JOY_MEDIA_DATABASE_URL` in `/etc/joy-media/api.env`) already owns table
creation via the idempotent `POSTGRES_SCHEMA` migration in
`apps/api/src/postgres-schema.ts`, so `media_allowed_users` must exist
(i.e. the JOY Media API must have started at least once) before this grant
will succeed.

Put the resulting connection string in joy-vps's production env file
(`/opt/joy-wg-bot/.env`) as `JOY_MEDIA_DATABASE_URL`, e.g.:

```
JOY_MEDIA_DATABASE_URL=postgresql://joyvps_media_admin:<password>@127.0.0.1:5432/<joy_media_db_name>
```
