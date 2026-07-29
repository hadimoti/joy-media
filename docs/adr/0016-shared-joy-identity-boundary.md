# ADR-0016: Shared JOY identity through signed audience-scoped assertions

Status: Superseded by [ADR-0017](./0017-independent-media-login.md)
Date: 2026-07-22

## Context

Q10 requires JOY Media to use the existing JOY login, remain disabled per user
until an administrator enables it, and never ask the creator to maintain a
second JOY Media password. WP-12's live audit found that the active
`/opt/joy-admin/webapp_api.py` is a stale, shared-password Flask deployment.
The tracked source is instead the separate `joy-vps` repository's
`bot/webapp_api.py` and `bot/webapp_auth.py`; it already has per-user web
sessions and feature flags through `accounts_service`. At decision time it did
not expose an audience-scoped JOY Media assertion or `joymedia_allowed` flag.
Sharing the admin password, importing its database, or accepting an arbitrary
caller-supplied header would violate the isolation, audit, and least-privilege
requirements in §§27–28 and X01.

## Decision

JOY Media integrates with the JOY identity owner only through a documented,
version-controlled signed assertion interface:

1. The JOY identity owner remains responsible for login, user sessions, user
   IDs, and an administrator-managed `joymedia_allowed` flag. The existing
   version-controlled `joy-vps` source is the only permitted implementation
   target; no direct edit of the stale `/opt/joy-admin` copy is allowed.
2. After normal JOY login, it issues a short-lived asymmetric signed token for
   the `joy-media` audience. Required claims are stable `sub`, `iss`, `aud`,
   `exp`, `iat`, and `joymedia_allowed`; the JOY Media API accepts only the
   configured issuer, audience, current signing keys, and `true` allow flag.
3. JOY Media verifies tokens through the issuer's public-key/JWKS endpoint. It
   stores only its own actor ID and project/job authorization records, never
   JOY passwords, session cookies, signing private keys, or a copied user
   table.
4. The API rejects missing, expired, wrong-audience, unverifiable, or
   disallowed assertions before reaching project, Worker, or job handlers.
   Health remains public; pair offers are created only for an authenticated,
   allowed actor and remain Worker-specific/short-lived as ADR-0009 requires.
5. The current shared-password admin API cannot be used as a compatibility
   fallback. Production `/v1` stays disabled until the issuer implementation,
   key rotation, session expiry/revocation behavior, and the per-user enable
   UI are tested end to end.

## Consequences

WP-12.2's injected authentication seam is the intended JOY Media verifier
insertion point. It may gain a standards-based verifier once the issuer
contract exists; test-only identities remain confined to local tests. The
identity owner must provide an immutable deployment/revision, JWKS URL, issuer
identifier, audience, key rotation policy, and a test account whose allow flag
can be toggled. X01 will then deploy the verifier configuration as a separate
secret/public-key reference, never by copying an administrator password.

## Implementation status (2026-07-22)

The source-only issuer implementation is committed in the identity owner
checkout as `joy-vps` revision `305e9b6`; it adds default-deny entitlement,
an RS256 JWKS/assertion endpoint, an admin action, and key-rotation support.
JOY Media's local `apps/api/src/joy-identity.ts` verifies the counterpart
contract with Node's built-in crypto. Both sides have focused unit tests, but
the issuer key has not been provisioned, neither component has been deployed,
and no browser assertion exchange has been observed. Production `/v1` must
remain disabled until those conditions and the persistence gate are met.

## Alternatives rejected

- **Reuse the current JOY Admin password in Media.** This grants an
  administrator-equivalent credential to every media request and cannot
  identify or disable individual users.
- **A JOY Media-specific login/password table.** Violates Q10's shared-login,
  no-second-sign-in requirement.
- **Trust an unsigned reverse-proxy header.** Turns proxy configuration into
  the sole authorization boundary and is unsafe across future deployment
  changes.

## Validation and rollback

Before public activation, integration tests must prove an allowed token passes,
a disabled/expired/wrong-audience token fails, a signing-key rotation succeeds,
and revocation ends access within the documented session bound. Rollback keeps
`/v1` disabled and leaves local editor projects/Workers unaffected.
