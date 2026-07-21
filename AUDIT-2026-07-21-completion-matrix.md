# JOY Media — Evidence-Based Completion Audit

**Date:** 2026-07-21 · **Revision audited:** `7e62dbe` (HEAD, committed 2026-07-21 03:14 +0330)
**Working tree:** dirty — 32 uncommitted modified files (the "P05-era working tree"), so every "done" claim for P05 and later was recorded against uncommitted code.
**Test baseline (this revision, `npx vitest run`):** **1042 passed / 33 failed** across 133 test files (8 files failing). All 33 failures are P05 packages — see §P05.
**Method:** each phase is scored against its *own written exit criteria* in `plan/*.md` and the master plan §36, not against "the package exists and unit tests pass."

> **Headline:** The codebase is a well-architected set of **pure, headless libraries with excellent unit coverage**. It is **not** an integrated editor. No pixels are ever rendered to a screen, no real media is ever decoded or encoded from the UI, no real network provider is ever contacted, and no live control-plane transport, database, desktop shell, or Worker binary exists. Roughly every phase from P02 onward is marked `done` in `STATE.md` on the strength of package-level unit tests while its *integration* exit criteria are unmet. STATE.md should be corrected accordingly (proposed edits in §Correction).

---

## Legend

- **VERIFIED** — exit criterion met and demonstrable in the integrated product (or legitimately package-only where the criterion is package-only, e.g. P00 spikes).
- **PARTIAL** — real logic exists and passes unit tests, but the criterion's integrated/real-media/real-transport intent is unmet.
- **NOT STARTED** — no production implementation (stub, placeholder, README, or type-only contract).
- **BLOCKED / REGRESSED** — was claimed done but is currently failing at HEAD.
- **Integration column:** `unit` = proven only in package tests; `editor` = works through the running editor; `live` = works against real media/network/VPS.

---

## Part-level matrix (against actual exit criteria)

| Phase | Exit criteria status | Overall | Integration | Real media? | Key evidence |
|---|---|---|---|---|---|
| **P00** architecture proofs | 5/5 evidenced (spikes + ADRs) | **VERIFIED** (as spikes) | unit | Fixtures only | `plan/P00-architecture-proofs.md:23`; ADR-0002…0010; spike packages |
| **P01** platform foundation | plan file: **0/6 boxes checked** `[ ]`; STATE says "reviewed 6/6" | **PARTIAL** | unit + editor (persistence only) | No | `plan/P01-platform-foundation.md:17-25`; local save/recover real (`EditorSession`, `project-persistence`); Worker/API transport is in-process only |
| **P02** editing slice | plan file: 6/6 `[x]` | **PARTIAL (overclaimed)** | mixed | No | See §P02 — proxy playback & export & interruption are unit-only/fixture |
| **P03** captions | 5/5 `[x]` | **VERIFIED for manual captions; transcription NOT STARTED** | editor | No (stub transcription) | `CaptionsPanel.tsx` real; `local-transcription.ts:7` hardcoded "Hello JOY world" |
| **P04** motion + HTML scenes | 5/5 `[x]` | **PARTIAL** | unit | No | Reel "exports" via test fixtures + software rasterizer; **no real Pixi preview** (`renderer-pixi/src/index.ts:1-8`) |
| **P05** audio + providers | 5/5 `[x]` "tests green" | **REGRESSED / BLOCKED** | unit | No | **33 tests failing at HEAD**, incl. `idempotency.test.ts` = exit #3, `normalization.test.ts` = exit #4, `consent-tts.test.ts` = exit #5. Providers are stubs |
| **P06** agent | 7/7 `[x]` | **PARTIAL** | unit | No | `agent-tools` command-bus logic tested; **not wired into editor-web** (not a dependency) |
| **P07** workflows | 5/5 `[x]` | **PARTIAL** | unit | No | `workflow-engine` + `joy-workflow` CLI real at package level; ports stubbed; not in editor |
| **P08** plugin SDK | 5/5 `[x]` | **PARTIAL** | unit | No | `plugin-sdk` contracts + fixtures; no host wiring in editor; 4 pre-existing lint errors noted in STATE |
| **P09** marketplace/collab | own bounded criteria | **PARTIAL (honestly gated)** | unit | No | `collaboration-core` package-level; explicitly no transport/marketplace (ADR-0011/0013/0014) |
| **P10** advanced | bounded (ADR-0015) | **PARTIAL** | unit + editor (camera UI) | No | camera/expression/bridge proven at evaluator + software-rasterizer pixel-digest parity; `CameraPanel.tsx` exists but no on-screen preview to show parallax |
| **X01** VPS control plane | doc: 5/5 `[x]` (edited today, uncommitted) | **UNVERIFIABLE from repo + INTERNALLY INCONSISTENT** | live (claimed) | — | `plan/X01…md:37-43` claims DNS live + restore drill passed 2026-07-21; `STATE.md:19` still says both open. No app Postgres adapter exists regardless |

---

## The twelve specific integration checks

| # | Capability | Status | Integration | Real media/network? | Exact evidence |
|---|---|---|---|---|---|
| 1 | **Real Pixi preview in Monitor panel** | **NOT STARTED** | — | — | `apps/editor-web/src/App.tsx:334-342` — the `monitor` panel falls through to a text placeholder (`"Program Monitor panel"`). `editor-web/package.json` has **no** `renderer-pixi` dependency. `renderer-pixi/src/index.ts:1-8`: *"test-mode … no browser or GPU dependency"* — `renderer-pixi` doesn't even depend on `pixi.js`. |
| 2 | **Browser decoding with real video** | **NOT STARTED** | — | — | No `VideoDecoder`, `<video>`, `<canvas>`, `getContext`, or `createImageBitmap` anywhere in `apps/editor-web/src`. `playback-engine` is a token scheduler, not a decoder. |
| 3 | **Audio/video synchronized playback** | **NOT STARTED** | — | — | `App.tsx:84-95` `advancePlayback()` increments the playhead by 250 ms on a `setInterval` and **fabricates** `decodedFrames`/`droppedFrames` via `scheduler.acceptFrame(token, true)`. No audio clock is bound to any sample source. |
| 4 | **Proxy / thumbnail / waveform generation** | **PARTIAL (unit only)** | unit | No | `media-core/src/assets.ts` models opaque derivative *records* (`byteLength`), no decode. `audio-core buildWaveform` is real DSP but needs real PCM fed in — nothing in the app feeds it. Only ffmpeg reference in `media-core` is in `pipeline.test.ts`. |
| 5 | **Deterministic export from the editor UI** | **NOT STARTED (from UI)** | unit (fixture) | No | No export button and no `export-core` dependency in `editor-web`. Worker export (`apps/worker/src/export-job.ts`) calls `renderFixture`, which encodes a **black frame** (`color=c=black`, `export-core/src/index.ts:31-73`). A real-pixel path (`renderRgbaFrames`) exists but is driven only by golden-render/`visual-object-renderer` **tests**. |
| 6 | **Actual PostgreSQL adapter** | **NOT STARTED (in code)** | unit | No | No `pg`/node-postgres dependency anywhere. `apps/api/src/control-plane.ts:41` `LocalControlPlane` is `Map`-based in-memory. `postgres-schema.ts` is a SQL *string constant*. `server.ts` exposes only `/health`. |
| 7 | **JOY shared-login + `joymedia_allowed`** | **NOT STARTED** | — | No | `joymedia_allowed`/SSO/OAuth appear only in `plan/*.md` and docs, never in application code. `control-plane` `auth()` just checks `actor.id` presence. |
| 8 | **Windows Worker packaging** | **NOT STARTED** | — | — | `apps/worker` is a `tsx src/index.ts` dev script. No electron-builder/nsis/msi/pkg/tauri bundler config; no installer or built binary. |
| 9 | **Tauri desktop application** | **NOT STARTED** | — | — | `apps/desktop/` is **README only** — *"Status: planned — no code yet."* No Rust, no `tauri.conf`. Master plan slots it for P02 (marked done); it was never built. |
| 10 | **Live ComfyUI / transcription / TTS providers** | **NOT STARTED (stubs)** | unit | No | No `fetch`/`http`/`WebSocket` in any `adapter-*`. `adapter-comfyui` returns `'mock text output'` (`index.ts:246`). Editor transcription (`local-transcription.ts:7`) returns hardcoded tokens: *"swap its executor for installed Whisper runtime wiring."* |
| 11 | **Recovery after Worker/VPS interruption** | **PARTIAL (unit only)** | unit | No | `apps/worker/src/reference-e2e.test.ts` proves WAL recovery from an **`InMemoryProjectStore`** and lease re-assignment inside the **in-memory** `LocalControlPlane`. No real process crash, no real VPS restart — there is no live transport to interrupt. |
| 12 | *(bonus)* **Agent operates the real editor** | **PARTIAL (unit only)** | unit | No | `agent-tools` is not a dependency of `editor-web`; the agent drives the command bus only in package tests. |

---

## Detail notes

### P01 — the plan file never checked its own boxes
`plan/P01-platform-foundation.md:17-25` has **all six** exit criteria as unchecked `[ ]`, yet `STATE.md:9` records P01 as `reviewed 6/6`. Of the six: *create/open/save/recover locally* and *workspace restores after restart* are genuinely real in the editor (`EditorSession` + `project-persistence` + Dockview layout in `localStorage`). *Connect/disconnect Worker* and *sample job end-to-end (submit→lease→progress→verify)* exist only as in-process `LocalControlPlane` calls (no wire transport). *joy-vps unaffected* is an X01/VPS claim (see below).

### P02 — the clearest overclaim
`plan/P02-editing-slice.md:19-24` marks 6/6 `[x]`, but the parentheticals already concede the gap ("decoder/scheduler *contracts*"):
- *Play through using proxies* → the scheduler counts fabricated frames; nothing decodes.
- *Export 16:9 & 9:16 through the Worker* → `renderFixture` black-frame video, in a unit test, not from the UI.
- *Survive Worker and VPS interruption* → in-memory lease expiry + in-memory WAL replay.
Only *reopen with decisions intact* and *undo/redo* are truly demonstrable in the editor.

### P05 — currently regressed
Marked `done` with "pnpm check: all tests green," but at HEAD **33 tests fail**, and they are exactly P05's subject matter:
- `provider-sdk/src/idempotency.test.ts` (6 fails) — this **is** exit criterion #3 ("failure/cancel/retry never duplicates assets").
- `audio-core/src/normalization.test.ts` (3) — exit criterion #4 ("dialogue mix meets loudness/peak targets").
- `adapter-tts/src/consent-tts.test.ts` (2) — exit criterion #5 ("cloned voice needs consent").
- plus `audio-core` analysis/effects/offline/processing and `commands/audio-commands`.
The failures track the 32 uncommitted working-tree files (mostly P05 packages). **P05 must be reopened as BLOCKED until these pass on a committed tree.**

### P04 — "builds and exports" ≠ integrated
The reel exit criterion is satisfied by `golden-render`/`renderRgbaFrames` **tests** feeding fixture/scene pixels through real ffmpeg. "Preview and final render stay within tolerance" is proven by comparing two **Node software rasterizers** (`renderer-pixi` test-mode vs `renderer-headless`), not a real GPU preview vs export. Real HTML-scene isolation (`html-scene-runtime` + chromium-driver) is genuine at the package level.

### X01 — cannot be verified from here, and the docs disagree
`plan/X01-vps-control-plane.md` (uncommitted, edited 2026-07-21) now asserts every exit criterion met, including *DNS CNAME `media.joyteam.ir` live* and *restore drill PASSED*. `STATE.md:19` and its 2026-07-20 session log still say the DNS record and restore drill are **open**, and it even switches "A record" → "CNAME." From this repo I **cannot confirm live VPS state** (no execution against the server was performed as part of this read-only audit). Independent of the live claims: **no application code connects to PostgreSQL**, so "actual PostgreSQL adapter" is unmet in the product regardless of what is installed on the box.

---

## Correction to the project-status report

`STATE.md` should stop reporting integration-bearing phases as `done`. Proposed row changes (evidence above):

| Part | Current | Proposed | Reason |
|---|---|---|---|
| P01 | reviewed 6/6 | `partial` | plan boxes unchecked; no live Worker/API transport |
| P02 | done 6/6 | `partial` | playback/export/interruption are unit/fixture-only |
| P04 | done 5/5 | `partial` | no real Pixi preview; reel export is test-driven |
| P05 | done 5/5 | `blocked` | 33 exit-criterion tests failing at HEAD |
| P06–P08 | done | `partial (unit)` | package-level only; not integrated into editor |
| P10 | done | `partial` | proven in evaluator/rasterizer tests, not on screen |
| X01 | reviewed | `unverified` | doc/ledger contradict; no app DB adapter |

(These are proposed edits; I have not modified `STATE.md` or any plan file — per the "do not change code during this audit" instruction. Say the word and I'll apply them.)

---

# Proposed milestone: **M-LPC — Live Preview Canvas**

**Framing (per your instruction):** this milestone does **not** merely "productize." It closes the **P01/P02/P04 integration exit criteria that were marked done but are not met** — real preview, real decode, synchronized playback, and export-from-UI — plus the P05 regression that blocks anything audio in the preview. Treat those as unfinished phase work folded into one bounded, demonstrable slice.

## Bounded scope (in)
1. **Real GPU preview** — add a true `pixi.js` renderer that consumes `RenderFrameIR` and paints into a `<canvas>` in the Monitor panel, wired via the existing `evaluator → visual-object-renderer → RenderFrameIR` path (WP-10.6 bridge).
2. **Real browser video decode** — decode one imported clip via `HTMLVideoElement`/`WebCodecs` into the preview at the playhead (proxy resolution acceptable).
3. **A/V synchronized playback** — drive `PlaybackScheduler` from a real media/audio clock; replace the fabricated 250 ms ticker (`App.tsx:84-95`); report *actual* decoded/dropped frames.
4. **Export from the UI** — an Export button that runs the composition through `renderRgbaFrames` (real pixels, not `renderFixture`) and verifies via ffprobe.
5. **Unblock P05** — get the 33 failing tests green on a committed tree (prerequisite for any audio in the preview).

## Explicitly out (own milestones)
Live control-plane transport, PostgreSQL adapter, JOY SSO/`joymedia_allowed`, Windows Worker packaging, Tauri shell, and live ComfyUI/Whisper/TTS providers. Each is a NOT-STARTED item above and deserves its own bounded milestone; bundling them defeats "one end-to-end workflow before widening" (ORCHESTRATION §2).

## Affected packages / apps
- **New:** `packages/renderer-pixi` gains a real browser entry (or new `renderer-pixi-web`) depending on `pixi.js`.
- **`apps/editor-web`:** add deps `renderer-pixi`(web), `renderer-headless`(parity), `export-core`, `evaluator`, `visual-object-renderer`; implement the Monitor canvas, decode integration, real clock, Export button.
- **`packages/playback-engine`:** accept an injected wall/media clock; surface real metrics.
- **`packages/visual-object-renderer`:** consumed at runtime (currently test-only).
- **`packages/export-core`:** UI-triggered path (already has `renderRgbaFrames`).
- **P05 packages** (`audio-core`, `adapter-tts`, `provider-sdk`, `commands`): fix regressions; commit the working tree.

## Acceptance criteria (all demonstrable in the running editor, verified via the browser preview tools)
1. Loading the editor shows a **rendered frame** (not text) in the Monitor for the reference project; scrubbing the timeline updates pixels.
2. A real imported/proxy video clip **decodes and displays** at the playhead; `read_network_requests`/console show no errors.
3. Pressing play advances audio and video **in sync** within a stated tolerance (e.g. ≤1 frame @30fps drift over 30 s); reported `decodedFrames` reflect actual decode work.
4. An **Export** click produces a real H.264/AAC file whose pixels match the on-screen preview within the existing golden tolerance, verified by ffprobe **and** a preview↔export digest check.
5. `npx vitest run` is **green (0 failures)** on a **committed** tree; the 33 current failures are gone.
6. `STATE.md` reflects reality after the milestone (P02/P04 integration criteria genuinely met; P05 unblocked).

## Tests to add / restore
- **Parity:** on-screen `renderer-pixi`(web) vs `renderer-headless` for pinned frames of the reference project (extend `renderer-pixi/src/editor-preview.test.ts`).
- **Decode:** headless integration decoding a tiny committed fixture clip to RGBA at N timestamps.
- **Sync:** scheduler test asserting drift bound against a fake-but-real clock (not `acceptFrame(token, true)`).
- **Export-from-UI:** editor-driven `renderRgbaFrames` → ffprobe + preview/export digest equality (promote the P04 reel path out of pure fixtures).
- **P05 regression gate:** the existing 33 tests as the milestone's entry gate.
- **Browser E2E:** load editor → scrub → play → export using the preview/verification workflow; capture a screenshot as evidence.

## Risks
- **`pixi.js` in the CSP/Vite environment** — bundle size and WebGL context handling; mitigate with a headless-parity gate so correctness never depends on the GPU path alone.
- **WebCodecs/browser-decode variance** — codec/container support differs across browsers; pin to proxy H.264 and a committed fixture.
- **A/V drift** — needs a single authoritative clock; risk of regressing determinism. Keep export on the deterministic frame-exact path, preview on the real-time clock, and reconcile only at the IR boundary.
- **P05 working tree** — the 33 failures must be understood (real regression vs stale tests) *before* committing; don't paper over exit criterion #3/#4/#5.
- **Scope creep toward transport/DB/providers** — hold the line; those are separate NOT-STARTED milestones.
