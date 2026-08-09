# WP-25 — Audio Studio UI repolish

Status: `gate-review` (fourth runtime-card alignment correction awaiting live remeasurement)

## Problem

The Studio tab put a tall runtime/model-cache block and a 16-tile Atomic APIs catalogue ahead of the execution flow. At a representative dock size, the `.audio-panel` measured 440×512 px while its scroll body exposed 433 px; the Studio stack was about 1,460 px tall, with the runtime at 235 px, workflow at 226 px, and catalogue at 982 px. The execution path and disabled run action were therefore easy to miss.

## Evidence

- Baseline source: `apps/editor-web/src/AudioPanel.tsx` and the audio styles near line 11817 of `apps/editor-web/src/app.css`.
- Baseline behavior: Local Worker rendered `Pairing`, Cloud Brain rendered `Online`, Device and Model Cache were always in the main scan path, and Atomic APIs rendered expanded by default.
- The existing PanelShell contract requires header → tabs → one scrolling body; this work keeps that contract and the existing Studio / Models / Master / Clips subtabs.

## Corrective pass — 2026-08-09

The first live review measured the improved stack at 646 px, but the disabled
Run action still ended at 710 px—116 px below the 433 px initial body viewport.
The runtime was 155 px and the workflow was 394 px, including a duplicate
27 px readiness row. This corrective pass removes that duplicate row, compacts
the runtime/settings and workflow rhythm, and uses a three-column preset grid
above 22rem so the Run action can remain in the first viewport without sticky,
fixed, absolute, or hidden required content. It also replaces the disliked mic
and gear masks with distinct shared waveform/processor/storage SVG icons.

## Third visual/density correction — 2026-08-09

The owner’s close-up of deployed `da28589` confirmed that the first-viewport
gate was still open: at 440×512 the 433 px body contained a 498 px Studio
stack, with the collapsed Capability Library at 583–659 px. The six workflow
steps occupied 69 px, the library summary occupied 76 px because its purpose
wrapped, the PlayIcon implied a false disclosure, the small DeviceProcessorIcon
still read as a gear, and the workflow footer split resources and readiness
awkwardly. This pass targets a stack no taller than the 433 px body without
hiding required content, sticky/fixed/absolute positioning, clipping, scaling,
or sub-11 px text. It makes the desktop path a compact connected row, keeps
narrow containers wrapped, makes the library summary one line above 22rem,
replaces the false-affordance and device glyphs with shared SVGs, and aligns
the footer’s resources, readiness, and action.

## Fourth runtime-card alignment correction — 2026-08-09

The owner’s computed-style audit of deployed `35f8097` found that the three
runtime cards did not share an outer box: Local Worker and Cloud Brain were
60.32 px tall, while Device was 44.32 px because the broad global `label`
rule contributed 8 px top and bottom margins. The runtime glyph wrapper also
spanned both content rows, placing each icon between the title and status.
This correction scopes `margin: 0` to the Device runtime label and explicitly
places each icon/title/status or select in the two-row runtime grid. It keeps
the existing density, status semantics, responsive layout, and no-scroll gate;
the live equal-height and icon-row result remains open for remeasurement.

## Acceptance criteria

- [x] Studio reads as runtime/readiness → workflow preset → selected workflow path/estimate → run action inside the existing PanelShell.
- [x] Local Worker remains honestly `Pairing`; Cloud Brain remains `Online`; Device stays editable; Model Cache is editable inside collapsed native runtime settings.
- [x] The selected workflow has concise command copy, a readable ordered path, resource estimates, and a disabled action whose title, accessible description, and visible readiness text explain that pairing is required.
- [x] Capability Library is collapsed by default, exposes all 16 capabilities and its purpose in the summary, and provides accessible target filters with counts and pressed state.
- [x] Touched audio styles use existing design tokens and preserve compact/responsive behavior, including the ≤22rem container query.
- [x] Focused server-render test covers action-first labels, honest statuses/readiness, collapsed library summary/count, filters, retained capability content, and ARIA.
- [ ] Live browser measurement at the representative dock size and ≤22rem has been rerun by the orchestrator.

## Implementation checklist

- [x] Compact runtime status surface with progressive-disclosure model-cache settings.
- [x] Coherent workflow preset selector and dominant selected-workflow card.
- [x] Honest disabled local-run state with visible and programmatic readiness copy.
- [x] Native Capability Library disclosure, target filters, and filtered capability tiles.
- [x] Compatible CSS density, focus, status-token, and narrow-container rules.
- [x] Preserve Models, Master, Clips, and PanelShell tab behavior.
- [x] Add focused `AudioPanel.test.tsx` server-render coverage.
- [x] Add the corrective render assertions for the removed mic/gear masks.
- [x] Compact the first-viewport runtime/workflow rhythm and add distinct shared audio icons.
- [x] Convert the ordered workflow path to a connected single-row pipeline above 22rem with narrow wrapping fallbacks.
- [x] Compact the collapsed Capability Library summary to one line above 22rem while retaining its purpose text.
- [x] Replace the false PlayIcon heading affordance and redraw the device icon as a rectangular compute card.
- [x] Rebalance the workflow footer so resources, readiness, and the disabled action align coherently.
- [x] Scope the runtime Device label margin and align runtime icons/titles/statuses to explicit grid rows.
- [x] Run Prettier on touched source, test, CSS, and documentation files.

## Verification notes

- Independent orchestrator verification outside the restricted Codex sandbox passed `pnpm typecheck`.
- Independent orchestrator verification passed `pnpm lint`.
- Independent orchestrator verification passed `pnpm format:check`.
- Independent orchestrator verification passed `pnpm exec vitest run apps/editor-web/src/AudioPanel.test.tsx apps/editor-web/src/PanelShell.test.tsx apps/editor-web/src/audio-studio-runtime.test.ts` (3 files, 10 tests).
- Independent orchestrator verification passed `pnpm --filter @joy-media/editor-web build` (1,268 modules transformed).
- Third-correction verification with installed local binaries passed the focused Vitest suite (3 files, 10 tests), `tsc -b`, `eslint .`, `prettier --check .`, `git diff --check`, and the editor Vite build (1,268 modules transformed).
- Final independent live browser gate passed after reload on `https://joyst.ir/` at commit `35f80978ea28d4b15e0a11fc8c2803c74868c64e`, release `/opt/joy-media/releases/editor-web-20260809-120957-35f8097-audio-studio`. At 440×512, the body was top 161 / bottom 594, clientHeight 433, scrollHeight 433, scrollTop 0, width 424, with no horizontal overflow. The Studio stack was 161–566 (405 px), leaving 28 px; Runtime was 96 px, Workflow 242 px, selected card 138 px, connected steps 31 px, and footer 46 px. Run was 466–495 (29 px) and the collapsed Capability Library summary was 520–566 (46 px), fully visible without scrolling. All six Podcast Quality labels fit: Denoise, Enhance, EQ, Compress, Limiter, Normalize.
- At the 340 px narrow gate, there was no body horizontal overflow; presets computed to 2 columns, steps to a 3-column grid, the footer to one column, and the Capability Library summary wrapped intentionally. All six labels remained visible and Run stayed compact.
- Live interactions passed: Runtime settings opened and exposed the editable Audio model cache path, then closed; YouTube Master updated the selected card and Run aria-label, then reset; Capability filters returned Local Worker 9, Browser DSP 6, and Cloud Brain 1 before the library was collapsed again. Models, Master, Clips, and Studio remained covered by the unchanged tab code/tests. No new console errors appeared; only the retained prior-bundle transition preview error remained in tab history. The runtime contained no old PNG mask; the device rendered as a shared rectangular compute-card SVG and the workflow heading as a shared path-nodes SVG with no play triangle.
- Final deployment evidence: HEAD, `origin/main`, and `vps-local/main` matched `35f8097`; the canonical worktree was clean; `nginx -t` passed; API health was `{ok:true, service:joy-media-api, controlPlane:true}`. Release, live symlink, and public index SHA-256 all matched `7986c1cb90b2fa1547736d5d5f314b87f62ae3d1d3185b229bd4b5a1282790c9`; release, live, and public CSS SHA-256 all matched `ff8516cd9dc486b80f63c7274af0174700c2ec62da6dda68f05c82e7d3499153`. Rollback releases `3bae8ec`, `da28589`, `e4860c7`, and `88340d5` remain available.
- Independent orchestrator verification after the final CSS change passed `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm exec vitest run apps/editor-web/src/AudioPanel.test.tsx apps/editor-web/src/PanelShell.test.tsx apps/editor-web/src/audio-studio-runtime.test.ts` (3 files, 10 tests), `pnpm --filter @joy-media/editor-web build` (1,268 modules), and `git diff --check`.
- The fourth correction is not live-verified. The orchestrator must remeasure equal runtime-card outer heights, title-row icon placement, and the existing 440×512 / ≤22rem gates after deployment.
- This fourth-correction working-tree session performed no deployment, commit, push, runtime-data, or secret mutation.
