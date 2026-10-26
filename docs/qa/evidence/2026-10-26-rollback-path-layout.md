# Rollback PATH layout: installer fix and its Windows Sandbox evidence, 2026-10-26

## Defect

A rollback moved the install folders back to the restored version but left the user PATH alone. The installer adds the
`bin` folder to PATH from version 1.0.3 on. Versions 1.0.1 and 1.0.2 list the install root instead. After a rollback to
either older version, PATH pointed at `bin`, a folder that version does not have, so `joy-media` and `joy` were not
found from a new shell.

## Fix

- `apps/desktop/installer/Setup.cs` (commit 58943380): `SetUserPathLayout(installPath, binLayout)` lists the folder the
  restored version uses and removes the other. `RollbackSync` calls it right after the folder swap. If the PATH update
  throws, the folder swap is undone and the error names the cause. The registry is written once, so a failed write
  leaves PATH unchanged.
- `tests/desktop/sandbox/sandbox-lifecycle-guest.ps1` (commit c94efe62): the kept-previous rollback asserts that the
  user PATH lists the folder the restored layout needs and no longer lists the other one.
- `tests/desktop/windows-lifecycle.ps1` (commit 58943380): the CI lifecycle uses the same kept-previous rollback, asserts
  the layout, and runs the held-file refusal and the shipped-CLI refusals.

## Windows Sandbox evidence, candidate `be7a636a`

The setup was rebuilt from the current source with `build-installer.ps1` from the payload of the 2026-10-26 candidate:
`joy-media-setup.exe`, 202,989,056 bytes, SHA-256 `be7a636aa8e1e7f576cec04424c7839ed07f95c6236428375a482bf51a095d32`.
The payload archive is `joy-media-windows-x64-v1.0.3.zip`, SHA-256 `07feb241dc263f42ef996ac0ffe9d7dbac5cc26f6ff249d5da4e45becacb4e03`.
The previous release was taken from a local verification folder and matched its pins before the run: setup
`3f5fbe853de04a24aac22a46e28dd661cc1a80a2a6c5a1fa383fcd9ab3efde04`, archive
`21be785e26c0d06cadba40929ada839cfd24345f17b828cdb735d4eff056a88c`, `SHA256SUMS.txt`
`a7b933f44ec82edd2f166dcde0bb013e1febd0ebbd19aa42dd49ac8e05adfe32`. The run folder is outside the repository and holds a
`run-summary.json` for both sequences.

| Sequence                                                                                            | Steps | Passed | Failed |
| --------------------------------------------------------------------------------------------------- | ----: | -----: | -----: |
| previous-upgrade-rollback (1.0.1 → 1.0.3 → kept rollback → upgrade → held-file refusal → uninstall) |    23 |     23 |      0 |
| fresh-candidate (fresh install → fresh shell → uninstall)                                           |     8 |      8 |      0 |

What the run verified:

- Version 1.0.1 registers the install root on the user PATH, as before this change.
- After the upgrade to 1.0.3 the PATH holds only `bin`.
- The rollback to the kept 1.0.1 restores its files and registration, and the PATH lists the install root and no longer
  lists `bin` ("PATH follows the restored layout"). This is the behaviour the fix changes.
- The restored 1.0.1 app starts and passes its renderer smoke.
- An upgrade again is refused while a file is held open, with the in-use message; the installed and kept versions are
  unchanged; the candidate still starts.
- The candidate uninstaller removes the folder, the uninstall key, both shortcuts and both PATH entries.
- A fresh install puts only `bin` on the PATH, and a fresh shell runs `joy-media --version` and `joy --version`, each
  reporting 1.0.3.
- No smoke profile and no worker process remained after any smoke run.

What this run does not cover:

- `/restore-data` and the database snapshot. The Sandbox profile has no database, so the snapshot path is untested.
- The CI lifecycle (`tests/desktop/windows-lifecycle.ps1`) runs these same steps only in the exact-candidate gate. Those
  steps have parsed, but they have not been executed.
- The release folder's `SHA256SUMS.txt` still lists the setup built from `3d6d9510`. It must be regenerated before any
  packaging step relies on it.

## Reproduce

```bash
node tests/desktop/sandbox/sandbox-run.mjs --out <run folder outside the repository> \
  --candidate-setup apps/desktop/dist/releases/joy-media-setup.exe \
  --candidate-standalone apps/desktop/dist/joy-media-win32-x64 \
  --candidate-version 1.0.3 \
  --previous-setup <joy-media-setup.exe for 1.0.1> \
  --previous-zip <joy-media-windows-x64-v1.0.1.zip> \
  --previous-version 1.0.1
```

A pass means both sequences report `failed: 0` in `run-summary.json`.
