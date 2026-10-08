<div align="center">

# JOY Media

### 100% Offline-First Professional Desktop NLE & Creative AI Studio

[![Platform: Windows x64](https://img.shields.io/badge/Platform-Windows%20x64-0078D6?style=flat-square&logo=windows)](https://joyst.ir)
[![Architecture: Offline--First NLE](https://img.shields.io/badge/Architecture-Offline--First%20NLE-00d2ff?style=flat-square)](https://joyst.ir)
[![Engine: React 19 + Electron](https://img.shields.io/badge/Engine-React%2019%20%2B%20Electron-9d4edd?style=flat-square)](https://joyst.ir)
[![Database: SQLite WAL + OPFS](https://img.shields.io/badge/Database-SQLite%20WAL%20%2B%20OPFS-10b981?style=flat-square)](https://joyst.ir)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

<p align="center">
  <b>JOY Media</b> is a high-performance desktop non-linear video editor engineered for creators who demand <b>zero cloud latency</b>, <b>total media privacy</b>, <b>sample-accurate playback</b>, and <b>on-device AI intelligence</b>.
</p>

---

</div>

## Highlights

- **100% Offline Creative Independence**: Edit multi-track 4K video, audio waveforms, motion titles, and living look transitions with zero Internet connection required.
- **Local Asset Streaming (`joy-asset://`)**: Custom protocol streaming video frames, waveforms, and catalog media straight from your NVMe drive with sub-millisecond seek times.
- **Dual AI Agent Integration**:
  - **Free / Open BYOK**: Plug in any OpenRouter or OpenAI-compatible endpoint with your own API key, securely encrypted via Windows DPAPI.
  - **Joy Pro Gateway**: Access to the JOY catalog requires a signed-in JOY account with an active Pro subscription. The hosted catalog is a server-enforced allow-list of five zero-cost OpenRouter models: `google/gemma-4-31b-it:free` (the default, with vision), `thinkingmachines/inkling:free` (vision), `nvidia/nemotron-3-ultra-550b-a55b:free`, `nvidia/nemotron-3-super-120b-a12b:free` and `cohere/north-mini-code:free`. When a free model is rate-limited or failing upstream, the gateway retries the next model in that list, never one outside it. `pnpm release:check-free-models` checks the list against OpenRouter's public model list. Paid models cannot be enabled: the old `JOY_GATEWAY_PAID_MODEL_ALLOWLIST` setting is ignored, and the server logs a warning at startup if it is set.
- **Kilo / BytePlus Coding**: Use the gateway at `https://api.kilo.ai/api/gateway`. The CLI default is `kilo/kilo-auto/free`; BytePlus models remain selectable, including `byteplus-coding/dola-seed-2.0-pro` and `byteplus-coding/dola-seed-2.0-lite` (vision) and `byteplus-coding/deepseek-v4-flash` (text).
- **Living Looks GPU Color Science**: Cinematic real-time color grading, dynamic film grain, and LUT emulation running at 60 FPS on your GPU.
- **Pixel-Perfect Preview / Export Parity**: What you see in the timeline monitor matches the final encoded MP4 byte-for-byte.

---

## CLI: JOY account login

The `joy-media` CLI signs in with a one-time code sent to your account email. Run `joy-media login --help` for every flag.

| Command / flag              | What it does                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `joy-media login`           | At a terminal: asks for the email, sends a code, then asks for the code (hidden).                                                                                 |
| `--email <address>`         | The account email; required when stdin is not a terminal.                                                                                                         |
| `--request-code`            | Only sends a code and exits. Finish with `--code-stdin`.                                                                                                          |
| `--code-stdin`              | Reads a code you already received from stdin (or a hidden prompt). It only verifies the code; no new one is sent.                                                 |
| `--code <digits>`           | Same as `--code-stdin`, but the code ends up in shell history and `ps`. Prefer the prompt or `--code-stdin`.                                                      |
| `--code-only`               | Verify only: asks for the code without sending a new one.                                                                                                         |
| `--api-base <url>`          | API base URL (default `https://joyst.ir/api`, or `JOY_MEDIA_API_BASE_URL`). It is saved with the login.                                                           |
| `--insecure-file-store`     | Keeps the session token in a private (0600) file when no system keyring is available.                                                                             |
| `joy-media whoami [--json]` | Shows the signed-in email and plan.                                                                                                                               |
| `joy-media logout`          | Revokes the session on the server, then removes the local token. If the server cannot revoke it, the token is kept so you can retry; `--force` removes it anyway. |

`whoami` and `logout` use the API base saved at login unless you pass `--api-base`. For scripts:

```sh
joy-media login --email me@example.com --request-code
read -rs CODE; printf '%s\n' "$CODE" | joy-media login --email me@example.com --code-stdin
```

---

## Architectural Blueprint

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                           JOY Media Desktop Application                       │
│                                                                               │
│   ┌───────────────────────────┐         ┌─────────────────────────────────┐   │
│   │   Electron Main Process   │         │    Chromium Renderer Process    │   │
│   │  • Windows DPAPI Vault    │  IPC    │  • React 19 + Dockview UI       │   │
│   │  • SQLite WAL Database    │◄───────►│  • Virtualized Multi-Track NLE  │   │
│   │  • joy-asset:// Streamer  │         │  • WebGL / WebGPU Shader Engine │   │
│   │  • Local Worker Supervisor│         │  • OPFS High-Speed Frame Cache  │   │
│   └─────────────┬─────────────┘         └────────────────┬────────────────┘   │
│                 │                                        │                    │
│                 │ OS File System                         │ Local Web Workers  │
│                 ▼                                        ▼                    │
│   ┌───────────────────────────┐         ┌─────────────────────────────────┐   │
│   │   Local NVMe Storage      │         │   Background Media Workers      │   │
│   │  • Media originals & cache│         │  • FFmpeg demux & frame decode  │   │
│   │  • Project state & audio  │         │  • Fast wave peak generation    │   │
│   └───────────────────────────┘         └─────────────────────────────────┘   │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │ HTTPS (Optional Cloud Features Only)
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                        Hardened Edge & Control Plane                          │
│                                                                               │
│   ┌───────────────────────────┐         ┌─────────────────────────────────┐   │
│   │  joyst.ir (Account Web)   │         │     VPS API Control Plane       │   │
│   │  • OTP Sign-in (Gmail/TG) │         │  • Device Entitlement Ledger    │   │
│   │  • Installer Downloads    │◄───────►│  • Postgres Account Store       │   │
│   │  • SHA-256 Checksum Verify│         │  • Joy Model Gateway (AI Proxy) │   │
│   └───────────────────────────┘         └─────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## Monorepo Anatomy

```text
joy-media/
├── apps/
│   ├── desktop/             # Electron desktop shell, DPAPI key vault, IPC bridges, auto-updater
│   ├── editor-web/          # React 19 NLE timeline, Dockview panels, living looks, project state
│   ├── account-web/         # joyst.ir portal: OTP login, installer downloads, account dashboard
│   ├── api/                 # Hardened VPS control plane: OTP auth, device tokens, AI model gateway
│   └── worker/              # High-performance media processing & export worker
├── packages/
│   ├── joy-agent-engine/    # Universal AI editing agent (dual BYOK & joy-hosted modes)
│   ├── agent-tools/         # Deterministic timeline manipulation tool contracts
│   ├── timeline-engine/     # Track virtualization, clip math, and playback scheduling
│   ├── project-schema/      # Canonical JSON schema for timeline projects
│   └── test-fixtures/       # Shared sample media and audio assets
├── deploy/                  # Production Nginx reverse-proxy configs & zero-downtime deployment scripts
└── docs/                    # Architectural specs, RFCs, and historical milestones
```

---

## Development & Build Guide

### Prerequisites

- **Operating System**: Windows 10 or Windows 11 (64-bit)
- **Node.js**: Version 22 LTS or newer
- **pnpm**: Version 10 or newer (`corepack enable pnpm`)
- **FFmpeg & FFprobe**: Configured on system `PATH` for media decode tests

### 1. Workspace Initialization

```bash
# Clone the public repository
git clone https://github.com/hadimoti/joy-media.git
cd joy-media

# Install all workspace dependencies
pnpm install
```

### 2. Launch Desktop NLE in Development

```bash
# Build the workspace, then run the Electron desktop shell
pnpm build
pnpm --filter @joy-media/desktop dev:electron
```

### 3. Run Quality & Verification Suite

```bash
# Verify TypeScript compilation across monorepo
pnpm typecheck

# Execute unit and integration tests (over 4,800+ automated tests)
pnpm test

# Run ESLint validation
pnpm lint
```

### 4. Package Windows Installers & Releases

```bash
# Produce unpacked production build
pnpm --filter @joy-media/desktop package:unpacked

# Package signed NSIS setup installer and portable zip archive
pnpm --filter @joy-media/desktop package:installer
```

Output artifacts are generated in `apps/desktop/dist/releases/`:

- `joy-media-setup.exe` — Windows Setup Installer
- `joy-media-windows-x64-v*.zip` — Standalone Portable Release
- `SHA256SUMS.txt` — SHA-256 Checksums for Release Verification

---

## Open Source Status

> **Notice:** JOY Media is free and open-source software licensed under the [MIT License](LICENSE).
