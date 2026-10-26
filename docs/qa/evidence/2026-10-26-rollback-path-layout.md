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

The setup was built with `build-installer.ps1` from a payload packaged earlier the same day. The installer code was current, but
that payload's CLI bundle predates the `update` command, so this candidate's shipped CLI has no `update` command. This
candidate is therefore not a build from current source. See "Candidate correction" below:
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

## Candidate correction (2026-10-26)

The two refusal checks added to the guest (the shipped CLI refuses a manifest changed after signing, and a manifest signed
by no pinned key) failed on `be7a636a` with `Unknown command "update"`. The payload's CLI bundle predated the `update`
command. The rollback and fresh-install steps above still hold for the installer on `be7a636a`. They do not show the update
commands, and the section above should not be read as a build from current source.

A current-source candidate was then built from the working tree (commit `41f8431d` for the product code): the worker,
editor, desktop and CLI were built, `package-installer.mjs` packaged the payload, and `build-installer.ps1 -Version 1.0.3`
built the setup. The shipped bundle carries the update markers.

## Current-source candidate results

Setup `00266d301c68a52c8f4d3defea9fa1160613b28a24d6e7b04057491bbe7f91d0` (202,472,960 bytes), built from `41f8431d`. Three
Sandbox runs of both sequences have completed, and a fourth is in progress.

- Installer steps pass in every run: install, upgrade, PATH layout, fresh shell (`joy-media` and `joy` report 1.0.3), repair,
  kept rollback, upgrade again, file-held refusal, uninstall, and the fresh install.
- Both shipped-CLI refusals pass from the second run on, after the check accepts the CLI's wording: a manifest changed after
  signing, and a manifest signed by no pinned key. Both print "This build trusts no release key, so the manifest cannot be
  verified."
- Open: the candidate's renderer smoke times out after 5 minutes in every sequence (after upgrade, after the refused update,
  and on fresh install). The previous version's smoke passes in the same run.

What the guest's watch files show, sampled every 10 seconds for the five minutes:

- The app process is alive, with about 0.1 seconds of CPU for the whole run.
- No smoke profile folder is created, so the stall happens before the app's smoke setup.
- Its 18 threads stay in system waits (user-request and event-pair waits).
- Windows records no hang or crash event for the process.
- Local runs of the same build finish in about 1 second, both with the network refused by proxy and with the GPU disabled. The
  stall has not been reproduced outside the Sandbox.

A fourth run wrote Chromium's startup log for each smoke launch. Every candidate log is empty, while the previous version's log
has its first browser-startup lines. A stock Electron 44.3.0 probe, with no JOY Media code and the same Sandbox configuration,
reached ready within six seconds and logged normally. So the stall is specific to the candidate's launch, not to Electron in the
Sandbox. The next probe runs the candidate's standalone build from a mapped folder, to separate the build from its installation.
