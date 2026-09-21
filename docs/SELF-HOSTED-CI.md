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

All runners are provisioned on the owner-controlled Windows PC via
Docker Desktop (Linux containers, plus a documented Windows-container
contract under `ops/self-hosted/windows-runner/Dockerfile.windows`):

| Runner                    | Labels                                                     | Where it runs                                              | Source of truth                                  |
| ------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `joy-media-ci-linux`      | `self-hosted,linux,x64,joy-media-ci`                       | PC Docker Linux container (`ops/self-hosted/linux-runner`) | `ops/self-hosted/linux-runner/{Dockerfile,entrypoint.sh,README.md}` |
| `joy-media-ci-acceptance` | `self-hosted,linux,x64,joy-media-acceptance`               | PC Docker Linux container (separate Docker network)       | `ops/self-hosted/acceptance-runner/README.md`    |
| `joy-media-worker`        | `self-hosted,windows,x64,joy-media-worker`                 | Owner-controlled Windows PC (host-direct, NOT a container) | `ops/self-hosted/windows-runner/{contract.md,worker-acceptance.ps1,README.md}` |
| `joy-media-ci-windows`    | `self-hosted,windows,x64,joy-media-ci`                     | PC Docker Windows-container (`Dockerfile.windows`)         | `ops/self-hosted/windows-runner/Dockerfile.windows` |

No runner registration token is committed, logged, or persisted inside
a long-running container — both `entrypoint.sh` (Linux) and
`windows-runner-entrypoint.ps1` (Windows) accept the token only at
`--configure-only` time and refuse to write it anywhere.

## Current runners

- Repository: `hadimoti/joy-media`
- Linux container runners (`joy-media-ci-linux`, `joy-media-ci-acceptance`):
  built from `ops/self-hosted/linux-runner/Dockerfile`, tagged with the
  digest-pinned image `sha256:fe6a3c657e9d9c7ee0b0c823eeaa2bcecac75041ff104ecc52ab37fc36f97b61`,
  running as uid `1001` (`joyci`), with Node `v22.14.0`, pnpm
  `11.15.0`, FFmpeg/FFprobe, PostgreSQL client, MinIO `mc`, and the
  system libraries required by headless Chromium; all downloaded
  binaries are hash-verified.
- Windows self-hosted runner (`joy-media-worker`): the owner-controlled
  Windows PC running the GitHub Actions runner directly (no Docker
  container). It must have Node 22, pnpm 11.15.0, ffmpeg/ffprobe, and
  Playwright Chromium installed and reachable from the runner account.
- Windows-container runner (`joy-media-ci-windows`): the
  `ops/self-hosted/windows-runner/Dockerfile.windows` contract; not
  currently registered with the repository. It exists so any future
  Windows-only step that does NOT need scheduled tasks or host
  `Win32_Process` enumeration can be added under an honest
  self-hosted-only label.

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
  Dockerfile / entrypoint / registration-token handling for both the
  Linux (`ops/self-hosted/linux-runner/`) and the Windows-container
  (`ops/self-hosted/windows-runner/`) contracts: digest-pinned base
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

The push workflow currently has three jobs:

1. `check` runs typecheck, lint, tests, builds, and the production dependency audit.
2. `worker-package` builds `@joy-media/worker`, packages a temporary `joy-worker.exe`, and runs
   `--joy-worker-self-test`. The output is placed in the runner temp directory so it cannot collide
   with the owner's headless Worker binary; this is a package smoke test, not the clean-profile
   release lane.
3. `browser-e2e` builds the app and runs the three desktop Playwright projects serially on the trusted runner.

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

## Linux real-services runner (owner-controlled Docker Desktop)

The Linux lane is now provisioned on the owner-controlled Docker Desktop Linux
engine; it is not installed on the Sweden production VPS. The repository-scoped
runner `joy-media-ci-linux` is online with labels `self-hosted`, `linux`, `x64`,
`joy-media-ci`, runs as uid `1001` (`joyci`), and uses the digest-pinned image
`sha256:fe6a3c657e9d9c7ee0b0c823eeaa2bcecac75041ff104ecc52ab37fc36f97b61`.
The image contains Node `v22.14.0`, pnpm `11.15.0`, FFmpeg/FFprobe, PostgreSQL
client tools, MinIO `mc`, and the system libraries required by headless Chromium;
all downloaded binaries are hash-verified.

The runner is attached to the private Docker network `joy-media-ci` with
restart-safe, non-published service containers:

- PostgreSQL 17 image digest `sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929`
  (`joy-media-ci-postgres`, persistent named volume).
- MinIO image digest `sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`
  (`joy-media-ci-minio`, persistent named volume).

Database/S3 credentials are generated locally and passed only to the runner
container; they are not repository secrets, logs, artifacts, or Gbrain data.
`JOY_MEDIA_CI_RELEASE_COMMAND` points at the checked-out
`ops/self-hosted/linux-runner/release-real-services.sh`, which creates and
unconditionally drops a run/schema and bucket namespace.

The acceptance runner `joy-media-ci-acceptance` is a separate repository-scoped
Linux runner on networks `joy-media-acceptance` and `joy-media-ci`, with its own
runner volume and labels `self-hosted`, `linux`, `x64`, `joy-media-acceptance`.
It is configured for the isolated real-services lane with
`JOY_MEDIA_CI_ACCEPTANCE_PROFILE=real-services`,
`JOY_MEDIA_CI_ACCEPTANCE_WORKER=disposable`, and the executable
`ops/self-hosted/linux-runner/real-service-acceptance.sh` command. Its database
and MinIO settings are runner-local only; it has no OpenCLI profile, owner
cookies, or production credentials. Both Linux runners are currently online
and idle; query the inventory with the health-check command below.

## Release-candidate lanes

The closure plan requires a separate, manually dispatched release workflow before promotion. It
must run twice on the exact candidate SHA and use repository-scoped runners with these labels:

- `self-hosted`, `linux`, `x64`, `joy-media-ci`: isolated Linux real-services lane (PostgreSQL 17,
  S3-compatible storage, migrations, tenant/project isolation, queue/lease/cleanup, provider
  idempotency, export, and rollback compatibility).
- `self-hosted`, `windows`, `x64`, `joy-media-worker`: clean-profile Worker/package lane. A GPU
  result uses the additional `gpu` label; CPU and GPU evidence are retained separately. The
  Windows acceptance script schedules the normal hidden daemon (not only `--joy-worker-self-test`)
  against a unique loopback control-plane fixture, verifies pairing/hello/lease traffic and
  protected state, then bounds process-tree termination before teardown. The fixture is explicitly
  test-only; production HTTPS validation remains enforced for ordinary startup.
- An isolated acceptance runner: disposable API/editor services plus a disposable Worker identity.
  Any automated browser uses fixture credentials only and never receives the owner's cookies or
  OpenCLI profile `cefd9k77`.

The inventory now has the trusted Windows source runner, the dedicated clean-profile
Worker runner, and the isolated Linux real-services and acceptance runners described
above. The Windows source runner remains the push-check lane; release jobs use the
separate `joy-media-worker` label for clean Worker evidence. Do not point release
jobs at the production Sweden VPS.

The manually dispatched `.github/workflows/release-candidate.yml` is the executable contract for
those lanes. Supply the full candidate SHA; it runs two exact passes for each lane. The Linux
runner must provide `JOY_MEDIA_CI_DATABASE_URL`, `JOY_MEDIA_CI_S3_HEALTHCHECK_URL`, and an
executable `JOY_MEDIA_CI_RELEASE_COMMAND` that creates a unique PostgreSQL/S3 namespace and
unconditionally tears it down. The clean Windows runner must set
`JOY_MEDIA_CI_WORKER_PROFILE=clean`; the acceptance runner must set
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
`test-output/delivery/result.json`, `test-output/windows/acceptance.json`, and
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

## Windows-platform evidence — honest caveat

JOY-Media's full release gate requires Windows-only signals (joy-worker.exe via
Node SEA + postject, and the `worker-acceptance.ps1` fixture that schedules a
hidden daemon against the host task scheduler and walks `Win32_Process`).
Those signals CANNOT be produced inside a Linux Docker container, and they
CANNOT be produced inside a Docker Desktop Windows-container either — a
Server Core container does not see the host's task scheduler or the host's
`Win32_Process` table. So:

- The release-candidate / r2-candidate `windows-worker-clean` /
  `worker-package` jobs target `self-hosted,windows,x64,joy-media-worker`,
  which is the OWNER-CONTROLLED Windows runner running DIRECTLY on the PC
  (no Docker container). It is a self-hosted label; it is NEVER
  `windows-latest` and never consumes a GitHub-hosted Windows VM minute.
- The `windows-worker-clean` evidence record the gate binds from
  (`test-output/windows/acceptance.json`) is tagged in-source with
  `runner: "self-hosted,windows,x64,joy-media-worker"` and
  `execution: "self-hosted-windows-worker"`. The durable evidence store
  and the source-bound release gate (`pnpm run release:gate`) bind those
  tags before accepting the record. A Linux-container run that somehow
  produced a `test-output/windows/acceptance.json` will fail the runner
  label check before it can claim Windows acceptance.
- `ops/self-hosted/windows-runner/Dockerfile.windows` documents the
  Windows-container variant for any future Windows-only step that does
  NOT need scheduled tasks or host `Win32_Process` enumeration. No
  workflow currently targets the `joy-media-ci` (Windows-container)
  label; adding one requires honoring `ops/self-hosted/windows-runner/
  contract.md` and adding the label to the documented allowlist in
  `tooling/release/src/ci-runner-policy.test.ts`.

In short: the JOY-Media release gate's only Windows acceptance signal
comes from the owner-controlled Windows self-hosted runner. There is no
Linux-container evidence ever presented as Windows acceptance.

## v2 release-candidate self-hosted CI

`.github/workflows/release-candidate-v2.yml` is the proposed successor to `release-candidate.yml`,
dispatched manually with a full 40-character candidate SHA. It runs the same lane inventory
described above, but encodes the clean-state repeat explicitly as two in-workflow passes per
matrix lane and restructures the browser viewport matrix so each pass stays inside its lane's
timeout budget. It depends on the same `self-hosted` runners (`joy-media-ci`,
`joy-media-worker`, `joy-media-acceptance`) and on the same runner-local env vars
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

### Local preservation at `H:\VPS-DATA`

The v2 evidence directory is mirrored to a local Windows host at `H:\VPS-DATA` (the operator's
preservation path on the same Windows host the runner sits on). `H:\VPS-DATA` holds the
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

If the host or runner directory is replaced, create a short-lived registration token with GitHub CLI (do not save it in the repository), download the current Windows x64 runner from the official `actions/runner` release, and configure it with the labels above:

```powershell
gh api --method POST repos/hadimoti/joy-media/actions/runners/registration-token
```

Then, from the extracted runner directory, use `config.cmd --unattended --url https://github.com/hadimoti/joy-media --token <short-lived-token> --name joy-media-ci-windows --labels self-hosted,windows,x64,joy-media-ci --work _work --replace` and start it with `run.cmd`. Registration tokens expire quickly and must not be committed or pasted into issue comments.

## Health checks

```powershell
gh api repos/hadimoti/joy-media/actions/runners --jq '.runners[] | {name,os,status,busy,labels:[.labels[].name]}'
Get-ScheduledTask -TaskName 'JOY Media Self-Hosted CI Runner'
```

The runner must be `online` before pushing a release commit. If it is offline, repair the runner or run the checks locally; do not switch CI to the production VPS.

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
finished with a clean checkout. At that time the two `joy-media-worker` jobs were
queued because no runner had that label; the run was cancelled and acceptance did
not start. This is retained as historical Linux evidence; the dedicated Worker
runner has since been provisioned, and runs `33287852067` and `33288503169` above
supersede this historical partial evidence.

The earlier self-hosted run `33282484240` passed on `main` at commit
`c514e5efdc24080e042450499eab75c74aebef81`: `check`, `browser-e2e`
(`desktop-minimum`, `desktop-primary`, and `desktop-compact`), and
`worker-package` all completed successfully. This confirms the Windows
source/browser/package lane is operational; it does not substitute for the
release-candidate clean-profile Worker or acceptance lanes described above.
