# Windows Sandbox lifecycle runs

These scripts produce the receipts that the local-only release gate reads
(`pnpm release:gate:local`, check `lifecycle-evidence`). Both run in a clean Windows Sandbox
with networking off. The Sandbox user is `WDAGUtilityAccount`; the host install, profile and
`joy://` key are never touched.

| Run                                                                 | Script          | Receipt (file under `docs/release/attended/<candidate-sha>/`) |
| ------------------------------------------------------------------- | --------------- | ------------------------------------------------------------- |
| Clean install: install, open, close, uninstall                      | `lifecycle.ps1` | `sandbox-lifecycle.json`                                      |
| Upgrade from v1.0.2 (zip): v1.0.2 installed and run, the candidate over it, uninstall | `upgrade.ps1` | `sandbox-upgrade.json` |
| Upgrade from v1.1.0 (setup exe): v1.1.0 installed and run, the candidate over it, uninstall | `upgrade.ps1` | `sandbox-upgrade-from-1.1.0.json` |

Run them with the helper (it starts the Sandbox, waits for the script, copies the receipt out):

```powershell
$sha = git rev-parse HEAD
$dir = "docs\release\attended\$sha"
.\tooling\release\sandbox\run-sandbox.ps1 -Kind lifecycle -SetupExe apps\desktop\dist\releases\joy-media-setup.exe `
  -OutDir C:\jgp\sandbox-lifecycle-$sha -Receipt $dir\sandbox-lifecycle.json
# close the Sandbox window, then (the candidate version is passed, never assumed):
.\tooling\release\sandbox\run-sandbox.ps1 -Kind upgrade -SetupExe apps\desktop\dist\releases\joy-media-setup.exe `
  -ToVersion <candidate x.y.z> -V102Zip <path>\joy-media-windows-x64-v1.0.2.zip `
  -OutDir C:\jgp\sandbox-upgrade-$sha -Receipt $dir\sandbox-upgrade.json
# close the Sandbox window, then the same from the v1.1.0 setup exe:
.\tooling\release\sandbox\run-sandbox.ps1 -Kind upgrade -SetupExe apps\desktop\dist\releases\joy-media-setup.exe `
  -ToVersion <candidate x.y.z> -FromSetupExe <path>\joy-media-setup-1.1.0.exe -FromVersion 1.1.0 -FromSha256 <sha256 of that exe> `
  -OutDir C:\jgp\sandbox-upgrade-110-$sha -Receipt $dir\sandbox-upgrade-from-1.1.0.json
```

The gate needs both upgrade receipts (`sandbox-upgrade.json` from 1.0.2 and
`sandbox-upgrade-from-1.1.0.json` from 1.1.0); each must end on the candidate version from
`apps/desktop/package.json`.

The gate (`tooling/release/src/sandbox-lifecycle-receipt.ts`) accepts a receipt only when:

- the run reports the Sandbox user and finished after it started;
- the setup it installed has the SHA-256 of the candidate's `joy-media-setup.exe` (from the release
  `SHA256SUMS.txt`), so a receipt for another build is refused;
- every required step passed and no `error` step was recorded;
- the install folder, uninstaller registration, user PATH entry and shortcuts are gone after the
  uninstall, and (upgrade) the app data folder and its files survive the upgrade and the uninstall.

The v1.0.2 installer zip must match the released SHA-256 (`e59ee15f2f881cd6620ad59e9f1d9fdc4f9b82efaf221f4e6041c079978d59ca`).
