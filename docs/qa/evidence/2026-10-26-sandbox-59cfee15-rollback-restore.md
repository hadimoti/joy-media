# Windows Sandbox lifecycle on candidate 59cfee15: rollback restores the database and the exact install tree, 2026-10-26

Scope: supporting evidence for the v1.0.3 candidate built from commit `59cfee15`. **Not a gate receipt.** The owner-gated release
gate runs `tests/desktop/windows-lifecycle.ps1` on the CI toolchain. This run used the Windows Sandbox guest
(`tests/desktop/sandbox/sandbox-lifecycle-guest.ps1`), which carries the same rollback checks.

## What the run checks

- The kept-previous rollback runs the candidate setup with `/rollback /restore-data` (plan 3.1, D5).
- **The database:** the upgrade snapshots the v1.0.2 database into `backups/pre-update-1.0.2`. Before the rollback, the guest
  appends a fixed block of bytes to the restored database while the application is closed, so the file differs from the snapshot.
  After the rollback, the database must equal the snapshot byte for byte. The step fails if the database did not differ before the
  rollback, because an identical restore would prove nothing.
- **The install tree:** a hash of every file's relative path and SHA-256 is taken before the upgrade, while the v1.0.2 install is
  the only one. After the rollback the tree must hash the same, so a stray candidate file or a lost v1.0.2 file fails the step.
- The same two checks are in `tests/desktop/windows-lifecycle.ps1` (the owner-gated CI lifecycle). There they are parse-checked only,
  because that script runs only in the release gate.

## Candidate

- Built from commit `59cfee15` with `pnpm build`, `pnpm run package:installer` (in `apps/desktop`) and
  `build-installer.ps1 -Version 1.0.3`. The release packager (`package:release`) refuses to package without the pinned release keys,
  which is the intended behaviour, so this candidate came from the installer path.
- `joy-media-setup.exe`: SHA-256 `3dc8beb91dd33f205f6c6a386f886c7ff93c63a425bdd6d275ae3ebe1efcb451`, version 1.0.3.
- Previous release v1.0.2: setup `6d8089…`, matching the published `SHA256SUMS.txt`.

## Result (the fourth run, which is the one reported here)

| Sequence                  | Passed | Failed |
| ------------------------- | -----: | -----: |
| previous-upgrade-rollback |     25 |      0 |
| fresh-candidate           |      8 |      0 |

`failedSteps` is 0. The rollback step reports: "the database is the pre-update snapshot and the install tree matches v1.0.2; the
database differed from the snapshot before the rollback: yes". The fresh-candidate sequence passes 8 of 8, including the fresh shell
checks for `joy-media --version` and `joy --version`.

## How the restore check was built (three earlier runs in the same session)

1. First run, before the rollback checks existed: 25 of 25 and 8 of 8.
2. Second run, with the restore and tree checks: both passed, but the database was already identical to the snapshot before the
   rollback, so the restore was not really exercised. The guest now reports that difference, and the third run showed "no".
3. Third run, with the same checks: 25 of 25 and 8 of 8, but still "no".
4. Fourth run: the guest appends the marker before the rollback and fails if no difference is made. The result is "yes", and the
   restored file matches the snapshot.

## What this does not establish

- It is not a gate receipt, and the CI lifecycle copy of the checks has not run.
- The database change is a simulated write of a fixed block of bytes. It does not run the application's own schema migration, so
  it proves the restore mechanism, not the migration path.
- The signed-update positive path needs the owner's release key, which does not exist yet (D2).
