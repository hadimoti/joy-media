# JOY Media

> **100% Local-First Open-Source Video Editor for Windows** with Built-in AI Agent Intelligence.

JOY Media is a high-performance offline desktop video editor (Windows Electron) powered by local SQLite (`LocalDatabase`), OPFS caching, and the local streaming protocol `joy-asset://` for catalog assets.

---

## Key Features

- **Offline-First Creative Engine**: Full NLE multi-track timeline, keyframes, text scenes, transitions, and audio denoise running 100% locally on your machine.
- **Instant Asset Library**: Local streaming protocol `joy-asset://` instantly loads waveforms, thumbnails, and audio tracks with zero external cloud dependencies.
- **Dual AI Agent Integration**:
  - **Free / Open BYOK**: Connect any OpenRouter or OpenAI-compatible endpoint with your own API key.
  - **Joy Pro Built-in Model**: Instant keyless access to curated frontier models (`minimax/minimax-m3`, `anthropic/claude-3.5-sonnet`, `openai/gpt-4o-mini`) through our secure VPS gateway with transparent token usage.
- **Standalone Local Worker**: High-speed offline media processing, frame extractions, and export pipelines.

---

## Quick Start (Development)

### Prerequisites
- Node.js ≥ 22
- pnpm ≥ 10 (`corepack enable pnpm`)

### Installation & Run

```bash
# Clone the repository
git clone https://github.com/hadimoti/joy-media.git
cd joy-media

# Install dependencies
pnpm install

# Start the desktop application in dev mode
pnpm --filter @joy-media/desktop dev
```

---

## Verification & Quality Checks

Run the automated verification suite:

```bash
# TypeScript compilation check across all packages
pnpm typecheck

# Code linting
pnpm lint

# Unit & integration test suites
pnpm test
```

---

## Desktop Packaging & Installer

Build production-ready Windows standalone executables and NSIS installers:

```bash
# Build unpacked distribution
pnpm --filter @joy-media/desktop package:unpacked

# Build production Windows Installer and portable archives
pnpm --filter @joy-media/desktop package:installer
```

Output binaries are produced in `apps/desktop/dist/releases/`:
- `joy-media-setup.exe` (Windows Installer)
- `joy-media-windows-x64-v*.zip` (Portable Archive)
- `SHA256SUMS.txt` (Cryptographic Checksums)

---

## Repository Architecture

```text
joy-media/
├─ apps/
│  ├─ desktop/          # Electron shell, IPC boundaries, DPAPI secret store, auto-updates
│  ├─ editor-web/       # React 19 + Dockview NLE timeline, OPFS caches, visual effects
│  ├─ api/              # VPS control plane: OTP auth, subscriptions, Joy Model proxy
│  └─ worker/           # Standalone offline media processing & export worker
├─ packages/
│  ├─ joy-agent-engine/ # Universal AI editing agent (BYOK + joy-hosted modes)
│  ├─ agent-tools/      # Deterministic timeline manipulation tools
│  ├─ timeline-engine/  # Track, clip, and transition synchronization
│  └─ project-schema/   # Canonical project serialization
└─ deploy/              # Lean Nginx & systemd production deployment assets
```

---

## License

Open-source under the MIT License.
