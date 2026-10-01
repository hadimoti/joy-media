# JOY Media v1.0.0 — Initial Public Release

We are excited to announce the initial public open-source release of **JOY Media** (v1.0.0)!

JOY Media is a modern, 100% offline-first desktop non-linear video editor (NLE) and creative studio built for creators, editors, and AI workflows.

---

### Key Highlights & Features

- **Offline-First Creative Engine**: High-performance multi-track timeline, canvas renderer, transitions, color grading, and subtitle generator running fully locally on your hardware.
- **BYOK Agent Engine**: Integrated Joy Agent workflow assistant. Bring Your Own Key (OpenAI, Anthropic, or local OpenAI-compatible models) with zero cloud storage of credentials, zero telemetry, and zero prompt retention.
- **Clean Open-Source Stack**: Fully compliant with the MIT License, featuring pinned open-source typography (OFL-1.1 via Fontsource) and video demuxing/muxing via Mediabunny (MPL-2.0).
- **Windows x64 Native Desktop Application**: Available both as an automated setup installer and as a portable standalone zip.

---

### Important Notice for Windows Users (Unsigned Installer)

> **Windows SmartScreen Notice**:
> This initial community release is currently **unsigned** (it does not yet include a commercial Authenticode Code Signing Certificate).
>
> When launching `joy-media-setup.exe`, Windows SmartScreen may display a warning:
> *"Windows protected your PC / Microsoft Defender SmartScreen prevented an unrecognized app from starting"*.
>
> **How to install:**
> 1. Click **More info**.
> 2. Click **Run anyway**.
>
> If you prefer not to run the installer, you can alternatively download the portable archive (`joy-media-windows-x64-v1.0.0.zip`), extract it to any folder, and run `joy-media.exe` directly.

---

### Downloads & Assets

| File | Type | Description |
|---|---|---|
| `joy-media-setup.exe` | Windows Installer | One-click setup with Start Menu & Desktop shortcuts and user PATH configuration |
| `joy-media-windows-x64-v1.0.0.zip` | Portable Archive | Fully self-contained portable application |
| `SHA256SUMS.txt` | Integrity | SHA256 checksums for all release binaries |

#### SHA256 Checksums

```
4910dffe9da225b5c41cc618760912e27098d71a3d1f58e92136743a063c9580  joy-media-setup.exe
cfe44ef5a79514bf1fad4e861b291059525a1aeaf578e36900bb959f6d7e3295  joy-media-windows-x64-v1.0.0.zip
```
