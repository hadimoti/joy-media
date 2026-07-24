# P15 — Sticker overlays + chrome rearrange

**Executable plan** for CapCut-like sticker workflow on the existing visual-object / motion stack.

Hermes / agent: work from `/opt/joy-media/repo`. Deploy web after STEPs that change UI.

## STEPs

- [x] **P15.1** Header icon groups + export-preset dropdown; dockview **v5** creative stack; `DEFAULT_WORKSPACE` includes `transitions`; DESIGN.md §4c/§4e
- [x] **P15.2** Real image pixels via OPFS → `StickerImageCache` → Monitor/export bitmaps (alpha)
- [x] **P15.3** Assets **Add as sticker** → `image.create` + Spike clip + `joy.clipObjects` binding (replaces hardcode for new stickers)
- [x] **P15.4** Inspector crop UI + crop applied in sticker decode; Motion/Effects follow `resolveObjectIdForSelection`
- [x] **P15.5** Remove BG: Assets button queues `image.comfy` / RemBG when Worker has `image.comfy`; honest disable otherwise; `joy.imageMatte` map for alpha mattes
- [x] **P15.6** Docs: this runbook + STATE handoff; deploy immutable web release

## Smoke gate

1. Register a PNG/WebP in Assets (this browser OPFS).
2. **Add as sticker** → select clip → Inspector/Motion see the object → apply Pop In.
3. Monitor shows real pixels (not gray 100×100) when OPFS bytes exist.
4. Remove BG disabled without GPU Worker; enabled + queues job when `image.comfy` Worker paired.

## Non-goals

Brush masks, blend modes, marketplace sticker packs, free-transform gizmos, Spike image clip kinds.
