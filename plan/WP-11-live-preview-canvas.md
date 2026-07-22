# M-LPC — Live Preview Canvas

**Status:** planned · **Gate to enter:** P10 (WP-10.6 visual-object-renderer bridge) · **Master plan:** §36 Phase 10, §20.3
**Gate:** pending — closes the P01/P02/P04 integration exit criteria that were marked done but are not met, per the 2026-07-21 audit ([`AUDIT-2026-07-21-completion-matrix.md`](../AUDIT-2026-07-21-completion-matrix.md)).
**Goal:** Complete the core integration work that enables real preview, real decode, synchronized playback, and export-from-UI — closing the integration gaps identified in the audit where P01/P02/P04 exit criteria were marked done but not met in reality.

## Work packages

- [x] **WP-11.1 — Real GPU preview with Pixi.js canvas in Monitor panel.** Add a true `pixi.js` renderer that consumes `RenderFrameIR` and paints into a `<canvas>` in the Monitor panel, replacing the text placeholder at `App.tsx:334-342`. Wired via the existing `evaluator → visual-object-renderer → RenderFrameIR` path (WP-10.6 bridge). `apps/editor-web` gains `renderer-pixi` (web) and `renderer-headless` (parity) as dependencies. Scrubbing the timeline updates pixels in real time.
- [x] **WP-11.2 — Real browser video decode integration.** Decode one imported/proxy clip via `HTMLVideoElement`/`WebCodecs` into the preview at the playhead (proxy resolution acceptable). Replaces the current state where no `VideoDecoder`, `<video>`, `<canvas>`, `getContext`, or `createImageBitmap` exists anywhere in `apps/editor-web/src`. `playback-engine` is currently a token scheduler, not a decoder — this WP makes it drive real decode. _Infrastructure complete: `createHtmlMediaDecoder`, `buildRenderFrameIR`, and `<video>` element integration are wired in `App.tsx`. End-to-end decode from real media files remains untested pending real media fixtures; the exit-criteria checkbox below will be checked once a real imported/proxy clip round-trips through the decoder._
- [x] **WP-11.3 — A/V synchronized playback from real media clock.** Drive `PlaybackScheduler` from a real media/audio clock; replace the fabricated 250 ms ticker (`App.tsx:84-95` `advancePlayback()` with `scheduler.acceptFrame(token, true)`). Report actual `decodedFrames`/`droppedFrames` reflecting real decode work. Audio and video advance in sync within a stated tolerance (≤1 frame @30fps drift over 30 s).
- [x] **WP-11.4 — UI-triggered export with preview↔export digest verification.** An Export button in the editor that runs the composition through `renderRgbaFrames` (real pixels, not `renderFixture`'s black frames) and verifies via ffprobe. The preview↔export digest check proves on-screen pixels match the exported file within the existing golden tolerance. `apps/editor-web` gains `export-core` as a dependency. Promotes the P04 reel path out of pure fixtures into a UI-driven workflow. _Export button implemented in the editor and uses `downloadBrowserExport` with digest verification. Note: the browser-side export produces an RGBA container (not H.264/AAC) due to browser codec limitations — this is documented in the code. H.264/AAC packaging remains a server-side concern; the corresponding exit-criteria checkbox will be checked once the H.264/AAC path is verified end-to-end via ffprobe._
- [x] **WP-11.5 — Fix P05 regressions (33 failing tests).** Done (this session, on top of the VPS/Hermes line's own P05 fixes — see below). The 33 originally-failing tests (`provider-sdk/idempotency`, `audio-core/normalization`, `adapter-tts/consent-tts`, plus `audio-core` analysis/effects/offline/processing and `commands/audio-commands`) no longer reproduce. One unrelated test still fails on this machine — see the caveat under exit criterion 5 below; it is not one of the 33 and is not a P05 regression.

## Exit criteria (all demonstrable in the running editor, verified via browser preview tools)

- [ ] Loading the editor shows a **rendered frame** (not text) in the Monitor for the reference project; scrubbing the timeline updates pixels. **Partially verified this session:** the Monitor panel had zero CSS (`.monitor-panel`/`.monitor-canvas` didn't exist in `app.css`), so the real Pixi `<canvas>` rendered at its native composition resolution (e.g. 1920×1080) with nothing constraining its box size — it silently overflowed off-screen instead of appearing in the panel. Added the missing CSS (`apps/editor-web/src/app.css`); verified live that the canvas now correctly scales/contains within the panel bounds. **Not yet verified:** actual non-black pixel content in the running editor — the app's default state has no seeded/reference composition to click through to, and editor-web has no UI yet to author one (no "add shape/text/image" command found). Pixel correctness is currently proven only by the automated suite (`renderer-pixi/editor-preview.test.ts`, `golden-render/first-party-scenes.test.ts`), not by this manual check.
- [ ] A real imported/proxy video clip **decodes and displays** at the playhead; `read_network_requests`/console show no errors.
- [ ] Pressing play advances audio and video **in sync** within a stated tolerance (e.g. ≤1 frame @30fps drift over 30 s); reported `decodedFrames` reflect actual decode work.
- [ ] An **Export** click produces a real H.264/AAC file whose pixels match the on-screen preview within the existing golden tolerance, verified by ffprobe **and** a preview↔export digest check.
- [ ] `npx vitest run` is **green (0 failures)** on a **committed** tree. **1093/1094 this session** — the 33 original P05 failures are gone; the one remaining failure (`golden-render/first-party-scenes.test.ts`, pinned Chromium SHA-256 pixel hashes) is a cross-platform Chromium rendering difference, not a P05 regression: this exact test's hashes were already updated once (commit `0179ae7`, Linux VPS, `--no-sandbox`) and now differ again under this machine's local Chromium build. Overwriting the hashes here would just flip which platform fails; needs an actual decision (tolerance-based comparison instead of exact hash, or a pinned/containerized Chromium) rather than a hash edit.
- [ ] `STATE.md` reflects reality after the milestone (P02/P04 integration criteria genuinely met; P05 unblocked).

## Affected packages / apps

- **New:** `packages/renderer-pixi` gains a real browser entry (or new `renderer-pixi-web`) depending on `pixi.js`.
- **`apps/editor-web`:** add deps `renderer-pixi` (web), `renderer-headless` (parity), `export-core`, `evaluator`, `visual-object-renderer`; implement the Monitor canvas, decode integration, real clock, Export button.
- **`packages/playback-engine`:** accept an injected wall/media clock; surface real metrics.
- **`packages/visual-object-renderer`:** consumed at runtime (currently test-only).
- **`packages/export-core`:** UI-triggered path (already has `renderRgbaFrames`).
- **P05 packages** (`audio-core`, `adapter-tts`, `provider-sdk`, `commands`): fix regressions; commit the working tree.

## Tests to add / restore

- **Parity:** on-screen `renderer-pixi` (web) vs `renderer-headless` for pinned frames of the reference project (extend `renderer-pixi/src/editor-preview.test.ts`).
- **Decode:** headless integration decoding a tiny committed fixture clip to RGBA at N timestamps.
- **Sync:** scheduler test asserting drift bound against a fake-but-real clock (not `acceptFrame(token, true)`).
- **Export-from-UI:** editor-driven `renderRgbaFrames` → ffprobe + preview/export digest equality (promote the P04 reel path out of pure fixtures).
- **P05 regression gate:** the existing 33 tests as the milestone's entry gate.
- **Browser E2E:** load editor → scrub → play → export using the preview/verification workflow; capture a screenshot as evidence.

## Risks

- **`pixi.js` in the CSP/Vite environment** — bundle size and WebGL context handling; mitigate with a headless-parity gate so correctness never depends on the GPU path alone.
- **WebCodecs/browser-decode variance** — codec/container support differs across browsers; pin to proxy H.264 and a committed fixture.
- **A/V drift** — needs a single authoritative clock; risk of regressing determinism. Keep export on the deterministic frame-exact path, preview on the real-time clock, and reconcile only at the IR boundary.
- **P05 working tree** — the 33 failures must be understood (real regression vs stale tests) _before_ committing; don't paper over exit criterion #3/#4/#5.
- **Scope creep toward transport/DB/providers** — hold the line; those are separate NOT-STARTED milestones (live control-plane transport, PostgreSQL adapter, JOY SSO/`joymedia_allowed`, Windows Worker packaging, Tauri shell, live ComfyUI/Whisper/TTS providers).
