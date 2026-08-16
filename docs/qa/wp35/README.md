# WP-35 QA Evidence Index

Audit date: 2026-08-16  
Audited source: `Complete WP-35 universal timeline and Worker preview closeout` (rebased onto `1e4657f`)  
Working tree: implementation is committed; deployment and GBrain import are the final release steps.

This directory records retrospective evidence for the remaining WP-35 work. It
does not claim a tests-first history: the product changes predate this evidence
pass. Browser mixed-element, production, CI, and real hardware-Worker evidence
remain open.

## Reproducible local evidence

- `packages/project-schema/src/universal-timeline.test.ts` — legacy schema-0
  projection, v1 copy-on-write fallback, explicit binding validation, and
  audio/visual binding coverage.
- `packages/evaluator/src/active-timeline-render-plan.test.ts` — overlapping
  red/blue layer order and disabled-track filtering.
- `packages/commands/src/commands.test.ts` — atomic cross-track movement,
  track reorder, rename, and inverses.
- `apps/editor-web/src/timeline-frame-store.test.ts` — stale-frame rejection
  and bounded entry/byte eviction.
- `apps/editor-web/src/bounded-decoder-pool.test.ts` — keyed LRU decoder
  eviction and exactly-once resource disposal.
- `apps/editor-web/src/place-timeline-element.test.ts` — shared atomic
  document planner for media, image, and generic Timeline elements.
- `apps/worker/src/gpu-preview-probe.test.ts` and
  `packages/job-protocol/src/preview.test.ts` — fail-closed hardware probe,
  ephemeral preview-session validation, replay protection, rate limits, and
  response bounds.

## Gate record

The complete local `pnpm check` run passed after the timeline placement, drag,
schema, and decoder-pool changes:

```text
Test Files  310 passed | 1 skipped (311)
Tests       2168 passed | 2 skipped (2170)
```

The follow-up release checks also passed:

```text
pnpm build       PASS
pnpm audit:prod  PASS — No known vulnerabilities found
```

Focused browser verification passed:

```text
WP-29 CASE-16 imported MP4 placement + selection       PASS (3 viewports)
WP-29 CASE-25 asset-card placement                    PASS (3 viewports)
WP-29 CASE-32 cross-track pointer drag                 PASS (3 viewports)
Focused WP-35 placement/timeline/decoder/schema/protocol tests 25 passed
```

The complete three-project browser audit ran 153 tests and reported 135 passed,
15 failed, and 3 skipped. The remaining failures are in existing Cloud/audio,
motion, WP-32 journey, two compact bulk/reload cases, and one minimum import-
environment case; this is not a green release gate. The focused WP-35 matrix
remains 9/9 across primary, compact, and minimum viewports.

## Closeout execution pass — 2026-08-16

The closeout work added the empty-lane marquee state machine, normalized
client-space hit testing, additive/replace selection publishing, atomic
non-ripple multi-element deletion, locked-track rejection, and clip-owned audio
cleanup. The fresh validation pass completed with:

```text
pnpm check       PASS — 313 test files passed, 1 skipped; 2176 tests passed, 2 skipped
pnpm build       PASS
pnpm audit:prod  PASS — No known vulnerabilities found
WP-35 E2E        PASS — marquee selection + Delete + Undo/Redo (desktop-primary)
```

The focused E2E proves a single Delete keypress removes the selected batch and
one Undo/Redo round-trip restores/removes the same batch. Unit coverage now
includes marquee geometry and cancellation helpers, the deletion planner, and
clip-owned audio/effect cleanup.

The following closeout gates remain explicitly open and are not claimed by the
local pass: a real GPU Worker renderer/client transport with paired hardware,
authenticated mixed-element screenshots/pixel evidence, browser-level resource
release evidence, and the complete Worker/template/caption placement rollback
audit. The GPU transport gate remains fail-closed by design; this release does
not claim a real hardware renderer.

## Universal rows and Jobs-panel Worker smoke pass — 2026-08-16

The visible timeline projection now renders every lane as a neutral universal
layer (`T1`, `T2`, ... / `Layer 1`, `Layer 2`, ...), including legacy projects
whose stored names were `Main Video`, `B-roll`, `Overlay`, `Text`, or captions.
Add-track commands now create the same universal lane shape instead of a
video-only track. The interaction contract asserts that the legacy labels no
longer appear in the rendered timeline reference panel.

The Jobs-panel thumbnail smoke route now executes end to end in the local
Worker. `fixture.thumbnail` is handled without FFmpeg or an asset, emits the
deterministic 1×1 PPM receipt (`14` bytes, SHA-256
`78bf4c43aa7ab3a14c9f1e34f3333f9f612a08191affba3fb9c3e6de88378735`), reports
progress, and completes without attempting derivative upload. Runtime and
daemon tests cover the route.

Fresh release validation:

```text
pnpm check       PASS — 313 test files passed, 1 skipped; 2179 tests passed, 2 skipped
pnpm build       PASS
pnpm audit:prod  PASS — No known vulnerabilities found
WP-35 E2E        PASS — universal timeline + marquee selection + Delete + Undo/Redo
```

## Explicit open items

- No authenticated browser screenshots or mixed-element pixel fixture are
  recorded yet.
- The Worker probe and request gate are fail-closed; no real GPU renderer host
  or browser client transport is implemented.
- Media Add/import/drop, sticker, and HTML-scene creation now share the pure
  `place-timeline-element` document planner and one compound timeline +
  document commit. Agent/Worker/template/caption routes and injected-failure
  coverage still need a complete placement-service audit.
- Primary playback is now behind a bounded keyed pool with deterministic
  disposal (one live decoder remains intentional because it is the audio clock);
  transition/partner decoders use the bounded keyed LRU pool, but browser-level
  resource-release evidence is still open.
- The source commit is the WP-35 closeout commit on top of `1e4657f`; public deployment and the final GBrain import
  are performed after the release checks above.
