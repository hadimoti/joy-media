# Windows Sandbox: kept-previous rollback, held-file refusal and leftover cleanup, 2026-10-26

Scope: the installer change in commit 3d6d9510 (L1 and F2). The setup keeps the version an update replaces, rolls back
to it with /rollback, refuses an update while a file is held, and the uninstaller removes the kept folder. The run
folder is outside the repository. Raw logs are not committed.

## Candidate under test

- Built from commit 3d6d9510 on top of 42d4a06d. The Electron pin in d48bbfdb was applied after the build. The
  resolved Electron version is 44.3.0 in both, so the binaries are the same.
- Setup `joy-media-setup.exe`: SHA-256 `1c93d9c41947f3f1214ede46e9c2691e4dc4ad2796ab4b3701601c92d7023ede`, 202,988,544 bytes.
- Archive `joy-media-windows-x64-v1.0.3.zip`: SHA-256 `07feb241dc263f42ef996ac0ffe9d7dbac5cc26f6ff249d5da4e45becacb4e03`.
- Setup compiled with the .NET Framework csc (C# 5). The payload manifest is embedded in the setup and written beside the archive.
- Previous release v1.0.1, pinned by the lifecycle harness.

## Results

| Sequence                                                                                   | Steps | Passed | Failed |
| ------------------------------------------------------------------------------------------ | ----- | ------ | ------ |
| A: previous install, upgrade, repair, kept-previous rollback, held-file refusal, uninstall | 23    | 23     | 0      |
| B: fresh candidate install, smoke, uninstall                                               | 8     | 8      | 0      |

The launcher reported `failedSteps: 0`.

What sequence A verified, on the candidate and the previous release:

- The upgrade from v1.0.1 keeps v1.0.1 on disk and registers the candidate. Installed files match the manifest.
- Repair restores a removed file, and the kept previous version is left as it was.
- `/rollback` puts v1.0.1 back, its files match the v1.0.1 manifest, the kept candidate sits beside it, and v1.0.1 starts.
- Upgrading again installs the candidate, and the update is refused while a file of the installed version is held open
  without sharing. The installed version and the kept previous version are unchanged, and the candidate still starts.
- The uninstaller removes the install folder, the uninstall key, both shortcuts, both PATH entries, the kept previous
  folder, and any sibling JOY Media folder.
- No smoke profile and no worker process remained after any smoke run.

Sequence B verified a fresh install with the new code path, its PATH and launchers, smoke, and an uninstall that leaves
no sibling folder.

## Not exercised by this run

- The data snapshot and `/restore-data`. The Sandbox profile had no database, so the snapshot was skipped, which is the
  designed behaviour for a fresh profile. The path that finds the data folder from the installed package name is not
  verified on a real profile.
- The release lifecycle (tests/desktop/windows-lifecycle.ps1) does not yet run the kept-previous rollback or the
  held-file refusal. It still uses the older removal-and-reinstall rollback.
- `joy-media update check | verify | rollback` (the CLI) is not built. The signed-manifest transitions
  (tampered and wrong-key refusals) need it, and they need the owner's release key for the positive path.
- Signing with the owner's key is not done. The verifier and the dev-key signing tool are committed (4b0d72e3).

## Reproduce

The launcher is tests/desktop/sandbox/sandbox-run.mjs. Arguments: --out <run folder outside the repository>,
--candidate-setup, --candidate-standalone, --candidate-version, --previous-setup, --previous-zip, --previous-version.
The run opens one Windows Sandbox window per sequence.
