# security docs

> **Status: active boundary implementation.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §29 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Threat model details, sandbox policies, consent/licensing inventories, incident runbooks.

**Implemented boundary:** browser-worker BYOK keys remain page-session memory, provider requests use bounded HTTPS OpenAI-compatible calls, model proposals are validated and revision-bound before explicit apply, and deny-all capability policy persists. This document still does not certify a penetration test, provider billing enforcement, or complete media/frame redaction review.

**Must not:** Storing secrets or real keys in docs.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
