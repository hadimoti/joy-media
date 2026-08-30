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
header; the local `tooling/e2e-server.ts` opts into this header while
production startup leaves it disabled. Set the isolated staging-only
`JOY_MEDIA_RELEASE_OBSERVER_TOKEN` environment variable to the disposable
test session token before a real authenticated observer run; never pass an
owner token or commit it. Timeline integrity requires the read-only
`window.__JOY_RELEASE_TIMELINE_PROBE__` hook. Hidden-tab polling uses a second
local tab and requires it to report `document.visibilityState=hidden`; query
rate requires the server header on every measured response. If either cannot
be measured (or heap/editor instrumentation is unavailable), the value is
emitted as unmeasured (`null`) and fails closed; no zero/pass placeholder is
written. Omitting `--url` deliberately emits all four failed,
provenance-bound artifacts so a missing run is visible to the release gate.

**Browser evidence contract.** The gate reads browser journeys from either `test-output/browser/journeys.json` in the repository or from `JOY_RELEASE_EVIDENCE.browserJourneys`. Each entry must point at an in-repo `evidencePath`, and the gate re-derives `verifiedAt`, `execution`, `deliveryChannel`, `inspectionState`, `postMotionPlacement`, and `sourceProvenance` from that evidence JSON rather than trusting the index entry. Release-ready evidence therefore needs both files: a journey index entry for `authenticated-editor-1.0`, and a matching journey evidence JSON whose `journeyId`/`status` are `authenticated-editor-1.0`/`verified` and whose assertions prove `verified-delivery`, passed inspection, at least two Motion placements, and a clean matching `sourceProvenance`.

**Must not:** Shipping when §32.7 release gates fail.

**Self-hosted candidate workflow.** The manually dispatched release workflow keeps the inexpensive
fixture matrix separate from the real-service acceptance lane. The acceptance runner must set
`JOY_MEDIA_CI_ACCEPTANCE_PROFILE=real-services`,
`JOY_MEDIA_CI_ACCEPTANCE_WORKER=disposable`, and an executable
`JOY_MEDIA_CI_REAL_ACCEPTANCE_COMMAND`; the command receives the candidate SHA, run ID, run
attempt, and pass number. It is responsible for isolated PostgreSQL/object storage/Worker
credentials and all seven desktop profiles, then emits the redacted browser, performance,
delivery, Windows, and restore files documented above. The workflow invokes `pnpm run release:gate`
on those files for both passes and fails if the command or any required evidence is absent. It
never receives the owner OpenCLI profile or production credentials.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
