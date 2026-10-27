# Owner checklist: GPU attended session (G1)

Owner-only. Run this on the machine with the RTX 5070 Ti, with you present. It needs the GPU, so Windows Sandbox is not
used for it. Each step lists what to run, what to expect, and what to record. Stop and tell the engineering side if a
step does not match.

## What this decides

1. The shipped GPU configuration. Option A: keep the one-time relaunch fallback, and make the acceptance harness drive the
   relaunched session. Option B: fix the default hardware path, then rerun the default build.
2. The root cause, which is open. The leading hypothesis, at medium confidence, is that the NVIDIA H.264 encoder component
   aborts inside the GPU sandbox during media setup.

Known facts (from the 2026-10-24 and 2026-10-26 notes):

- Default build: the GPU process exits with -1073740791 (0xC0000409) during media setup, and WebGL is lost for that session.
- The fallback relaunches once with `--joy-media-gpu-encode-fallback`, which disables the
  `MediaFoundationVideoEncodeAccelerator` feature. It is never persisted.
- Media Foundation lists one NVIDIA H.264 encoder and two AMD H.264 encoders on this PC.

## Safety rules (do not skip)

- Install nothing, and do not run any setup executable.
- Change nothing in the driver, registry, PATH, services, or Windows settings.
- Work only in `C:\JoyMediaG1`. Delete it at the end, after the logs are sent.
- If a Windows administrator prompt appears, cancel it and tell the engineering side.
- Keep every log file as it is. Do not edit them.

## Step 0: record the host (read only)

```powershell
New-Item -ItemType Directory -Force C:\JoyMediaG1\logs | Out-Null
Get-Date -Format o | Tee-Object C:\JoyMediaG1\logs\host.txt
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader | Tee-Object -Append C:\JoyMediaG1\logs\host.txt
Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,Status | Format-List | Out-String |
  Tee-Object -Append C:\JoyMediaG1\logs\host.txt
```

Expected: an NVIDIA GeForce RTX 5070 Ti. A different driver version is recorded, not a stop.

## Step 1: copy the candidate's portable build and check it

The candidate is `6a307ea9be8b012a26cb2793e07da42a6a9e1e04`, from run 40580654500. Copy the portable zip and its checksum
file from the durable evidence store. Replace `<store-root>` in the commands with the store path that engineering gives you for this session. The path is not kept in the repository. This is a read-only copy.

```powershell
wsl.exe -d Ubuntu-24.04 -e docker cp "joy-media-ci-acceptance:<store-root>/6a307ea9be8b012a26cb2793e07da42a6a9e1e04/40580654500-1-release-artifacts/joy-media-windows-x64-v1.0.3.zip" /mnt/c/JoyMediaG1/
wsl.exe -d Ubuntu-24.04 -e docker cp "joy-media-ci-acceptance:<store-root>/6a307ea9be8b012a26cb2793e07da42a6a9e1e04/40580654500-1-release-artifacts/SHA256SUMS.txt" /mnt/c/JoyMediaG1/
Get-FileHash C:\JoyMediaG1\joy-media-windows-x64-v1.0.3.zip -Algorithm SHA256
Select-String -Path C:\JoyMediaG1\SHA256SUMS.txt -Pattern 'joy-media-windows-x64-v1.0.3.zip'
Expand-Archive -Path C:\JoyMediaG1\joy-media-windows-x64-v1.0.3.zip -DestinationPath C:\JoyMediaG1\app
```

Expected: the hash from `Get-FileHash` equals the hash in `SHA256SUMS.txt`. If not, stop and send the two outputs.

## Step 2: default build, plain launch (the case that crashes)

```powershell
$start = Get-Date
Start-Process C:\JoyMediaG1\app\joy-media.exe
```

Wait 60 seconds, then record in the results table below:

- Did the window open?
- Did WebGL work (for example, the editor preview draws)?
- Did a second `joy-media.exe` appear, which is the relaunch?

Then list the processes, with their command lines:

```powershell
Get-CimInstance Win32_Process -Filter "Name='joy-media.exe'" | Select-Object ProcessId,CreationDate,CommandLine |
  Format-List | Out-String | Tee-Object C:\JoyMediaG1\logs\run1-processes.txt
```

Close the app with its own Quit or Alt+F4. Do not kill processes unless the app is frozen. If a relaunched process is still
open, close it the same way.

## Step 3: fallback launch (the shipped mitigation)

```powershell
$start = Get-Date
Start-Process C:\JoyMediaG1\app\joy-media.exe -ArgumentList '--joy-media-gpu-encode-fallback'
```

Record the same three answers as in step 2. Then export the sample project once to an MP4 file in `C:\JoyMediaG1\exports`
and say whether the file plays. Close the app as in step 2.

## Step 4: find the app's own logs (read only, record only)

The app writes to its Electron user-data folder, and the folder name is not confirmed here, so list the candidates first:

```powershell
Get-ChildItem $env:APPDATA,$env:LOCALAPPDATA -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'joy' } | Select-Object FullName,LastWriteTime |
  Tee-Object C:\JoyMediaG1\logs\candidate-folders.txt
```

Send `candidate-folders.txt` to the engineering side. Do not copy the folders yourself, because they may hold account data.

## Step 5: results table (fill in and send with the logs)

| Run | Launch                            | Window opened | WebGL worked | Relaunch seen | Export played | Notes |
| --- | --------------------------------- | ------------- | ------------ | ------------- | ------------- | ----- |
| 1   | default, plain                    |               |              |               | (not run)     |       |
| 2   | `--joy-media-gpu-encode-fallback` |               |              |               |               |       |

## Step 6: clean up

Confirm that no `joy-media.exe` is still running, then delete `C:\JoyMediaG1` after the logs are sent.

## Decision after the results

Engineering needs your decision before any change to the shipped configuration:

- Option A: keep the relaunch fallback as shipped, and make the acceptance harness drive the relaunched session.
- Option B: fix the default hardware path, then rerun the default build as a new candidate.
