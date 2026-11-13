# T-J03 Sign-In Cancellation Implementation Plan

> **For agentic workers:** This plan is executed inline in the existing worktree. Follow each task in order and use RED-GREEN tests. Git staging and commits are prohibited by the task prompt.

**Goal:** Make provider sign-in cancellation and replacement attempts safe through the final profile save, and resolve the browser wait at three minutes.

**Architecture:** Keep one latest requested attempt per provider, including starts waiting for an older listener to close. Carry its abort signal through provider HTTP, browser-open, token verification, model lookup, and the IPC save boundary; reject cancelled or superseded results before saving.

**Tech Stack:** TypeScript, Electron IPC, Node fetch/AbortSignal, Vitest fake fetches and timers, React settings panel.

**Spec:** `C:\jgp\v111\evidence\T-J03\prompt-fix-cx.txt`; task card `C:\Users\HadiMoti\Desktop\joy-media-temps\fable-plan\07b-NEW-TASK-CARDS-part2.md` (T-J03).

## Global Constraints

- Never start a real sign-in or contact a real provider; use fake fetch servers and unit tests only.
- Preserve this worktree and its existing branch; do not add, commit, merge, or checkout.
- Put `C:\jgp\tools\node-v24` first on `PATH` for Node commands.
- Run typecheck, changed-file ESLint, Prettier write on changed files, and Vitest for each touched package with `--configLoader runner`.

## Review Focus

- Cancellation while device-code issuance is pending must abort the request and never open the returned page.
- Cancellation after a code is received but before browser open must not open the page.
- Cancellation during device polling, ChatGPT code exchange, or identity-key lookup must stop follow-up work and return `CANCELLED`.
- Cancellation during model lookup or immediately before profile save must write no secret and create or update no profile.
- Concurrent starts must serialize per provider, run only the last pending replacement, and let Cancel target that pending replacement.

---

### Task 1: Propagate cancellation through provider and model requests

**Files:**

- Modify: `packages/provider-oauth/src/kimi.ts`, `xai.ts`, and `chatgpt.ts`.
- Modify: `apps/desktop/src/main/oauth/sign-in.ts`.
- Test: `packages/provider-oauth/src/kimi.test.ts`, `xai.test.ts`, and `chatgpt.test.ts`.
- Test: `apps/desktop/src/main/oauth/sign-in.test.ts`.

**Interfaces:**

- Provider sign-in options carry the attempt `AbortSignal` through discovery, device-code request, browser opening guard, polling, token exchange, and JWKS lookup.
- Desktop model-list helpers accept the same optional signal and abort their fetch/body read when cancelled.

- [ ] Write fake-fetch regression tests for cancellation before device-code response, between code receipt and browser open, during polling, and during model lookup.
- [ ] Run the focused tests and confirm each fails because the relevant request or browser open continues after cancellation.
- [ ] Implement the minimal signal propagation and stable `CANCELLED` mapping.
- [ ] Rerun the focused tests and confirm the cancelled path stops without returning a sign-in result.

### Task 2: Serialize starts and guard the IPC save

**Files:**

- Modify: `apps/desktop/src/main/oauth/sign-in-attempts.ts`, `sign-in.ts`, `electron-entry.ts`, and `ipc-handlers.ts`.
- Test: `apps/desktop/src/main/oauth/sign-in-attempts.test.ts`, `sign-in.test.ts`, `ipc-sign-in.test.ts`, and `ipc-sign-in-attempts.test.ts`.

**Interfaces:**

- `SignInAttempts.start(provider, run)` owns the full sign-in operation from preflight through profile save; `cancel` addresses its active or pending entry.
- `providerSignIn(provider, context, call)` receives the active attempt signal and guarded browser opener.

- [ ] Add failing tests for two replacement requests waiting on one old attempt, latest-only execution, and Cancel of a pending replacement.
- [ ] Add failing IPC tests proving cancel/supersede immediately before save writes neither a profile nor a secret.
- [ ] Move attempt ownership to the full IPC flow, propagate the signal, and check it at the save boundary.
- [ ] Run attempt, sign-in, and IPC tests; confirm replacement attempts are serialized and cancelled results leave storage unchanged.

### Task 3: Settle the browser wait at three minutes

**Files:**

- Modify: `packages/provider-oauth/src/loopback.ts` and `apps/editor-web/src/ProviderSignInPanel.tsx`.
- Test: `packages/provider-oauth/src/loopback.test.ts` and `apps/editor-web/src/ProviderSignInPanel.waiting.test.tsx`.

**Interfaces:**

- The main-process callback timeout and settings countdown both use 180,000 ms.

- [ ] Update behavior tests to expect the three-minute wait and countdown.
- [ ] Confirm the ChatGPT loopback flow in this repository has no provider-imposed minimum wait beyond receiving the callback; set the shared timeout to three minutes.
- [ ] Run the changed package suites, typecheck, changed-file ESLint, and Prettier write on every changed file.
- [ ] Review the full diff for unintended provider calls, credentials, or storage effects.
