# T-D02 acceptance: product name grep

Card T-D02 (one product name: JOY Media) accepts when the old name only appears where
listed below. Line numbers are as of this change and may move; the file list is the check.

## Command

Run from the repository root (PowerShell or Git Bash):

```sh
rg -n "JOY Studio" apps packages tooling tests
```

Scope is code and tests only. `DESIGN.md`, `docs/`, `plan/`, `docs/release/` and built
output under `dist/` keep the old name as history and are outside this check.

## Allowed remaining hits

- `apps/editor-web/src/project-package.ts` (30, 42): reader compatibility. `LEGACY_PROJECT_PACKAGE_APP` accepts packages written under the old name.
- `apps/editor-web/src/project-package.test.ts` (174–175): test for the reader compatibility above.
- `tooling/release/src/attended-fresh-process.ts` (218–219): release-gate reader accepts the legacy `app` name next to `JOY Media`.
- `tooling/release/src/attended-fresh-process.test.ts` (774–775): test for the release-gate reader compatibility above.
- `apps/editor-web/src/fixtures/old-release-moved-items-package.json` (4): legacy fixture, a real pre-rename package used by the library test. Do not edit.
- `tests/e2e/wp29-r5-batch-b.spec.ts` (19–20, 25, 30): historical test text, comments quoting a retired test (commit `a37448a3`). Rewriting them would misstate history.
- `packages/html-scene-runtime/src/first-party.ts` (1612): gradient-sweep template default subtitle kept as the old name. Saved scenes store only `scenePackageId` and resolve this default at render time, so changing it would change their output. A comment in the template records this. Follow-up: a versioned template change.

Any hit not in this list fails the check. A new hit in user-visible text is a defect
unless it is added here with a reason.
