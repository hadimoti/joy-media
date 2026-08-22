# Production Pipeline Packs

JOY Media first-party workflows shown in the editor System tab are production pipeline packs, not demo success paths.

Each pack starts from a creative `brief` and `selectedMedia`, then runs research, script, shot-list, candidates, contact-sheet review, cost approval, editor artifact application, render, QA inspection, and a delivery manifest where the pack requires those stages. Production runs fail closed with `workflow/port-unavailable:*` until the host wires the required API, Worker, provider, render, editor, and output ports.

## Visible Packs

- Long video draft reels
- Multilingual promo
- Podcast cleanup
- Reference social cutdown
- Interview documentary assembly

## Fixture Boundary

Fixture handlers are explicit test/demo registry entries in `apps/editor-web/src/first-party-handlers.ts`. They return fixture/deferred metadata so UI and tests can exercise parking, approval, resume, artifact, render, inspect, and manifest flow without pretending files were exported or providers ran.

Production construction uses `createProductionFirstPartyLibrary()`, which does not bind fixture ports. Missing ports are non-retryable failures and are visible in the production run record.

## Pack Metadata

Pack metadata is exported by `buildFirstPartyPipelinePacks()` and surfaced by the editor:

- required and optional ports
- capabilities
- approval kinds
- QA/report references
- pinned JSON definition file

The JSON artifacts in `packages/workflow-engine/workflows/` are generated from the TypeScript builders and pinned by `first-party.test.ts`.
