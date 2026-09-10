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

## Which specs carry per-viewport assertions

**Corrected after independent review** — the earlier version wrongly classified
`wp35-universal-timeline` and `golden-path` as "functional".

| Spec                                                                                                             | Per-viewport assertion                                                                                                                                                                                                                                                 | In the 6-viewport sweep? |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------: |
| `wp32-responsive-checkpoints.spec.ts`                                                                            | `document.body.scrollWidth <= clientWidth` **in the default layout AND after opening each of 11 panels** (incl. the R2 surfaces Joy Code / Enhance / 3D Scene / Creative Brief), plus panel + File-menu-keyboard + Projects-Library reachability.                      |            ✅            |
| `golden-path.spec.ts`                                                                                            | The **unauthenticated login gate**: `scrollWidth <= clientWidth` **+ a full axe accessibility scan** + no-fatal-error envelope. `wp32` authenticates in `beforeEach`, so without this the login screen has zero per-viewport coverage.                                 |        ✅ (added)        |
| `wp35-universal-timeline.spec.ts` → `renders backend track titles, mixed elements, and Quarter preview controls` | With a 6+ clip mixed timeline loaded: `.monitor-transport` `scrollWidth <= clientWidth`, `.monitor-transport-end` stays inside the transport bounding box, `.workspace` `scrollWidth <= clientWidth`. This is the assertion that breaks at `desktop-minimum` 1024×768. |        ✅ (added)        |
| `stock-video-ui.spec.ts`                                                                                         | Self-parametrised (`compact 300`), card/poster geometry — runs inside the primary suite, not viewport-dependent.                                                                                                                                                       |      rides primary       |
| `wp29-r5-batch-b.spec.ts`                                                                                        | `boundingBox()`-driven drag/drop. Coordinate arithmetic, but the drop targets are not tight to viewport width; covered functionally at primary.                                                                                                                        |      rides primary       |
| `wp29-r5-batch-*`, `wp30-cross-browser-assets`                                                                   | Second-context rehydration at the same viewport — "reopen at this size works", covered by the primary run.                                                                                                                                                             |      rides primary       |
| all other specs                                                                                                  | Product logic / Worker / export / decode / timeline / motion / caption — identical code at any viewport on one engine.                                                                                                                                                 |      rides primary       |

The 6-viewport sweep (`acceptance-responsive` job **and** `real-service-acceptance`'s
`runDesktopMatrix`) runs **all three** layout specs via a union `--grep`, and the
harness asserts a **minimum test count of 3** per viewport — a grep that matches
nothing, or a spec that runs zero tests, fails the leg (previously the matrix was
recorded `passed` unconditionally on a zero-exit run).

## Release gate — `acceptance` lane (fixture stack)

| Execution (now)                                                     | Count | After                                                                                                                                                          | Held by                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/e2e` × **desktop-primary** × pass 1,2                        | 2     | **kept**, `--workers=2`                                                                                                                                        | Full functional + engine + decode coverage at the reference viewport, twice (clean-state repeat).                                                                                                                                                                                                                                     |
| `tests/e2e` × {compact, minimum, 1280, 1440, 1581, 1920} × pass 1,2 | 12    | **the 3 layout specs** (`wp32-responsive-checkpoints` + `golden-path` + `wp35`'s transport-geometry test, unioned via `--grep`) × those 6 viewports × pass 1,2 | Functional behaviour is viewport-independent on one engine → the primary run. Per-viewport: default + per-panel overflow, login-gate overflow + axe, loaded-timeline transport/workspace geometry — all at each of the 6 exact viewports, ≥3 tests asserted per leg. `stock-video-ui`'s compact-300 geometry rides the primary suite. |

`acceptance` executions: **14 → 4** (2 full-primary + 2 responsive-sweep). No
engine, decode, Worker, export, timeline, motion, caption, privacy/BYOK,
approval/rejection, canonical-commit, Undo/Redo, reload, project-isolation, or
persistence check is dropped — they all live in the primary suite, which still
runs twice.

## Release gate — `real-service-acceptance` lane (real Postgres + MinIO + Worker + dev server)

**Distinct real-service coverage is preserved.** The internal
`runDesktopMatrix` currently runs the full `tests/e2e` against real services for
all 7 viewports, sequentially, per pass.

| Execution (now)                                                                                                                                                          | Per pass | After                                             | Held by                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/e2e` × **desktop-primary** vs real services                                                                                                                       | 1        | **kept**                                          | The full suite exercised against real Postgres/MinIO/Worker at the reference viewport — the thing fixtures cannot prove.                                                                                                                                                                   |
| `tests/e2e` × 6 other viewports vs real services                                                                                                                         | 6        | **the 3 layout specs** × those 6 vs real services | Real-service _functional_ behaviour is viewport-independent → the real-service primary run. Real-service _layout / a11y / transport-geometry_ at each viewport → the 3 layout specs at that viewport, still against real services; `runDesktopMatrix` throws unless ≥3 tests pass per leg. |
| scripted `recordJourney` (import → motion preset → real Export MP4 → register/upload/download/ffprobe → re-import → delivery cancel/retry → reload + Motion persistence) | 1        | **kept, unchanged**                               | The real end-to-end delivery + persistence evidence.                                                                                                                                                                                                                                       |
| `runObserver` 30-min effects soak + 60 s polling                                                                                                                         | 1        | **kept, unchanged — one 30-min soak per pass**    | Owner instruction: retain one soak in each of the two isolated passes. Any 2→1 reduction is a separate proposal for independent review.                                                                                                                                                    |
| `verifyRestoreCompatibility` (N / N-1 schema)                                                                                                                            | 1        | **kept, unchanged**                               | Migration/restore evidence.                                                                                                                                                                                                                                                                |

`real-service-acceptance` `runDesktopMatrix` per pass: **7 full-suite runs → 1
full-suite (desktop-primary) + 6 targeted layout runs** (the 3 layout specs at
each non-primary viewport). Each leg must pass ≥ 3 tests or the matrix throws;
the matrix `status` is now derived from the per-leg summaries, not hardcoded. The
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
