# Open-source release readiness

JOY Media is being developed as a free, open-source editor. The repository
code is licensed under the MIT License in `LICENSE`. Public redistribution of
the complete editor artifact is still not cleared by this repository alone.

Before publishing a redistributable release, the project owner or legal
reviewer must verify that every bundled dependency and asset is compatible with
the MIT License (or approve a different project license in a future change).
The editor's former Fontiran Modam Pro, content-creation packs, and legacy
login-gate font files have been removed. The Fontiran-specific asset
redistribution gate is closed: editor UI and content typography now
use pinned, self-hosted Fontsource packages under OFL-1.1; their full license
text and attribution are shipped under `apps/editor-web/public/licenses/fonts/`
and recorded in `THIRD_PARTY_NOTICES.md`.

The built-in JOY Agent Engine does not require a JOY-hosted model credential.
Users provide their own provider connection for a private session, and the
application must keep those values out of storage, project exports, server
requests, logs, and release artifacts. Provider terms, model licenses, and
user API charges remain the user's responsibility.

The 2026-09-04 record reported an 8,869-byte raw / 3,387-byte gzip Worker and
63 Playwright checks across seven desktop viewport projects. Those are
historical measurements, not acceptance evidence for a later source revision.
Regenerate bundle, audit, and browser evidence against the exact release
candidate, including the current model-connection dialog and workflow recovery
journey. Source changes and unit tests do not establish what is currently
deployed at `joyst.ir`. Remaining third-party asset review is still an
owner/legal gate; removing Fontiran runtime fonts does not itself approve
redistribution of the complete artifact.

The remaining open gate is whole-artifact owner/legal review of all bundled
dependencies, media, templates, codecs, and optional integrations; it is
separate from the now-closed Fontiran asset gate.

Release evidence must include the Worker size/import gate, production
dependency audit, third-party notices, repository license decision, and asset
redistribution review.
