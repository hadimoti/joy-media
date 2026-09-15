# CI v2 — persistent evidence store

`release-candidate-v2.yml`'s `real-service-acceptance` job requires
`JOY_MEDIA_CI_EVIDENCE_ROOT` — a directory that durably keeps each pass's
redacted, checksum-verified evidence so a **failed** pass's structure survives
the next job's `git clean` and the artifact-storage outage.

## Artifact-quota handling (2026-09-10)

The v2 release workflow still attempts a GitHub Actions artifact upload, but
the upload is best-effort because GitHub account storage can be unavailable
for 6–12 hours after cleanup. The upload step remains visible in the job log
and its outcome is written to each pass's durable evidence directory as
`ARTIFACT-UPLOAD-STATUS.txt`. The redacted, checksum-verified durable store is
the authoritative evidence copy during a quota outage; an upload error is not
silently treated as a source failure.

## PROVISIONED — 2026-09-09 (owner-approved, idle window)

The acceptance runner is a **Docker Desktop** container on the CI host (`docker
info` → `docker-desktop`, Linux). On Docker Desktop a VM bind path is not durable
across a Docker Desktop reset, so a **dedicated named volume** was used (the
proposal's stated alternative "if a host path is undesirable"):

|            |                                                                          |
| ---------- | ------------------------------------------------------------------------ |
| volume     | `joy-media-ci-evidence` (created `docker volume create`)                 |
| mount      | `-v joy-media-ci-evidence:/opt/ci-evidence` on `joy-media-ci-acceptance` |
| env        | `JOY_MEDIA_CI_EVIDENCE_ROOT=/opt/ci-evidence`                            |
| perms      | `750 joyci:joyci` (uid 1001 — the runner)                                |
| backing fs | `/dev/sdd` — **927.9 GB free**                                           |

**How it was applied:** verified all runners `online / busy:false` and zero
in-progress runs; `docker stop` + `docker rm` + `docker run` re-creating
`joy-media-ci-acceptance` with its **exact prior config** (image
`joy-media-ci-linux:2.337.0`, entrypoint, `--restart unless-stopped`, both
networks `joy-media-acceptance` + `joy-media-ci`, the **existing**
`joy-media-ci-acceptance-runner:/opt/actions-runner` mount, and its env via
`--env-file` from `docker inspect` — values never printed) **plus** the evidence
volume and the env var. The env-file was deleted afterwards.

**Verified:**

- The runner reconnected to GitHub **without re-registration** (`.runner`
  persists in the runner volume) — `joy-media-ci-acceptance: online`.
- **Persistence on the exact mount:** a marker file written to `/opt/ci-evidence`
  survived (a) `docker restart`, (b) a full `docker stop` + `docker rm` +
  `docker run` cycle of the acceptance runner, and (c) reads from a **fresh
  unrelated `alpine` container** mounting `joy-media-ci-evidence`. Then removed.
- **Existing mounts / unrelated workloads preserved:** post-change mounts are
  `joy-media-ci-acceptance-runner → /opt/actions-runner` (unchanged) +
  `joy-media-ci-evidence → /opt/ci-evidence` (new); `joy-media-ci-linux`,
  `joy-media-ci-minio`, `joy-media-ci-postgres` all still `Up` / healthy.

The rest of this note is the original analysis / rationale.

## The runner container as it is today

`docker inspect joy-media-ci-acceptance`:

|                             |                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| image                       | `joy-media-ci-linux:2.337.0`                                                                |
| entrypoint                  | `/usr/local/bin/joy-media-linux-runner` (`config.sh --replace` on first run, then `run.sh`) |
| mount                       | **named volume** `joy-media-ci-acceptance-runner` → `/opt/actions-runner`                   |
| runner user                 | `joyci` — uid/gid **1001**                                                                  |
| `/opt/actions-runner` perms | `755 joyci:joyci`                                                                           |
| backing fs                  | `/dev/sdd` — **1006.9 GB total, 31.4 GB used, 924.2 GB free (3 %)**                         |

`joy-media-ci-linux` has its **own** volume `joy-media-ci-linux-runner`; it runs
`linux-real-services` (a lighter smoke) but **not** the `retain-evidence.sh`
step, so only the acceptance runner needs the store.

### What "persistent" has to mean here

| location                                                          | survives job boundary | survives `docker rm` + recreate | survives `docker volume rm` / re-register |
| ----------------------------------------------------------------- | :-------------------: | :-----------------------------: | :---------------------------------------: |
| `/tmp`, `$RUNNER_TEMP` (`_work/_temp`)                            |          ❌           |               ❌                |                    ❌                     |
| a dir in the checkout (`_work/<repo>`)                            |   ❌ (`git clean`)    |               ❌                |                    ❌                     |
| a dir under the runner volume (`/opt/actions-runner/ci-evidence`) |          ✅           |               ✅                | ❌ (shares the runner volume's lifecycle) |
| **a dedicated host bind mount**                                   |          ✅           |               ✅                |      ✅ (not a Docker object at all)      |

"Outside `_work`" alone is **not** persistence — `_work/_temp` is outside the
checkout and still per-job.

## Recommended: a dedicated host bind mount

**Host (CI host, once):**

```bash
sudo mkdir -p /srv/joy-media-ci/evidence
sudo chown 1001:1001 /srv/joy-media-ci/evidence   # joyci
sudo chmod 750 /srv/joy-media-ci/evidence          # runner writes; host root/owner reads
```

**Runner launch** — add one mount to the `docker run` for `joy-media-ci-acceptance`:

```
--mount type=bind,source=/srv/joy-media-ci/evidence,target=/opt/ci-evidence
```

**Runner environment** — set alongside the existing `JOY_MEDIA_CI_*` vars
(`JOY_MEDIA_CI_REAL_ACCEPTANCE_COMMAND`, `JOY_MEDIA_CI_DATABASE_URL`, …):

```
JOY_MEDIA_CI_EVIDENCE_ROOT=/opt/ci-evidence
```

The workflow prereq step fails loudly if the var is unset, if the path is not a
writable directory, or if it resolves inside the checkout / `_work` / `_temp`.

### Why a bind mount over the runner volume

- Survives **everything** short of deleting the host path: container recreation,
  `config.sh --replace` re-registration (only touches `.runner`), `docker volume
prune` / `rm`, `docker system prune -a`.
- The owner inspects it with plain `ls` / `du` / `find` / `tar` on the host — no
  `docker exec`, no `docker run --rm -v … alpine`.
- Independent lifecycle: wiping/rebuilding the runner does not touch evidence;
  pruning evidence does not touch the runner.
- A filesystem quota or a retention cron can be applied to just this path.

**Alternative (Docker-managed):** a dedicated named volume
`joy-media-ci-evidence` → `/opt/ci-evidence`
(`docker volume create joy-media-ci-evidence`, `--mount
type=volume,source=joy-media-ci-evidence,target=/opt/ci-evidence`). Survives
container recreation + re-registration; inspect via `docker run --rm -v
joy-media-ci-evidence:/v alpine …`. Use only if a host path is undesirable.

## Persistence — demonstrated

The focused checks already wrote to `/opt/actions-runner/ci-evidence` (inside the
runner volume, for the test only). A **fresh, unrelated container** reads it:

```
$ docker run --rm -v joy-media-ci-acceptance-runner:/v alpine \
    find /v/ci-evidence -type f
/v/ci-evidence/83daea2f…/9100000001-1-p1/MANIFEST.json
/v/ci-evidence/83daea2f…/9100000001-1-p1/test-output/operations/teardown.json
/v/ci-evidence/83daea2f…/9100000001-1-p1/test-output/browser/journey-failure.json
…
$ docker run --rm -v joy-media-ci-acceptance-runner:/v alpine df -h /v
/dev/sdd  1006.9G  31.4G  924.2G  3%  /v
```

The evidence is in the **volume**, not the acceptance container's writable layer
→ it survives `docker rm joy-media-ci-acceptance` + `docker run`. A bind mount
(the recommendation) is strictly more durable. **The production store is
`/srv/joy-media-ci/evidence`, not the runner volume** — the test path above will
be removed.

## Layout, size, retention

```
$JOY_MEDIA_CI_EVIDENCE_ROOT/<candidateSha>/<runId>-<attempt>-p<pass>/
    MANIFEST.sha256   MANIFEST.json   context.txt   git-status.txt
    test-output/…      (the allowlisted, redacted evidence)
```

- Per pass: ~13 small JSON files + 2 manifests ≈ **50–500 KB**; ~1 MB per gate
  run. 10,000 runs ≈ 10 GB against 924 GB free.
- Retention (optional monthly cron on the host):
  `find /srv/joy-media-ci/evidence -mindepth 2 -maxdepth 2 -type d -mtime +90 -exec rm -rf {} +`
- Nothing here is secret (redaction + a leak-guard run before it lands), but
  `750` keeps it owner-only regardless.
