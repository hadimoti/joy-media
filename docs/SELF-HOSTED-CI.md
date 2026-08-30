# JOY Media self-hosted CI

JOY Media's GitHub-hosted Actions minutes are exhausted, so the repository CI uses a dedicated self-hosted Windows runner. The runner is intentionally separate from the production VPS and is labeled `joy-media-ci`.

## Current runner

- Repository: `hadimoti/joy-media`
- Runner name: `joy-media-ci-windows`
- Labels: `self-hosted`, `windows`, `x64`, `joy-media-ci`
- Work directory: `C:\actions-runner-joy-media\_work`
- Startup: the `JOY Media Self-Hosted CI Runner` Scheduled Task starts `run.cmd` at the interactive user's logon
- Toolchain: Node 22, pnpm 11.15.0, ffmpeg/ffprobe, and Playwright Chromium

The runner must stay on a trusted development/CI host. Never register the production VPS as a general-purpose runner: a runner can execute repository workflow code and can retain credentials or workspace data.

## Workflow policy

`.github/workflows/ci.yml` runs on `push` to `main` and on explicit `workflow_dispatch`. It does not run untrusted pull-request code on this runner. Before merging a branch, run the same checks locally:

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
Linux runner on network `joy-media-acceptance`, with its own runner volume and
labels `self-hosted`, `linux`, `x64`, `joy-media-acceptance`. It sets only
`JOY_MEDIA_CI_ACCEPTANCE_PROFILE=fixture-only` and has no OpenCLI/browser
profile or production credentials. Both Linux runners are currently online and
idle; query the inventory with the health-check command below.

## Release-candidate lanes

The closure plan requires a separate, manually dispatched release workflow before promotion. It
must run twice on the exact candidate SHA and use repository-scoped runners with these labels:

- `self-hosted`, `linux`, `x64`, `joy-media-ci`: isolated Linux real-services lane (PostgreSQL 17,
  S3-compatible storage, migrations, tenant/project isolation, queue/lease/cleanup, provider
  idempotency, export, and rollback compatibility).
- `self-hosted`, `windows`, `x64`, `joy-media-worker`: clean-profile Worker/package lane. A GPU
  result uses the additional `gpu` label; CPU and GPU evidence are retained separately.
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
`JOY_MEDIA_CI_WORKER_PROFILE=clean`; the fixture-only acceptance runner must set
`JOY_MEDIA_CI_ACCEPTANCE_PROFILE=fixture-only` and must not expose `JOY_MEDIA_OPENCLI_PROFILE`.
These values are runner-local configuration, never repository secrets or committed files.

Every release lane must generate a unique run ID, namespace its database/schema, object prefix,
ports, projects, Worker state, and temporary paths, and unconditionally tear them down. Retain only
redacted summaries, manifests, hashes, SBOM, signatures, and provenance. Never upload `.env`, DB
dumps/URLs, Worker state, pairing/session material, user media, owner auth state, or unredacted
logs. CI schedules and verifies; Codex primary owns promotion, deployment, live browser checks,
canary, and rollback.

The workflow does not upload GitHub artifacts by default: artifact storage is separate from runner
minutes. If a release lane later uploads evidence, it must be the minimal sanitized set above.

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

On 2026-08-30 UTC, the exact-SHA rerun `33288503169` verified documentation-inclusive
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
Playwright output directories and ended with clean checkouts. This is the first
fully green release-candidate evidence for the current candidate SHA; production
promotion and the authenticated live canary remain orchestrator-owned steps.

On 2026-08-30 UTC, the earlier release-candidate run `33285506563` verified commit
`41b024a677b29131ffd0868f7449bceb591f4bbe` on both Linux passes. Each pass
completed the full source gate (typecheck, lint, format, 414 test files / 3,608
tests, build, and production audit), ran the real Postgres migration smoke,
created and removed a DNS-safe MinIO bucket, uploaded candidate provenance, and
finished with a clean checkout. At that time the two `joy-media-worker` jobs were
queued because no runner had that label; the run was cancelled and acceptance did
not start. This is retained as historical Linux evidence; the dedicated Worker
runner has since been provisioned and the fully green run `33287852067` above is
the current release-candidate evidence.

The earlier self-hosted run `33282484240` passed on `main` at commit
`c514e5efdc24080e042450499eab75c74aebef81`: `check`, `browser-e2e`
(`desktop-minimum`, `desktop-primary`, and `desktop-compact`), and
`worker-package` all completed successfully. This confirms the Windows
source/browser/package lane is operational; it does not substitute for the
release-candidate clean-profile Worker or acceptance lanes described above.
