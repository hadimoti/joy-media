# JOY Media — Current State & Architecture Ledger

**Last Updated:** 2026-09-19 (UTC)  
**Primary Surface:** 100% Offline-First Windows Desktop NLE (Electron + React 19 + Local SQLite)  
**Web Surface:** Hardened Control Plane & Account Web (`joyst.ir` via `apps/account-web`)  
**Historical Log:** Preserved at [`docs/archive/STATE-historical-2026-09-18.md`](docs/archive/STATE-historical-2026-09-18.md)

---

## 1. Executive Summary & Architecture

JOY Media has transitioned from a dual web/desktop architecture into a dedicated, **100% offline-first Windows desktop creative suite**.

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
- **AI Agent Intelligence**: Dual-mode engine supporting Free/Open BYOK (OpenRouter / OpenAI) or Joy Pro curated models through the model gateway.

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

## 3. Verification Matrix

| Check                        | Scope                                    | Tool / Command                               | Result                                                                                                                                                             |
| :--------------------------- | :--------------------------------------- | :------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit & Integration Tests** | Full Monorepo                            | `pnpm test`                                  | **608 files passed, 1 skipped; 5,095 tests passed, 3 skipped** (latest full run on this branch)                                                                    |
| **TypeScript Types**         | Full Monorepo                            | `pnpm typecheck` (`tsc -b`)                  | **Clean** (0 errors)                                                                                                                                               |
| **Account Web Build**        | `@joy-media/account-web`                 | `pnpm --filter @joy-media/account-web build` | **Clean** (0.62s)                                                                                                                                                  |
| **Desktop Editor Build**     | `@joy-media/editor-web`                  | `pnpm --filter @joy-media/editor-web build`  | **Clean**                                                                                                                                                          |
| **CI Triggers**              | `.github/workflows/ci.yml`, `ci-dev.yml` | Manual inspection                            | `ci.yml`: `workflow_dispatch`, `pull_request`, and `push` to `main` on `joy-media-ci` / `joy-media-worker-docker` self-hosted runners; `ci-dev.yml`: dispatch-only |

---

## 4. Pending Operational Handoffs

1. **VPS Deployment**:
   - Push 4 pending commits (`e07e398c..6d809229`) plus current cleanup commits to `vps/main`.
   - Execute `deploy/deploy-control-plane.sh` on the Sweden VPS to migrate PostgreSQL schema (`009_agent_usage_ledger`), deploy `account-web`, and apply the hardened Nginx boundary.
2. **Windows Desktop Binary**:
   - Packaged release `apps/desktop/dist/releases/joy-media-windows-x64-v1.0.0.zip` (198 MB) is verified and ready for distribution via `joyst.ir/releases/`.
