# Owner checklist: GPU attended session (G1)

Owner-only. Run it on the machine with the RTX 5070 Ti, with you present. The session needs the real GPU, so Windows Sandbox
is not used. This checklist matches the G1 steps in plan section 10d exactly. It does not offer a choice of fix: option B is
committed (OA1), and this session only diagnoses.

## What this session produces

- The GPU encoder session counts during each launch, from the sampler, and the encoder check of the Media Foundation probe.
- The GPU child-process exit with its normalised code (for example 0xC0000409), and the Windows Error Reporting events that
  match it.
- The failing stage of the stage probe (S2 to S6), and the answer of each Media Foundation encoder to a one-frame encode.
- A receipt for the session, written by engineering from the results you hand over.

## Builds used

- (a) **Baseline:** candidate `6a307ea9be8b012a26cb2793e07da42a6a9e1e04` (run 40580654500), as shipped. It reproduces the crash.
  Its portable zip and checksum file are copied from the durable evidence store, as in step 1.
- (b) **The G1 kit:** built from the G0 commit by `tooling/diagnostics/build-g1-kit.ps1`. It is the instrumented build, with
  the diagnostic tools. Engineering hands it over as a folder, `C:\JoyMediaG1\kit`, and its `SHA256SUMS.txt` lists every file.

## Where everything goes

- Everything the session creates is meant to stay inside `C:\JoyMediaG1`. Two things are outside it: the `joy://` registration
  described under Safety rules, and whatever the GPU driver caches on its own. Nothing is added to the PATH.
- The instrumented build always runs with `--joy-media-test-user-data=C:\JoyMediaG1\userdata`. Its GPU event log and its
  diagnostic dumps go to that folder. The instrumented build does not register the `joy://` protocol.
- The baseline build runs with `--user-data-dir=C:\JoyMediaG1\userdata-baseline`, so the candidate never opens your own profile.
  The switch is UNVERIFIED on this build: step 2 records the folder the app opens.
- Your own user-data folder is never read or copied. Step 4 lists folder names under AppData only, and that is the only look at them.
- **Node:** the Node 22.6 or later already on this PC is used, and its version is recorded in step 0. Nothing is installed. If
  Node is missing or older, the inventory step is recorded as "not run". Installing Node is a Part 2 item.
- No checkout of the repository is needed for this session.

## Safety rules (do not skip)

- Install nothing, and do not run any setup executable.
- Change nothing in the driver, the PATH, the services, or the Windows settings.
- The shipped build registers the `joy://` protocol at every launch, which writes `HKCU\Software\Classes\joy`. Steps 2 and 3 can
  change that key. Step 0 records whether the key is present, and exports it when it is. Step 10 restores it. That restore is the only registry change allowed.
- Work only in `C:\JoyMediaG1`. Delete it at the end, after the logs are handed over.
- If a Windows administrator prompt appears, cancel it and tell engineering.
- Keep every log file as it is. Do not edit a log.
- Type nothing into a credential field. The app should not ask for one in this session. If it does, stop and tell engineering.

## Part 1: no system change

Each step lists what to run, what to expect, and what to record. Stop and tell engineering if a step does not match.

### Step 0: record the host (read only)

```powershell
New-Item -ItemType Directory -Force C:\JoyMediaG1\logs | Out-Null
Get-Date -Format o | Tee-Object C:\JoyMediaG1\logs\host.txt
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader | Tee-Object -Append C:\JoyMediaG1\logs\host.txt
Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,Status | Format-List | Out-String |
  Tee-Object -Append C:\JoyMediaG1\logs\host.txt
node --version | Tee-Object -Append C:\JoyMediaG1\logs\host.txt
New-Item -ItemType Directory -Force C:\JoyMediaG1\exports, C:\JoyMediaG1\stage-userdata | Out-Null
$joyState = if (Test-Path 'HKCU:\Software\Classes\joy') { 'present' } else { 'absent' }
"joy-key $joyState" | Tee-Object -Append C:\JoyMediaG1\logs\host.txt
if ($joyState -eq 'present') { reg.exe export "HKCU\Software\Classes\joy" C:\JoyMediaG1\logs\joy-key-before.reg /y }
```

Expected: an NVIDIA GeForce RTX 5070 Ti. A different driver version is recorded, not a stop. `host.txt` records
`joy-key present` or `joy-key absent`. If the key was present, `joy-key-before.reg` holds it as it was before the session.

### Step 1: copy and hash-check the baseline and the kit

Copy the baseline portable zip and its checksum file from the durable evidence store. Replace `<store-root>` with the path that
engineering gives you for this session. The path is not kept in the repository.

```powershell
wsl.exe -d Ubuntu-24.04 -e docker cp "joy-media-ci-acceptance:<store-root>/6a307ea9be8b012a26cb2793e07da42a6a9e1e04/40580654500-1-release-artifacts/joy-media-windows-x64-v1.0.3.zip" /mnt/c/JoyMediaG1/
wsl.exe -d Ubuntu-24.04 -e docker cp "joy-media-ci-acceptance:<store-root>/6a307ea9be8b012a26cb2793e07da42a6a9e1e04/40580654500-1-release-artifacts/SHA256SUMS.txt" /mnt/c/JoyMediaG1/
Get-FileHash C:\JoyMediaG1\joy-media-windows-x64-v1.0.3.zip -Algorithm SHA256
Select-String -Path C:\JoyMediaG1\SHA256SUMS.txt -Pattern 'joy-media-windows-x64-v1.0.3.zip'
Expand-Archive -Path C:\JoyMediaG1\joy-media-windows-x64-v1.0.3.zip -DestinationPath C:\JoyMediaG1\baseline
```

Then check the kit against its own list. Every line of `SHA256SUMS.txt` in the kit must match:

```powershell
Get-Content C:\JoyMediaG1\kit\SHA256SUMS.txt | ForEach-Object {
  $hash, $path = $_ -split '  ', 2
  if ((Get-FileHash -LiteralPath (Join-Path C:\JoyMediaG1\kit $path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { "MISMATCH $path" }
} | Tee-Object C:\JoyMediaG1\logs\kit-check.txt
```

Expected: the baseline hash equals the hash in `SHA256SUMS.txt`, and `kit-check.txt` is empty. Otherwise stop and send both outputs.

### Step 2: baseline default launch (the case that crashes)

```powershell
$start = (Get-Date).ToUniversalTime()
Start-Process C:\JoyMediaG1\baseline\joy-media.exe -ArgumentList '--user-data-dir=C:\JoyMediaG1\userdata-baseline'
```

Start the sampler in its own window before the export, and keep it running until the export has finished:

```powershell
pwsh -NoProfile -File C:\JoyMediaG1\kit\tree\tooling\diagnostics\sample-encoder-sessions.ps1 -OutFile C:\JoyMediaG1\logs\encoder-baseline-default.csv
```

Wait 60 seconds, then record: did the window open, did WebGL work (the editor preview draws), and did a second
`joy-media.exe` appear (the relaunch)? If the window opened, start the export of the sample project and record whether the
export finishes. In the save dialog, choose `C:\JoyMediaG1\exports`, so the file stays in the session folder.

Then list the processes, with their command lines, and the user-data folder the app opened:

```powershell
Get-CimInstance Win32_Process -Filter "Name='joy-media.exe'" | Select-Object ProcessId,CreationDate,CommandLine |
  Format-List | Out-String | Tee-Object C:\JoyMediaG1\logs\baseline-default-processes.txt
```

Close the app with its own Quit, or Alt+F4. Do not kill a process unless the app is frozen. Then stop the sampler with
`New-Item C:\JoyMediaG1\logs\encoder-baseline-default.csv.stop`. The measurement is `encoder-max-baseline-default`.

### Step 3: baseline fallback launch (the shipped mitigation)

```powershell
Start-Process C:\JoyMediaG1\baseline\joy-media.exe -ArgumentList '--user-data-dir=C:\JoyMediaG1\userdata-baseline','--joy-media-gpu-encode-fallback'
```

Run the sampler to `C:\JoyMediaG1\logs\encoder-baseline-fallback.csv` as in step 2, and record the same answers. The
fallback disables the Media Foundation encoder, so the count is expected to be low. It is recorded, and it is never accepted. If you export, choose `C:\JoyMediaG1\exports` in the save dialog.
Close the app as in step 2.

### Step 4: folder names (read only, record only)

```powershell
Get-ChildItem $env:APPDATA,$env:LOCALAPPDATA -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'joy' } | Select-Object Name,LastWriteTime |
  Tee-Object C:\JoyMediaG1\logs\candidate-folders.txt
```

Send `candidate-folders.txt` to engineering. Do not open or copy any of the folders.

### Step 5: read-only inventory

The inventory tool changes no setting, and it writes its output already redacted. Node must be 22.6 or later.

```powershell
node --experimental-strip-types C:\JoyMediaG1\kit\tree\tooling\diagnostics\src\gpu-inventory.ts --out C:\JoyMediaG1\logs\inventory.json
```

Expected: the file exists. It answers whether the AMD encoders belong to an active adapter. If Node is missing, record "not run".

### Step 6: instrumented default launch, with the GPU event log

```powershell
$start = (Get-Date).ToUniversalTime()
Start-Process C:\JoyMediaG1\kit\app\joy-media.exe -ArgumentList '--joy-media-test-user-data=C:\JoyMediaG1\userdata'
```

Run the sampler to `C:\JoyMediaG1\logs\encoder-instrumented-default.csv` during the export attempt, as in step 2. In the save
dialog, choose `C:\JoyMediaG1\exports`. Then:

- Read `C:\JoyMediaG1\userdata\gpu-events.jsonl`. Record each line's `exitCodeHex` and `reason`. The measurement is
  `encoder-max-instrumented-default`.
- Read the crash events for the same window:

  ```powershell
  $end = (Get-Date).ToUniversalTime()
  pwsh -NoProfile -File C:\JoyMediaG1\kit\tree\tooling\diagnostics\read-wer-events.ps1 -Start $start -End $end |
    Tee-Object C:\JoyMediaG1\logs\wer-events-matched.jsonl
  ```

  The measurement `wer-events-matched` counts the lines. It answers whether Windows Error Reporting records the known crash on
  this PC. If no line appears when the crash is expected, record zero. That is a finding, not a stop.

Close the app as in step 2.

Then the diagnostic launch, whose local dumps go to the same folder:

```powershell
Start-Process C:\JoyMediaG1\kit\app\joy-media.exe -ArgumentList '--joy-media-test-user-data=C:\JoyMediaG1\userdata','--joy-media-gpu-diagnostics'
```

Record the faulting module and the fast-fail subcode from `C:\JoyMediaG1\userdata\gpu-diagnostics.jsonl`. Close the app.

### Step 7: stage probe, one stage per process

```powershell
node C:\JoyMediaG1\kit\tree\tests\desktop\gpu-probe\run-stage-probe.mjs --out C:\JoyMediaG1\logs\stage-probe --stages S2,S3,S4,S5,S6 --electron C:\JoyMediaG1\kit\stage-runtime\electron.exe --user-data C:\JoyMediaG1\stage-userdata
```

The probe uses `stage-runtime`, a plain copy of the runtime with no app. It refuses any runtime that holds an app, so it cannot
start the JOY Media app by mistake. Do not point it at `app\`.

The probe keeps each stage's user data under `C:\JoyMediaG1\stage-userdata`, outside `logs`, so it is not part of the log
handover. Each stage starts with a fresh profile, in a fresh process, and the probe stops at the first stage that kills the GPU
process. Record the
`summary.json` `stoppedAfter` value. That is the measurement `failing-stage`.

### Step 8: Media Foundation encode, one encoder per process

```powershell
pwsh -NoProfile -File C:\JoyMediaG1\kit\tree\tooling\diagnostics\mf-probe\run-mf-encode.ps1 `
  -Probe C:\JoyMediaG1\kit\tree\tooling\diagnostics\mf-probe\mf-probe.exe -OutFile C:\JoyMediaG1\logs\mf-encode.jsonl
```

Run the sampler to `C:\JoyMediaG1\logs\encoder-mfprobe.csv` during this step. Each encoder runs in its own process, and each
result line records its exit code. The NVIDIA encoder is the one that matters. Its maximum during the encode is
`encoder-max-mfprobe-nvidia`. If the NVIDIA encode crashes outside Chromium, the fault is in the encoder or the driver, not in
the Chromium sandbox. Record that, and do not interpret it further.

### Step 9: results and receipt steps

Fill in the table, and send it with the logs.

| Run | Launch                                      | Window opened | WebGL worked | Relaunch seen | Export finished | Notes |
| --- | ------------------------------------------- | ------------- | ------------ | ------------- | --------------- | ----- |
| 2   | baseline, default                           |               |              |               |                 |       |
| 3   | baseline, `--joy-media-gpu-encode-fallback` |               |              |               |                 |       |
| 6   | instrumented, default                       |               |              |               |                 |       |

The receipt steps, with their measurements, are: `encoder-max-baseline-default`, `encoder-max-baseline-fallback`,
`encoder-max-instrumented-default`, `encoder-max-mfprobe-nvidia`, `gpu-exit-code` (the normalised value), `wer-events-matched`,
`failing-stage`, and any Part 2 item that was run. Each step is recorded as pass or fail, as it was observed. A failed step is kept.

### Step 10: clean up

Confirm that no `joy-media.exe` and no probe process is still running.

Compare the `joy://` registration with the one from step 0, if step 0 recorded `joy-key present`:

```powershell
reg.exe export "HKCU\Software\Classes\joy" C:\JoyMediaG1\logs\joy-key-after.reg /y
fc.exe C:\JoyMediaG1\logs\joy-key-before.reg C:\JoyMediaG1\logs\joy-key-after.reg
```

Then act on the step-0 record in `host.txt`:

- If step 0 recorded `joy-key present` and the files differ, delete the key and import the step-0 file. That restores it
  exactly, including any value the session added: `reg.exe delete "HKCU\Software\Classes\joy" /f`, then
  `reg.exe import C:\JoyMediaG1\logs\joy-key-before.reg`.
- If step 0 recorded `joy-key absent`, delete the key if it exists now: `reg.exe delete "HKCU\Software\Classes\joy" /f`.

This restore reverses a change the session made, and the owner runs it. Record the outcome in the log.

Then send the logs to engineering. Delete `C:\JoyMediaG1` after they confirm that they have the logs.

## Part 2: state-changing items (only if Part 1 is inconclusive)

Each item needs your approval for that item, given in the session (GD2). Each one is reversed, and the reversal is verified,
before the session ends (F81). Engineering does not run a Part 2 item on its own.

| Item                                                                                                                                                 | Reversal                                              | Verified by                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| Launch with `--disable-gpu-sandbox` (one session; the instrumented build, test user data; export with the sampler, saved to `C:\JoyMediaG1\exports`) | Close the app. No persistent state                    | The process list shows no flagged process                            |
| Exploit-protection override for `joy-media.exe`                                                                                                      | `Set-ProcessMitigation` back to the recorded defaults | `Get-ProcessMitigation -Name joy-media.exe` equals the step-0 record |
| Debugging-tools install (for example WinDbg)                                                                                                         | Uninstall                                             | The installed-apps list equals step 0                                |
| Driver change (with a restore point)                                                                                                                 | Reinstall the step-0 driver                           | The `nvidia-smi` driver equals step 0                                |
| Disable a stale adapter or MFT registration                                                                                                          | Re-enable                                             | The inventory equals step 0                                          |
| Electron variant download and launch (GD3)                                                                                                           | Delete the folder                                     | The folder is absent                                                 |
| Installing Node (only if step 0 found none)                                                                                                          | Uninstall                                             | The installed-apps list equals step 0                                |

The v1.0.3 plan's D7 approved these classes in principle (plan section 12e). It does not replace the per-item approval.

## Close

Leak-scan the logs with the literals file that engineering provides. The count must be zero. Then engineering writes the
receipt from the results, with the command the plan gives in section 10d:

```text
node tooling/attended/src/write-receipt.mjs --session G1 --candidate-sha <G0 commit> --exe C:\JoyMediaG1\kit\app\joy-media.exe
  --thresholds docs/qa/attended/model-thresholds.json --started <UTC> --finished <UTC> --steps <file>
  --leak-scan <file> --out <file outside the repository>
```

## What happens next (owner decides)

The G1 result leads to one of three outcomes (plan section 10d):

- (i) A fix candidate with a discriminating test. It goes to G3, and it keeps the NVIDIA hardware encoder in use.
- (ii) The diagnosis is inconclusive even after Part 2. v1.0.3 is blocked, and you decide again (GD4).
- (iii) The cause is outside the product, for example only a driver version fixes it. v1.0.3 is blocked, and you decide (GD4).

Nothing is adopted automatically. No threshold, no fallback, and no MF setting changes without your written decision.
