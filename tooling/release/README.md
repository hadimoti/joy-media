# release

> **Status: active.** This folder now contains the local release-gate evaluator and evidence writer used by CI and bounded closeout work.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §32.7, §35.4 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Build pinning, packaging, release-gate checks, and machine-readable release evidence.

**Current evidence output.** `pnpm run release:gate` writes `report.json`, `manifest.json`, `sbom.json`, `artifact-hashes.json`, `static-assets.json`, and `release-manifest.sha256` under `test-output/release-gate/`.

**Must not:** Shipping when §32.7 release gates fail.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
