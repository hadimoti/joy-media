# Sandbox lifecycle with v1.0.2 as the previous release, 2026-10-26

Scope: the plan's previous version for the v1.0.3 lifecycle is v1.0.2 (track D). The committed Sandbox harness and the gate's
lifecycle script still pin v1.0.1. This run used the published v1.0.2 release as the previous version, so the upgrade path a
user takes from the published release has Sandbox evidence.

**Not a gate receipt.** The gate's lifecycle (`tests/desktop/windows-lifecycle.ps1`) runs on the CI toolchain and still pins
v1.0.1. Moving the gate's pins to v1.0.2 is a release-gate change, and it needs the owner's approval.

## Previous release: verified against the published release

- Local folder `JOY_Media_v1.0.2_candidate_7f2b826d`: `joy-media-setup.exe` SHA-256
  `6d8089467afaecc1d78d272f5c029d6c186a81f7aac90a7cd584045e847bdabe`, and `joy-media-windows-x64-v1.0.2.zip` SHA-256
  `e59ee15f2f881cd6620ad59e9f1d9fdc4f9b82efaf221f4e6041c079978d59ca`.
- Both match the published `SHA256SUMS.txt` of release v1.0.2, which was downloaded on its own (433 bytes). The other three
  published files also match, and every asset size equals the published size.

## Candidate

- `apps/desktop/dist/releases/joy-media-setup.exe`: SHA-256
  `a369df5383fe204352bd71de153fc7cf2b92386e1f794d9d92d3dc65a9a2a78e` (202,499,072 bytes), built after `0da4e880`.
- Its standalone build matches the candidate manifest of the release-trust run: `joy-media.exe`, the CLI bundle and
  `joy-worker.exe`.

## Harness

- A scratch copy of `sandbox-run.mjs`, the guest runner, `disposable-environment.ps1`, `smoke-supervisor.mjs` and
  `windows-lifecycle.ps1`. Only the previous-release pins in the scratch `windows-lifecycle.ps1` were changed, to the v1.0.2
  setup, checksums and archive hashes. The committed scripts are unchanged and still pin v1.0.1.
- The run folder is outside the repository. `run-summary.json` was generated at 04:32 UTC.

## Result

| Sequence                                                                                                                                                                               | Passed | Failed |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | -----: |
| previous-upgrade-rollback: 1.0.2 install, PATH check, smoke, upgrade to 1.0.3, fresh shells, repair, kept rollback to 1.0.2, upgrade again, held-file refusal, two refusals, uninstall |     25 |      0 |
| fresh-candidate: fresh install, PATH check, fresh shells, smoke, uninstall                                                                                                             |      8 |      0 |

The lifecycle transitions, as the Sandbox run records them:

- `installPrevious` (1.0.2): registration, shortcuts and files match. The app starts and passes its renderer smoke on 1.0.2.
- `upgradeCandidate` (1.0.3): passes. PATH holds only `bin`, and a fresh shell reports 1.0.3 for `joy-media` and `joy`.
- `repairCandidate`: passes. A removed CLI bundle is restored.
- `rollbackToKeptPrevious`: passes. The install is rolled back to 1.0.2, 1.0.3 is kept beside it, PATH follows the restored
  layout, and the app starts on 1.0.2.
- `updateRefusedWhileFileHeld`: passes. The installed and kept versions are unchanged, and the candidate still starts.
- `tamperedUpdateRefused`: passes. The shipped CLI refuses a manifest changed after signing.
- `wrongKeyManifestRefused`: passes. The shipped CLI refuses a manifest signed by no pinned key.
- `uninstall`: passes. The folder, key, shortcuts and both PATH entries are gone.

## What this does not establish

- It is not a gate receipt. See the note at the top.
- `userDataPreserved` and the database snapshot path (`/restore-data`) are not covered. The Sandbox profile holds no data.
- The positive signed-update path is not covered. The owner's signing key has not been generated (D2).
