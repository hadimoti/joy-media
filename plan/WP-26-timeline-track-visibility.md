# WP-26 — Timeline track visibility UX

**Status:** in-progress · **Scope:** local editor UX only; no deploy or runtime-data changes.

Implemented locally: shared `visible` presentation semantics for Main Timeline,
Dual Lens Time View, and Motion Studio’s `TimelineCanvas`; eye/eye-off controls
with Hide/Show accessibility copy; one schema-backed
`property.setTrackEnabled` command path; and coordinated 168px gutter/header
geometry. TS measurements and the scoped CSS variable both use the exact
168px source; focused render, context-menu, Motion Studio, and engine coverage
are included.

**Live gate:** open for owner browser verification at the main Timeline and Dual
Lens Time View. Do not commit, push, or deploy from this worktree until that
verification is accepted.
