# WP-25 — Audio Studio UI repolish

Status: `gate-review` (implementation and automated verification complete; third visual/density correction awaiting live remeasurement)

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
- [x] Run Prettier on touched source, test, CSS, and documentation files.

## Verification notes

- Independent orchestrator verification outside the restricted Codex sandbox passed `pnpm typecheck`.
- Independent orchestrator verification passed `pnpm lint`.
- Independent orchestrator verification passed `pnpm format:check`.
- Independent orchestrator verification passed `pnpm exec vitest run apps/editor-web/src/AudioPanel.test.tsx apps/editor-web/src/PanelShell.test.tsx apps/editor-web/src/audio-studio-runtime.test.ts` (3 files, 10 tests).
- Independent orchestrator verification passed `pnpm --filter @joy-media/editor-web build` (1,268 modules transformed).
- Third-correction verification with installed local binaries passed the focused Vitest suite (3 files, 10 tests), `tsc -b`, `eslint .`, `prettier --check .`, `git diff --check`, and the editor Vite build (1,268 modules transformed).
- The prior independent live review on `https://joyst.ir/` at deployed commit `da2858958ca7303726201fc874dc539116a4415d`, release `/opt/joy-media/releases/editor-web-20260809-114501-da28589-audio-studio`, exposed this third correction. Its exact evidence was 440×512, body top 161 / bottom 594, clientHeight 433, width 424, scrollHeight 498, scrollTop 0, and no horizontal overflow; Runtime was 102 px (grid 72, closed settings 29), Workflow was 299 px (heading 44, preset grid 69, selected card 186, steps 69, footer 48), Run was top 535 / bottom 566, and Capability Library began at 583.
- The third correction is not live-verified. The orchestrator must remeasure the 440×512 default state and the narrow responsive fallbacks before this WP can close.
- No deploy, commit, push, runtime-data, or secret mutation was performed.
