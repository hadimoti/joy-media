# Open-source release readiness

JOY Media is being developed as a free, open-source editor. The repository
code is licensed under the MIT License in `LICENSE`. Public redistribution of
the complete editor artifact is still not cleared by this repository alone.

Before publishing a redistributable release, the project owner or legal
reviewer must verify that every bundled dependency and asset is compatible with
the MIT License (or approve a different project license in a future change).
The editor's former Fontiran Modam Pro, content-creation packs, and legacy
login-gate font files have been removed. Editor UI and content typography now
use pinned, self-hosted Fontsource packages under OFL-1.1; their full license
text and attribution are shipped under `apps/editor-web/public/licenses/fonts/`
and recorded in `THIRD_PARTY_NOTICES.md`.

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
evidence, not a public-release approval: remaining third-party asset review is
still an owner/legal gate. The overall Fontiran redistribution gate remains
open until the clean release checks and owner/legal review are accepted; the
editor font asset scan itself now passes with no Fontiran runtime assets.

Release evidence must include the Worker size/import gate, production
dependency audit, third-party notices, repository license decision, and asset
redistribution review.
