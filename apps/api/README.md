# api

> **Status: WP-12.2 in progress.** A typed `/v1` HTTP transport accepts only a configured shared-JOY assertion verifier and can use a transaction-backed PostgreSQL control plane. Neither is deployed yet. This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §27, §28 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** JOY VPS control plane: auth, project metadata/revision sync, jobs, provider config handles, audit, review links. Modular monolith.

**First built in part:** P01 + X01. The public deployment must supply the shared-JOY authentication adapter; no development header/token fallback may be enabled on the VPS.

`/v1` remains disabled unless all of these deployment variables are set:

- `JOY_MEDIA_DATABASE_URL`
- `JOY_MEDIA_IDENTITY_ISSUER`
- `JOY_MEDIA_IDENTITY_AUDIENCE`
- `JOY_MEDIA_IDENTITY_JWKS_URL`

At startup the durable adapter applies the idempotent schema and uses
transactions plus `FOR UPDATE SKIP LOCKED` for the queue lease. It persists
only Media project/job/Worker metadata and events; it never stores JOY login
cookies, passwords, or identity signing keys.

**Must not:** Heavy inference, frame rendering, large-media relay; one microservice per module.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
