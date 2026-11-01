# MiniMax Region Selection — Design

## Intent

Let a person choose the MiniMax account and inference region before starting the device-code sign-in. The current flow silently defaults to Global, so a China account cannot select its matching endpoints.

## Goals and non-goals

- Show a region selector with Global (International) selected by default and China as the alternative.
- Carry the selected `MiniMaxRegion` through the desktop bridge and validated main-process IPC into the existing OAuth flow.
- Keep the region in the existing MiniMax token record and regional inference base URL.
- Keep ChatGPT sign-in, saved profiles, credentials, and UI behavior unchanged.
- Do not configure another application's client ID or make a live provider call.

## Approaches

1. Keep Global-only behavior. This has no implementation cost but leaves the recorded China-region gap unresolved.
2. Add an app-wide region preference. This risks applying one account's choice to every MiniMax profile and adds persistence unrelated to the existing per-profile token record.
3. Select the region per sign-in and pass it through the existing request. **Chosen:** region belongs to the account authorization; the existing token record already persists it and the resulting profile already stores the matching inference base URL.

## Constraints and behavior

- Use the provider SDK's `MiniMaxRegion` values: `global` and `cn`.
- Default missing region values to `global` for existing callers; reject invalid values and region fields on non-MiniMax sign-ins in the main process.
- Preserve the current `minimaxClientId` gate. The selector does not enable sign-in without JOY Media's own registered client ID.
- The selector and request payload contain no credentials or tokens.

## Verification

Mocked tests must prove the selector sends `cn`, the main process rejects an invalid region before the sign-in callback, and the MiniMax flow uses the selected regional authorization and inference endpoints. No browser or live provider test is part of this change.
