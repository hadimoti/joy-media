# WP-26 — Timeline track visibility UX

**Status:** done · **Scope:** local editor UX only; no runtime-data or secret changes.

Implemented locally: shared `visible` presentation semantics for Main Timeline,
Dual Lens Time View, and Motion Studio’s `TimelineCanvas`; eye/eye-off controls
with Hide/Show accessibility copy; one schema-backed
`property.setTrackEnabled` command path; and coordinated 168px gutter/header
geometry. TS measurements and the scoped CSS variable both use the exact
168px source; focused render, context-menu, Motion Studio, and engine coverage
are included.

**Live gate:** closed after browser verification at the pre-closeout live gate,
when `HEAD`, `origin/main`, and `vps-local/main` matched product commit
`5f917b1fca674a909188d0212e07d3ab44d71d86`. The subsequent docs-only closeout
may advance repo refs; the immutable live product remains built from that
product commit and is deployed immutably at
`/opt/joy-media/releases/editor-web-20260809-133945-5f917b1-track-visibility`.
The live symlink resolves to that release. Local/public index SHA-256 is
`a9c4ddcf67e449edbb413a813245bfdb9e417fa26b153426bcbc68fedd403746`; CSS
`index-CvLlghVu.css` SHA-256 is
`e4722f157deee86836da8e75bf2fa0bf7c129d10fd525d19acf178c53dfa6710`.

`nginx -t` and `/api/health` passed. Browser proof: Dual Lens and Main Timeline
both measured a 168px gutter/header with matching client and scroll widths;
lane origins matched the header edge at `x=171.7143` and `x=180.5089`,
respectively. The document measured `1639` client/scroll with no page overflow.
Dual Lens toggled `track-0` from visible/open-eye/Hide to hidden/eye-off/Show,
Main Timeline immediately mirrored it, and restoring from Main synchronized both
back to visible/open-eye/Hide. Browser logs were empty. Final checks passed:
14 focused tests, typecheck, lint, format, editor build, and diff-check.
