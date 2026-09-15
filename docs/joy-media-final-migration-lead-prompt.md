# JOY Media final migration — Claude Code lead brief

You are the implementation lead for the final JOY Media migration. Work only in this isolated worktree and use the installed Claude Code model `claude-sonnet-5`. Do not use Kilo, do not access owner browser profiles, do not read or print secrets, and do not deploy, restart VPS services, retire production routes, or enable live payments. Commit focused changes after each wave; Codex will independently verify, push, update Gbrain, and make release decisions.

## Required product outcome

Build a signed Windows Electron desktop application from the existing React/Node JOY editor. The desktop must own editing, local media ingest, monitoring/preview, export, Worker jobs, project persistence, and the built-in JOY Agent. Keep the renderer behind a narrow sandboxed/preload IPC boundary. Use durable local SQLite (or an equivalent transactional embedded store with a documented reason), atomic project/document writes, checksummed media references, supervised child processes, and deterministic recovery after crashes.

`joyst.ir` is reduced to OTP login, installer/download page, account/subscription panel, and release metadata. The VPS retains only OTP, user/device/session, subscription/entitlement, payment-verification, and release metadata APIs. Hosted project/media/render/preview/job/control-plane paths must be feature-flagged or retired only after the later archive and acceptance wave.

## Locked owner decisions

- Provider API keys are owned by each user. Persist them only in Windows-protected storage (DPAPI/Keychain equivalent) through the host; `.env` is for non-secret configuration and one-time local import only. Never put provider keys in renderer state, project files, logs, telemetry, Git, or Gbrain.
- After initial activation, editing and export work offline. Internet is required for OTP, account/subscription, entitlement refresh, release download/update, and hosted-AI/provider actions.
- Archive existing hosted/browser projects and start a fresh desktop workspace. Provide a reversible, encrypted, checksummed archive export and a clear import boundary; do not silently migrate or delete customer data.
- One paid plan with monthly and yearly billing. An active subscription gates new releases and updates; the installed version remains usable after expiry. Device/session entitlements must be signed, time-bounded, revocable, and safe under clock rollback/offline use.
- Prices are USD. Settlement is USDC only on Ethereum mainnet. Use the exact Nutrized public USDC contract and recipient only after protected verification of deployed configuration; never copy Alchemy API keys or signing secrets. Use exact integer base units, unique invoice identity/amount, canonical RPC confirmation checks, webhook signature verification, replay/out-of-order deduplication, and exactly-once entitlement activation.
- Public release requires a signed Windows x64 installer and a verified update/rollback path.

## Ordered implementation waves

0. **Preflight/architecture:** map current editor, desktop contract, Worker, persistence, auth, deploy, and Nutrized payment surfaces; write a migration design and an explicit hosted-service retirement list. Add no secrets. Commit docs only if useful.
1. **Desktop host/IPC:** bootstrap Electron main/preload/renderer packaging; sandbox/context isolation; narrow typed channels for file selection, local jobs, worker status, project open/save, entitlement state, and provider-profile operations; enforce origin/path boundaries and crash-safe shutdown.
2. **Local runtime:** implement SQLite/transactional project store, media manifest and local asset roots, supervised Worker/media/export services, monitor/preview data path, cancellation/recovery, and offline-first editor startup. Remove runtime dependence on hosted project/media/render endpoints for local workflows.
3. **JOY Agent/BYOK:** move the existing JOY Agent protocol and local engine behind the desktop host; implement persistent encrypted user provider profiles, volatile request handoff, model/base-url validation, direct-provider adapters, offline capability reporting, and redacted diagnostics. Preserve approval/revision/readback semantics.
4. **VPS/account/site:** add migrations and routes for device registration, signed entitlements, monthly/yearly subscriptions, release channels/metadata, self-service account panel, OTP login, and desktop download links. Make retired project/media/job routes fail closed with an explicit migration response after cutover flags are enabled.
5. **USDC/Alchemy:** adapt the Nutrized checkout patterns to a JOY invoice ledger, USD-only catalog, USDC-only Ethereum mainnet flow, protected Alchemy webhook/RPC configuration, canonical confirmation polling, exact amount/invoice matching, duplicate tx/log protection, expiry/refund-safe state transitions, and an operator-safe reconciliation view. Keep checkout disabled until the live-wallet test gate is recorded.
6. **Archive/cutover guards:** implement encrypted export/checksum manifest for hosted/browser data, fresh-start desktop initialization, backup/restore and rollback runbooks, VPS service retirement flags, Nginx website boundary, and no-data-loss verification. Do not delete releases or databases.
7. **Packaging/release:** produce signed Windows installer/update artifacts, clean-machine install/upgrade/uninstall checks, secure auto-update policy, release manifest/identity, and a final acceptance report. Leave deployment/public cutover for Codex after independent checks and external Astra approval.

## Required engineering discipline

- Use the repo's existing package/build/test conventions. Add focused tests for every new contract, including Windows-path and offline behavior where possible. Do not claim full CI unless it was actually run.
- Keep commits small and named by wave. At each wave end report: commit SHA(s), files changed, commands/tests and results, known blockers, and the exact next gate in `docs/joy-media-final-migration-progress.md`.
- Preserve unrelated user changes and existing release history. Never run destructive resets. Never commit `.env`, credentials, cookies, private keys, wallet signing material, or customer exports.
- Stop and ask Codex for a gate when a task would deploy, restart/retire VPS services, alter production data, enable checkout, or publish a signed release.

Start by reading the repository instructions, the existing desktop/Worker/editor/auth code, and this brief. Then implement wave 0 and continue sequentially, keeping the worktree buildable after every wave.
