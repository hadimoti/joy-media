# ADR-0042: Built-in JOY Agent Engine

Status: accepted
Date: 2026-09-04

## Decision

JOY Media provides one browser-resident JOY Agent Engine for every AI-assisted
editing surface. The engine runs in a dedicated Web Worker, uses a
provider-neutral tool loop, and accepts a user-owned OpenRouter or compatible
HTTPS provider connection for the current session only. KiloCode, code-server,
the cloud planner, and the optional local DeepSeek-harness product paths are
not engine choices for new runs.

The Worker may inspect bounded snapshots and propose validated operations. It
does not receive the live EditorSession, cannot mutate canonical project state,
and does not own approval, scratch previews, commits, or Undo. The main thread
keeps those JOY authority boundaries and exposes only sanitized monotonic
activity events to the UI.

AI SDK Core 7.0.92 and its OpenAI-compatible provider 3.0.43 are pinned
implementation dependencies behind the JOY-owned package boundary. They are
replaceable: no product surface may depend directly on their types, provider
fallback behavior, telemetry, or diagnostic objects. The Worker is subject to
the raw/gzip release budget and browser-only import gate in
`tooling/release/verify-joy-agent-worker.mjs`.

## Consequences

- BYOK provider, model, endpoint, and key values live only in a disposable
  Worker session. They are not persisted in app state, project data, browser
  storage, JOY API requests, logs, telemetry, traces, or error payloads.
- OpenRouter and custom providers use an exact-origin hardened fetch policy.
  Redirects, non-HTTPS public URLs, credentials in URLs, and private-network
  hosts are rejected by default. CORS and network failures are surfaced as
  safe actionable errors.
- Plan-only mode and tool-loop mode are explicit capabilities of the same
  configured connection. No failure may silently switch provider, model, or
  execution route.
- Existing JOY validation, approval, atomic transaction, revision, and Undo
  contracts remain authoritative for edits.
- Historical KiloCode and joy-code-server provenance remains readable for
  existing records. This ADR supersedes their new-run runtime role without
  rewriting project history. It also supersedes the product decisions in
  ADR-0020, ADR-0036, and ADR-0041 where they conflict with this decision.
- AI SDK and Zod licensing/notice data is recorded in
  `THIRD_PARTY_NOTICES.md`. Public redistribution still requires the
  independent license and font-asset gate in `docs/OPEN_SOURCE_RELEASE.md`.
