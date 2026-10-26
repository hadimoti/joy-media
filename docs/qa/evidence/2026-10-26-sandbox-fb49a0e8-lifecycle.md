# Windows Sandbox lifecycle on candidate fb49a0e8, 2026-10-26

Development evidence, not a release receipt. The run used the desktop packaged from source commit `fb49a0e8`, the head of
`v1.0.3/no-owner-tracks` when the packaging ran. It supports the plan's lifecycle transitions. It does not replace the exact-candidate
gate, which runs `tests/desktop/windows-lifecycle.ps1` in CI and is owner-gated. The run folder is outside the repository.

## Candidate and previous release

| Item                               | Value                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Source commit                      | `fb49a0e8` (`v1.0.3/no-owner-tracks`)                                                                                   |
| `joy-media-setup.exe`              | SHA-256 `02fefb7da7f83d0a0de7d64f56bb90630656022dfa356fe0a5b073164c327983`, 202,499,584 bytes                           |
| `joy-media-windows-x64-v1.0.3.zip` | SHA-256 `723918a74462a45b2c272998789383036acca290369f79da8d83d86fc7f64185`, 202,364,881 bytes                           |
| Previous setup (v1.0.2)            | SHA-256 `6d8089467afaecc1d78d272f5c029d6c186a81f7aac90a7cd584045e847bdabe`, equal to the pin in `windows-lifecycle.ps1` |
| Previous archive (v1.0.2)          | SHA-256 `e59ee15f2f881cd6620ad59e9f1d9fdc4f9b82efaf221f4e6041c079978d59ca`, equal to the pin                            |

## Result

| Sequence                                                                                                                                                                                    | Steps | Passed | Failed |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | -----: | -----: |
| previous-upgrade-rollback: 1.0.2 install, PATH and smoke, upgrade to 1.0.3, fresh shells, repair, kept rollback to 1.0.2, upgrade again, held-file refusal, shipped-CLI refusals, uninstall |    25 |     25 |      0 |
| fresh-candidate: fresh install, fresh shells, smoke, uninstall                                                                                                                              |     8 |      8 |      0 |

The launcher exited 0, and the run summary records no failed step.

## What the run verified

- Version 1.0.2 registers the install root on the user PATH. After the upgrade to 1.0.3, PATH holds only `bin`.
- The kept-version rollback restores 1.0.2 and keeps 1.0.3 beside it. PATH follows the restored layout. The database is restored to
  the pre-update snapshot, and it differed from that snapshot before the rollback. The install tree matches v1.0.2.
- An upgrade after the rollback succeeds.
- An update is refused while a file is held open. The installed and kept versions are unchanged.
- The shipped CLI refuses a manifest changed after signing, and a manifest signed by a key that is not pinned. These correspond to
  the plan's `tamperedUpdateRefused` and `wrongKeyManifestRefused` transitions, through the verification path the shipped CLI uses.
- The application starts and passes its renderer smoke after the upgrade, after the rollback, after the refused update, and on a
  fresh install. No smoke profile or worker process remains after any smoke run.
- A fresh install puts only `bin` on PATH. A fresh shell runs `joy-media --version` and `joy --version`, and each reports 1.0.3.
- Uninstall removes the folder, the uninstall key, both shortcuts and both PATH entries.

## What this run does not cover

- The positive signed-update path. The pinned release key list (`PINNED_RELEASE_PUBLIC_KEYS_PEM`) is empty. No signed update can
  pass until the owner runs the key ceremony and approves the pin change (decision D2).
- The exact-candidate lifecycle receipt from `tests/desktop/windows-lifecycle.ps1`, which runs in the owner-gated gate.
- Any run on a Hyper-V or ISO-based virtual machine. The owner's decision of 2026-10-26 uses Windows Sandbox instead.
