# JOY Media self-hosted CI

JOY Media's GitHub-hosted Actions minutes are exhausted and cannot be
purchased from Iran, so the repository CI runs entirely on owner-
controlled self-hosted runners. Every workflow job in `.github/workflows/`
must target a self-hosted label tuple; no job may use `ubuntu-latest`,
`windows-latest`, `macos-latest`, or any other GitHub-hosted label. The
contract is enforced offline by
`tooling/release/src/ci-runner-policy.test.ts` and the runner Dockerfile
/ entrypoint / registration-token handling is locked down by
`tooling/release/src/ci-runner-contract.test.ts`.

## Self-hosted runner inventory

The active self-hosted runners are Linux Docker containers hosted by the owner-controlled PC. The Windows-Docker runner was retired in P5 because its isolated Windows lane and acceptance evidence producer are no longer part of the release plan. The Linux lanes remain available through WSL2 Ubuntu-24.04 Docker Engine.

| Runner                    | Labels                                       | Where it runs                                                   | Source of truth                                                     |
| ------------------------- | -------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| `joy-media-ci-linux`      | `self-hosted,linux,x64,joy-media-ci`         | PC WSL2 Docker Linux container (`ops/self-hosted/linux-runner`) | `ops/self-hosted/linux-runner/{Dockerfile,entrypoint.sh,README.md}` |
| `joy-media-ci-acceptance` | `self-hosted,linux,x64,joy-media-acceptance` | PC WSL2 Docker Linux container (separate runner volume)         | `ops/self-hosted/acceptance-runner/README.md`                       |

No runner registration token is committed, logged, or persisted inside a
long-running container. The Linux `entrypoint.sh` accepts the token only at
`--configure-only` time and refuses to write it anywhere.

## Current runners

- Repository: `hadimoti/joy-media`
- Linux container runners (`joy-media-ci-linux`, `joy-media-ci-acceptance`):
  built from `ops/self-hosted/linux-runner/Dockerfile`, tagged with the
  digest-pinned image `sha256:4012f99f4599e7bac1214da9c8c00ef6e04cb02ca673618884334d35ac4a5d53`,
  running as uid `1001` (`joyci`), with Node `v22.14.0`, pnpm
  `11.15.0`, FFmpeg/FFprobe, PostgreSQL client, MinIO `mc`, and the
  system libraries required by headless Chromium; all downloaded
  binaries are hash-verified.
- The Windows-Docker runner and its Windows acceptance lane were retired in P5.

## Workflow policy

The runner policy is enforced by two offline test suites:

- `tooling/release/src/ci-runner-policy.test.ts` scans every file under
  `.github/workflows/` and asserts (a) no job uses `ubuntu-latest`,
  `windows-latest`, `macos-latest`, or any other hosted label, and (b)
  every job targets exactly one of the self-hosted Docker labels in the
  table above. Adding a hosted label, or pointing a job at a label that
  is not declared under `ops/self-hosted/`, fails this test before any
  CI minute is consumed.
- `tooling/release/src/ci-runner-contract.test.ts` locks down the
  Dockerfile / entrypoint / registration-token handling for the Linux
  (`ops/self-hosted/linux-runner/`) contract: digest-pinned base
  images, SHA-256-pinned runner / Node / MinIO binaries, the dedicated
  non-login runner user, the absence of any path that would echo or
  persist `RUNNER_TOKEN`, and the explicit
  `--configure-only` / long-running `run.sh` split.

`.github/workflows/ci.yml` runs on explicit `workflow_dispatch` (and is
superseded by `ci-dev.yml` for the developer feedback loop). Neither
runs untrusted pull-request code on the self-hosted runners.

```powershell
pnpm install --frozen-lockfile
pnpm run verify:ci
pnpm build
pnpm exec playwright install chromium
pnpm exec playwright test tests/e2e --project=desktop-primary --workers=1
```

Run `pnpm run release:gate` locally only when the orchestrator has already recorded the required
source-bound browser evidence for that exact revision; a clean checkout cannot manufacture that
authenticated evidence.

The push workflow currently has two jobs:

1. `check` runs typecheck, lint, tests, builds, and the production dependency audit.
2. `browser-e2e` builds the app and runs the three desktop Playwright projects serially on the trusted Linux runner.

The source-bound `pnpm run release:gate` is intentionally run by the orchestrator only after
authenticated live-browser evidence has been recorded for the exact candidate revision. It is not
run by the basic push jobs, because a clean CI checkout cannot legitimately claim an authenticated
production journey. These jobs are green source/browser checks, not final release proof. The
disposable E2E API harness uses a high request ceiling so a long single-owner browser run does not
cascade into unrelated `429` failures; transport rate-limit behavior remains covered by the API
security tests. Secrets must never be written to logs or artifacts.

The trusted push workflow also serializes superseded `main` runs with a GitHub Actions
`concurrency` group and gives each browser matrix job its own API port, editor port, HTML report
directory, and Playwright output directory derived from the GitHub run identity. This keeps reruns
and parallel trusted runners from reusing stale ports or overwriting another matrix leg's traces.

## Linux real-services runner (owner-controlled WSL2 Docker Engine)

The Linux lane is provisioned on the owner-controlled Ubuntu-24.04 WSL2 Docker
Engine; it is not installed on the Sweden production VPS. The repository-scoped
runner `joy-media-ci-linux` is registered with labels `self-hosted`, `linux`, `x64`,
`joy-media-ci`, runs as uid `1001` (`joyci`), and uses the digest-pinned image
`sha256:4012f99f4599e7bac1214da9c8c00ef6e04cb02ca673618884334d35ac4a5d53`.
The image contains Node `v22.14.0`, pnpm `11.15.0`, FFmpeg/FFprobe, PostgreSQL
client tools, MinIO `mc`, and the system libraries required by headless Chromium;
all downloaded binaries are hash-verified.

The runner containers use WSL host networking because the WSL Docker bridge has
a reproducible external TLS/API timeout on this PC. The runner image and
service setup are restart-safe; the workflow rechecks runner registration and
PostgreSQL/MinIO health as separate fail-closed gates before every real-services
run. These are local-only WSL host services (not Internet-published ports):

- PostgreSQL 17 image digest `sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929`
  (`joy-media-ci-postgres`, persistent named volume).
- MinIO image digest `sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`
  (`joy-media-ci-minio`, persistent named volume).

The current PC uses synthetic CI-only database/S3 credentials from runner-local
environment files; they are not production credentials and are not copied to
logs, artifacts, or Gbrain. The workflows must consume these values from the
runner environment rather than embedding defaults in the repository. The
legacy `r2-candidate.yml` path now follows that rule as well.
`JOY_MEDIA_CI_RELEASE_COMMAND` points at the checked-out
`ops/self-hosted/linux-runner/release-real-services.sh`, which creates and
unconditionally drops a run/schema and bucket namespace.

The acceptance runner `joy-media-ci-acceptance` is a separate repository-scoped
Linux runner with its own runner volume and labels `self-hosted`, `linux`, `x64`,
`joy-media-acceptance`. On this PC it uses the same WSL host network and the
runner-local environment points at MinIO on `localhost:9000`; it does not share
the runner volume or checkout with `joy-media-ci-linux`.
It is configured for the isolated real-services lane with
`JOY_MEDIA_CI_ACCEPTANCE_PROFILE=real-services`,
`JOY_MEDIA_CI_ACCEPTANCE_WORKER=disposable`, and the executable
`ops/self-hosted/linux-runner/real-service-acceptance.sh` command. Its database
and MinIO settings are runner-local only; it has no OpenCLI profile, owner
cookies, or production credentials. A local runtime check recorded the Linux
runners online and idle; this is an observation, not a durable state guarantee.
WSL2 may stop an idle distribution,
so the operator must verify `wsl -l -v`, the Docker daemon, and the GitHub
runner inventory immediately before dispatching a gate.

## Release-candidate lanes

The closure plan requires a separate, manually dispatched release workflow before promotion. It runs twice on the exact candidate SHA and uses repository-scoped Linux Docker runners:

- `self-hosted`, `linux`, `x64`, `joy-media-ci`: isolated Linux real-services lane (PostgreSQL 17, S3-compatible storage, migrations, tenant/project isolation, queue/lease/cleanup, provider idempotency, export, and rollback compatibility).
- An isolated acceptance runner: disposable API/editor services plus a disposable Worker identity. Automated browser checks use fixture credentials only and never receive the owner's cookies or OpenCLI profile.

The current PC inventory has two Linux Docker runners. The Windows-Docker runner was retired in P5 because its isolated Windows lane and evidence producer were removed. There is no host-direct fallback and no VPS runner fallback; if a local daemon or its labeled container is unavailable, the workflow queues/fails rather than consuming a different runner.

The manually dispatched `.github/workflows/release-candidate.yml` is the executable contract for
those lanes. Supply the full candidate SHA; it runs two exact passes for each lane. The Linux
runner must provide `JOY_MEDIA_CI_DATABASE_URL`, `JOY_MEDIA_CI_S3_HEALTHCHECK_URL`, and an
executable `JOY_MEDIA_CI_RELEASE_COMMAND` that creates a unique PostgreSQL/S3 namespace and
unconditionally tears it down. The acceptance runner must set
`JOY_MEDIA_CI_ACCEPTANCE_PROFILE=real-services`,
`JOY_MEDIA_CI_ACCEPTANCE_WORKER=disposable`, and must not expose
`JOY_MEDIA_OPENCLI_PROFILE`.
These values are runner-local configuration, never repository secrets or committed files.

After the fixture matrix, the same workflow runs a separate `real-service-acceptance` job twice
on the isolated acceptance runner. That job is deliberately fail-closed: it requires
`JOY_MEDIA_CI_ACCEPTANCE_PROFILE=real-services`,
`JOY_MEDIA_CI_ACCEPTANCE_WORKER=disposable`, and an executable runner-local
`JOY_MEDIA_CI_REAL_ACCEPTANCE_COMMAND`. The command receives
`<candidate-sha> <run-id> <run-attempt> <pass>` and must provision disposable authenticated
services/Worker state, exercise all seven desktop profiles, run the bounded performance observer,
and emit only redacted, candidate-bound evidence at
`test-output/browser/journeys.json`, `test-output/release-performance/{polling,effects-soak,timeline-integrity,editor}.json`,
`test-output/delivery/result.json`, `test-output/windows/acceptance.json` (the separate
operational Worker lifecycle evidence), and
`test-output/operations/restore.json`. The job then runs `pnpm run release:gate` against that
evidence, so a green fixture matrix cannot be mistaken for real-service release proof. The
acceptance harness must never use `JOY_MEDIA_OPENCLI_PROFILE`, owner cookies, production
credentials, or a production bucket.

Every release lane must generate a unique run ID, namespace its database/schema, object prefix,
ports, projects, Worker state, and temporary paths, and unconditionally tear them down. Retain only
redacted summaries, manifests, hashes, SBOM, signatures, and provenance. Never upload `.env`, DB
dumps/URLs, Worker state, pairing/session material, user media, owner auth state, or unredacted
logs. CI schedules and verifies; Codex primary owns promotion, deployment, live browser checks,
canary, and rollback.

The workflow does not upload GitHub artifacts by default: artifact storage is separate from runner
minutes. If a release lane later uploads evidence, it must be the minimal sanitized set above.

## Windows-platform acceptance was retired in P5

P5 retired the Windows-Docker runner and the `windows-acceptance` release-gate check with it. The release workflows no longer schedule Windows runner jobs or require Windows-platform evidence. The separate `evidence.windows` field remains part of operational real-service lifecycle evidence; it describes the Worker lifecycle and is not Windows-platform acceptance.

## v2 release-candidate self-hosted CI

`.github/workflows/release-candidate-v2.yml` is the proposed successor to `release-candidate.yml`,
dispatched manually with a full 40-character candidate SHA. It runs the same lane inventory
described above, but encodes the clean-state repeat explicitly as two in-workflow passes per
matrix lane and restructures the browser viewport matrix so each pass stays inside its lane's
timeout budget. It depends on the same `self-hosted` runners (`joy-media-ci`,
`joy-media-acceptance`) and on the same runner-local env vars
(`JOY_MEDIA_CI_RELEASE_COMMAND`, `JOY_MEDIA_CI_REAL_ACCEPTANCE_COMMAND`,
`JOY_MEDIA_CI_EVIDENCE_ROOT`).

### Durable evidence root

Both the real-service and P3 lanes write redacted, checksum-verified evidence outside the
checkout and the runner's `_work`/`_temp` to the path supplied by `JOY_MEDIA_CI_EVIDENCE_ROOT`
(sibling directory of `JOY_MEDIA_CI_EVIDENCE_ROOT/` for the real-service lane,
`JOY_MEDIA_CI_EVIDENCE_ROOT/p3/` for the P3 lane). The namespace is
`$JOY_MEDIA_CI_EVIDENCE_ROOT/$CANDIDATE_SHA/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-p<pass>`
for the real-service lane and
`$JOY_MEDIA_CI_EVIDENCE_ROOT/p3/$CANDIDATE_SHA/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-p<pass>`
for the P3 lane. Each pass writes a `MANIFEST.sha256`/`MANIFEST.json` pair,
re-verifies every file against the manifest, and is required to satisfy the
`Verify retained evidence` step in addition to any teardown check. The durable store is
authoritative evidence regardless of platform artifact state.

### Local preservation at `<owner-drive>\VPS-DATA`

The v2 evidence directory is mirrored to a local Windows host at `<owner-drive>\VPS-DATA` (the operator's
preservation path on the same Windows host the runner sits on). `<owner-drive>\VPS-DATA` holds the
durable evidence across runs so the operator can inspect, hand off, or rotate evidence
without leaving the Windows host. The mirror is a copy, not a substitute for the runner's
authoritative `JOY_MEDIA_CI_EVIDENCE_ROOT`.

### VPS Gbrain metadata

A subset of Gbrain metadata (run identity, candidate SHA, pass, evidence root layout,
upload-policy receipt, and the names of the retained evidence files) is also retained on
the production Sweden VPS so Gbrain can correlate the v2 run with the corresponding
orchestrator run history. The VPS Gbrain metadata is index-only; it never owns the
authoritative evidence bytes. Operator-only buckets apply; never assume the public
gh-pages index now reflects v2 runs.

### v2 artifact upload policy

v2 does not call `actions/upload-artifact` or `actions/download-artifact`. Both the
real-service and the P3 pass instead write an `ARTIFACT-UPLOAD-STATUS.txt` receipt into
their durable evidence directory with the fields `candidate_sha`, `run_id`, `attempt`,
`pass`, `upload_outcome=disabled`, `source=durable-evidence-store`, and
`reason=github-artifact-upload-disabled-by-policy`. The upload-policy unit test in
`tooling/release/src/ci-artifact-policy.test.ts` asserts that contract directly against
`release-candidate-v2.yml`. GitHub-hosted Actions minutes/quota is still exhausted on the
GHA side; v2 keeps running entirely on the self-hosted runner set and does not depend on
GitHub artifact quota being repaired.

## Re-registering a runner

If the Docker image or runner volume is replaced, create a short-lived registration token with GitHub CLI (do not save it in the repository) and follow `ops/self-hosted/linux-runner/README.md`. A native runner directory must not be used: the old host-direct label is retired.

```powershell
gh api --method POST repos/hadimoti/joy-media/actions/runners/registration-token
```

Registration tokens expire quickly and must not be committed or pasted into issue comments.

## Health checks

```powershell
gh api repos/hadimoti/joy-media/actions/runners --jq '.runners[] | {name,os,status,busy,labels:[.labels[].name]}'
```

The Linux runner must be `online` before dispatching a release workflow. If it is offline, repair the runner or run the checks locally; do not switch CI to the production VPS.

## Latest verified runs

On 2026-08-30 UTC, workflow-dispatch exact-SHA run `33288503169` verified documentation-inclusive
commit `6a6384596e74ef24137483639fa47f3d4110d900` on both passes for all three
release lanes. Linux real services, the clean Windows Worker, and isolated acceptance
all completed successfully; each acceptance pass ran 56 desktop-primary journeys
(55 passed, 1 intentional skip), removed runner-temp Playwright outputs, and ended
with a clean checkout. This is the candidate gate for the promotion step below.

On 2026-08-30 UTC, release-candidate run `33287852067` verified commit
`570c8d3b38cd2e9e1a2cad980c4a30a78e5339a2` on both exact passes for all three
release lanes. Both Linux real-service passes completed the source, migration,
PostgreSQL/S3 namespace, export, and clean-teardown checks. Both clean Windows
Worker passes built and self-tested the Worker package/executable with a clean
profile. Both isolated acceptance passes completed 56 desktop-primary journeys
(55 passed, 1 intentional skip each), including Effects, Inspector, timeline,
3D/Joy Code, Worker, animated export, and reload paths; both removed their
Playwright output directories and ended with clean checkouts. This is fully green
release-candidate evidence for that documentation-inclusive SHA; production
promotion and the authenticated live canary remain orchestrator-owned steps.

On 2026-08-30 UTC, the earlier release-candidate run `33285506563` verified commit
`41b024a677b29131ffd0868f7449bceb591f4bbe` on both Linux passes. Each pass
completed the full source gate (typecheck, lint, format, 414 test files / 3,608
tests, build, and production audit), ran the real Postgres migration smoke,
created and removed a DNS-safe MinIO bucket, uploaded candidate provenance, and
finished with a clean checkout. At that time the two Windows jobs were queued
because no accepted Docker Windows runner existed; the run was cancelled and
acceptance did not start. This is historical Linux evidence only; the
Windows-Docker lane was retired in P5.

The earlier self-hosted run `33282484240` passed on `main` at commit
`c514e5efdc24080e042450499eab75c74aebef81`: `check`, `browser-e2e`
(`desktop-minimum`, `desktop-primary`, and `desktop-compact`), and
`worker-package` all completed successfully before P5 retired that Windows
package lane. The run is historical and does not describe the current runner
inventory.
