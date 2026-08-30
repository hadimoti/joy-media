# release

> **Status: active.** This folder now contains the local release-gate evaluator and evidence writer used by CI and bounded closeout work.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §32.7, §35.4 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Build pinning, packaging, release-gate checks, and machine-readable release evidence.

**Current evidence output.** `pnpm run release:gate` writes `report.json`, `manifest.json`, `sbom.json`, `artifact-hashes.json`, `static-assets.json`, and `release-manifest.sha256` under `test-output/release-gate/`.

**PROOF-01 observer.** `pnpm run release:performance -- --url http://127.0.0.1:4173`
writes the four quantitative evidence files (`polling.json`,
`effects-soak.json`, `timeline-integrity.json`, and `editor.json`) under
`test-output/release-performance/`. The observer is loopback-only and blocks
non-loopback browser requests. It defaults to the strict 60-second polling
warm-up plus 30-minute soak; shorter runs cannot pass the gate. All four files
share one `runId`, timestamp, generator, phase, and source provenance.

Browser metrics use Playwright and explicit editor hooks. PostgreSQL query
rate is read only from the local server's `x-joy-db-query-count` response
header. Timeline integrity requires the read-only
`window.__JOY_RELEASE_TIMELINE_PROBE__` hook. Hidden-tab polling uses a second
local tab and requires it to report `document.visibilityState=hidden`; query
rate requires the server header on every measured response. If either cannot
be measured (or heap/editor instrumentation is unavailable), the value is
emitted as unmeasured (`null`) and fails closed; no zero/pass placeholder is
written. Omitting `--url` deliberately emits all four failed,
provenance-bound artifacts so a missing run is visible to the release gate.

**Browser evidence contract.** The gate reads browser journeys from either `test-output/browser/journeys.json` in the repository or from `JOY_RELEASE_EVIDENCE.browserJourneys`. Each entry must point at an in-repo `evidencePath`, and the gate re-derives `verifiedAt`, `execution`, `deliveryChannel`, `inspectionState`, `postMotionPlacement`, and `sourceProvenance` from that evidence JSON rather than trusting the index entry. Release-ready evidence therefore needs both files: a journey index entry for `authenticated-editor-1.0`, and a matching journey evidence JSON whose `journeyId`/`status` are `authenticated-editor-1.0`/`verified` and whose assertions prove `verified-delivery`, passed inspection, at least two Motion placements, and a clean matching `sourceProvenance`.

**Must not:** Shipping when §32.7 release gates fail.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
