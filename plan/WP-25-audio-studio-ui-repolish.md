# WP-25 — Audio Studio UI repolish

Status: `gate-review` (implementation and automated verification complete; live browser verification remains a follow-up)

## Problem

The Studio tab put a tall runtime/model-cache block and a 16-tile Atomic APIs catalogue ahead of the execution flow. At a representative dock size, the `.audio-panel` measured 440×512 px while its scroll body exposed 433 px; the Studio stack was about 1,460 px tall, with the runtime at 235 px, workflow at 226 px, and catalogue at 982 px. The execution path and disabled run action were therefore easy to miss.

## Evidence

- Baseline source: `apps/editor-web/src/AudioPanel.tsx` and the audio styles near line 11817 of `apps/editor-web/src/app.css`.
- Baseline behavior: Local Worker rendered `Pairing`, Cloud Brain rendered `Online`, Device and Model Cache were always in the main scan path, and Atomic APIs rendered expanded by default.
- The existing PanelShell contract requires header → tabs → one scrolling body; this work keeps that contract and the existing Studio / Models / Master / Clips subtabs.

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
- [x] Run Prettier on touched source, test, CSS, and documentation files.

## Verification notes

- Independent orchestrator verification outside the restricted Codex sandbox passed `pnpm typecheck`.
- Independent orchestrator verification passed `pnpm lint`.
- Independent orchestrator verification passed `pnpm format:check`.
- Independent orchestrator verification passed `pnpm exec vitest run apps/editor-web/src/AudioPanel.test.tsx apps/editor-web/src/PanelShell.test.tsx apps/editor-web/src/audio-studio-runtime.test.ts` (3 files, 10 tests).
- Independent orchestrator verification passed `pnpm --filter @joy-media/editor-web build` (1,268 modules transformed).
- No deploy, commit, push, runtime-data, or secret mutation was performed.
- Browser/live visual verification was not run in this implementation session; the unchecked responsive acceptance item is intentionally left for review.
