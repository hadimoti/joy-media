# ChatGPT Sign-Out and Reauthorization Implementation Plan

> **For agentic workers:** Implement inline in the existing `feature/p4-worker-cli` worktree. The owner approved this behavior design on 2026-10-30.

**Goal:** Give a saved JOY Media ChatGPT profile an explicit remote sign-out/revocation action and a safe same-account reauthorization path.

**Architecture:** Keep OAuth credentials and revocation in Electron main. The renderer receives only profile metadata and invokes explicit IPC actions. Generic profile deletion remains local-only; the ChatGPT-specific action revokes first and removes local state only after success.

**Tech Stack:** TypeScript, Electron IPC, React, existing provider SDK and secret store.

**Spec:** Owner-approved design in this Codex conversation; current status in `C:/Users/HadiMoti/Desktop/joy-media-temps/joy-media-change/session-handoff/NEXT-SESSION.md` §7.

## Global Constraints

- Existing `desktop.provider-profile.delete` remains a local-only removal operation.
- Only a ChatGPT sign-in profile with a valid decoded token record can use remote sign-out or reauthorization.
- OAuth tokens and client IDs stay in the main process and never appear in renderer results, UI text, or errors.
- Remote revocation uses the issuer's OpenID discovery `revocation_endpoint`, the stored refresh token, and `token_type_hint=refresh_token`.
- A revocation failure leaves the stored profile and agent-slot bindings untouched; the user may retry or explicitly remove the profile locally with a warning.
- Reauthorization reuses the saved client ID, requires the verified account subject to match, and preserves the old record unless the replacement is fully validated and saved.
- API-key profiles and other providers keep their current behavior.
- No provider call is made by implementation or automated verification; a live sign-in/revocation requires separate attended authorization.
- Do not push or merge JOY Media code, publish the app, or release it.
- The owner explicitly authorized focused tests on 2026-10-30. Do not expand to full-suite, typecheck, lint, or build checks without further direction.

## Review Focus

- Malformed or cross-origin discovery metadata must not receive a refresh token.
- Network errors, redirects, and non-success revocation responses must preserve the local profile and its slot bindings.
- A reauthorization for another account must not overwrite the saved account or expose the newly issued tokens.
- A generic local delete must not silently invoke the provider revocation endpoint.
- Reauthorization and revocation results must contain no credential material.

## File Map

- `apps/desktop/src/main/oauth/chatgpt.ts` — discover and validate the revocation endpoint; post refresh-token revocation.
- `apps/desktop/src/main/oauth/errors.ts` — safe revocation/account-mismatch error codes.
- `apps/desktop/src/main/oauth/sign-in.ts` — accept saved ChatGPT identity context during profile reauthorization.
- `apps/desktop/src/main/ipc-handlers.ts` — validate profile actions, preserve local-only delete, coordinate reauthorization and remote sign-out.
- `apps/desktop/src/ipc.ts` and `apps/desktop/src/preload/ipc-channels.cjs` — allow-list the new sign-out IPC channel.
- `apps/desktop/src/main/electron-entry.ts` — wire main-process sign-in and revocation callbacks.
- `apps/editor-web/src/desktop-client.ts` — add typed renderer bridge methods without secret fields.
- `apps/editor-web/src/JoyAgentSettingsDialog.tsx` — add explicit reauthorize/sign-out actions and local-removal warning for ChatGPT.
- Focused existing test files for OAuth, both IPC suites, preload channel parity and settings UI — tests were authorized; all 6 focused files pass.

## Tasks

### Task 1: ChatGPT revocation primitive — complete

- Add an injected, read-only discovery fetch and validate exact issuer plus an HTTPS revocation URL on the issuer's origin.
- Add a refresh-token revocation call using form encoding, manual redirects and generic errors that do not include response bodies or credentials.
- Added TDD coverage in `apps/desktop/src/main/oauth/chatgpt.test.ts` for valid discovery, unsafe endpoint rejection, request body, redirects, HTTP failure and network failure.

### Task 2: Main-process profile actions — complete

- Extend the sign-in callback context with the saved ChatGPT client ID and expected account subject, populated only after the main process decodes the existing secret.
- Reject account-subject changes before profile save; preserve the original profile and secret on failure.
- Add a ChatGPT sign-out IPC channel. It validates the token record, performs remote revocation, then deletes the secret/profile and clears bound slots only on success.
- Leave the existing local delete handler unchanged.
- Added IPC/sign-in coverage for reauthorization with the saved client, account/client mismatch revocation, local-only generic deletion, remote sign-out success/failure, and the unchanged one-argument call for first-time sign-ins.

### Task 3: Settings actions — complete

- Add a `Reauthorize` action for saved ChatGPT sign-in profiles; refresh the list after successful replacement.
- Add an explicit `Sign out & revoke` action. On failure, retain the profile and offer retry or a separately confirmed local-only removal that explains the provider grant may remain active.
- Keep the existing local delete behavior for all other profiles.
- Added settings coverage for reauthorization and the declined local-only fallback after remote revocation fails. The UI retains both retry and the separately confirmed local-only action.

### Task 4: Manual review and closeout — implementation and focused verification complete

- Read the complete diff and confirm the global constraints above against each changed path.
- Owner authorized focused tests. The 6 scoped files passed (186 tests); `git diff --check` is clean. No full suite, typecheck, lint, or build was run.
- Update the local handoff and a new VPS Gbrain checkpoint with redacted results; read back the Gbrain write.
- The required redacted Gbrain checkpoint was read back at revision `9d775702-035d-4df1-ba9a-7b8dead5c1d6`; the no-argument export verified at `2221a6bc04030fcfff4a46e1bc0d07c6bdc1f07d`; the PC receipt was published at `fedf1a7d7997ff0673f521bda0742534160cd9ba` under the current user-provided AGENTS closeout contract.
