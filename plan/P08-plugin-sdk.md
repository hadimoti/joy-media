# P08 — Public Plugin SDK and Team Templates

**Status:** in-progress · **Gate to enter:** P04–P07 contracts stable (SDK publishes what already exists) · **Master plan:** §36 Phase 8, §24, §25, §2.8
**Goal:** trusted developers extend JOY without compromising the core. Internal extension points have existed since P01; this part makes them public, versioned, and safe.

## Work packages

- [x] **WP-08.1 — SDK v1 freeze.** _(done 2026-07-20)_ Stable v1 subset freezes panel, data-only caption-pack, and provider-adapter capability contracts; capability detection is fail-closed; a documented comparator grammar and compatibility fixtures preserve supported v1 plugins; deprecation entries have explicit supported-until windows (§24.6).
- [x] **WP-08.2 — Packaging + security.** _(done 2026-07-20)_ `plugin.json` is diagnostics-validated with package-relative entrypoints, granular permissions, capability/API compatibility, and tier prerequisites; canonical package hashes plus trusted Ed25519 signatures verify immutable content; runtime policy blocks unapproved permissions, server plugins by default, and all third-party entrypoints in safe mode; updates expose added/removed permission diffs and require approval for additions (§24.4, §24.5, §29.7).
- [x] **WP-08.3 — Lifecycle.** _(done 2026-07-20)_ Verified packages install disabled; policy-gated entrypoints enable explicitly; updates require approval for added permissions and exact version migrations for persisted namespaced data, returning transformed data for the host to persist atomically; disable/uninstall only remove registration, and missing/disabled dependencies resolve to declared editable/read-only degraded modes (§24.7).
- [ ] **WP-08.4 — Dev kit.** Plugin CLI/scaffolder, typed SDK, local dev host, permission simulator, fixture runner, render snapshot tests, docs with focused examples (§24.8).
- [ ] **WP-08.5 — Team/private template catalog.** Template package/variables/slots/dependencies (§25.2–25.4), quality checks (§25.7), private catalog — marketplace stages 1–2 only (§25.5).

## Exit criteria (§36 Phase 8)

- [ ] A third party can build a panel, a data-only caption pack, and a provider adapter from published docs alone.
- [ ] Missing/disabled plugins never destroy project data.
- [ ] Permission changes are visible and gated.
- [ ] An old supported plugin version passes compatibility fixtures.
- [ ] Safe mode opens projects without third-party execution.
