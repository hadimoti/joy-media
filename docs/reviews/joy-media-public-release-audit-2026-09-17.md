# JOY Media — public open-source + SaaS readiness audit

**Date:** 2026-09-17 · **Scope:** `apps/desktop`, `apps/editor-web`, `apps/api`, `apps/worker`,
`packages/*`, `deploy/` · **Baseline commit:** `75bddef0` (branch `main`, clean tree)

**Target architecture assumed by this audit (per owner directive):**

1. No cloud assets / cloud projects. ParsPack bucket retired. The product is a local Windows
   Electron desktop app; `joyst.ir` is not a live web editor.
2. `joyst.ir` VPS scope is exactly: (a) registration/login via OTP, (b) subscription plans +
   user DB, (c) Joy Agent API gateway proxying OpenRouter with commission/usage accounting.
3. Repo goes public; local editor is free; the paid tier unlocks the built-in Joy Model via the
   VPS proxy so users need no API key of their own. BYOK stays as a free alternative.

---

## 0. Executive summary — the five things that block everything else

| # | Blocker | Evidence |
|---|---------|----------|
| B1 | **`main` does not typecheck and does not lint.** | `pnpm typecheck` → 2 × TS2345 in `apps/editor-web/src/AssetLibraryPanel.tsx:562,598`; `pnpm lint` → 9 errors. Cannot publish a repo whose default branch fails its own `pnpm check`. |
| B2 | **The desktop app cannot reach the VPS at all.** Every API call in the renderer is the relative path `/api/...`. Under the packaged origin `joy-media-app://renderer` that resolves to `joy-media-app://renderer/api/...`, never to `joyst.ir`. | `apps/editor-web/src/media-session.ts:58`, `identity.ts:57,93,130`, `control-plane-client.ts:299` |
| B3 | **The local Worker never runs a job.** It only enters its daemon loop when `JOY_MEDIA_API_URL` is set and it has paired with the *remote* control plane. The desktop supervisor spawns it with no env and there is no local job channel. | `apps/worker/src/index.ts:35-80`, `apps/desktop/src/main/worker-supervisor.ts:67` |
| B4 | **Subscription / entitlement / auto-update is dead code end-to-end.** `checkForDesktopUpdate` is exported and unit-tested but never called by any renderer code; there is no sign-in, account, or subscription UI in the desktop shell. | `apps/editor-web/src/desktop-client.ts:109` — zero non-test callers |
| B5 | **Production VPS host, root user and SSH key paths are committed in tracked Markdown.** | `STATE.md:188` (`82.115.8.224`, root, key path), `ORCHESTRATION.md:98` (`46.249.103.142`), `AGENTIC_EDITING_NEXT_AGENT.md:41` |

No plaintext credentials, `.env`, `.pem`, or API keys are tracked — verified via
`git ls-files`. Every `apiKey`/`secret` literal found is a test fixture.

---

## 1. Dead, vestigial, and legacy cloud code

### 1.1 ParsPack / S3 object store — remove

| Path | What it is | Action |
|---|---|---|
| `apps/api/src/private-object-store.ts` (556 ln) | `RclonePrivateObjectStore` + `createParsPackClient` + hand-rolled SigV4 client; hardcodes `remoteName !== 'parspack'` (line 263) and reads credentials out of `rclone.conf` (line 279) | **Delete** |
| `apps/api/src/private-object-store.test.ts` | Companion tests | Delete |
| `apps/api/src/resumable-original-upload.ts` (559 ln) | Multipart original upload staging into the bucket | Delete |
| `apps/api/src/import-alpha-library.ts` | Root-only importer registering rclone-verified ParsPack refs | Delete |
| `apps/api/src/stock-video*.ts` (5 files, ~1000 ln) | Pexels/Pixabay broker that downloads into the private bucket | Delete, or re-home as a desktop-local fetcher |
| `apps/api/src/server.ts:83-118` | Wires all of the above | Remove wiring |
| `.agent/skills/alpha-asset-library-builder/alpha_asset_builder/cloud_import.py` | Tracked Python that imports into the bucket; ships to the public repo | Delete or untrack |

### 1.2 Hosted control plane — the largest single removal

`apps/api/src/control-plane.ts` (2280 ln), `postgres-control-plane.ts` (2477 ln),
`project-document-store.ts` (701 ln), `project-document-sync-request-validation.ts`,
`project-snapshot-service.ts`, `project-intelligence-service.ts`, `gpu-preview-transport.ts`,
`export-remux.ts`, `spectral-denoise*.ts`, `whisper-transcribe.ts`, `speech-synthesize.ts`,
`asset-hermes-tags.ts`.

`apps/api/src/http-server.ts` is 2925 lines routing ~50 endpoints. Under the target
architecture only these survive:

```
KEEP   POST /v1/auth/request-otp · POST /v1/auth/verify-otp · POST /v1/auth/logout
       GET  /v1/auth/session · GET /v1/auth/avatar
       POST /v1/devices · GET /v1/devices · POST /v1/devices/:id/revoke
       GET  /v1/account/subscription · POST /v1/account/subscription
       POST /v1/entitlements/refresh · GET /v1/entitlements/public-key
       POST /v1/billing/invoices (+ /:id, /:id/submit-tx) · POST /v1/billing/webhooks/alchemy
       GET  /v1/releases/:channel
       GET  /live /ready /health
ADD    POST /v1/agent/chat/completions   (Joy Model gateway — §3)
       GET  /v1/agent/models · GET /v1/agent/usage
DELETE everything under /v1/projects/*, /v1/workers/*, /v1/worker-pair/*,
       /v1/preview-sessions/*, /v1/library/*, /v1/providers/speech/*,
       /v1/providers/audio/*, /v1/providers/mistral/*, /v1/providers/reasoning
```

The retirement scaffolding already exists and is the right mechanism to stage this:
`hosted-route-retirement.ts` (7 enumerated routes, flag-gated, fails closed with 410),
`legacy-editor-retirement.ts` (coarse kill switch that makes `authenticate` return
`undefined`), `joy-agent-route-retirement.ts` (already-retired reasoning routes). **Every flag
defaults `false` and `apps/api/src/server.ts` never sets one**, so today the full legacy surface
is still live. Recommended order: flip flags on the VPS → observe → delete code → drop tables.

### 1.3 Editor-web cloud surface

- `apps/editor-web/src/control-plane-client.ts` (1177 ln) — the whole hosted client. After
  §1.2 only the auth/account/releases calls remain; the rest goes.
- `apps/editor-web/src/AssetLibraryPanel.tsx` — still carries the full cloud-backup UX
  (`shareToCloud`, "backed up to private cloud storage", `cloudAssetIds`, `cloudObjectPurgeFailures`,
  `Cloud library unavailable…`) at lines 491, 699-786, 818-832. The desktop path is branched in
  via `isDesktopHost()` but the cloud path was left beside it rather than removed.
- `apps/editor-web/src/cloud-preview-queue.ts` — exists to throttle "rclone-backed requests";
  keep the class (it is a generic concurrency queue) but rename and re-purpose, or delete.
- `apps/editor-web/src/project-control-plane.ts`, `project-document-sync.ts`,
  `project-document-autosync.ts`, `project-document-hydration.ts` — server-CAS project sync.
- `BrowserAsset.cloudBacked`, `sharedCloudAssets()`, `sharedCloudOriginalBytes()` — remove from
  the type and every call site.

### 1.4 Other dead weight

- **`apps/render-host/` is an empty shell** — a README, a stale `dist/`, and a
  `tsconfig.tsbuildinfo`. No `src/`. Delete the app or state clearly that it is unimplemented.
- **`apps/worker/src/control-plane-client.ts` + `pairing-loop.ts` + `pairing-notification.ts`** —
  remote pairing; obsolete once the worker is driven locally (§4.2).
- **`packages/adapter-openrouter`** — its own header says "Does NOT resolve environment
  variables… The adapter never calls this in the current implementation (fail-closed)". It is a
  stub. Either make it the gateway's real client or delete it.
- **`packages/adapter-deepseek-harness`, `packages/adapter-comfyui`, `packages/scene3d-core`,
  `packages/renderer-pixi-web`, `packages/production-quality`, `packages/render-planner`,
  `packages/ui-kit`** — several have no `src/` in the tree listing (dist-only). Audit each for
  "is this shipped or is it scaffolding" before going public.
- **Stale packaging artifact:** `apps/desktop/dist/joy-media-win32-x64/resources/app/dist/
  joy-media-win32-x64/resources/app/dist/...` is nested **5 levels deep**. The current
  `package-release.mjs:98-100` correctly skips `joy-media-unpacked` and `joy-media-win32-x64`,
  so this is stale output from an older run — but `package-installer.mjs:69` copies
  `unpackedDir` wholesale into `resources/app` with no guard. Add an explicit
  `rm -rf apps/desktop/dist` prepass and an assertion that the staged tree contains no
  `joy-media-win32-x64`.

### 1.5 Documentation debt (264 tracked `.md` files)

`README.md` still advertises `media.joyteam.ir` as the editor entry, describes a "lightweight
JOY VPS control plane", and points new readers at `JOY_MEDIA_MASTER_PLAN.md` (188 KB),
`STATE.md` (409 KB), and `ORCHESTRATION.md` — an internal agent-orchestration protocol. For a
public repo this is actively misleading. `docs/reviews/` and `plan/` contain ~70 files of
agent handoff notes, evidence ledgers, and worktree paths that no external contributor can use.

---

## 2. Security, privacy, and public-repo blockers

### S1 — Production infrastructure identifiers in tracked files · **critical**

- `STATE.md:188` — `82.115.8.224`, user `root`, key `C:\Users\HadiMoti\.ssh\Joy-Vps-New.pem`,
  plus the `ssh sweden` alias convention.
- `ORCHESTRATION.md:98` — a *second* IP, `46.249.103.142`, with CPU/RAM/disk inventory.
- `AGENTIC_EDITING_NEXT_AGENT.md:12,41,511` — checkout path and `.pem` path.
- `docs/SELF-HOSTED-CI.md`, `ops/self-hosted/linux-runner/entrypoint.sh:12`,
  `ops/self-hosted/linux-runner/README.md:17` — `hadimoti/joy-media` and runner registration
  procedure.
- ~40 files under `docs/reviews/`, `docs/qa/`, `plan/` with `C:\Users\HadiMoti\...` paths.

**Action:** treat the VPS IPs as compromised-on-publish — rotate the SSH key and restrict by
source before the repo flips public. Then scrub. Because these are in *git history*, scrubbing
HEAD is insufficient: either squash to a fresh initial commit for the public repo, or run
`git filter-repo` over the affected paths. A fresh public repo seeded from a clean tree is the
lower-risk option and also solves §1.5.

### S2 — Remote origins in the desktop IPC allow-list · **high**

`apps/desktop/src/origin-policy.ts:3-4` allow-lists `https://joyst.ir` and
`https://www.joyst.ir` as editor origins. `apps/desktop/src/ipc.ts`'s `isAllowedIpcRequest`
gates every IPC channel on that list, and the channel list includes
`desktop.provider-profile.begin-session`, which returns the **decrypted plaintext API key**
(`apps/desktop/src/main/ipc-handlers.ts:200-221`). Any page served from `joyst.ir` that gets
loaded into the shell inherits full file-dialog and secret-store access. The app never loads
`joyst.ir` — so remove both entries and reduce the list to `joy-media-app://renderer` plus the
dev-server origins (gated on `isDev`).

### S3 — IPC origin is renderer-supplied, not verified · **high**

`preload.cjs` puts `window.location.origin` into the request body; `electron-entry.ts:137`
handles it as `(_event, request)` and discards the event. The main process should derive the
origin from `event.senderFrame.url` and reject any mismatch. Today the origin check is a
formality.

### S4 — No Content-Security-Policy anywhere · **high**

`apps/editor-web/index.html` has no CSP meta tag, and no `session.defaultSession
.webRequest.onHeadersReceived` handler sets one. An Electron renderer that executes
user-supplied HTML scenes (`packages/html-scene-runtime`), plugin code
(`apps/editor-web/src/plugin-host.ts`), and model output with **no CSP** is the single largest
remaining attack surface. Add a strict CSP for the `joy-media-app://` origin, and add a
`will-navigate` handler (only `setWindowOpenHandler` is present, `electron-entry.ts:239`).

### S5 — `joy-asset://` handler: weak boundary check + wildcard CORS · **medium**

`apps/desktop/src/main/electron-entry.ts:186-190`:

```ts
const resolvedPath = path.normalize(path.join(baseDir, relPath));
const normalizedBase = path.normalize(baseDir);
if (!resolvedPath.startsWith(normalizedBase)) { /* 403 */ }
```

`startsWith` is a prefix test, not a path-boundary test: with `baseDir = C:\lib`, the path
`C:\library-private\x` passes. Compare with `path.relative(base, resolved)` instead and reject
results starting with `..` or absolute. Separately, every response carries
`Access-Control-Allow-Origin: *` on a scheme registered as `standard, secure, corsEnabled` —
scope it to the renderer origin.

### S6 — Unvalidated user-chosen library directory · **medium**

`desktop.asset-library.set-directory` (`ipc-handlers.ts:264-275`) accepts any non-empty string.
Combined with S5, pointing the library at `C:\` turns the app into a read-anything local file
server for the renderer. Validate: must exist, must be a directory, must not be a system root,
and should require the native picker path for first-time selection.

### S7 — `catalog.json` is parsed untrusted and cast to a typed contract · **medium**

`ipc-handlers.ts:288-306` does `JSON.parse(fs.readFileSync(catalogPath))` with no schema check
and returns it; `AssetLibraryPanel.tsx:297-299` does
`catalog.assets as readonly BrowserAsset[]`. A malformed or hostile catalog file propagates
arbitrary shapes into rendering code. Validate with a zod schema at the IPC boundary
(`zod` is already a dependency).

### S8 — Session token in `localStorage` · **medium**

`apps/editor-web/src/media-session.ts:8` stores the bearer token under
`joy-media-session-token` in `localStorage`. In a desktop shell with no CSP (S4) and a plugin
host, move it to `safeStorage` behind a new IPC channel.

### S9 — Hardcoded attribution origin in the worker · **low**

`apps/worker/src/local-ai.ts:123` sends `'HTTP-Referer': 'https://joyst.ir'`. Fine as OpenRouter
attribution, but it should come from a constant shared with the gateway config, not a literal.

### S10 — `apps/api/src/media-mailer.ts:15` hardcodes `https://joyst.ir/assets/...` for the OTP
email logo; `apps/desktop/src/main/auto-update-policy.ts:35` hardcodes the release-host
allow-list `['joyst.ir','www.joyst.ir']`. Both are legitimate product constants, but in a
public repo they should be single, documented, overridable configuration points rather than
scattered literals. **This is the right call for a public repo — do not try to hide the
domain, just centralize it.**

---

## 3. Agent & API architecture — implementing the Joy Model gateway

### 3.1 What exists today

- **BYOK only.** `packages/joy-agent-engine/src/provider-config.ts:3-8` defines
  `ByokSessionConfig` with `provider: 'openrouter' | 'openai-compatible'` and a **required**
  `apiKey`. There is no third mode.
- The agent runs entirely **in a browser Worker** in the renderer:
  `apps/editor-web/src/joy-agent/engine.worker.ts` (~1500 ln) receives a `configure(config)`
  message (line 721) carrying the plaintext key, builds an `@ai-sdk/openai-compatible` provider
  (`joy-agent-engine/src/provider.ts:80`) and talks to the provider origin directly.
- `createHardenedFetch` (`provider.ts:14`) pins traffic to exactly one origin, forces
  `credentials: 'omit'`, `redirect: 'error'`, and bounds the response body to 2 MiB. **This is
  good and should be reused unchanged for the gateway origin.**
- Desktop BYOK profiles are stored properly: key in `safeStorage`
  (`apps/desktop/src/main/secrets/electron-secret-store.ts`), metadata in SQLite, plaintext
  released only via `begin-session`.
- **A server-side model proxy precedent already exists:**
  `apps/api/src/mistral-provider.ts` (604 ln) + `/v1/providers/mistral/complete`
  (`http-server.ts:888`) with a Postgres invocation ledger, idempotency claim/lease,
  `computePrivacyPreflight`, and explicit spend approval. This is the exact skeleton the Joy
  gateway needs.
- Billing/entitlement plumbing exists: `account-service.ts` (`monthly|yearly`, `none|active|
  expired`), `entitlement-signing.ts` (Ed25519 signed entitlements + pinned public key),
  `usdc-*.ts` (checkout, ledger, Alchemy webhook), all disabled-by-default.

### 3.2 What is missing

1. No `joy-hosted` provider mode in the engine. `normalizeByokSessionConfig` rejects an empty
   `apiKey`, so a keyless session is impossible by construction.
2. No gateway route. Nothing proxies OpenRouter for an authenticated subscriber.
3. No usage/commission accounting. The Mistral ledger records invocations for idempotency, not
   tokens or cost.
4. No model catalog surfaced to the client.
5. The gateway cannot use the current auth boundary as-is: `/v1/providers/*` sits *after*
   `const actor = await options.authentication.authenticate(request)`
   (`http-server.ts:775`), which is the **legacy control-plane actor** — `undefined` whenever
   `durableControlPlane` is unset or `legacyEditorRetired` is on. The gateway must authenticate
   against the **mediaAuth OTP identity**, the same one `/v1/auth/*` and `/v1/account/*` use.

### 3.3 Recommended design

**A. Engine: add a third provider mode.** In
`packages/joy-agent-engine/src/provider-config.ts`:

```ts
export type JoyProviderMode = 'joy-hosted' | 'openrouter' | 'openai-compatible';
// joy-hosted: baseUrl = <gateway origin>/v1/agent, apiKey = the user's JOY session token,
//             modelId = a gateway-catalog id. No provider key ever reaches the client.
```

Everything downstream (`createJoyAgentProvider`, `createHardenedFetch`, the Worker's
`configure`) already works unchanged, because the gateway speaks OpenAI-compatible
`/chat/completions`. Relax only the `apiKey`-presence branch and add the mode to the
`isSafeBaseUrl` check in `engine.worker.ts:721`. **Do not thread a second transport through the
engine — reuse the OpenAI-compatible path.** This is the smallest correct change.

**B. API: new module `apps/api/src/joy-model-gateway.ts` + routes.**

```
POST /v1/agent/chat/completions   OpenAI-compatible, streaming (SSE) passthrough
GET  /v1/agent/models             gateway catalog (id, display name, context, price class)
GET  /v1/agent/usage              current period tokens + spend for the caller
```

Per-request pipeline:

1. Authenticate via `mediaAuth.authenticate(request)` — **not** the legacy actor.
2. Load the subscription (`AccountService.subscription`); require `status === 'active'`.
   Return `402 JOY_SUBSCRIPTION_REQUIRED` otherwise, and have the client fall back to the BYOK
   dialog.
3. Resolve `modelId` against a **server-side allow-list** — never forward a
   client-supplied model string to OpenRouter.
4. Enforce a quota check against the period ledger *before* the upstream call, and a
   concurrency cap per owner.
5. Call OpenRouter with the server's own key, read from a systemd `LoadCredential=` file —
   follow the existing `readEntitlementSigningKeyFromCredential` /
   `stock-video-credentials.ts` pattern, never `process.env`, never committed.
6. Stream the response back. Strip every upstream header except content-type.
7. On completion, write a usage row.

**C. Usage & commission ledger.** New table via `postgres-migrations.ts`:

```sql
CREATE TABLE agent_usage (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  upstream_cost_micros BIGINT NOT NULL,   -- from OpenRouter's usage/generation data
  billed_cost_micros  BIGINT NOT NULL,    -- upstream × (1 + commission_rate)
  commission_rate_bps INTEGER NOT NULL,   -- snapshot the rate on each row, never join to a
                                          -- mutable config table
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX agent_usage_owner_period ON agent_usage (owner_id, created_at DESC);
```

Notes: OpenRouter returns real cost when you pass `usage: { include: true }` — use that rather
than a local price table, which drifts. Snapshot `commission_rate_bps` per row so historical
invoices stay reproducible. Reuse the idempotency-claim machinery from
`mistral-provider.ts:60-110` verbatim so a retried request is never double-billed.

**D. Client UX.** `apps/editor-web/src/JoyAgentSettingsDialog.tsx` currently offers only
provider/baseUrl/modelId/apiKey. Add a mode switch at the top:

- **JOY Model (subscription)** — default when a subscription is active. No key fields.
  Shows the model catalog from `GET /v1/agent/models` and period usage.
- **Bring your own key** — always available and always free. Existing flow unchanged.

Free users must see the BYOK path as a first-class option, not a degraded one — that is the
open-source promise.

**E. Guardrails that must ship with it.** Per-owner rate limit distinct from the global
`consumeRateLimit` (`http-server.ts:186`); a hard monthly spend ceiling per owner with a
`402` on breach; request-body cap (the gateway must not inherit
`DEFAULT_MAX_JSON_BODY_BYTES` of 1 MiB blindly once images are attached — the engine already
supports image/audio/video modalities, see `multimodal-transport.ts`); and **no logging of
prompts or completions** — `packages/joy-agent-engine/src/redaction.ts` exists, apply the same
discipline server-side.

---

## 4. Missing features, UX gaps, and stability

### 4.1 Desktop cannot talk to the VPS (B2) — must fix first

Introduce a single resolved API origin instead of the hardcoded `/api`:

```ts
// apps/editor-web/src/api-origin.ts
export function apiOrigin(): string {
  return isDesktopHost()
    ? (import.meta.env.VITE_JOY_API_ORIGIN ?? 'https://joyst.ir')
    : '/api';
}
```

Then replace `/api` in `media-session.ts:58`, `identity.ts:57,93,130`, and
`control-plane-client.ts:299`. Without this, §3's gateway, login, subscriptions, and
auto-update are all unreachable from the shipping product.

### 4.2 The local Worker does no work (B3) — must fix

Today `apps/worker/src/index.ts` requires `JOY_MEDIA_API_URL` + remote pairing to enter
`WorkerDaemon.run`. In desktop mode there is no such server. Consequences:

- `desktop.request-derivative` enqueues into SQLite (`ipc-handlers.ts:114`); nothing consumes
  the queue; `localDatabase.recoverInterrupted()` cancels the rows at next launch
  (`electron-entry.ts:67`). Thumbnails, proxies, exports, upscaling, masking and ML denoise are
  all inert.
- The supervisor spawns the child with `{ cwd }` only (`worker-supervisor.ts:67`), no env. The
  worker prints `hello` and then either exits (→ supervisor restarts it 3× then marks
  `degraded`) or idles holding an open GPU-preview browser. Either way the status the UI shows
  is not the status the user needs.

**Fix:** add a local transport. Either (a) a loopback HTTP server in the Electron main process
implementing the small subset of the worker protocol the daemon already speaks — cheapest, no
worker changes — or (b) a `WorkerLocalClient` that reads jobs from `LocalDatabase` over stdio.
(a) is the lower-risk path and lets you delete `pairing-loop.ts` at the same time.

### 4.3 Projects have no file format and no Save/Open · **high**

Project state lives in the renderer's browser storage: `BrowserProjectStore` /
`BrowserKeyValueStore` keyed by `joy-media.project-catalog.v1`, `joy-media.active-project.v1`
(`apps/editor-web/src/project-catalog.ts:13-16`). There is **no** project IPC channel
(see the 21-entry `IPC_CHANNELS` list) and `SqliteProjectStore` from
`@joy-media/project-persistence/desktop` is used only by `apps/cli`, never by the desktop app —
`electron-entry.ts:296` says so explicitly. For a desktop NLE this means: no `.joyproj` file,
no Save As, no Open Recent from disk, no moving a project between machines, and clearing app
data silently destroys work. This is the biggest *product* gap after B2/B3.

### 4.4 Auto-update path is fully built and never invoked (B4)

`evaluateAutoUpdate` (main process, pinned key, signature verification, downgrade protection),
`release-signing.ts`, `release-metadata-service.ts`, `release-publish-cli.ts` and
`GET /v1/releases/:channel` all exist and are tested. `checkForDesktopUpdate` has **zero**
non-test callers. Also note the policy only *decides*; nothing downloads or installs. Needs:
a renderer call site, a download+verify+install step, and an update UI.

### 4.5 No account / subscription / billing surface in the desktop app

`LoginGate` is browser-only and `identity.ts:50` short-circuits the desktop to a synthetic
`Local Creator` session. That is correct for "the editor is free", but there is then no way for
a user to sign in, buy a plan, see usage, or manage devices. Needs a Settings → Account pane
wired to `/v1/auth/*`, `/v1/account/subscription`, `/v1/devices`, `/v1/billing/*`.

### 4.6 Maintainability

- `apps/editor-web/src/App.tsx` is **8,539 lines**. `http-server.ts` is 2,925. `control-plane.ts`
  is 2,280. For an open-source repo inviting contribution these need decomposition — App.tsx in
  particular is the file every contributor must touch.
- 264 tracked Markdown files, most of them internal agent transcripts.
- No `CONTRIBUTING.md`, no `CODE_OF_CONDUCT.md`, no `SECURITY.md`, no issue/PR templates, no
  build-from-source instructions for a non-owner.
- `docs/security/` contains a single 977-byte README.

### 4.7 CI

`.github/workflows/` has 6 workflows. Per project memory, Actions is blocked on a billing
issue, which is consistent with B1 (a typecheck failure sitting on `main`). A public repo needs
at minimum a green `pnpm check` on every PR before it is announced.

### 4.8 Licensing gate (still open, carried from `docs/OPEN_SOURCE_RELEASE.md`)

Fonts are resolved (Fontsource OFL-1.1, attributed in `THIRD_PARTY_NOTICES.md`). Still
unresolved: whole-artifact review of bundled dependencies, media, templates, and **codecs** —
the worker shells out to `ffmpeg`/`ffprobe` (`apps/worker/src/runtime.ts:376`); confirm whether
the installer bundles binaries and under which build/licence.

---

## 5. Suggested sequencing

**Phase 0 — unblock (days).** Fix B1 (typecheck + lint green). Rotate the VPS SSH key and
restrict access. Decide: scrub history vs. fresh public repo.

**Phase 1 — make the product work (1-2 weeks).** B2 API origin → B3 local worker transport →
4.3 project file format + Save/Open.

**Phase 2 — security hardening (1 week).** S2, S3, S4, S5, S6, S7, S8.

**Phase 3 — monetization (1-2 weeks).** §3 gateway + usage ledger + account UI (4.5) +
auto-update wiring (4.4).

**Phase 4 — cleanup and publish.** §1 deletions, retirement flags flipped on the VPS, §1.5 docs
rewrite, CONTRIBUTING/SECURITY, CI green, licence gate closed.

Phase 1 before Phase 4: deleting the cloud code is easier once the local replacements exist,
and the retirement flags let you stage it without a big-bang removal.

---

## Verification notes

Everything in §1-§2 and §4.1-§4.5 was confirmed by reading the cited source. The
typecheck/lint results are from an actual `pnpm typecheck && pnpm lint` run on `75bddef0`. The
unit test suite and a real packaged-app launch were **not** run for this audit — the runtime
consequences described in 4.2 are derived from the control flow in `apps/worker/src/index.ts`
and `worker-supervisor.ts`, not from observing a running process. Confirm B3 against a real
launch before scheduling the fix.
