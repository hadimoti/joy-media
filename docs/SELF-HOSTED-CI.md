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
`sha256:8dd5d2bcdfcebe2948382eff2bf0aff8abc8c20c418dd9bf54de3489bfaade11`.
The image contains Node `v22.14.0`, pnpm `11.15.0`, FFmpeg/FFprobe, PostgreSQL
client tools, and MinIO `mc`; all downloaded binaries are hash-verified.

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

The inventory now has the trusted Windows source runner plus the isolated Linux
real-services and acceptance runners described above. The Windows source runner
is sufficient for push checks, but it is not a clean-profile Worker runner and
does not satisfy `joy-media-worker`. Do not point release jobs at the production
Sweden VPS. A dedicated Windows Worker runner with
`JOY_MEDIA_CI_WORKER_PROFILE=clean` is still required before the release
workflow can be dispatched; until that lane exists, the release gate remains
NO-GO.

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

## Latest verified run

On 2026-08-30 UTC, self-hosted run `33282484240` passed on `main` at commit
`c514e5efdc24080e042450499eab75c74aebef81`: `check`, `browser-e2e`
(`desktop-minimum`, `desktop-primary`, and `desktop-compact`), and
`worker-package` all completed successfully. This confirms the Windows
source/browser/package lane is operational; it does not substitute for the
release-candidate Linux, clean-profile Worker, or acceptance lanes described
above.
