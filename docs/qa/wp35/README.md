# WP-35 Final Closeout Evidence

Audit date: 2026-08-16  
Status: product candidate green; immutable production cutover and final GBrain receipt are recorded after this candidate commit is deployed.

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

## Validation record

```text
pnpm typecheck       PASS
pnpm lint            PASS
pnpm test            PASS — 334 files passed, 1 skipped; 2256 tests passed, 2 skipped
pnpm build           PASS — editor 1369 modules transformed
pnpm format:check    PASS after closing all 46 warnings (35 pre-existing + 11 WP-35)
WP-35 browser E2E    PASS — 3/3 desktop-primary
GPU fixture          PASS — RTX 5070 Ti / D3D11 / WebGL2 / Quarter PNG
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

## Deployment and GBrain

The prior WP-35 release remains the rollback target until this green candidate
is pushed and deployed. The final documentation pass records the accepted
product SHA, immutable API/editor release paths, public hashes, Worker hardware
capability, production browser evidence, and final GBrain page/health receipt.

## Remaining items

None in WP-35 product scope. Production cutover and the final evidence receipt
are operational completion steps for this already-green candidate, not deferred
feature work.
