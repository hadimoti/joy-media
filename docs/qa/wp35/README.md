# WP-35 Final Closeout Evidence

Audit date: 2026-08-16  
Status: **FINISHED** — the initial `ffa9ea0` closeout below is retained as
historical evidence. Its timeline UX is superseded by the corrective
professional-timeline product `5273e34`, deployed immutably on 2026-08-16.

## Corrective professional-timeline release (2026-08-16)

The accepted initial WP-35 release still displayed neutral `T` rows and let a
plain click toggle selection. Product
`5273e34aeafc8ed7fe30383b7f443cc00667302c` closes that product gap.

- Visual layers are ordered top-to-bottom as `V1…V10`; audio is a separate,
  lower `A1…` stack. Track titles come from persisted backend `track.name`,
  with the schema-0 track ID as the legacy fallback. The track's family is now
  persisted (`visual` or `audio`) rather than inferred from the UI label.
- Every visual timeline element can be placed on any visual row. Audio is
  admitted only to audio rows; neither clip moves nor row drags can interleave
  the two families. Row reorder and selected-group movement are atomic and
  reversible.
- Plain click replaces the timeline selection. Ctrl/Command-click is the only
  additive/toggle gesture; marquee records the modifier when the gesture
  begins. Keyboard Delete, one Undo, and one Redo remain batch-atomic.
- The compositor excludes audio-family rows from video/overlay rendering while
  the existing audio pipeline remains responsible for sound.

### Corrective verification

```text
pnpm typecheck                 PASS
pnpm lint                      PASS
pnpm format:check              PASS
pnpm build                     PASS
pnpm test (four shards)        PASS — 337 files / 2,268 tests / 2 expected skips
WP-35 browser, desktop-primary PASS — 5/5
```

The browser suite proves marquee/Delete, ordinary-vs-modifier selection,
visual row drag reorder, visual/audio topology plus backend titles, Quarter
and Auto controls, and preview resource release. A signed-in production probe
of `https://joyst.ir/?deploy=5273e34` reported V1–V10 visual rows above A1
Audio and verified normal-click replacement followed by Ctrl-click addition.

### Corrective immutable deployment

- Product SHA: `5273e34aeafc8ed7fe30383b7f443cc00667302c`.
- Editor release:
  `/opt/joy-media/web-releases/editor-web-20260816T211800Z-5273e34-wp35-professional-timeline`.
- Retained editor rollback:
  `/opt/joy-media/web-releases/editor-web-20260816T201526Z-ffa9ea0-wp35-responsive`.
- Release and public index SHA-256:
  `7d51d92022fbd0cf24b514bfc28b8ca92eb0510dcaac17828dc56b1ad4eda641`.
- `nginx -t`, local API `/health`, and public index verification passed. No API
  or database migration was required; the paired GPU Worker release remains
  unchanged and available.

The GBrain page `joy-media-wp35-universal-timeline-gpu-preview-closeout-2026-08-16`
and `joy-media-state` are reconciled to this corrective deployment after this
evidence update.

### Ruler-surface follow-up (2026-08-16)

Product `1298c17d30227c64cb89401bd7e94c9efc0503f2` closes the final
timeline-chrome issue found in production review. The sticky scrub row, ruler,
and left gutter now use the opaque panel surface rather than exposing the
scrolling tracks grid. The 5/5 WP-35 desktop browser suite adds an explicit
computed-style guard for that condition; typecheck, ESLint, Prettier, and the
editor production build pass. Immutable editor release
`/opt/joy-media/web-releases/editor-web-20260816T213059Z-1298c17-wp35-ruler-surface`
and public `https://joyst.ir/?deploy=1298c17` index bytes both hash to
`160337ce38a81ac387312edefe3923d4836032f514248a16013da598ddee4728`.
The live browser verified `rgb(37, 37, 37)` on both ruler surfaces; `nginx -t`
and API health passed. GBrain is reconciled after this documentation commit.

### Origin-label clearance follow-up (2026-08-16)

Product `9013b1f3360484d73d3ab2f22f7a0116c4759fe0` resolves the remaining
playhead/ruler collision without interrupting the continuous NLE playhead. The
origin (`0:00`) tick gets a dedicated 0.85rem label clearance; the live browser
measured 13.6px between the rail and label content. The updated WP-35 browser
suite passes 5/5, as do typecheck, ESLint, Prettier, and the editor production
build. Immutable release
`/opt/joy-media/web-releases/editor-web-20260816T214205Z-9013b1f-wp35-origin-label`
and public `https://joyst.ir/?deploy=9013b1f` index bytes both hash to
`53436e57ae7928542fb8d3cf341f1a765619d1ffdea439398247ae394fa7e18b`.

### Transparent timecode-gutter follow-up (2026-08-16)

Product `9996c0e` makes `.timeline-scrub-gutter` transparent, leaving its
parent as the single opaque ruler surface. Live browser verification reports
gutter `rgba(0, 0, 0, 0)` and row `rgb(37, 37, 37)`. The focused WP-35 browser
suite passed 5/5 alongside typecheck, ESLint, Prettier, and the editor
production build. Immutable release
`/opt/joy-media/web-releases/editor-web-20260816T221547Z-9996c0e-wp35-transparent-gutter`
and public `https://joyst.ir/?deploy=9996c0e` index bytes both hash to
`f9b6f36cd26c06530f669046774541983b89e414ddc1ca2e4c1aa20a52299161`.

## Initial WP-35 closeout evidence (historical)

## Closed scope

- Universal compatibility rows accept every supported Timeline element. Row
  codes remain neutral (`T1`, `T2`, ...), while the visible title comes from
  persisted backend `track.name`; schema-0 rows without a name use their
  persisted track ID. The UI no longer replaces backend titles with synthetic
  kind labels or `Layer N` when a backend identity exists.
- Marquee selection, cross-track movement/layer ordering, keyboard `Delete`,
  one-step Undo/Redo, and the local Worker thumbnail job path remain covered.
- `Auto`, `GPU Worker`, and `Local` Monitor modes are available. Preview quality
  defaults to Quarter and supports Half and Full without changing export size.
- A paired Worker advertises `render.preview.gpu` only after Edge/Chrome creates
  a non-software WebGL2 context. Preview requests use a project/subject/Worker-
  bound, five-minute, random bearer session; the relay is in-memory,
  latest-wins, bounded, replay-protected, `no-store`, and creates no durable job.
- The Worker renders the evaluated `RenderFrameIR` on the local NVIDIA GPU,
  composites decoded RGBA video surfaces and text/caption plates in z-order,
  returns a bounded PNG, and rejects software rendering.
- Agent, sticker/HTML-scene, Worker media import, content template, text
  template, 3D, and caption placements were audited. Routes that mutate both
  Timeline and creative documents now use one `dispatchCompound()` boundary;
  injected persistence-failure coverage proves rollback/reload recovery.
- Browser preview resources have QA-only exact-once counters. Primary and
  partner decoders, audio contexts, Pixi renderers, scene caches, capture
  canvases, and transient GPU object URLs are released when the workspace
  closes.
- The 35 unrelated pre-existing Prettier warnings and all new WP-35 formatting
  warnings were mechanically cleaned.

## Hardware GPU evidence

`node tooling/verify-wp35-gpu-preview.mjs` launched the same long-lived Worker
host used by the daemon and rendered the committed mixed-element frame:

```text
Renderer: ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti, Direct3D11)
Backend:  WebGL 2.0 (OpenGL ES 3.0 Chromium)
Quality:  Quarter
Output:   160x90 PNG, 4021 bytes
SHA-256:  9dee89ef2a67141cb2ee075e6ec5a6991eb9e639d2dee59a7a7cab6c35ee366c
```

The decoded blue video surface overlaps the gold overlay; the committed pixel
fixture proves the overlay stays above the video rather than being covered by
a late bitmap composite.

- `gpu-worker-mixed-frame.png` — hardware Worker pixel fixture.
- `gpu-worker-mixed-frame.json` — GPU identity, dimensions, hash, and latency.
- `authenticated-mixed-elements.png` — authenticated Playwright workspace with
  eleven universal rows and mixed video/overlay/3D/text/caption/motion/effect
  elements.
- `production-authenticated-gpu-preview.png` — signed-in production workspace
  on the accepted public bundle, with backend row titles, Quarter/Auto, the
  mounted hardware-GPU frame, and the narrow two-row Monitor footer fully
  contained in its dock. SHA-256:
  `b7eecb2372d652e29d3e3a90896bfafa0fd28d7b50f843f28569f279280a3474`.

## Validation record

```text
pnpm typecheck       PASS
pnpm lint            PASS
pnpm test            PASS — 334 files passed, 1 skipped; 2256 tests passed, 2 skipped
pnpm build           PASS — editor 1369 modules transformed
pnpm format:check    PASS after closing all 46 warnings (35 pre-existing + 11 WP-35)
WP-35 browser E2E    PASS — 3/3 desktop-primary
GPU fixture          PASS — RTX 5070 Ti / D3D11 / WebGL2 / Quarter PNG
Responsive footer    PASS — 1613×1066, no Monitor/workspace horizontal overflow
```

The authenticated browser cases prove:

1. reverse marquee selection plus keyboard Delete is one atomic, undoable batch;
2. `T1 Video 1`, `T2 Video 2`, and `T3 Overlay` match persisted backend row
   identities while mixed elements render and Monitor starts at Quarter/Auto;
3. closing the workspace reaches zero active preview-owned resources and
   records deterministic decoder/Pixi releases.

## Placement and rollback audit

| Entry route                     | Atomic document boundary                                  | Evidence                                                               |
| ------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| Direct media/sticker/HTML scene | compound Timeline + creative document                     | shared pure placement planner and App route audit                      |
| Agent command bus               | compound when universal binding changes                   | `agent-command-bus.test.ts`                                            |
| Worker generated media          | verified asset import, then shared placement boundary     | Worker result/import tests; no split placement write                   |
| Content template                | one compound commit for all inserted tracks/clips/objects | injected persistence failure in `content-template-transaction.test.ts` |
| Text template                   | one compound commit with explicit text binding            | `text-template-transaction.test.ts`                                    |
| Caption layer                   | one compound commit with caption-source binding           | `caption-layer.test.ts`                                                |
| 3D layer                        | one compound commit with image/object binding             | `three-d-render-layer.test.ts`                                         |
| Undo/redo/reload recovery       | journaled compound rollback                               | `editor-session.test.ts` persistence-failure cases                     |

Worker audio `replace` changes the project/audio snapshot atomically. `keep`
only registers the generated asset and therefore has no Timeline placement to
roll back. When generated media is placed, it uses the shared media placement
planner.

## Production deployment

- Feature product SHA:
  `07ecbe19860db91485ae8e8d2ba4fed209e86176`.
- Accepted responsive closeout SHA:
  `ffa9ea0212719175ec028514ac2f2c0698f62f29`.
- Immutable API release:
  `/opt/joy-media/releases/wp35-final-api-20260816T200008Z-07ecbe1`.
- Immutable editor release:
  `/opt/joy-media/web-releases/editor-web-20260816T201526Z-ffa9ea0-wp35-responsive`.
- Previous editor release retained for rollback:
  `/opt/joy-media/web-releases/editor-web-20260816T200008Z-07ecbe1-wp35-final`.
- Pre-deploy PostgreSQL backup:
  `/opt/joy-media/data/backups/wp35-final-predeploy-20260816T195852Z-07ecbe1.sql.gz`,
  SHA-256
  `a289700c2ca04a0b56fb455323445240ea53cc2813d3b72a0bb0aae158de4850`.
- Public/editor index SHA-256:
  `5e0ac25807c2624da6d093fdca2c70ac6971eada9540995a897add2f7ddf5476`.
- Public entry `assets/index-BKvGb4f-.js` SHA-256:
  `2216a7c104c53f6c2f88c7cbf57fd40b6ee5a55f54cac94aecc7ecf1a5bd0a66`.
- `nginx -t`, `joy-media@api.service`, and public `/api/health` are green.
- Permanent Scheduled Task `JOY Media Local Worker` is running as
  `worker-32ab7e8c-d2e5-4ab8-bcb3-ccaf7be97188`. Production reports both
  `asset.thumbnail` and `render.preview.gpu`; its latest heartbeat was six
  seconds old during the final receipt.

The signed-in production browser reported `T1` through `T11` with persisted
backend names (`Video 1`, `Video 2`, `Overlay`, `3D Scene`, `Text`, `Captions`,
`Motion`, `Effects`, `Filters`, `Adjust`, and `Audio`), selected Quarter/Auto,
displayed status `GPU`, and mounted exactly one
`data-preview-renderer="hardware-gpu"` image. The Monitor footer and entire
Dockview workspace stayed inside the 1613×1066 viewport after the responsive
release.

GitHub workflows `31969031005` (feature product) and `31969924004` (responsive
closeout) did not start any job because the repository account reported a
billing/spending-limit failure. This is an external CI account condition, not a
test failure. The equivalent complete local gate passed after the final source
change: 334 test files, 2,256 passing tests, all workspace builds,
Prettier/ESLint/typecheck, production audit, and 3/3 WP-35 browser cases.

## GBrain receipt

The authoritative closeout page is
`joy-media-wp35-universal-timeline-gpu-preview-closeout-2026-08-16`; the
`joy-media-state` timeline also records the accepted source/release/hash and
paired-Worker facts. GBrain wrote the page, generated three fresh embedding
chunks, and returned no unresolved auto-link errors. `gbrain doctor --json
--fast` reported brain checks `100`, 52/52 reachable/conformant skills, and an
overall health score of `85`. Its three warnings are pre-existing operations
items: the fast run intentionally skipped the live connection check, the
optional retrieval-reflex policy skill is not installed, and an old 2026-08-04
post-upgrade migration warning remains. None is a WP-35 content, embedding,
link, or deployment failure.

## Remaining items

None. GitHub billing must be fixed by the repository owner for future hosted CI
runs, but it does not leave a WP-35 product or deployment item open.
