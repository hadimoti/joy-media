# JOY Media · Developer & Contributor Guide

JOY Media is a high-performance desktop non-linear video editor (NLE) and creative AI studio engineered with React 19, Electron, WebGL/WebGPU, and SQLite WAL storage. This document provides build, test, and packaging instructions for developers and contributors.

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

JOY Media is a local desktop application. Core editing and configured local speech workflows run on the PC; features that use an external AI provider require a network connection and may incur provider charges.

---

## Monorepo Anatomy

```text
joy-media/
├── apps/
│   ├── desktop/             # Electron desktop shell, DPAPI key vault, IPC bridges, Worker supervisor
│   ├── editor-web/          # React 19 NLE timeline, Dockview panels, living looks, project state
│   ├── account-web/         # Retired web portal (historical archive)
│   ├── api/                 # Retired VPS control plane (historical archive)
│   └── worker/              # High-performance media processing & export worker
├── packages/
│   ├── joy-agent-engine/    # Universal AI editing agent (BYOK provider modes)
│   ├── agent-tools/         # Deterministic timeline manipulation tool contracts
│   ├── audio-core/          # Audio engine, waveform processing, and mixer contracts
│   ├── captions-core/       # Subtitle parsing, formatting, and template styling
│   ├── commands/            # Transactional undo/redo editing commands
│   ├── evaluator/           # Camera expression and keyframe evaluation
│   ├── html-scene-runtime/  # Isolated HTML scene rendering runtime
│   ├── job-protocol/        # Media processing job definitions and speech contracts
│   ├── motion-core/         # Spatial animation, easing curves, and keyframing
│   ├── project-persistence/ # SQLite WAL and OPFS persistence drivers
│   ├── project-schema/      # Canonical JSON schema for timeline projects (.joyproject.json)
│   ├── property-system/     # Reactive visual property binding and transactions
│   ├── provider-sdk/        # AI provider registry, model routing, and DPAPI key management
│   ├── render-ir/           # Render Intermediate Representation definitions
│   ├── renderer-headless/   # Headless reference renderer for verification
│   ├── renderer-pixi/       # WebGL/WebGPU GPU renderer, color grade pipeline, and shader engine
│   ├── test-fixtures/       # Shared sample media, test videos, and audio assets
│   ├── timeline-engine/     # Track virtualization, clip math, and playback scheduling
│   └── ui-kit/              # Shared UI component primitives and styling
├── deploy/                  # Deployment scripts and server configs
├── docs/                    # User handbook, architectural specifications, and RFCs
│   ├── USER-GUIDE-v1.1.2.md # User and designer guide for this release
│   └── DEVELOPMENT.md       # Developer build guide (this document)
├── scripts/                 # Monorepo build and automation utilities
└── tests/                   # End-to-end integration and Playwright test suites
```

---

## Prerequisites

- **Operating System**: Windows 10 (1809+) or Windows 11 (64-bit)
- **Node.js**: Version 22 LTS or newer (`node -v`)
- **pnpm**: Version 10 or newer (`corepack enable pnpm` or `npm install -g pnpm@10`)
- **FFmpeg & FFprobe**: Installed and available on system `PATH` for media decode and export tests
- **Python (Optional, for Local Speech Studio development)**:
  - Python 3.10+ with `faster-whisper`, `torch`, `chatterbox-tts`, `safetensors`, `soundfile`, `numpy`

---

## Workspace Setup

### 1. Clone Repository & Install Dependencies

```bash
# Clone the repository
git clone https://github.com/hadimoti/joy-media.git
cd joy-media

# Install workspace dependencies via pnpm
pnpm install
```

### 2. Launch Development Environment

Run the Electron desktop application with hot-module replacement for the editor renderer:

```bash
# Launch Electron shell connected to local Vite dev server
pnpm --filter @joy-media/desktop dev
```

Alternatively, to run the editor web renderer standalone in a browser:

```bash
# Start renderer Vite server on http://localhost:5173
pnpm --filter @joy-media/editor-web dev
```

---

## Quality & Verification Suites

JOY Media maintains an extensive test suite covering unit math, IPC contracts, timeline virtualization, GPU shaders, and provider integrations:

```bash
# Verify TypeScript compilation across monorepo packages
pnpm typecheck

# Run unit and integration tests (Vitest)
pnpm test

# Run ESLint linter across monorepo
pnpm lint

# Format code with Prettier
pnpm format
```

### Targeted Testing

```bash
# Run tests for a specific package
pnpm --filter @joy-media/timeline-engine test
pnpm --filter @joy-media/editor-web test
pnpm --filter @joy-media/renderer-pixi test

# Run end-to-end desktop tests
pnpm test:e2e
```

---

## Packaging Desktop Releases

The desktop application packages into an unpacked directory, an NSIS setup installer, or a standalone portable ZIP archive.

### 1. Build Unpacked Application

```bash
# Build production assets and bundle unpacked Electron app
pnpm --filter @joy-media/desktop package:unpacked
```

Output is placed in `apps/desktop/dist/win-unpacked/`.

### 2. Build Installers and Portable Distribution

```bash
# Package NSIS setup executable and standalone ZIP
pnpm --filter @joy-media/desktop package:installer
```

Output artifacts are placed in `apps/desktop/dist/releases/`:

- `joy-media-setup.exe`: Windows Setup Installer (NSIS)
- `joy-media-windows-x64-v1.1.2.zip`: Standalone Portable Release
- `SHA256SUMS.txt`: Cryptographic SHA-256 verification hashes

---

## Windows Native Fullscreen & Window Controls Architecture

- **Cold-Start Fullscreen**: Configured in `apps/desktop/src/main/window.ts` via `fullscreen: true` in `buildMainWindowOptions`. The app launches directly into display-filling native fullscreen without window borders or title bars.
- **Window Controls**: Managed in `apps/editor-web/src/WindowControls.tsx` and bridged via IPC `desktop:toggle-maximize-window`.
- **Restore / Maximize Toggle**: In native fullscreen, clicking the Restore control toggles fullscreen off (`setFullScreen(false)`), returning the window to a moveable, resizable 1440×900 window. In windowed mode, the control toggles window maximization.
- **Shortcut**: `F11` or menu item `View -> Toggle Full Screen` toggles native fullscreen at any time.

---

## Storage & Security Boundary

- **Project Metadata**: Saved in local SQLite database with Write-Ahead Logging (WAL) and browser Origin Private File System (OPFS).
- **Credentials Vault**: API keys for external providers are encrypted on-device using the Windows Data Protection API (DPAPI) via the Electron main process. Keys never enter local logs, unencrypted disk storage, or remote sync.
- **Media Streaming**: High-throughput media playback streams via the custom `joy-asset://` protocol, avoiding base64 encoding or excessive RAM bloat.

---

## Documentation Links

- [v1.1.2 User & Designer Guide](USER-GUIDE-v1.1.2.md)
- [Release Notes v1.1.2](../RELEASE_NOTES_v1.1.2.md)
