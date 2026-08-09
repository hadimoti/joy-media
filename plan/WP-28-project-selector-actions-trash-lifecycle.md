# WP-28 — Project Selector Actions and Trash Lifecycle

## Status

Implemented and live on 2026-08-09.

## Delivered

- Always-visible 32px three-dot action trigger on every project card.
- Accessible Rename, Duplicate, and Move to Trash menu with click-away, Escape,
  keyboard focus return, and viewport-safe positioning.
- Rename and Duplicate dialogs with blank-name validation and deterministic copy
  naming (`copy`, `copy 2`, …), success feedback, and copy-first sorting.
- Persistent Trash view with count, Restore, and exact-name permanent deletion.
- Local project lifecycle service covering catalog metadata, creative-document
  duplication, ID rewriting, fresh history/jobs/exports/conversations, and
  target-only cleanup.
- Server lifecycle integration with revision-aware rename/duplicate/trash/
  restore/purge operations, active-job guards, and reconciliation before purge.

## Verification

- Product commits: `65cbbd9`, `0f4d23b` (both pushed to `origin/main`).
- API release: `65cbbd9-project-actions`.
- Editor release: `editor-web-20260809-1730-0f4d23b-project-actions`.
- Signed-in Chromium smoke: menu, Rename + refresh persistence, Duplicate,
  Trash, Restore, permanent deletion, and empty final Trash all passed.
- Responsive checks: `1024×768` and `1366×768` passed; browser console empty.
- Focused lifecycle/catalog/API tests, typecheck, lint, and API/editor builds
  passed. The full suite retains the pre-existing RNNoise model fixture failure
  (`RNNoise model missing: /opt/joy-media/data/rnnoise/cb.rnnn`).

## Rollback and cleanup

The previous immutable API/editor releases remain available for rollback. Two
temporary smoke projects were removed permanently after verification; no audit
objects remain in Trash.
