# JOY Media branch reconciliation matrix — 2026-08-28

This is a working parity matrix for the standalone `joy-media` repository. It is intentionally
not an exit-gate claim: GitHub `main` and the tested candidate diverge from common base
`73744bb` (`407` main-only and `175` candidate-only commits at capture time). No `joy-vps` files,
remote refs, or deployed releases were changed while preparing this matrix.

| Domain                           | GitHub-main behavior family                                                                                                    | Candidate decision                                                                                                                          | Required follow-up before promotion                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release/CI/provenance            | Main carries later WP-37/WP-38 notes and release records.                                                                      | Keep the candidate's source-bound manifest, SBOM, clean-worktree gate, and explicit release identity.                                       | Run the complete gate twice on the final reconciled SHA and retain redacted evidence.                                                                         |
| Creative Brief contract          | Main replaces/extends the existing v1 contract with coupled consent, resolver, persistence, HTTP, provider, and panel runtime. | Defer the coupled runtime. Retain additive `CreativeBriefV2` types/validators (`eda8d64`, follow-up `70e38f3`) plus the bounded async execution boundary (`129edba`), with v1 exports intact. | Define one shared snapshot/revision contract, then port runtime/persistence/consent/UI together with integration tests.                                       |
| Joy Code                         | Main adds planner API, consent, OpenRouter policy, browser session, and compound-edit composition.                             | Keep candidate stale-response/duplicate-submit guard. Defer main runtime because its schema, coordinator, and command compiler are coupled. | Reconcile universal timeline command coverage and planner boundary first; add real-service approval/session journeys.                                         |
| Universal timeline/editor schema | Main-only commits change project documents, timeline commands, evaluators, and panel wiring together.                          | Do not cherry-pick UI-only components; preserve the tested current editor contract.                                                         | Port by behavior with contract tests for snapshot/revision, command compilation, undo/recovery, and persistence.                                              |
| Program Monitor ratios            | Main has no source-bound acceptance evidence for a mounted ratio workflow.                                                       | Keep additive `MonitorAspectRatioSelector` at `9f91e4e`; `Fit` is view-only and named presets use one reversible visual/timeline transaction. | Add the ratio journey to the authenticated browser evidence and verify persistence/reopen against the reconciled document contract.                              |
| GPU preview/mask/upscale workers | Main-only worker/API/job-protocol/render-host changes form one protocol family.                                                | Defer; a partial worker or UI port would be non-functional.                                                                                 | Reconcile job protocol, leases, storage, renderer, API routes, and real PostgreSQL/Worker tests as one tranche.                                               |
| Static transition previews       | Deployed release still falls back from `/transitions/preview/*.png` to SPA HTML.                                               | Keep source-controlled SVG preview assets and MIME tests from `e2e7838`.                                                                    | Deploy the candidate, then verify origin and both public domains return non-HTML image bytes and clean console/network.                                       |
| API readiness                    | Candidate adds dependency checks and validated non-secret release identity to `/ready`; live endpoint is legacy.               | Keep candidate readiness contract; do not treat current live 200 as proof of readiness.                                                     | Inject four release identity values in the approved deployment and verify `/live`/`/ready` at origin and public domains.                                      |
| Browser evidence                 | Main has historical/partial journey records that are not bound to this candidate.                                              | Reject as release evidence. OpenCLI profile `cefd9k77` currently proves only a public Projects shell.                                       | Authenticate through the user-controlled flow, run `authenticated-editor-1.0` on real services, verify delivery/inspection, and bind exact SHA/tree/lockfile. |
| VPS/deployment                   | VPS has its own drift and older deployed release.                                                                              | Out of scope for reconciliation; no VPS mutation.                                                                                           | After all gates pass, use the documented immutable release/rollback procedure against JOY Media only.                                                         |

## Resolution rules

- “Keep candidate” means the behavior is implemented, tested, and safe to retain on the current
  line; it does not mean it has been deployed.
- “Defer coupled runtime” means no isolated cherry-pick is allowed until the listed contracts and
  integration tests are reconciled on a fresh integration branch.
- “Reject as evidence” means the artifact may remain diagnostic, but it cannot satisfy the release
  gate or justify a main/VPS deployment.

## Current consensus

Backend, frontend, and release agents accepted the additive v2 contract as safe but rejected it as
complete Creative Brief runtime functionality. They also rejected a wholesale WP-37/WP-38 merge,
blind promotion, and any VPS action while authenticated source-bound browser evidence, migration /
readiness checks, and live static-route verification remain open.
