<div align="center">

# JOY Media
### 100% Offline-First Professional Desktop NLE & Creative AI Studio

[![Platform: Windows x64](https://img.shields.io/badge/Platform-Windows%20x64-0078D6?style=flat-square&logo=windows)](https://joyst.ir)
[![Architecture: Offline--First NLE](https://img.shields.io/badge/Architecture-Offline--First%20NLE-00d2ff?style=flat-square)](https://joyst.ir)
[![Engine: React 19 + Electron](https://img.shields.io/badge/Engine-React%2019%20%2B%20Electron-9d4edd?style=flat-square)](https://joyst.ir)
[![Database: SQLite WAL + OPFS](https://img.shields.io/badge/Database-SQLite%20WAL%20%2B%20OPFS-10b981?style=flat-square)](https://joyst.ir)
[![Status: Private Evaluation](https://img.shields.io/badge/Status-Private%20Evaluation-amber?style=flat-square)](https://joyst.ir)

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
  - **Joy Pro Gateway**: Instant keyless access to curated frontier models (`minimax/minimax-m3`, `claude-3.5-sonnet`, `gpt-4o-mini`) through our VPS gateway with transparent token usage.
- **Living Looks GPU Color Science**: Cinematic real-time color grading, dynamic film grain, and LUT emulation running at 60 FPS on your GPU.
- **Pixel-Perfect Preview / Export Parity**: What you see in the timeline monitor matches the final encoded MP4 byte-for-byte.

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
# Clone the private repository
git clone https://github.com/hadimoti/joy-media.git
cd joy-media

# Install all workspace dependencies
pnpm install
```

### 2. Launch Desktop NLE in Development
```bash
# Run Electron desktop shell with hot-reloading editor
pnpm --filter @joy-media/desktop dev
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

## Private Repository Status

> **Notice:** JOY Media is currently in **Private Preview & Evaluation** for repository owner testing.
> All rights reserved. Unauthorized reproduction, distribution, or public deployment of this software is strictly prohibited.
