---
name: joy-code-cuts-and-motion
description: Use when a user asks for a scoped rough cut, a transition at an existing junction, or bounded motion on an identified object.
---

# Cuts and Motion

1. Resolve selected clip IDs, source ranges, track, time base, actual junction and the duration of both adjacent clips. Resolve an existing object and supported property before proposing keyframes.
2. Use the registered `build-rough-cut` recipe for a scoped rough cut when its availability is `available`. The registered `motion-and-transition-polish` recipe is unavailable in the current editor runtime because composition capture is not wired. For a direct transition operation, read `presets` and use a listed ID only when it includes `transition.addAtJunction`. Current Joy Code aliases are `dissolve` → `gl:fade`, `wipe` → `gl:wipeLeft` and `slide` → `gl:Directional`.
3. Treat `joy:dipToBlack` as an editor catalog item: the current Joy Code preset lookup does not expose a runnable operation for it. The design's 8–12 frame Chapter Break is a design target until the host lists it as runnable. For a proposed dissolve, target 6–10 frames at 30 fps, convert through the actual project frame rate, and keep duration within both source clips and the compiler's bounds. Keep a straight cut if the transition does not fit.
4. Use `transition.addAtJunction` for a verified adjacent pair. Use `motion.setKeyframe` only for host-supported bindings and values. Product Focus (scale 0.98→1.00 over 280 ms) is a design target; do not claim a motion preset can execute it.
5. Preview the frames before, at and after the edited junction or motion bounds. Verify no negative duration, clip overrun, off-track edit or unexpected audio cut using evidence the host provides. Recheck the revision and stage one edit for approval.
