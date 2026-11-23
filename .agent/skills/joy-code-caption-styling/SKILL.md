---
name: joy-code-caption-styling
description: Use when a user asks to restyle existing captions for readability, Persian or Arabic text, portrait video, or timed word emphasis.
---

# Caption Styling

1. Resolve the selected caption document and segments, language, frame dimensions, current style, safe area and word timing. Keep the transcript, cue timing and burn-in setting as they are.
2. Choose an existing catalog ID: `joy-clean` for general dialogue; `joy-rtl-classic` for Persian or Arabic; `joy-karaoke-pop` only when reliable word timing and user-requested word emphasis are both present. Read the `presets` context before selection when the current catalog is uncertain.
3. Use `caption.setTemplate` only when the live host advertises the operation for the selected target. The registered `title-and-caption-polish` recipe is unavailable in the current editor runtime because RTL-text readback is not wired. Its native presets set a style reference; the additional designer tuning below is not a separate runnable Joy Code operation:
   - `joy-clean`: 4.5% of frame height, 1.30 line spacing, centered, white on `#0A0E1A` at about 78% opacity, 10% safe-area insets, at most 2 lines.
   - `joy-rtl-classic`: 4.2% of frame height, 1.45 line spacing, logical start alignment, warm white `#FAF0DC`, 12% insets, at most 2 lines. Its native plate is unset.
   - `joy-karaoke-pop`: 5.5% of frame height, 1.25 line spacing, centered, active word `#E9B949`, black plate at about 63% opacity, 8% horizontal and 12% vertical insets, at most 3 lines.
4. Preview a long cue and a cue over busy footage. Inspect clipping, overlap, visible punctuation, Arabic dotted yeh, Persian dotless yeh, ZWNJ and intact left-to-right URLs where present. Use a rendered check only when the host supplies the preview evidence.
5. Stage one scoped edit for approval, then report the style ID and preview scope. Recheck the project revision before approval.

**Design-only target:** Vertical Tutorial proposes 54 px text, an 82% `#10141C` plate and a 9:16 placement at 9% side and 18% bottom inset. No native caption template ID currently maps to this target; describe it as a suggestion for editor review.
