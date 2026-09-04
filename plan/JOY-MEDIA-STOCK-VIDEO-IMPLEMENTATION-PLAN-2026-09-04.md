---
title: JOY Media native Pexels/Pixabay stock-video implementation plan
type: implementation-plan
status: owner-approved
effective_date: '2026-09-04T00:00:00.000Z'
tags:
  - joy-media
  - stock-video
  - pexels
  - pixabay
  - asset-library
  - implementation
---

# Mission

Implement and deploy a complete native stock-video experience in JOY Media.
The user must be able to open Cloud library → Video, browse eight JOY-styled
categories with six usable clips each, search, preview, see source/creator
provenance, and import one selected clip into My media/private storage. The
result must be real, restart-safe, and production-usable; mocks, placeholders,
raw provider links in the browser, or a catalog that cannot import are not
completion.

The owner has already supplied and validated Pexels and Pixabay credentials.
They are encrypted on the VPS but are not attached to the API until the
provider consumers below exist. Never copy, print, commit, or send a key to an
agent, browser, test artifact, log, Gbrain page, or command argument.

# Authority and agent contract

The primary Codex agent is the only authority for source verification,
integration, browser operation, production deployment, Git push, and final
Gbrain write/read-back/export/receipt. The primary may use the following
advisory lanes because the owner explicitly approved them in this handoff:

- Codex-spawned implementation or review agents: `gpt-5.6-luna` only.
- SuperPlane and DSH through the local bundle under
  `C:\Users\HadiMoti\Desktop\HadiPc-Agents` and
  `C:\Users\HadiMoti\hadipc-agent`: advisory/review only.
- Owner independent agents launched from
  `C:\Users\HadiMoti\Desktop\HadiPc-Agents`: advisory/review only.

SuperPlane/DSH/independent agents may inspect only an OS-enforced read-only
snapshot and a bounded redacted packet. They may not implement, edit, commit,
push, deploy, restart a service, operate the signed-in browser, read provider
credentials, or access production data. A process exit is not acceptance.
If SuperPlane is used, first consult the professional advisory contract in
`C:\Users\HadiMoti\Desktop\gbrain-pc\plans\superplane-professional-advisory-pipeline-2026-08-30.md`
and VPS page `ops/superplane-professional-pipeline-2026-08-30`. Require S0–S5
intake, bounded snapshot, structured redacted packets, evidence validation,
and Luna adjudication before any primary-agent execution. The historical
launcher is advisory only and cannot replace owner approval.

Every advisory packet must state run ID, route, access level, model identity,
no-write attestation, claim classification, exact path/line/hash evidence,
risk, and a recommended focused check. Dynamic `openrouter/free` lanes cannot
corroborate one another or vote. NVIDIA lanes are skipped unless their
non-secret health check is green. Never pass owner browser state, cookies,
tokens, prompts, raw provider responses, or unredacted logs.

# Baseline and non-goals

Start with the required Gbrain process gate:

`C:\Users\HadiMoti\Desktop\gbrain-pc\scripts\Start-Agent-Process.ps1`

Then query the authenticated VPS Gbrain MCP, including the current JOY Media
deployment page and the SuperPlane page if advisory lanes are used. Canonical
source is `C:\Users\HadiMoti\joy-media`; the legacy `joy-vps/joy-media` path is
out of scope. Baseline is commit `1e378372c8b9ca5da9b1d30911d7568f936a38be`
(schema 4), with existing resumable originals and a persistent
`/opt/joy-media/data/upload-staging` directory.

Do not:

- use API keys from GitHub or free-for-dev credential lists;
- bulk-mirror provider originals or pretend remote cards are owned
  `BrowserAsset` records;
- expose provider rendition URLs or keys in browser JSON, DOM, source maps,
  logs, cache keys, or error text;
- add generated-video providers, change the existing upload transport, or
  redesign unrelated editor surfaces;
- run the full release suite, long soak, or Windows packaging campaign in this
  tranche. Use focused checks and one bounded live search/import smoke only.

# Product contract

Use these eight stable category slugs and labels:

| Slug                   | Label                |
| ---------------------- | -------------------- |
| `business-work`        | Business & Work      |
| `technology`           | Technology           |
| `people-lifestyle`     | People & Lifestyle   |
| `nature`               | Nature               |
| `travel-places`        | Travel & Places      |
| `city-transport`       | City & Transport     |
| `food-drink`           | Food & Drink         |
| `abstract-backgrounds` | Abstract Backgrounds |

The default catalog contains exactly six eligible cards per category (48 total
when all categories are loaded). Prefer three portrait and three landscape
clips per category and at least two cards from each provider when both are
healthy; provider failover may fill a category when one provider is unavailable.
Cards target 5–20 seconds, MP4/H.264/yuv420p, 720p minimum with 1080p
preferred, and a selected rendition no larger than about 60 MiB. Reject unsafe,
unplayable, duplicate, or incomplete candidates rather than displaying a
broken card.

Cards must look and behave like JOY asset cards but remain a separate
`BrowserStockVideo` projection until import. Each card includes title, poster,
duration, dimensions, orientation, provider, creator, a source-page link, and
an explicit `Import to My media` action. The source chip (for example,
`Pexels · creator`) remains visible; native styling does not erase provenance.
Only after import is complete may the resulting `BrowserAsset` be previewed,
added to a timeline, and shown in My media with its source metadata retained.

# API and data architecture

Add a provider-neutral service rather than putting provider logic in
`http-server.ts` or the React component. Suggested files (adapt names to the
existing conventions without widening scope):

- `apps/api/src/stock-video.ts` — category/types, normalized card, service,
  cache/import interfaces, and browser-safe projection.
- `apps/api/src/stock-video-providers.ts` — provider interface and strict
  normalization/eligibility helpers.
- `apps/api/src/pexels-stock-video-provider.ts` and
  `apps/api/src/pixabay-stock-video-provider.ts` — official API clients only.
- `apps/api/src/stock-video-credentials.ts` — startup-only systemd credential
  reader using code-owned IDs; no caller-supplied paths.
- `apps/api/src/stock-video-import.ts` — durable import coordinator and
  restart/retry state machine.
- focused `*.test.ts` files beside each module.

Do not add stock discovery methods to the already-large `ControlPlane` unless
there is no clean alternative. A `PostgresStockVideoRepository`/service may
share the existing `Pool` and `PrivateObjectStore`, while `LocalControlPlane`
gets a small deterministic test double.

Expose only authenticated, same-origin routes:

- `GET /v1/library/stock-videos?category=<slug>&q=<query>&cursor=<opaque>`
  returns six normalized cards plus bounded counts/next cursor. Query is
  trimmed and length-limited; category and cursor are validated.
- `GET /v1/library/stock-videos/:id/poster` returns a browser-safe poster
  through the JOY origin, with content-type/size checks and private caching.
- `GET /v1/library/stock-videos/:id/preview` streams or proxies only an
  allowlisted preview rendition, supports bounded range requests, and never
  forwards provider credentials or reveals the upstream URL.
- `POST /v1/projects/:projectId/stock-video-import` with `{catalogId}` creates
  or resumes an idempotent import and returns 202 plus an opaque import ID.
- `GET /v1/projects/:projectId/stock-video-imports/:importId` returns only
  `claimed`, `downloading`, `object-stored`, `registered`, `completed`, or
  `failed` plus a safe error code and the completed `BrowserAsset`.

The browser projection must never contain a key, provider API URL, mutable
download URL, local filesystem path, object-store ref, or raw upstream error.
Provider failures become stable JOY error codes and preserve already-cached
cards where safe.

# PostgreSQL migration 005

Append an additive migration to `apps/api/src/postgres-migrations.ts`; do not
edit the frozen baseline. Bump the release identity schema version to 5 only
when the migration is included and tested. Tables should be owner-safe and
indexed for the routes above:

`stock_video_catalog` stores normalized card identity, provider, provider asset
ID, category, title, creator, source page, terms/license reference, selected
rendition ID, poster/preview metadata, dimensions, duration, orientation,
retrieval time, expiry, and normalized eligibility facts. Enforce a unique
provider/asset/rendition identity.

`stock_video_search_cache` stores provider/category/query/orientation keys,
normalized result JSON, fetched/expiry timestamps, and a bounded response
version. Cache Pixabay for 24 hours; use a shorter Pexels TTL (for example one
hour) and serve stale data only with an explicit safe fallback policy.

`stock_video_imports` stores owner, project, catalog ID, provider identity,
requested rendition, state, import attempt, JOY asset ID, object hash/bytes,
safe failure code, timestamps, and retry metadata. Enforce idempotency for
`(owner_id, provider, provider_asset_id, rendition_id)` and prevent a project
from reading another owner’s import.

`media_asset_sources` stores the durable source relationship for imported
assets: provider, provider asset ID, creator, source page, terms reference,
retrieval time, rendition, SHA-256, bytes, dimensions, and duration. Keep
provider download URLs server-only or omit them and re-resolve by provider ID.

Migration tests must prove fresh install, repeat startup, checksum protection,
owner isolation, indexes/uniques, and that the previous release can still
start for rollback. Keep all schema operations additive and transactional.

# Provider safety contract

Use official Pexels and Pixabay API documentation and license pages as the
terms references. Pexels requests use the server-side `Authorization` header;
Pixabay requests use the server-side key parameter and must be redacted before
any logging. Use explicit HTTPS host allowlists, no arbitrary URL fetches, no
user-controlled redirect targets, and revalidate every redirect hop.

For every provider response:

- validate JSON shape, provider ID, source-page URL, creator, media URL host,
  MIME, dimensions, duration, and rendition availability;
- enforce response, poster, preview, redirect, timeout, and byte limits;
- reject private/link-local IPs, non-HTTPS endpoints, unsupported schemes,
  content types, and content that exceeds the selected limit;
- follow at most a small fixed redirect count while rechecking the allowlist;
- hash downloaded bytes and verify container/codec with existing media tools;
- deduplicate by provider asset/rendition, SHA-256, and poster perceptual hash;
- rate-limit per owner and coalesce identical cache misses;
- redact provider URLs containing credentials and all upstream bodies from
  client errors/logs.

The source/terms link shown to users must be the provider’s canonical page,
not the mutable media file URL. Do not claim that Pixabay or Pexels cards are
owned JOY assets until the import finishes.

# Import lifecycle

On import, re-read the catalog row and provider metadata server-side; do not
trust a card body from the browser. Claim the idempotency key, resolve a safe
preview/original rendition, and download to a file-backed, owner-scoped staging
area outside immutable releases. Enforce the 60 MiB rendition limit (and a
reasonable aggregate/session limit), hash while downloading, verify media
metadata, and atomically put the exact bytes into the existing private object
store.

Register the `MediaAssetRecord`, attach the private-object location only after
the object and source metadata are durable, then mark the import completed.
Failure leaves a safe retryable state and removes only its own temporary file
or orphan object. Startup/status polling must resume `claimed` or
`downloading` imports after an API restart. Repeated POSTs return the same
import/result, never duplicate a My media card, and never expose staging paths.

# Editor integration

The existing entry points are `apps/editor-web/src/AssetLibraryPanel.tsx`,
`control-plane-client.ts`, `asset-library-state.ts`, `asset-card-preview.ts`,
and their focused tests. Preserve current My media, upload, derivative,
selection, delete, and timeline behavior.

When `assetSource === 'cloud'` and the active category is Video, render the
stock discovery projection and its category/search controls. Cloud images and
audio continue using the existing `sharedCloudAssets()` path. Do not merge
stock cards into `BrowserAsset[]` just to reuse counts or actions.

Implement client methods for card listing, poster/preview blobs, import start,
and status polling. Use lazy poster loading with object-URL cleanup and fetch
preview only on explicit preview. Import progress must have accessible
loading/success/failure states, retry, cancellation where safe, and no raw
provider text. On completion, insert/reconcile the returned `BrowserAsset`,
show its source chip, and offer the normal JOY preview/timeline actions.

Keep keyboard navigation, accessible names, focus/empty/error/loading states,
responsive card layout, category counts (six each), search, and source links.
No card may show a false “download” or “add to timeline” action before import.

# Focused verification

Add and run only the tests needed to cover this tranche:

- provider normalization, category selection, codec/size filters, safe URL and
  redirect handling, redaction, rate/cache behavior, and deduplication;
- migration/repository uniqueness, owner isolation, import lifecycle,
  restart/retry, orphan cleanup, and object/source ordering;
- HTTP auth, validation, same-origin poster/preview, range limits, safe errors,
  idempotent import, and no path/provider URL leakage;
- browser client parsing/polling and request sequence;
- React/UI contracts for eight categories, six-card counts, attribution,
  poster/preview loading, import states, retry, accessibility, and preserving
  My media;
- targeted API/editor typechecks, ESLint, Prettier, and `git diff --check`.

Tests must use provider mocks for deterministic coverage and must not contain
real keys. Do not count a mocked import as live acceptance.

# Release and live acceptance

After focused checks and independent Luna review pass:

1. Commit the implementation in focused slices, then push GitHub `main` and
   VPS `main`. Keep the canonical worktree clean and preserve any unrelated
   user changes.
2. Create/verify persistent VPS directories for stock staging/cache with
   service ownership and mode 0700. Attach only the two existing encrypted
   systemd credentials through a reviewed drop-in; never put values in
   `/etc/joy-media/api.env`, Git, or command arguments.
3. Run additive migration 005 with a root-owned database backup. Build API and
   editor, create immutable release directories, write release identity,
   validate `nginx -t`, atomically switch API/web symlinks, and restart only
   `joy-media@api`. Keep the previous release as rollback target.
4. Verify `/live`, `/ready`, `/api/health`, release identity, service status,
   private object-store readiness, and zero unexpected restarts. Use direct
   origin checks in addition to the public route.
5. In the owner-controlled browser, verify Cloud library → Video exposes eight
   categories with six cards each, native cards show source/creator chips, one
   preview works, one Pexels/Pixabay search returns real cards, and one chosen
   card imports into My media and can be previewed/added to the timeline.
   Inspect network/DOM/console to prove no key or mutable provider URL leaks.
6. If any category has fewer than six eligible cards, any import fails, or any
   provider attribution/source link is missing, the tranche is not complete;
   fix it before handoff.

Do not run the broad exact-SHA browser campaign, long soak, or Windows
installer test until the other application gaps and the desktop shell are
finished. Keep focused evidence, hashes, release paths, and rollback facts;
discard raw provider responses and browser auth state.

# Definition of done

The goal is complete only when all of the following are true:

- this plan’s code paths are implemented, not merely scaffolded;
- production serves the implementation from immutable API/web releases;
- both providers work through backend-only credentials and safe normalized
  contracts, with cached fallback and no secret/provider-URL leakage;
- all eight categories show six eligible cards (48 total), with usable poster,
  preview, source/creator attribution, and search;
- one selected card completes an idempotent import into My media/private object
  storage, survives reload/status polling, and works with normal JOY preview and
  timeline actions;
- migration, owner isolation, retries, restart recovery, cleanup, and rollback
  behavior are verified by focused tests;
- focused tests/type/lint/format pass and independent review has no blocker;
- GitHub/VPS/source/release identities align, health is green, and no broad
  suite was substituted for the required live smoke;
- the primary agent writes and reads back a redacted VPS Gbrain page, runs the
  no-argument VPS export, and publishes a redacted Gbrain-pc receipt containing
  the verified export SHA;
- remaining gaps are explicitly reported; no false claim of Windows native
  packaging or secure desktop-key persistence is made.

# Required completion record

Update this plan’s status and create a matching redacted Gbrain ops page with
commit, migration/schema, release paths, provider/category counts, focused test
results, browser proof, credential-file names only, rollback target, and
remaining gaps. Never include keys, tokens, cookies, raw provider payloads,
provider download URLs containing credentials, personal media, or unredacted
logs.
