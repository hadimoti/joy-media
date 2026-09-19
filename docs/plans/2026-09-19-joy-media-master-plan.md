# Master Implementation Plan: JOY Media Desktop Pivot, Web Retirement & Repo Polish

This comprehensive plan addresses the owner's four core goals, integrating all verified facts from [BRIEF.md](file:///C:/Users/HadiMoti/joy-media/docs/BRIEF-2026-09-19.md), repository Git state, and live VPS control-plane telemetry.

---

## 1. Executive Summary & Architecture Ground Truth

- **Product Reality**: JOY Media transitioned on 2026-09-14/15 to an **offline-first Windows Electron desktop NLE** (`@joy-media/desktop`).
  - Desktop executable installed at `%LOCALAPPDATA%\Programs\JOY Media\joy-media.exe`.
  - Local database is SQLite with WAL at `%APPDATA%\@joy-media\desktop\joy-media.sqlite3`.
  - Local media worker (`joy-worker.exe`) embeds Real-ESRGAN, DeepFilterNet, and BiRefNet.
  - Local asset catalog at `H:\VPS-DATA\joy-media-assets` accessed via `joy-asset://` protocol.
  - The Sweden VPS (`joyst.ir`) is reduced to a lean control plane (OTP auth, subscriptions, installer downloads, release metadata, and the Joy Model AI Gateway).
- **Authentication**: "Gmail login" in the JOY system is **email OTP verification** (`apps/api/src/media-auth.ts`, `media-mailer.ts`), not Google OAuth. The `LoginGate.tsx` component already exists and implements Gmail/Telegram OTP input.
- **Git & Deployment Drift**:
  - Local `main` (`6d809229`) is 4 commits ahead of `github/main` and `vps/main` (`75bddef0`).
  - Production `joyst.ir` is 23 commits behind local main (`c015ea05`).
  - Commit `e07e398c` introduced the Joy Model Gateway (`/v1/agent/*`) and Postgres migration `009_agent_usage_ledger`. Until this is pushed and deployed, `POST /v1/agent/chat/completions` returns 405.
- **GitHub Actions Constraint**: Free-plan minutes are exhausted for September 2026. No workflows may run automatically on push/PR.
- **Multi-Agent Orchestration**:
  - **Orchestrator**: Antigravity (Gemini 3.8 Flash).
  - **Implementor Workhorse**: Kilo CLI (`kilo/kilo-auto/efficient`).
  - **High-Leverage Reviewer**: Codex CLI (`gpt-5.6-sol`, reserved for up to 2 critical validation gates).

---

## 2. Four Goals Task Breakdown

### Goal 1: App Review & Windows App Preparation (Closing Gaps)

#### Task 1.1: Desktop In-App Account Connection for Joy Model

- **File**: `apps/editor-web/src/DesktopAccountModal.tsx` [NEW], `apps/editor-web/src/App.tsx` [MODIFY], `apps/editor-web/src/JoyAgentSettingsDialog.tsx` [MODIFY]
- **Context**: In desktop mode, `probeJoySession` defaults to `Local Creator` if no token is saved. The user needs an easy in-app way to sign in with their Gmail OTP so their session token is stored and "Joy Model (Built-in Pro AI)" becomes usable.
- **Action**:
  1. Create `DesktopAccountModal.tsx` wrapping the OTP request/verify flow.
  2. In `App.tsx`'s account dropdown, add a "Connect JOY Account" button when running as `Local Creator`.
  3. Upon successful OTP verification, store the token via `setStoredMediaToken`, trigger `refreshJoySession()`, and update `joySession` with the real user identity.
  4. In `JoyAgentSettingsDialog.tsx`, when `provider === 'joy-hosted'` and user is unauthenticated, show a clear "Sign in to use Joy Model" button that opens `DesktopAccountModal`.
- **Do NOT Touch**: Timeline engine, playback engine, canvas rendering logic.
- **Verification**: `pnpm --filter editor-web test src/JoyAgentSettingsDialog.test.tsx` && `pnpm --filter editor-web typecheck`

#### Task 1.2: Control Plane & Joy Model Gateway VPS Deployment

- **File**: `deploy/deploy-control-plane.sh` [NEW]
- **Context**: Production VPS runs `c015ea05` (schema 8). Commits `e07e398c..6d809229` implement the Joy Model gateway and migration `009_agent_usage_ledger`.
- **Action**:
  1. Create `deploy/deploy-control-plane.sh` with automated pre-deploy DB backup, advisory locks, build, release symlink swap, and service restart.
  2. Push local commits `e07e398c..6d809229` to `vps/main` and `github/main`.
  3. Execute deployment on VPS, verifying that `/ready` returns `schemaVersion >= 9` and `POST /v1/agent/chat/completions` responds with 401 (properly authenticated) rather than 405.
- **Verification**: `pnpm --filter @joy-media/api test`

#### Task 1.3: Windows Standalone Packaging Validation

- **File**: `apps/desktop/scripts/package-installer.mjs`
- **Context**: Verify that standalone packaging produces valid executables, installers, and checksums.
- **Action**:
  1. Run `pnpm --filter @joy-media/desktop package:installer`.
  2. Verify that `joy-media-windows-x64-v1.0.0.zip`, `Setup-JoyMedia.ps1`, `install.cmd`, and `SHA256SUMS.txt` are created in `apps/desktop/dist/releases/`.
- **Verification**: `pnpm --filter @joy-media/desktop test:smoke-packaged`

---

### Goal 2: Complete Web Editor Retirement & Account Landing UI

#### Task 2.1: Author Lightweight `apps/account-web` Package

- **File**: `apps/account-web/package.json` [NEW], `apps/account-web/vite.config.ts` [NEW], `apps/account-web/index.html` [NEW], `apps/account-web/src/main.tsx` [NEW], `apps/account-web/src/App.tsx` [NEW]
- **Context**: The video editor SPA should no longer be served on `joyst.ir`. A dedicated, fast landing and dashboard replaces it.
- **Action**:
  1. Initialize `apps/account-web` in the pnpm workspace with React 19 and Vite.
  2. Output build to `apps/account-web/dist`.
  3. Configure route switching: unauthenticated visitors see `LandingHero` + `LoginGate`, authenticated visitors see `AccountLanding`.
- **Do NOT Touch**: Do not import editor packages (`@joy-media/timeline-engine`, `pixi.js`, `dockview`) into `account-web`.
- **Verification**: `pnpm --filter @joy-media/account-web build`

#### Task 2.2: Implement `LandingHero` Component

- **File**: `apps/account-web/src/LandingHero.tsx` [NEW], `apps/account-web/src/landing.css` [NEW]
- **Context**: Showcase the offline-first Windows NLE to visitors.
- **Action**:
  1. Header: Joy Studio logo, feature anchors, "Download" button, "Sign In" button.
  2. Hero: Dark glassmorphic design (`#0d0f12`, cyan/purple accents). Tagline: "The Offline-First Windows NLE Powered by Local AI Intelligence."
  3. Primary CTA: Direct download for Windows installer (`v1.0.0`). Secondary CTA: Sign in with Gmail OTP.
  4. Features Grid: Zero cloud latency (SQLite WAL + `joy-asset://`), Dual-Lens timeline, On-device AI worker (Real-ESRGAN, DeepFilterNet, BiRefNet), Living Looks, Dual AI Agent (Joy Model + BYOK).
  5. System Requirements: Windows 10/11 64-bit, 16 GB RAM, NVIDIA RTX recommended.
- **Verification**: `pnpm --filter @joy-media/account-web build`

#### Task 2.3: Implement Authenticated `AccountLanding` Dashboard

- **File**: `apps/account-web/src/AccountLanding.tsx` [NEW]
- **Context**: Dashboard displayed once a user completes Gmail/Telegram OTP verification.
- **Action**:
  1. User Header: Displays Gmail address / Telegram handle, logout button.
  2. Download Hub: Dynamic release metadata from `/v1/releases/stable`, installer download button, portable zip link, SHA256 checksum.
  3. Subscription Card: Live status from `/v1/account/subscription` (active, expired, free), plan selector, USDC invoice checkout.
  4. Authorized Devices Card: Active Windows devices from `/v1/devices`, registration timestamps, "Revoke Device" button.
  5. Joy Model Token Ledger: Usage summary from `/v1/agent/usage`.
- **Verification**: `pnpm --filter @joy-media/account-web build`

#### Task 2.4: Enable Server-Side Route Retirement & Nginx Boundary Cutover

- **File**: `deploy/joy-media-account-web.nginx.conf` [NEW]
- **Context**: Fail-closed retirement of legacy editor endpoints and edge narrowing on `joyst.ir`.
- **Action**:
  1. Set retirement env vars in `/etc/joy-media/api.env`:
     ```bash
     JOY_MEDIA_RETIRE_PROJECT_ROUTES=true
     JOY_MEDIA_RETIRE_MEDIA_LIBRARY_ROUTES=true
     JOY_MEDIA_RETIRE_WORKER_PAIRING_ROUTES=true
     JOY_MEDIA_LEGACY_EDITOR_RETIRED=true
     ```
  2. Deploy `joy-media-account-web.nginx.conf`:
     - Point root to `/opt/joy-media/account-web/dist`.
     - Narrow `/api/` proxy to `/v1/(auth|devices|account|entitlements|releases|billing|agent)`.
     - Return 404 at edge for any other `/api/*` paths.
- **Verification**: `curl -s -o /dev/null -w "%{http_code}" https://joyst.ir/api/v1/projects` (expects 404/410).

---

### Goal 3: Deep Repository Clean-up

#### Task 3.1: Prune Unreferenced Root Logos & Binary Media

- **Target Files**:
  - `joycode-logo.png` [DELETE]
  - `joycode-logo-hoizontal.png` [DELETE]
  - `joycode-logo-hoizontal-new.png` [DELETE]
  - `worker_output.txt` [DELETE]
  - `apps/editor-web/public/media/reference/asset-outro.mp4` [DELETE]
  - `apps/editor-web/public/media/reference/asset-product.mp4` [DELETE]
- **Preserve**: `asset-intro.mp4` (required for unit/E2E test fixtures), `joy-code-horizontal.png` (used in `JoyCodeLogo.tsx`), `JoyCodeNew_512x512.png` (used in web manifest).
- **Verification**: `pnpm -w run check`

#### Task 3.2: Clean Up Historical QA Binary Screenshots

- **Target Files**:
  - `docs/qa/evidence/20260809/*.png` [DELETE 7 files]
  - `docs/qa/wp35/*.png` [DELETE 3 files]
- **Verification**: `git status`

#### Task 3.3: Reorganize Heavy Root Markdown Documentation

- **Target Files**:
  - Move legacy planning documents to `docs/archive/legacy-plans/`:
    - `JOY_MEDIA_MASTER_PLAN.md`
    - `JOY_MEDIA_UNIFIED_DATA_TIMELINE_AND_AGENT_FLOW_PLAN.md`
    - `EFFECTS_LAYOUT_BEFORE_AFTER.md`
    - `ARCHITECTURE_SUMMARY.md`
    - `AGENTIC_EDITING_NEXT_AGENT.md`
    - `AUDIT-2026-07-21-completion-matrix.md`
    - `HTML_SCENES_CREATIVE_NEXT_AGENT.md`
    - `ORCHESTRATION.md`
    - `P05-VERIFICATION-2026-07-21.md`
  - Move historical 400 KB `STATE.md` to `docs/archive/STATE-2026-08.md`.
  - Create a clean, concise 2-page `STATE.md` at root tracking the current desktop release and deployment milestones.
- **Verification**: `git status`

#### Task 3.4: Lock GitHub Workflows Against Minute Quota Exhaustion

- **Target Files**:
  - `.github/workflows/ci.yml` [MODIFY]
  - `.github/workflows/ci-dev.yml` [MODIFY]
  - `.github/workflows/release-candidate.yml` [ARCHIVE / DELETE]
  - `.github/workflows/release-candidate-v2.yml` [ARCHIVE / DELETE]
  - `.github/workflows/r2-candidate.yml` [ARCHIVE / DELETE]
  - `.github/workflows/artifact-quota-check.yml` [ARCHIVE / DELETE]
- **Action**: Replace `push`/`pull_request` triggers in `ci.yml` with `workflow_dispatch` only. Delete obsolete R2 release candidate workflows.
- **Verification**: `git diff .github/workflows`

---

### Goal 4: World-Class GitHub Repo Front Page (README.md)

#### Task 4.1: Author Premium Private-Preview `README.md`

- **Target Files**: `README.md` [MODIFY]
- **Action**:
  1. Professional badges: Windows 10/11 x64, Electron 44, React 19, SQLite WAL, NVIDIA WebGL2, Private Preview.
  2. Hero description: "JOY Media — Next-Generation Offline-First Desktop NLE & Creative AI Studio for Windows".
  3. Feature sections:
     - _Zero-Cloud Latency_: Local SQLite storage, instant playback from local disk via `joy-asset://`.
     - _Dual-Lens Timeline_: Professional track hierarchy (V1–V10 visual, A1–A4 audio) with magnetic snapping.
     - _On-Device AI Engine_: Real-ESRGAN upscaler, DeepFilterNet audio denoiser, BiRefNet background matting.
     - _Living Looks_: 6 cinematic motion & typography packs.
     - _Dual AI Agent_: Curated Joy Model gateway or BYOK OpenRouter with DPAPI encryption.
     - _Studio Deliver_: Social H.264, Reels 1080x1920, Shorts, YouTube 4K with cryptographic checksum verification.
  4. Visual ASCII Architecture Diagram.
  5. System Requirements & Installation guide (Windows Installer + Portable Zip).
  6. Private Preview Disclaimer (remove premature "Open-Source MIT" statements).
- **Verification**: `git diff README.md`

---

## 3. Multi-Agent Execution Protocol

1. **Antigravity (Orchestrator)**:
   - Sets task boundaries, validates acceptance criteria, executes verification commands, and maintains clean git staging.
2. **Kilo CLI (`kilo/kilo-auto/efficient`) (Implementor Workhorse)**:
   - Receives atomic, self-contained task prompts.
   - Fast, resilient against rate limits, and strictly follows the "Do NOT touch" list.
3. **Codex CLI (`gpt-5.6-sol`) (High-Leverage Reviewer — Max 2 Calls)**:
   - **Call 1**: Architectural review of `deploy/joy-media-account-web.nginx.conf` and `deploy/deploy-control-plane.sh` prior to VPS cutover.
   - **Call 2**: Final verification audit of live VPS state and retirement response codes.

---

## 4. Verification & Acceptance Criteria

| Phase | Target                 | Acceptance Check                                                              | Command                                                |
| ----- | ---------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1     | In-app Account Connect | Local Creator can trigger OTP login modal in desktop app                      | `pnpm --filter editor-web test`                        |
| 1     | Joy Model Gateway      | Live `/v1/agent/chat/completions` responds with 401 instead of 405            | HTTP probe to `joyst.ir`                               |
| 1     | Windows Packaging      | Standalone zip, installer script, and SHA256SUMS generated                    | `pnpm --filter @joy-media/desktop test:smoke-packaged` |
| 2     | Account Web Build      | `apps/account-web` builds cleanly into lightweight static bundle              | `pnpm --filter @joy-media/account-web build`           |
| 2     | Web Retirement         | `https://joyst.ir` serves landing/account web; `/v1/projects` returns 404/410 | Browser inspection & curl                              |
| 3     | Repo Bloat Removal     | Unreferenced logos, duplicate MP4s, and screenshots removed                   | `git status` clean                                     |
| 3     | CI Minute Protection   | No workflows trigger automatically on git push                                | `git diff .github/workflows`                           |
| 4     | README Front Page      | Premium English documentation reflecting private desktop NLE                  | Visual inspection of `README.md`                       |
