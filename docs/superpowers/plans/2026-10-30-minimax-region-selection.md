# MiniMax Region Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Global/International and China selectable for MiniMax device-code sign-in.

**Architecture:** Keep a `MiniMaxRegion` selector in `ProviderSignInPanel`, send the chosen value through `signInDesktopProviderProfile`, validate it in `asSignInRequest`, and expose it only in the main-process `ProviderSignInContext`. `createProviderSignIn` uses that region for OAuth and model discovery; the existing token record and profile base URL retain it.

**Tech Stack:** TypeScript, React, Electron IPC, Vitest, jsdom.

**Spec:** `docs/superpowers/specs/2026-10-30-minimax-region-selection-design.md`

## Global Constraints

- Use only `MiniMaxRegion` values `global` and `cn`; default omitted values to `global`.
- Reject invalid region values and region fields on non-MiniMax sign-in requests before invoking the sign-in callback.
- Keep MiniMax disabled by the existing missing-client-ID guard; do not configure a public third-party client ID.
- Do not make live provider calls or alter ChatGPT sign-in behavior.
- Preserve all pre-existing uncommitted ChatGPT sign-out/reauthorization changes.

## Review Focus

- Missing region: continues using Global/International.
- Invalid or unsupported region: IPC rejects it before any sign-in starts.
- Region supplied to ChatGPT: rejected and never forwarded.
- China selection: reaches the MiniMax OAuth and inference endpoints and is stored in the returned token record.
- Missing JOY Media client ID: still refuses before opening a browser or making a request.

---

### Task 1: Validate and route the MiniMax region in the main process

**Files:**

- Modify: `apps/desktop/src/main/ipc-handlers.ts`
- Modify: `apps/desktop/src/main/oauth/sign-in.ts`
- Test: `apps/desktop/src/main/ipc-sign-in.test.ts`
- Test: `apps/desktop/src/main/oauth/minimax.test.ts`
- Test: `apps/desktop/src/main/oauth/sign-in.test.ts`

**Interfaces:**

- `ProviderSignInContext` adds optional `minimaxRegion: MiniMaxRegion`.
- `desktop.provider-profile.sign-in` accepts optional `region` only for `provider: 'minimax'`; absent region resolves to `global`.

- [x] Add IPC tests proving `cn` reaches the sign-in callback and invalid/non-MiniMax region values are refused before callback or profile writes.
- [x] Run the focused IPC tests and confirm the new behavior fails before implementation.
- [x] Freeze the absolute-expiry MiniMax negative-test fixtures so state/host/missing-user-code assertions reach their intended branches.
- [x] Add the per-call region to the validated main-process context and use it in the MiniMax OAuth and model-list path; retain the client-ID gate.
- [x] Update the MiniMax sign-in test to pass `cn` per call and assert China account, authorize, inference, and token-record region values.
- [x] Run `node node_modules/vitest/vitest.mjs run apps/desktop/src/main/ipc-sign-in.test.ts apps/desktop/src/main/oauth/sign-in.test.ts`.

### Task 2: Expose the region choice in the desktop sign-in panel

**Files:**

- Modify: `apps/editor-web/src/ProviderSignInPanel.tsx`
- Modify: `apps/editor-web/src/desktop-client.ts`
- Test: `apps/editor-web/src/ProviderSignInPanel.test.tsx`
- Test: `apps/editor-web/src/JoyAgentSettingsDialog.test.tsx`

**Interfaces:**

- `signInDesktopProviderProfile` accepts `region?: MiniMaxRegion`.
- The panel labels the selector `MiniMax account region`; options are `Global (International)` (`global`) and `China` (`cn`).

- [x] Add a DOM test proving Global is the initial value and selecting China sends `{ provider: 'minimax', region: 'cn' }` through the existing IPC channel.
- [x] Run the focused panel test and confirm it fails before implementation.
- [x] Add the selector only when MiniMax is among the registry sign-in providers; send the selected region only for MiniMax.
- [x] Update the integrated settings test helper to identify the provider select after the new region select is rendered.
- [x] Run `node node_modules/vitest/vitest.mjs run apps/editor-web/src/ProviderSignInPanel.test.tsx`.

### Task 3: Verify and review the complete round

**Files:** The files above plus this plan/design.

- [x] Run the combined focused tests for both tasks and preserved ChatGPT profile-auth flow (7 files, 196 passed).
- [x] Run `node node_modules/typescript/bin/tsc -b` and ESLint on the touched implementation/integration files.
- [x] Check the diff and confirm the pre-existing ChatGPT changes remain intact and unstaged.
- [x] Ask MCode for a read-only review of only this round; received explicit `APPROVED` before committing.
- [ ] Commit only this round's explicit files on `feature/p4-worker-cli`; do not push, merge, or release.
