# P08 — Public Plugin SDK and Team Templates

**Status:** not-started · **Gate to enter:** P04–P07 contracts stable (SDK publishes what already exists) · **Master plan:** §36 Phase 8, §24, §25, §2.8
**Goal:** trusted developers extend JOY without compromising the core. Internal extension points have existed since P01; this part makes them public, versioned, and safe.

## Work packages

- [ ] **WP-08.1 — SDK v1 freeze.** Stable subset selection, versioning + deprecation policy, capability detection, compatibility matrix + fixtures (§24.6).
- [ ] **WP-08.2 — Packaging + security.** Package format, manifest validation, permission model (§24.4), signing/hash verification, execution tiers enforcement (§24.5), permission-diff-on-update UI, safe mode (§29.7).
- [ ] **WP-08.3 — Lifecycle.** Install/validate/enable/update-with-migration/disable/uninstall; disabled plugin never deletes project data; missing-plugin degraded modes (§24.7).
- [ ] **WP-08.4 — Dev kit.** Plugin CLI/scaffolder, typed SDK, local dev host, permission simulator, fixture runner, render snapshot tests, docs with focused examples (§24.8).
- [ ] **WP-08.5 — Team/private template catalog.** Template package/variables/slots/dependencies (§25.2–25.4), quality checks (§25.7), private catalog — marketplace stages 1–2 only (§25.5).

## Exit criteria (§36 Phase 8)

- [ ] A third party can build a panel, a data-only caption pack, and a provider adapter from published docs alone.
- [ ] Missing/disabled plugins never destroy project data.
- [ ] Permission changes are visible and gated.
- [ ] An old supported plugin version passes compatibility fixtures.
- [ ] Safe mode opens projects without third-party execution.
