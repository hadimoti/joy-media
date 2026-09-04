# Open-source release readiness

JOY Media is being developed as a free, open-source editor. The repository
code is licensed under the MIT License in `LICENSE`. Public redistribution of
the complete editor artifact is still not cleared by this repository alone.

Before publishing a redistributable release, the project owner or legal
reviewer must verify that every bundled dependency and asset is compatible with
the MIT License (or approve a different project license in a future change).
In particular, the Fontiran Modam Pro and content-creation font packs listed
in `THIRD_PARTY_NOTICES.md` are currently covered by commercial terms that have
not been approved for redistribution. They must be removed, replaced with
redistribution-safe assets, or separately cleared before a public release is
claimed to be open source.

The built-in JOY Agent Engine does not require a JOY-hosted model credential.
Users provide their own provider connection for a private session, and the
application must keep those values out of storage, project exports, server
requests, logs, and release artifacts. Provider terms, model licenses, and
user API charges remain the user's responsibility.

The 2026-09-04 implementation and deployment evidence is reproducible: the
browser Worker bundle is 8,869 raw bytes / 3,387 gzip bytes, the production
dependency audit is clean, and 63 Playwright checks pass across the seven
desktop viewport projects. The release verifier also confirms that the Worker
imports only the JOY engine boundary. The built-in engine is deployed on
`joyst.ir` at the commit recorded in `STATE.md`; the live browser settings
dialog is the acceptance surface. This is implementation and deployment
evidence, not a public-release approval: Fontiran font/asset redistribution
review remains an owner/legal gate.

Release evidence must include the Worker size/import gate, production
dependency audit, third-party notices, repository license decision, and asset
redistribution review.
