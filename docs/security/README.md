# JOY Media Security Boundaries

Status: current as of 2026-08-22.

This document records the production security boundaries that are safe to publish. It deliberately
does not contain operational secrets, signing keys, OTP values, provider prompts, provider API keys,
worker pairing codes, session tokens, filesystem paths, or object-store credentials.

## Authentication

- JOY Media uses an independent allow-list plus OTP login for the media app.
- OTP requests return the same response for known and unknown contacts, so the login endpoint does
  not confirm allow-list membership.
- OTP and session digests are HMAC-SHA-256 values with explicit key ids. New rows use the active key;
  previous-key and legacy rows are accepted only so they can expire or migrate after successful use.
- OTP request throttles are stored in PostgreSQL/shared durable storage and keyed by a hashed client
  address, not by raw IP text.
- Browser requests authenticate with bearer sessions. Project, asset, worker-owner, provider, and
  production-run APIs use the authenticated actor from the server-side auth boundary rather than a
  browser-supplied authority claim.
- Production-run authority objects are still part of the public record, but the API verifies that
  the principal and role match the authenticated actor and rejects `system` authority from browser
  routes.

## API Limits

- JSON request bodies are bounded by the API transport.
- Binary upload routes have per-route byte limits and integrity headers.
- Production-run records are size-limited and reject local paths, URLs, raw media fields, and
  base64-like media payloads.
- Provider approval audit rows store request digests, ids, status, and spend metadata; they do not
  store raw prompts or provider secrets.

## Non-GA Surfaces

- Plugin, template, workflow, production-board, and GPU/job panels remain registered in source for
  explicit development and saved-layout compatibility, but they are not opened by the GA default
  workspace or advertised through the default View menu.
- The first-party demo plugin host is not registered by default. It requires an explicit
  `enableExperimentalDemoPanel` opt-in and still remains subject to safe-mode and permission checks.
- Remote provider calls are unavailable unless the server is configured with the provider secret and
  the request has a matching approval grant when remote processing or spend requires it.
- Local/GPU Worker jobs require an authenticated owner, owner-approved pairing, a valid Worker
  session, advertised capabilities, and protocol-valid receipts. Worker outputs are recorded as
  opaque refs and verified metadata, not local paths or media bytes.

## Operational Notes

- Rotate media auth HMAC keys by deploying the new key first and retaining the previous key until old
  OTPs expire and active sessions have either migrated, expired, or been revoked.
- Treat the database, object store, provider ledgers, and Worker PCs as privileged infrastructure.
- Keep CSRF exposure low by avoiding cookie authentication for the API; bearer sessions are supplied
  explicitly by the editor client and checked on every protected route.
