# P16 — OSS transitions + HTML scene effects

## What shipped

### A — gl-transitions (dual-texture)

- Registry: `@joy-media/transition-shaders` — curated MIT shaders + `listTransitionShaders` / `getTransitionShader` / `mergeTransitionParams`.
- Schema: `TransitionV1.type` is a registry id (`dissolve` | `wipe` | `slide` | `gl:*`); optional `params`.
- IR: `TransitionNode` carries `shaderId` + `params`.
- Preview/export: Pixi filter blends `leftClipId` / `rightClipId` bitmaps (`packages/renderer-pixi` browser path). Editor caches per-clip frames and seeks a partner decoder during active transitions.
- UI: Transitions panel add buttons use the selected type; catalog select + numeric param sliders.

### B — HTML scene pack

First-party packages in `packages/html-scene-runtime/src/first-party.ts` (Motion panel picker):

| Id | Role |
|----|------|
| `joy.firstparty.lower-third-bar` | Sliding name/role bar |
| `joy.firstparty.lower-third-split` | Two-tone bar |
| `joy.firstparty.title-cinematic` | Full-bleed title + subtitle |
| `joy.firstparty.countdown` | Deterministic countdown from variables |
| `joy.firstparty.caption-card` | Quote / callout |
| `joy.firstparty.end-slate` | End card + CTA |
| `joy.firstparty.super-app-hero` | JOY Super App hero copy (from wg-bot client) |

All motion uses `ctx.progress` / `ctx.timeUs` only. Reference-frame hashes are pinned in `first-party.test.ts`.

## How to add one more gl shader

1. Drop the `.glsl` (MIT/Apache/CC0) into `packages/transition-shaders/src/shaders/`.
2. Register it in `catalog.json` / `catalog.ts` with `id` (`gl:Name`), `defaultParams`, `paramsTypes`, author, license.
3. Add the file to `glsl-sources.ts`.
4. Record attribution in `THIRD_PARTY_NOTICES.md`.
5. Extend registry unit tests; smoke a mid-progress Monitor frame on a two-clip junction.

## How to add one more HTML scene

1. Author a `__joyScene(ctx)` package in `first-party.ts` (or a split module).
2. Keep ADR-0006: no network, no `Date`/`setTimeout`, only safe `Math` helpers, system fonts / inline SVG.
3. Export the id on `FirstPartySceneId` and `FIRST_PARTY_SCENES`.
4. Pin `referenceFrameSha256` in `first-party.test.ts`.

## Delivery checklist

- [x] **A0** — Registry + schema/`params` + Transitions panel type-picker (selected type on add)
- [x] **A1** — Dual-texture Pixi gl path; Monitor partner-frame cache; export seeks left+right
- [x] **B1** — Six+ HTML scene packages in Motion picker; pinned `referenceFrameSha256` goldens
- [x] **Docs** — this runbook + `THIRD_PARTY_NOTICES.md`; stale P04/P11/P13 STATUS rows refreshed

## Exit criteria

- [x] Adjacent clips → gl transition → Monitor blends A↔B when both clip bitmaps are cached (`dualTextureBitmapsReady`)
- [x] Export mid-transition uses the same Pixi adapter + dual seek (preview/export parity path)
- [x] New HTML scenes in picker; animate on `ctx.progress`; deterministic goldens in `first-party.test.ts`
- [x] `pnpm typecheck` + focused renderer/html-scene/transition-shaders tests; web tip via `web-releases/<sha>`

## Out of scope (follow-ups)

- Third-party scene zip marketplace
- Pixi EffectsPanel blur/glow expansion (P13)
- OBS browser-source control panels
