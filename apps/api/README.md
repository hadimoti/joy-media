# api

> **Status: WP-12.2 in progress.** A typed `/v1` HTTP transport wraps the local control-plane contract behind injected authentication; it is not yet persisted or connected to the shared JOY identity boundary. This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §27, §28 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** JOY VPS control plane: auth, project metadata/revision sync, jobs, provider config handles, audit, review links. Modular monolith.

**First built in part:** P01 + X01. The public deployment must supply the shared-JOY authentication adapter; no development header/token fallback may be enabled on the VPS.

**Must not:** Heavy inference, frame rendering, large-media relay; one microservice per module.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
