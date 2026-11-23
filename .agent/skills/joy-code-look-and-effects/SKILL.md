---
name: joy-code-look-and-effects
description: Use when a user asks for a coherent visual look, a filter, a text backdrop, or a restrained visual effect.
---

# Look and Effects

1. Resolve the target object and read a representative source frame when available. Read the `looks` context for eligible Living Looks and the `presets` context for effect catalog entries.
2. Apply a Living Look only through the separate Living Looks workflow (`look_apply` and its normal prepared preview) when the host exposes it and the target satisfies that Look's constraints. Existing Look IDs are `editorial-clean`, `product-precision`, `kinetic-type`, `quiet-documentary` and `music-pulse`.
3. Existing Effects editor preset IDs include `cinematic-contrast`, `soft-portrait`, `vintage-fade`, `neon-glow`, `clean-product`, `vhs-light`, `bw-punch`, `warm-food`, `cool-tech`, `dreamy-bloom`, `newsprint-portrait`, `bayer-noir`, `lcd-dither`, `topographic-ink`, `field-notes`, `glyph-code`, `matrix-rain`, `symbol-matrix`, `contour-type`, `scatter-poster`, `tone-circles`, `barcode-portrait`, `pixel-melt`, `xerox-punk`, `riso-red` and `pixel-poster`. Their underlying effect IDs include `brightness-contrast`, `hue-saturation`, `vibrance`, `sepia`, `vignette`, `gaussian-blur`, `glow`, `noise`, `bloom`, `pixelate`, `halftone`, `monochrome`, `bayer-dither`, `contour-map`, `glyph-matrix`, `scatter-mosaic`, `posterize`, `tone-geometry`, `pixel-sort` and `color-overlay`.
4. These Effect Studio entries are discoverable for selection, and the preset lookup marks them non-runnable in Joy Code. There is no current canonical Joy Code operation for ordinary filter or effect application. Use Effect Studio for those presets. `Interview Neutral`, `Warm Documentary`, `Readable Backdrop` and `Product Focus` are design targets without native preset mappings. A caption plate in `joy-clean` or `joy-karaoke-pop` styles captions only.
5. Compare the supported preview with the original on the same target. Report which change is prepared through Living Looks and which recommendation needs the editor. Stage supported changes through preview and approval, and refresh stale project context before approval.
