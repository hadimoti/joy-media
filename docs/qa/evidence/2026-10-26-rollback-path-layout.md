# Rollback PATH layout: installer fix and its verification state, 2026-10-26

## Defect

A rollback moved the install folders back to the restored version but left the user PATH alone. The installer adds the
`bin` folder to PATH from version 1.0.3 on. Versions 1.0.1 and 1.0.2 list the install root instead. After a rollback to
either older version, PATH pointed at `bin`, a folder that version does not have, so `joy-media` and `joy` were not
found from a new shell. The CI lifecycle would have caught this only in the exact-candidate gate.

## Fix (commit 58943380)

- `apps/desktop/installer/Setup.cs`: `SetUserPathLayout(installPath, binLayout)` lists the folder the restored version
  uses and removes the other. `RollbackSync` calls it right after the folder swap. If the PATH update throws, the folder
  swap is undone and the error names the cause. The registry is written once, so a failed write leaves PATH unchanged.
- `tests/desktop/sandbox/sandbox-lifecycle-guest.ps1`: the kept-previous rollback asserts which PATH entry the restored
  layout needs, and that the other entry is gone.
- `tests/desktop/windows-lifecycle.ps1`: the CI lifecycle uses the same kept-previous rollback, asserts the layout, and
  runs the held-file refusal and the shipped-CLI refusals.

## What was verified

| Check                                                                       | Result                                                                                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `csc.exe` compile of `Setup.cs` (C# 5, the build's own compiler)            | exit 0                                                                                                                       |
| Installer build from the current source, `build-installer.ps1`              | rebuilt `joy-media-setup.exe`, 202,989,056 bytes, SHA-256 `be7a636aa8e1e7f576cec04424c7839ed07f95c6236428375a482bf51a095d32` |
| Installer contract test (`installer-setup-contract.test.mjs`)               | passes, including the new PATH-layout assertion                                                                              |
| PowerShell parse, `windows-lifecycle.ps1` and `sandbox-lifecycle-guest.ps1` | both parse                                                                                                                   |
| Sandbox launcher tests (`sandbox-run.test.mjs`)                             | 15 of 15                                                                                                                     |
| Windows Sandbox run of the kept-previous rollback on the fixed installer    | NOT RUN (see blockers)                                                                                                       |
| CI lifecycle run of the same steps                                          | NOT RUN (runs only in the exact-candidate gate)                                                                              |

The previous Sandbox evidence (`2026-10-26-kept-previous-sandbox.md`, sequence A 23 of 23, sequence B 8 of 8) was
recorded on candidate `3d6d9510`, which predates this fix. It does not show PATH behaviour after a rollback.

## Blockers to the Sandbox run

1. The pinned previous release must be on disk before the launcher starts. The v1.0.1 assets are
   `joy-media-setup.exe` (198,102,016 bytes) and `joy-media-windows-x64-v1.0.1.zip` (198,085,736 bytes). Both
   downloads failed mid-transfer this session (74.7 MB and 4.3 MB received, "unexpected EOF"). Retrying large
   downloads on this network risks the connection drops the owner is investigating, so no further attempt was made.
   The pinned hashes are `3f5fbe853de04a24aac22a46e28dd661cc1a80a2a6c5a1fa383fcd9ab3efde04` (setup) and
   `21be785e26c0d06cadba40929ada839cfd24345f17b828cdb735d4eff056a88c` (archive). `SHA256SUMS.txt` matched its pin.
2. The release folder's `SHA256SUMS.txt` still lists the setup built from `3d6d9510`. The new setup was built into the
   same folder, which the build script guards against. The launcher hashes the candidate directly, so the run is not
   affected, but the folder's checksum file is stale until it is regenerated.

## Next command, once the two v1.0.1 files download and match their pins

```bash
node tests/desktop/sandbox/sandbox-run.mjs --out <run folder outside the repository> \
  --candidate-setup apps/desktop/dist/releases/joy-media-setup.exe \
  --candidate-standalone apps/desktop/dist/joy-media-win32-x64 \
  --candidate-version 1.0.3 \
  --previous-setup <path to joy-media-setup.exe 1.0.1> \
  --previous-zip <path to joy-media-windows-x64-v1.0.1.zip> \
  --previous-version 1.0.1
```

A pass means sequence A reports `failedSteps: 0`, including the kept-previous rollback step. That step now also asserts
that the user PATH lists the install root and no longer lists `bin` after the rollback to 1.0.1. The guest does not run
a fresh-shell command after the rollback, so that behaviour is not covered by this run.
