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

The current GitHub runner inventory has only the trusted Windows `joy-media-ci` runner. It is
online and is sufficient for the push checks above, but it is not a Linux real-services runner and
does not satisfy the Worker label or clean-profile release lane. Do not point these jobs at the
production Sweden VPS. Provision an isolated WSL2 Ubuntu runner (or disposable Linux VM) and a
dedicated Windows Worker runner before dispatching the release workflow; until then the release
gate must remain NO-GO.

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
