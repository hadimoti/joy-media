# JOY Media acceptance Linux runner

Labels: `self-hosted,linux,x64,joy-media-acceptance`

The acceptance runner is a SECONDARY Linux Docker self-hosted runner
used only by the isolated real-services acceptance lane of
`release-candidate.yml` / `release-candidate-v2.yml`.

## Self-hosted label

`self-hosted,linux,x64,joy-media-acceptance`

It is intentionally separate from `joy-media-ci` by label, runner volume,
checkout, and job contract so a hung acceptance job cannot starve the primary
verify / gate-summary lanes. On the current PC both Linux runners use the WSL2
host network, so network namespaces are not the isolation boundary; disposable
PostgreSQL/MinIO namespaces, Worker identity, authenticated API state, and
checkout paths must remain unique to the acceptance job.

## Toolchain

Identical to `ops/self-hosted/linux-runner/Dockerfile` (Node 22, pnpm
11.15.0, FFmpeg, PostgreSQL client, MinIO `mc`, Playwright Chromium
system libraries, all hash-verified). Build the same way and register
with `RUNNER_LABELS=self-hosted,linux,x64,joy-media-acceptance`.

## Registration token handling

The registration token is short-lived, supplied at
`docker run --rm … --configure-only`, and never persisted inside the
image, the long-running container, the workflow logs, or the durable
evidence store. See `ops/self-hosted/linux-runner/README.md` for the
identical pattern.

## Gate contract prerequisites

The runner-local operator MUST provision:

- `JOY_MEDIA_CI_ACCEPTANCE_PROFILE=real-services`
- `JOY_MEDIA_CI_ACCEPTANCE_WORKER=disposable`
- `JOY_MEDIA_CI_REAL_ACCEPTANCE_COMMAND` — absolute path to an executable
  harness that creates the disposable PostgreSQL/S3 namespaces, the
  disposable Worker identity, and unconditionally tears them down.
- `JOY_MEDIA_CI_EVIDENCE_ROOT` — a persistent, writable directory
  OUTSIDE the runner's `_work` / `_temp`, where durable redacted
  evidence is retained. For the container, use `/opt/joy-media-evidence`
  backed by a named volume `<container>-evidence` owned by runner uid 1001.
  Never a repository secret or a committed path.

Keep these settings in a root-owned, mode-`0600` env file outside the
repository and pass it with Docker `--env-file`. The service environment also
needs `JOY_MEDIA_CI_DATABASE_URL`, `JOY_MEDIA_CI_S3_ENDPOINT` (scheme, host,
and port only, no userinfo), `JOY_MEDIA_CI_S3_ACCESS_KEY`,
`JOY_MEDIA_CI_S3_SECRET_KEY`, and `JOY_MEDIA_CI_S3_HEALTHCHECK_URL`. Map
`joyminio` to `127.0.0.1` with `--add-host joyminio:127.0.0.1` on the
host-network runner. Do not include environment values in repository files;
the primary Linux runner README documents the Docker invocation pattern.

The acceptance runner MUST NOT have `JOY_MEDIA_OPENCLI_PROFILE`, owner
cookies, production credentials, or a production bucket. The gate
itself rejects any of those as fail-closed.
