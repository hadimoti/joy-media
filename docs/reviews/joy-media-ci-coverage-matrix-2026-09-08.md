# JOY Media CI — browser coverage matrix (before → after)

**Branch `codex/joy-live-director-ci-opt`.** Every execution removed from the
release gate is mapped here to the coverage that still holds it. Rule followed:
**do not reduce browser-engine coverage; do not treat a mocked journey as
real-service or real-render evidence; keep every mandatory check.**

## Engine vs. viewport

All 7 Playwright projects are `devices['Desktop Chrome']` (one Chromium engine)
differing only in `viewport`:

| project         | viewport    |
| --------------- | ----------- |
| desktop-primary | 1639 × 1066 |
| desktop-compact | 1366 × 768  |
| desktop-minimum | 1024 × 768  |
| desktop-1280    | 1280 × 800  |
| desktop-1440    | 1440 × 900  |
| desktop-1581    | 1581 × 1066 |
| desktop-1920    | 1920 × 1080 |

So the release matrix is a **viewport** matrix, not an engine matrix. Restructuring
it changes **zero** engine coverage.

## Which specs are layout-sensitive

| Spec                                           | Layout-sensitive?      | Why                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wp32-responsive-checkpoints.spec.ts`          | **Yes — by design.**   | Asserts `document.body.scrollWidth <= clientWidth` (no horizontal overflow) and that every workspace panel + the Export / Recent-processes / Workspace-preset controls stay reachable, using `testInfo.project.name` so it runs the identical assertions at each viewport. |
| `stock-video-ui.spec.ts`                       | **Self-parametrised.** | Forces its own `compact 300` width and checks card/poster geometry consistency + `scrollWidth <= clientWidth`. Does not depend on the project viewport — runs its narrow-layout check inside the primary suite.                                                            |
| `wp29-r5-batch-*`, `wp30-cross-browser-assets` | No (functional).       | Open a second browser context at `testInfo.project.use.viewport` for a rehydration / second-profile check — i.e. "reopen at the same size works", which the primary run already exercises.                                                                                 |
| all other 25 specs                             | No (functional).       | Exercise product logic, Worker/export contract, decode paths, timeline/motion/caption behaviour — identical code at any viewport on one engine.                                                                                                                            |

## Release gate — `acceptance` lane (fixture stack)

| Execution (now)                                                     | Count | After                                                                                                                  | Held by                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/e2e` × **desktop-primary** × pass 1,2                        | 2     | **kept**, `--workers=2`                                                                                                | Full functional + engine + decode coverage at the reference viewport, twice (clean-state repeat).                                                                                                                                                                                                                                                  |
| `tests/e2e` × {compact, minimum, 1280, 1440, 1581, 1920} × pass 1,2 | 12    | **`wp32-responsive-checkpoints.spec.ts`** × those 6 viewports × pass 1,2 (one job per pass, all 6 in sequence, ~1 min) | Functional behaviour is viewport-independent on one engine → the primary run. Overflow / panel-reachability at each of the 6 exact viewports → the responsive spec at that viewport (this is **more** than dev `ci.yml`, which covers only compact + minimum). `stock-video-ui`'s own compact-300 geometry check rides along in the primary suite. |

`acceptance` executions: **14 → 4** (2 full-primary + 2 responsive-sweep). No
engine, decode, Worker, export, timeline, motion, caption, privacy/BYOK,
approval/rejection, canonical-commit, Undo/Redo, reload, project-isolation, or
persistence check is dropped — they all live in the primary suite, which still
runs twice.

## Release gate — `real-service-acceptance` lane (real Postgres + MinIO + Worker + dev server)

**Distinct real-service coverage is preserved.** The internal
`runDesktopMatrix` currently runs the full `tests/e2e` against real services for
all 7 viewports, sequentially, per pass.

| Execution (now)                                                                                                                                                          | Per pass | After                                                                | Held by                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/e2e` × **desktop-primary** vs real services                                                                                                                       | 1        | **kept**                                                             | The full suite exercised against real Postgres/MinIO/Worker at the reference viewport — the thing fixtures cannot prove.                                                                                |
| `tests/e2e` × 6 other viewports vs real services                                                                                                                         | 6        | **`wp32-responsive-checkpoints.spec.ts`** × those 6 vs real services | Real-service _functional_ behaviour is viewport-independent → the real-service primary run. Real-service _layout_ at each viewport → the responsive spec at that viewport, still against real services. |
| scripted `recordJourney` (import → motion preset → real Export MP4 → register/upload/download/ffprobe → re-import → delivery cancel/retry → reload + Motion persistence) | 1        | **kept, unchanged**                                                  | The real end-to-end delivery + persistence evidence.                                                                                                                                                    |
| `runObserver` 30-min effects soak + 60 s polling                                                                                                                         | 1        | **kept, unchanged — one 30-min soak per pass**                       | Owner instruction: retain one soak in each of the two isolated passes. Any 2→1 reduction is a separate proposal for independent review.                                                                 |
| `verifyRestoreCompatibility` (N / N-1 schema)                                                                                                                            | 1        | **kept, unchanged**                                                  | Migration/restore evidence.                                                                                                                                                                             |

`real-service-acceptance` internal browser executions per pass: **7 → 2**
(1 full-primary vs real services + 1 responsive-sweep vs real services). The
soak, the delivery journey, the restore check, and both passes are untouched.

## New release-gate lane — `prod-build-smoke` (added, no coverage removed)

Runs the shipped production bundle (`vite build` → `vite preview` of `dist/` with
the new `preview.proxy`) through the app's public UI:
`authenticated-smoke` + `wp32-real-project-journey` + `wp30-animated-timeline-export`

- `golden-path`. Covers, against the **built artifact** (not the dev server):
  session/auth, disposable project, fixture register/upload/reload/read, **import →
  preview each asset (decode/seek) → captions render**, **Export MP4 → verified
  download (encode + Worker path)**, no-fatal-error / no-horizontal-overflow.

This is **additive**. The dev-server-only white-box decoder specs
(`agent-observation-decode`, `final-encoded-export-decoder`,
`agent-director-skills` — they `import('/src/*.ts')` at runtime) are unchanged
and still run in full against the dev server in `acceptance-primary` and
`real-service-acceptance`.

## Development verification (`ci-dev.yml`, push / PR) — NOT a release gate

Clearly labelled "development verification — not release approval". Runs:

- `pnpm run verify:ci` (format + lint + typecheck + full vitest + build + prod audit)
- Worker package build + self-test
- `tests/e2e` × desktop-primary `--workers=2` (full)
- `wp32-responsive-checkpoints.spec.ts` × desktop-compact + desktop-minimum

Affected-test selection is **not** used for shared runtime / controller / schema
/ render / CI changes — those run the full set above. A full-suite fallback is
kept whenever dependency mapping is uncertain. This mirrors what `ci.yml` already
does, plus `--workers=2` and the explicit "not release approval" label.

## Mandatory checks — unchanged, all in the retained primary suite

Privacy / BYOK · approval + rejection · canonical commit (one durable
transaction, repeated-execution returns the prior receipt) · Undo / Redo ·
reload · project isolation · `LookInstance` persistence (R2) · render / export
decode (WebCodecs) · Worker lease / heartbeat / complete · N / N-1 restore.

## Not changed by this pass

- Browser engine set (one Chromium).
- The 2 isolated passes inside the workflow.
- The 30-minute effects soak (one per pass).
- `windows-worker-clean` scope (only the teardown-detection robustness — see benchmarks doc).
- Real-service / `acceptance` harness server stays **Vite dev** so the ~16
  `/src` white-box specs keep running; the new `prod-build-smoke` lane adds
  built-artifact coverage alongside, it does not replace the dev-server lanes.
