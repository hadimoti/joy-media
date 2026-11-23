---
name: joy-code-titles-and-lower-thirds
description: Use when a user asks for an opener, title, quote, speaker name and role, lower third, or end slate.
---

# Titles and Lower Thirds

1. Resolve the target interval, exact supplied copy, language, frame size and caption area. Ask one focused question if copy, target or timing is ambiguous enough to change the edit.
2. Read the live `presets` context and choose a native text-template ID. Useful defaults are `clean-title` for a concise LTR opener, `rtl-editorial-title` for RTL, `name-role` for an LTR lower third and `rtl-name-role` for an RTL lower third. The RTL templates use `Vazirmatn Variable` and logical start alignment.
3. Use `text.insertTemplate` with the exact supplied content and interval for a new title. Use `text.setContent` or `text.setTemplate` only for a resolved existing text object and when the host advertises that operation. The registered `title-and-caption-polish` recipe is unavailable in the current editor runtime because RTL-text readback is not wired. The title templates have native styling; the design targets below do not override their stored values:
   - Editorial Opener: 72 px at 1080 px frame height, warm white, one brief phrase and 10% side inset.
   - Speaker Name and Role: 48 px name, 31 px role, restrained amber and 8% side inset.
4. Preview the first readable frame and longest line. Check the text stays within the frame and above the subtitle area. For RTL or mixed-script copy, inspect the rendered preview; ask the user to confirm any shaping or line break that the host cannot verify.
5. Stage one scoped change for approval. Recheck the project revision before approval and report the exact template ID, copy and interval.

**Design-only targets:** `Product Reveal` refers to the existing content-template ID `joy.product-card`, but Joy Code's `text.insertTemplate` accepts IDs from the text-template catalog. It does not execute that content template. A 280 ms reveal is also a design target until supported keyframe timing and preview evidence are available.
