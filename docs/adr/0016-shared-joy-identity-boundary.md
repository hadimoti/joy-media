# ADR-0016: Shared JOY identity through signed audience-scoped assertions

Status: Accepted
Date: 2026-07-22

## Context

Q10 requires JOY Media to use the existing JOY login, remain disabled per user
until an administrator enables it, and never ask the creator to maintain a
second JOY Media password. WP-12's live audit found that the current
`joy-admin-api` implementation is a non-version-controlled Flask service with
one shared admin password. It has no user principal, per-user allow flag, or
safe reusable identity contract. Sharing that password, importing its database,
or accepting an arbitrary caller-supplied header would violate the isolation,
audit, and least-privilege requirements in §§27–28 and X01.

## Decision

JOY Media integrates with the JOY identity owner only through a documented,
version-controlled signed assertion interface:

1. The JOY identity owner remains responsible for login, user sessions, user
   IDs, and an administrator-managed `joymedia_allowed` flag. Its own source
   must move into a version-controlled deployment boundary before this work is
   implemented.
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
