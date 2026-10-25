# Windows Sandbox lifecycle acceptance, 2026-10-26

Scope: the v1.0.3 candidate installer, run in disposable Windows Sandbox sessions. Sequence A runs v1.0.1 install, upgrade to v1.0.3, smoke, repair, rollback and uninstall. Sequence B runs a fresh v1.0.3 install, smoke and uninstall. Nothing was installed on the host. Raw logs and the run folder are kept outside the repository.

## Inputs

| Item                                                      | Value                                                                                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| App code built from                                       | `98505dfa`                                                                                                                                           |
| Guest and smoke supervisor from                           | `0420ced4` (identical to the repository files at that commit)                                                                                        |
| Candidate setup `joy-media-setup.exe`                     | SHA-256 `3e3af2e7f03cdffb8ff45d721b38c62dfbbc69c0c3c9e580580b34350321e222`                                                                           |
| Candidate archive `joy-media-windows-x64-v1.0.3.zip`      | SHA-256 `155183bd435e6b96ac6b7af1bf883e548b4bd84f5bd8f2d2f983adb8731f4053`                                                                           |
| Previous release v1.0.1 (pinned in the lifecycle harness) | setup `3f5fbe853de04a24aac22a46e28dd661cc1a80a2a6c5a1fa383fcd9ab3efde04`, archive `21be785e26c0d06cadba40929ada839cfd24345f17b828cdb735d4eff056a88c` |
| Sandbox                                                   | Windows 11 Pro 10.0.26100; Windows Sandbox 10.0.26100.1; networking off, GPU off                                                                     |

## Results

| Sequence                                                              | Steps | Passed | Failed |
| --------------------------------------------------------------------- | ----- | ------ | ------ |
| A: v1.0.1 install, v1.0.3 upgrade, smoke, repair, rollback, uninstall | 19    | 19     | 0      |
| B: fresh v1.0.3 install, smoke, uninstall                             | 8     | 8      | 0      |

Each sequence ran in one sandbox session, which was closed after its evidence was written. No launch was retried.

What each step verified:

- **Installed-file integrity:** every installed file matches its SHA-256 in the manifest after install, upgrade, repair and rollback.
- **Shortcuts:** the Desktop and Start Menu shortcuts exist after each install.
- **Registry:** the uninstall key shows the installed version, and is removed by uninstall.
- **CLI launchers:** `joy --version` and `joy-media --version`, each run in a fresh shell whose PATH is rebuilt from the registry, report the installed version.
- **PATH:** after the upgrade the user PATH holds only the `bin` folder. After uninstall neither the install root nor `bin` remains.
- **Temporary profile cleanup:** no smoke profile folder is left in the temp folder after any smoke run.
- **Leftover files:** after uninstall the install folder, the uninstall key and both shortcuts are gone.

## Smoke supervision

Both candidate smoke runs were supervised. The supervisor removed the profile on the first attempt, about 5 ms after the app exited, and no owned process was still running at that point. The previous release has no supervisor, so its smoke runs create no profile that the check can see.

## Not qualified by this run

- **GPU:** the Sandbox has no GPU. The GPU process exits with code 34 during smoke in both the previous and the candidate builds. That is an environment result, not a hardware qualification result.
- **Owned-process stop path:** it is covered by unit tests only. No owned process was still running after exit in these runs.
- **Rollback:** a rollback is the candidate's own uninstall, which keeps the user's data, followed by the previous setup. Running the previous setup over an installed candidate cannot remove the `bin` PATH entry, because that setup does not know the entry. A kept previous version is planned under L1.
