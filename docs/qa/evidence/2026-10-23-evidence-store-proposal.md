# Cross-runner evidence store: current state and proposal (2026-10-23)

Status: proposal only. Nothing in this document has been provisioned, and no infrastructure was changed.
The owner must choose an option before any runner or workflow configuration changes.

## What was verified (read-only, 2026-10-23)

- The Windows lane `windows-worker-clean` runs on the labels `self-hosted, windows, x64, joy-media-worker-docker`.
  On this PC that runner is the Docker container `joy-media-worker-docker` (Windows image).
- The container has no mounts (`docker inspect`: `Mounts` is empty), and its environment does not define
  `JOY_MEDIA_WINDOWS_EVIDENCE_ROOT`.
- The retention step in `.github/workflows/release-candidate-v2.yml` (line 661) throws when that variable is
  empty. On this runner the step therefore fails closed today.
- The Linux gate `gate-summary` runs on the labels `self-hosted, linux, x64, joy-media-acceptance`. Its runner is
  documented as a Docker container on this PC (`docs/SELF-HOSTED-CI.md`). No `joy-media-ci*` container exists now.
- The Docker Desktop engine is in Windows-container mode (`OSType=windows`). Linux containers and their volumes are
  not visible from this engine. The volume `joy-media-ci-evidence` named in
  `docs/reviews/joy-media-ci-evidence-store-2026-09-08.md` is not listed by `docker volume ls` here.
- The SMB share `JoyShared` exposes `E:\`. No container mounts it, and no Linux client is known to mount it.
- The renderer bundle already moves between runners through `actions/upload-artifact` (workflow line 198) and
  `actions/download-artifact` (line 377). The evidence upload outcome is recorded as
  `reason=github-artifact-upload-disabled-by-policy`, and the design note says GitHub storage can be unavailable for
  6 to 12 hours after cleanup.

Conclusion: no transport moves the Windows lane's retained bytes to the Linux gate today. Shared storage is not proven,
and the Windows retention step fails closed until a store is configured.

## Options

| Option | Transport                                                                                                            | What must be provisioned                                                                    | Main risk                                                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A      | Host folder (for example `E:\joy-media-ci-evidence`) bind-mounted into the Windows container and into the Linux gate | Recreate `joy-media-worker-docker` with the bind mount; run the Linux gate on the same host | The Windows and Linux engines cannot run together in Docker Desktop, so the gate needs an engine switch or a native runner |
| B      | Same host folder read by a native WSL2 Linux runner at `/mnt/e/...`                                                  | A WSL2 runner registration with label `joy-media-acceptance`                                | A new runner to operate; no container is involved                                                                          |
| C      | Remote store on the VPS over the existing SSH host alias, append-only directory                                      | Directory, write-only key for the Windows lane, read-only key for the gate                  | Writes to production infrastructure; needs approval                                                                        |
| D      | GitHub Actions artifact, as the renderer bundle already uses it                                                      | Nothing new                                                                                 | Quota outages block it; the upload is best-effort, so the gate must fail closed when it is missing                         |

## Recommendation

Option A or B, with a digest anchor. Both keep the bytes on one physical disk and need no external service.

1. The Windows lane writes the retained tree with the write-once module (`tooling/release/src/retain-release-artifacts.mjs`).
   The module hashes every file, refuses an existing run folder with a non-recursive `mkdir`, and removes a partial
   copy on failure.
2. The workflow publishes the manifest's SHA-256 and the file list as job outputs of `windows-worker-clean`.
3. The Linux gate runs `--verify-only` against the store, re-hashes every file, and compares each digest with the job
   output. A mismatch, a missing file, an extra file, or an unreadable store fails the gate.

The job-output anchor is the part that does not depend on the store. An operator who edits the store after retention
changes a digest the gate does not trust.

Known limitation: NTFS and ext4 do not enforce write-once here. The module enforces it in software, and the anchor
detects later edits. It does not prevent them.

## Verification plan (before any provisioning)

1. Stand-in store: a directory under the scratchpad. Run retention, verification, a tampered file, a missing file, an
   extra file, a second write for the same run, and a store inside the checkout. The unit tests already cover most of
   these; they run with `pnpm exec vitest run tooling/release/src/retain-release-artifacts.test.ts`.
2. Connectivity and permissions, after the path is chosen: write from the Windows container, read from the Linux
   gate, and check the permissions in both directions.
3. Read-back integrity: compare the SHA-256 of each file read by the Linux gate with the manifest and with the job
   output.
4. Failure behavior: unmount or rename the store and confirm the gate fails closed rather than passing.

## Decisions needed from the owner

1. Choose option A, B, C or D as the authoritative store. (Option D cannot be authoritative while uploads are
   best-effort.)
2. Approve the configuration change for the chosen option: a container recreation (A), a runner registration (B), or
   a VPS directory and keys (C).
3. Approve the workflow change that publishes the digests as job outputs.
4. Approve the values of `JOY_MEDIA_WINDOWS_EVIDENCE_ROOT` and `JOY_MEDIA_CI_EVIDENCE_ROOT` in the runner environments.

Until these decisions are made, the release gate stays closed and no candidate is frozen.
