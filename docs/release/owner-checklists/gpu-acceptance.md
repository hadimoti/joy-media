# Owner checklist: GPU acceptance session (G5)

Owner-only. Run it on the machine with the RTX 5070 Ti, with you present, on the exact candidate. Windows Sandbox is not used.
The session drives the GPU for thirty default launches. It runs after the candidate has been frozen (G4), and only after you have
approved that candidate's commit (GD5). Nothing in it runs unattended.

## Before you start

- The candidate SHA is the one you approved in GD5. Write it here: ______________________________________
- The G1 receipt and the G2 thresholds file are in the repository at the G4 commit. The thresholds file is
  `docs/qa/attended/model-thresholds.json`. Its SHA-256 is printed by the harness, and the receipt binds to it.
- Node 22.6 or later and pnpm 11.15.0 are on this PC. Their folders are the `-NodeDirectory` and `-PnpmDirectory` values below.
  Nothing is installed.
- The harness is never run with a JOY Media window open. It refuses to start while the test install is running.

## Step 1: install the candidate with its own installer

1. Copy the candidate installer and its `SHA256SUMS.txt` into `C:\JoyMediaG1\acceptance`. Engineering provides both.
2. Check the installer's hash against the list. The line for the installer must match the hash `Get-FileHash` prints.
3. Run the installer, and install into the default location. Record the install folder name only.

## Step 2: a dedicated worktree of the candidate SHA, outside C:\JoyMediaG1

This is the dependency fetch into the worktree. It is not a system install. The install writes pnpm's store and downloads the
pinned Electron binary into the owner's per-user caches, which are outside `C:\JoyMediaG1`. Those writes are part of the plan's
fetch, and this checklist names them here.

```powershell
git worktree add C:\JoyMediaG1\acceptance-tree <candidate SHA>
pnpm --dir C:\JoyMediaG1\acceptance-tree install --frozen-lockfile
```

## Step 3: the thirty-run acceptance

```powershell
pwsh -NoProfile -File C:\JoyMediaG1\acceptance-tree\tooling\diagnostics\run-default-export-repeat.ps1 `
  -InstallRoot 'C:\Users\<owner>\AppData\Local\Programs\JOY Media' -OutDir C:\JoyMediaG1\acceptance-out `
  -Runs 30 -NodeDirectory '<folder of node.exe>' -PnpmDirectory '<folder of pnpm>'
```

Replace the install folder with the one step 1 recorded. Each run is a default launch and an export, sampled during the export.
The harness runs the export spec once more at the end. It writes `steps.json` and `summary.json` into `C:\JoyMediaG1\acceptance-out`.

Expected for a pass: the five steps are `pass`. Those are `default-launches` (30 runs), `gpu-process-exits` (0),
`fallback-relaunches` (0), `encoder-sessions-during-export` (at least 1 in every run), and `export-spec`. Record the
`summary.json` `stopReason`. A stop with three consecutive harness errors means the measurement failed, and the session is
not accepted.

## Step 4: leak scan and receipt

1. Run the leak scan over `C:\JoyMediaG1\acceptance-out` with the literals file that engineering provides. The count must be zero.
2. Engineering writes the receipt from `steps.json` with
   `node tooling/attended/src/write-receipt.mjs --session G2 --candidate-sha <candidate SHA> --exe <install>\joy-media.exe
--thresholds docs/qa/attended/model-thresholds.json --started <UTC> --finished <UTC> --steps <steps.json>
--leak-scan <file> --out <file outside the repository>`.

## Failure and escalation (OA2)

- Any step that fails makes the receipt `not-accepted`, and the receipt is kept.
- A run with zero encoder sessions, or any fallback relaunch, is a failure. It is never accepted.
- A fix means a new candidate (G4), with a new approval (GD5). The same candidate is rerun only if the failure is shown to be on
  the harness side, and you approve that rerun.
- If no fix is available, v1.0.3 is blocked, and you decide again (GD4).

## Close

Delete `C:\JoyMediaG1\acceptance-tree` after the receipt is written, with `git worktree remove`. Keep `C:\JoyMediaG1\acceptance-out`
until engineering confirms the receipt. Then delete `C:\JoyMediaG1`.
