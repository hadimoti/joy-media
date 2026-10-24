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

## Addendum 2026-10-25: corrected facts and recommendation

Read-only checks on 2026-10-25 change three statements above.

- **Both engines run at once.** The Linux runner containers `joy-media-ci-linux` and `joy-media-ci-acceptance` run under a separate Docker engine inside the WSL Ubuntu distribution, next to the Windows-mode Docker Desktop engine that runs `joy-media-worker-docker`. The note that the two engines cannot run together does not hold on this PC. They still share no storage.
- **Each Linux runner already has its own store.** Both set `JOY_MEDIA_CI_EVIDENCE_ROOT=/opt/joy-media-evidence`, backed by a named volume per container (`joy-media-ci-linux-evidence`, `joy-media-ci-acceptance-evidence`). `gate-summary`, `real-service-acceptance` and `p3-real-services` run on the acceptance runner, and `linux-real-services` runs on `joy-media-ci-linux`. The Windows container has no evidence variable and no evidence volume.
- **Options A and B conflict with the runner contracts.** `ops/self-hosted/windows-runner/provision.ps1` rejects host bind mounts ("Volume must be a Docker named volume"), and the Linux runner README requires a named volume per container. A host folder shared by both engines would need an exception to both contracts and would expose a host path to workflow code.

The gate cannot be satisfied by verifying on the Windows side. `create-readiness-evidence.mjs` reads the installer bytes from `test-output/readiness/artifacts` on the gate runner and checks them against `SHA256SUMS.txt` and the digests in the two Windows lifecycle receipts. The bytes have to reach the acceptance runner.

Existing tests close the two simplest transports. `gate.test.ts` requires the Windows lane to contain no `actions/upload-artifact` or `actions/download-artifact`, and `ci-artifact-policy.test.ts` allows exactly one upload and one download in the whole workflow (the editor bundle). The policy came from the September 2026 quota incident, when the repository was private. It is public now, and the quota probe has passed since 2026-10-18.

Recommendation: **Option D, narrowed.** Move only the staged Windows release artifacts (the seven files and `artifact-manifest.json`) from the Windows lane to the gate as a one-day artifact. The gate downloads it, runs the retention module in retain mode into its own store, and the existing verify-only step, receipt digests and `SHA256SUMS.txt` checks stay as they are. This needs no change to any runner, keeps the independent re-hash on the gate runner, and keeps the write-once store as the authority for everything after the hand-off. It requires the owner to relax the two tests deliberately: one more named upload and download pair, scoped to the Windows release artifacts, with the rest of the policy unchanged. The trade-off is that an unreleased, unsigned candidate installer is downloadable from the run page for one day by anyone signed in to GitHub.

Option C (a write-only directory on the VPS over SSH) keeps the bytes private but writes to production infrastructure and adds a key to the runner. Options A and B need the contract exceptions above and a recreation of both containers.

## Outcome 2026-10-25: narrowed Option D, implemented

The owner approved Option D on 2026-10-25, strictly as a cross-runner transport, and accepted that the unsigned candidate binaries are downloadable from the run page while the artifact lives.

- **Windows lane.** One `actions/upload-artifact` step uploads `test-output/release-artifacts` (the seven release files and `artifact-manifest.json`) as `joy-media-windows-release-<run>-<attempt>-<candidate SHA>`, with `retention-days: 1` and `if-no-files-found: error`. The per-runner `JOY_MEDIA_WINDOWS_EVIDENCE_ROOT` retention step is gone.
- **Gate.** `gate-summary` downloads that artifact from the same run only, with no run id, repository or token. `retain-release-artifacts.mjs` hashes the downloaded files against the manifest and `SHA256SUMS.txt`, checks the manifest names this candidate, run and attempt, writes them once into the acceptance runner's store and re-verifies them there. The existing verify-only step then re-reads the store copy, and the new `--restore-to` mode copies the verified files to `test-output/readiness/artifacts`. Before this change nothing placed any bytes there, so the readiness builder had no input.
- **Receipts.** The readiness builder checks the restored bytes against `SHA256SUMS.txt` and the first receipt's digests, and it fails unless both Windows receipts carry identical digests, container and image.
- **Tests.** Only `ci-artifact-policy.test.ts` forbade a second artifact pair, and its one test now names exactly the two allowed pairs, with `gate-summary` allowed one download and no upload. New tests pin the artifact name, one-day retention, same-run download, step order, and the read-only token. The `--restore-to` mode has its own tests. Reverse mutations (a `run-id` on the download, a longer retention, a dropped restore step, an upload in the gate, an artifact name without the attempt) each fail a test.
- **Not decided here.** Pruning of the acceptance runner's evidence volume, which now holds about one release set per run.
