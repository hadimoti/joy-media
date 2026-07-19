# commands

> **Status: spike implemented (WP-00.2)** — pure command application, semantic inverses, atomic transactions, and linear undo/redo are implemented over the P00 spike model. This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §11 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Command registry, validation, inversion, transactions, undo/redo history.

**First built in part:** P00 (spike), then hardened in P01. The P00 command envelope deliberately omits actor/revision/idempotency fields and interactive coalescing; see [`ADR-0003`](../../docs/adr/0003-command-transaction-undo-semantics.md).

**Must not:** UI concerns; direct store mutation APIs that bypass validation.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
