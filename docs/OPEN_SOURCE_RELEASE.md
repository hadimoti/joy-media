# Open-source release readiness

JOY Media is being developed as a free, open-source editor. Public
redistribution is not yet cleared by this repository alone.

Before publishing a redistributable release, the project owner or legal
reviewer must choose and add an OSI-approved license for the repository and
verify that every bundled dependency and asset is compatible with that license.
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

Release evidence must include the Worker size/import gate, production
dependency audit, third-party notices, repository license decision, and asset
redistribution review.
