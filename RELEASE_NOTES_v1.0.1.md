# JOY Media v1.0.1 — Maintenance Release

This is a maintenance release of **JOY Media**. It hardens the Windows installer, fixes release-process gaps found in the September review, and removes dead test code. There are no changes to editor features.

---

### Important Notice for Windows Users (Unsigned Installer)

> **Windows SmartScreen Notice**:
> This community release is currently **unsigned** (it does not yet include a commercial Authenticode Code Signing Certificate).
>
> When launching `joy-media-setup.exe`, Windows SmartScreen may display a warning:
> _"Windows protected your PC / Microsoft Defender SmartScreen prevented an unrecognized app from starting"_.
>
> **How to install:**
>
> 1. Click **More info**.
> 2. Click **Run anyway**.
>
> If you prefer not to run the installer, you can alternatively download the portable archive (`joy-media-windows-x64-v1.0.1.zip`), extract it to any folder, and run `joy-media.exe` directly.

---

### Changes since v1.0.0

- **Installer zip-slip guard**: each archive entry is resolved with `GetFullPath` and must stay inside the install root before it is extracted.
- **Single version constant**: the installer version lives in `InstallerEngine.ProductVersion`, and `build-installer.ps1 -Version` refuses to build if the two disagree.
- **CI now runs on pull requests and pushes to `main`**: `ci.yml` previously ran only on manual dispatch.
- **Scratch files removed**: `batch4-results.txt` and `tmp/stock-video-test.log` are no longer tracked, and `tmp/` is ignored.
- **Retired Creative Brief tests deleted**: about 1,700 lines of skipped tests for routes that no longer exist.
- **Version bump**: desktop app, CLI and installer are now `1.0.1`.

---

### Downloads & Assets

| File                               | Type              | Description                                                                     |
| ---------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `joy-media-setup.exe`              | Windows Installer | One-click setup with Start Menu & Desktop shortcuts and user PATH configuration |
| `joy-media-windows-x64-v1.0.1.zip` | Portable Archive  | Fully self-contained portable application                                       |
| `SHA256SUMS.txt`                   | Integrity         | SHA256 checksums for all release binaries                                       |

#### SHA256 Checksums

```
1713995bb92446de36f0214202d2de9f7a9b8800605930b34786d76d60bad96  joy-media-setup.exe
2db6aaba0ed2a4edc15a81e34be4b2216be7b36e2acbef0390b3404fe89946b5  joy-media-windows-x64-v1.0.1.zip
```

CI evidence: [successful CI run on candidate commit 966de08617f89c060ac53b3366f68aec5e2d0d5f](https://github.com/hadimoti/joy-media/actions/runs/37003659437) and [successful release-candidate-v2 run](https://github.com/hadimoti/joy-media/actions/runs/37004833043).
