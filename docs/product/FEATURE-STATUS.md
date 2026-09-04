# Feature Status

Audited against current source on 2026-09-04.

This ledger records source-mounted feature availability only. It does not replace
release-gate evidence, authenticated browser verification, or deployment
readiness checks.

| Surface                                                                               | Status       | Basis                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated editor shell and signed-in project workspace                            | production   | Mounted in `apps/editor-web/src/App.tsx` and covered by `tests/e2e/authenticated-smoke.spec.ts`.                                                                                  |
| Project library lifecycle: create, open, rename, duplicate, trash, restore, and purge | production   | Implemented in `apps/editor-web/src/ProjectLibrary.tsx`, `apps/editor-web/src/project-lifecycle.ts`, and the API project lifecycle routes/tests.                                  |
| Transition preview frames and effect preview media                                    | production   | The editor serves `TransitionPreviewCard` and `EffectPreviewMedia` from source-controlled static assets under `apps/editor-web/public/`.                                          |
| Workflow recorder and workflow templates                                              | experimental | Present in `apps/editor-web/src/workflow-recorder.ts` and `apps/editor-web/src/workflow-templates.ts`, but still tracked as active workflow-plan work rather than a release gate. |
| Built-in JOY Agent Engine (Joy Code + Creative Brief)                                | production   | Browser-resident Worker engine and Composer capability are mounted in `apps/editor-web/src/joy-agent/` and `apps/editor-web/src/AgentPanel.tsx`; server AI routes are retired with HTTP 410 responses. |
| Worker-gated mask video capability                                                    | hidden       | `apps/editor-web/src/MaskInspector.tsx` keeps unavailable Worker capabilities from being advertised as ready.                                                                     |
