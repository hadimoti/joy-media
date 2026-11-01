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
- **Bring Your Own AI Keys**: Connect OpenRouter, OpenAI, Claude, Gemini, Grok, MiniMax, or Kimi with your own API key. Keys stay on this PC, encrypted with Windows DPAPI. ChatGPT sign-in needs a ChatGPT plan. The first sign-in registers this app with ChatGPT.
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
```

The editor works offline. The only network traffic is the AI provider you choose, and only when you use the agent.

---

## Monorepo Anatomy

```text
joy-media/
├── apps/
│   ├── desktop/             # Electron desktop shell, DPAPI key vault, IPC bridges, Worker supervisor
│   ├── editor-web/          # React 19 NLE timeline, Dockview panels, living looks, project state
│   ├── account-web/         # Retired joyst.ir portal: not used by v1.1.0 (removed in P5)
│   ├── api/                 # Retired VPS control plane: not used by v1.1.0 (removed in P5)
│   └── worker/              # High-performance media processing & export worker
├── packages/
│   ├── joy-agent-engine/    # Universal AI editing agent (BYOK provider modes)
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

## Open Source Status

> **Notice:** JOY Media is free and open-source software licensed under the [MIT License](LICENSE).
