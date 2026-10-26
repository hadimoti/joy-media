# Windows Sandbox lifecycle on the rebuilt candidate, with v1.0.2 as the previous release, 2026-10-26

Scope: supporting evidence for the v1.0.3 candidate built from commit `63999fa7`. **Not a gate receipt.** The gate's lifecycle
(`tests/desktop/windows-lifecycle.ps1`) runs on the CI toolchain, in the owner-gated release gate. This run used the committed
harness and lifecycle script unchanged. Their previous-release pins now name v1.0.2, which the owner approved this round.

## Candidate

- `apps/desktop/dist/releases/joy-media-setup.exe`: SHA-256 `68b7e7011fae01ba84531dfd32d9ae84a45c4caada4f2f3214ffdcf69ffa69bf`
  (202,644,480 bytes). Compiled by `apps/desktop/installer/build-installer.ps1` from the payload staged in the same build.
- Portable archive `joy-media-windows-x64-v1.0.3.zip`: SHA-256 `177d968ee78967613082aee42ea4c74630e11fe73a74894296aa945866a44e6c`.
- Standalone folder `apps/desktop/dist/joy-media-win32-x64`, rebuilt in the same run.
- `package-installer.mjs` stages the payload and the archive but does not compile the setup executable. The executable still had the
  hash of an earlier build (`a369df53…`) until `build-installer.ps1` was run for this candidate. The setup tested here is the one
  that script compiled from this payload.

## Previous release: the published v1.0.2 files

- `joy-media-setup.exe` SHA-256 `6d8089467afaecc1d78d272f5c029d6c186a81f7aac90a7cd584045e847bdabe`, which matches the pinned value
  and the published `SHA256SUMS.txt`.
- `joy-media-windows-x64-v1.0.2.zip` SHA-256 `e59ee15f2f881cd6620ad59e9f1d9fdc4f9b82efaf221f4e6041c079978d59ca`, also matched.

## Result

| Sequence                                                                                                                                                                                           | Passed | Failed |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | -----: |
| previous-upgrade-rollback: install 1.0.2, PATH check, smoke, upgrade to 1.0.3, fresh shells, repair, kept rollback to 1.0.2, upgrade again, held-file refusal, two shipped-CLI refusals, uninstall |     25 |      0 |
| fresh-candidate: fresh install, PATH check, fresh shells, smoke, uninstall                                                                                                                         |      8 |      0 |

`failedSteps` is 0. The renderer smoke passed on 1.0.2, on 1.0.3 after the upgrade, after the kept rollback, after the refused update,
and on the fresh install. `joy-media --version` and `joy --version` report 1.0.3 from a fresh shell. The run summary is kept outside
the repository, in the session scratch folder.

## What this does not establish

- It is not a gate receipt (see the note at the top).
- The renderer smoke starts the application and checks that the renderer loads. It does not open `File > Settings…` or check for
  updates. The Settings > Updates dialog is covered by unit tests only.
- The positive signed-update path is not covered. The owner's release key has not been generated (D2).
- The database snapshot and `/restore-data` are not covered, because the Sandbox profile holds no data.
