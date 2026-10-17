# JOY Media — Current State & Architecture Ledger

**Last Updated:** 2026-10-17 (readiness review)
**Primary Surface:** Windows Electron editor candidate; installed-app, project-persistence, and media-delivery acceptance remain open
**Web Surface:** Hardened Control Plane & Account Web (`joyst.ir` via `apps/account-web`)  
**Historical Log:** Preserved at [`docs/archive/STATE-historical-2026-09-18.md`](docs/archive/STATE-historical-2026-09-18.md)

The goals, verification table, and operational handoffs below are the 2026-09-19 checkpoint.
They are historical records, not current release instructions. Current source findings and
scenario status are maintained in [Feature Status](docs/product/FEATURE-STATUS.md) and the
[readiness matrix](docs/qa/READINESS-MATRIX.md).

## Current readiness — 2026-10-17

- The audited upstream candidate is `c1fffd59d5078902e031e7684e69c27df40ce607`. A fresh Windows
  baseline passed the repository-pinned pnpm verification before the current release-gate edits;
  the latest full verification result is recorded separately in
  [the readiness evidence](docs/qa/evidence/2026-10-17-windows-baseline.md).
- The CLI has a real FFmpeg renderer and playable-output tests through its source entry. Windows
  launcher parity, accurate unsupported-feature handling, failure recovery, and packaged-app
  behavior remain open.
- The Electron host opens a local database for media/job/provider metadata, but its project
  open/save path is not wired to `SqliteProjectStore`. Worker derivative jobs can be queued but
  are not dispatched to completion.
- An unsigned staging package can be assembled for smoke tests. The release-packaging gate marks
  public signing/tooling owner-gated; no new install or release acceptance is claimed here.
- No merge, publish, deployment, or production-data operation is authorized by this status note.

---

## 1. Executive Summary & Architecture

The following architecture picture is the 2026-09-19 target-state snapshot. The 2026-10-17
source review found that Windows project persistence, derivative-job execution, and installed
application lifecycle are not yet closed; see the current readiness section above.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        JOY Media Desktop (NLE)                         │
│  Electron Shell ── Windows DPAPI ── Local SQLite ── OPFS Caching       │
│  joy-asset:// Protocol ── Local Worker ── In-App OTP Account Bridge     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTPS (Bearer Token)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   Hardened Edge Boundary (joyst.ir)                    │
│  Nginx Cutover (client_max_body_size 10m) ── apps/account-web SPA     │
│  Allowed: /v1/(auth|devices|account|entitlements|releases|agent)       │
│  Edge Denied: /v1/(projects|media|jobs) -> 404/410                     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Proxy
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      VPS Control Plane (apps/api)                      │
│  Fastify API ── PostgreSQL Ledger ── Gmail/Telegram OTP Mailer         │
│  Joy Model Gateway (/v1/agent/chat/completions) ── Device Entitlements │
└────────────────────────────────────────────────────────────────────────┘
```

- **Local-First Timeline Engine**: Track virtualization, sample-accurate playhead sync, Living Looks GPU color science, 3D scenes, motion typography, and audio polish run entirely on the user's workstation without cloud latency.
- **Data Privacy & Storage**: Local media assets are streamed via the custom `joy-asset://` protocol. Projects are stored in SQLite with WAL mode.
- **AI Agent Intelligence**: Dual-mode engine supporting Free/Open BYOK (OpenRouter / OpenAI) or Joy Pro curated frontier models (`minimax/minimax-m3`, `claude-3.5-sonnet`, `gpt-4o-mini`) through the zero-knowledge model gateway.

---

## 2. Current Checkpoint Milestones (2026-09-19)

### Goal 1: Desktop In-App Account Connection

- Authoring and integration of `DesktopAccountModal.tsx` in `apps/editor-web`.
- Enables "Local Creator" desktop users to connect their JOY account via email/Telegram OTP directly inside the desktop app.
- Activates keyless Joy-hosted model capabilities with automated token ledger synchronization.
- Status: **Complete & Verified** (10/10 Vitest in `JoyAgentSettingsDialog.test.tsx`).

### Goal 2: Web Retirement & Account Web Package

- Retired full editor SPA from web serving (`joyst.ir`).
- Authored `apps/account-web` (`@joy-media/account-web`):
  - `LandingHero.tsx`: Showcase of offline-first NLE features, architecture, and installer downloads.
  - `LoginCard.tsx`: Gmail and Telegram OTP sign-in with 6-digit PIN verification.
  - `AccountLanding.tsx`: Creator dashboard for desktop installers, SHA-256 checksum verification, subscription tiers, device management, and token usage ledgers.
- Authored `deploy/joy-media-account-web.nginx.conf` and updated `deploy/apply-nginx-cutover.sh` to allow control-plane routes including `agent`.
- Authored `deploy/deploy-control-plane.sh` with automated Postgres backup, atomic build swap, and migration execution.
- Status: **Complete & Verified** (Production build passes in 622ms).

### Goal 3: Repository Hygiene & Monorepo Cleanup

- Deleted unreferenced root logos (`joycode-logo.png`, `joycode-logo-hoizontal*.png`) and untracked artifacts (`worker_output.txt`).
- Cleaned unreferenced heavy sample videos (`asset-outro.mp4`, `asset-product.mp4`) while strictly preserving test fixtures (`asset-intro.mp4`).
- Purged 10 binary QA screenshots from `docs/qa/evidence/20260809/` and `docs/qa/wp35/`.
- Archived 290 KB of pre-desktop planning documentation to `docs/archive/legacy-plans/`.
- Configured all `.github/workflows/` to `workflow_dispatch` only (zero minute consumption on push).
- Status: **Complete & Verified** (Monorepo test suite: 588 files passed, 4,819 tests passed).

### Goal 4: Documentation & Private Repository Identity

- Root `README.md` re-engineered with cool English visual guides, architecture maps, and clear private evaluation status.
- Status: **Complete & Verified**.

---

## 3. Historical verification matrix — 2026-09-19

| Check                        | Scope                    | Tool / Command                               | Result                            |
| :--------------------------- | :----------------------- | :------------------------------------------- | :-------------------------------- |
| **Unit & Integration Tests** | Full Monorepo            | `pnpm test`                                  | **588 passed**, 4,819 tests green |
| **TypeScript Types**         | Full Monorepo            | `pnpm typecheck` (`tsc -b`)                  | **Clean** (0 errors)              |
| **Account Web Build**        | `@joy-media/account-web` | `pnpm --filter @joy-media/account-web build` | **Clean** (0.62s)                 |
| **Desktop Editor Build**     | `@joy-media/editor-web`  | `pnpm --filter @joy-media/editor-web build`  | **Clean**                         |
| **CI Budget Guard**          | `.github/workflows/`     | Manual inspection                            | **100% `workflow_dispatch`**      |

---

## 4. Historical operational handoffs — 2026-09-19 (not current instructions)

1. **VPS Deployment**:
   - Push 4 pending commits (`e07e398c..6d809229`) plus current cleanup commits to `vps/main`.
   - Execute `deploy/deploy-control-plane.sh` on the Sweden VPS to migrate PostgreSQL schema (`009_agent_usage_ledger`), deploy `account-web`, and apply the hardened Nginx boundary.
2. **Windows Desktop Binary**:
   - Packaged release `apps/desktop/dist/releases/joy-media-windows-x64-v1.0.0.zip` (198 MB) is verified and ready for distribution via `joyst.ir/releases/`.
