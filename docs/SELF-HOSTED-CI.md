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
pnpm run release:gate
pnpm build
pnpm exec playwright install chromium
pnpm exec playwright test tests/e2e --project=desktop-primary --workers=1
```

The workflow has two jobs:

1. `check` runs typecheck, lint, tests, builds, and the production dependency audit.
2. `browser-e2e` builds the app and runs the three desktop Playwright projects serially on the trusted runner.

The source-bound `pnpm run release:gate` is intentionally run by the orchestrator only after
authenticated live-browser evidence has been recorded for the exact candidate revision. It is not
run by the basic CI jobs, because a clean CI checkout cannot legitimately claim an authenticated
production journey. The workflow does not upload GitHub artifacts: the repository's artifact quota
is separate from runner-minute quota, and evidence remains on the trusted runner for the release
review. The disposable E2E API harness uses a high request ceiling so a long single-owner browser
run does not cascade into unrelated `429` failures; transport rate-limit behavior remains covered
by the API security tests. Secrets must never be written to logs or artifacts.

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
