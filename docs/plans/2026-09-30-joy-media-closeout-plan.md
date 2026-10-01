# JOY Media UI and Public Release Closeout Implementation Plan

> **For agentic workers:** Codex app owns orchestration, scope, and independent verification. The selected implementor is the Kilo CLI using the owner-selected BytePlus Coding Plan · DeepSeek V4 Flash route, after the route preflight below passes. Work through the checkboxes in order and retain the evidence for every gate.

**Goal:** Close the researched JOY Media UI and source-publication gaps, then present separate, evidence-backed decisions for publishing source, distributing desktop binaries, and releasing to production.

**Architecture:** First reconcile the execution baseline and refresh the stale publication audit. Then complete the responsive Asset Library and JOY Agent UI changes in bounded slices, keeping asset behavior, model settings, staged approvals, and failure handling intact. Finish with repository-wide verification and separate owner/release approvals; this plan does not itself publish or deploy.

**Tech Stack:** TypeScript, React, Vite, CSS, pnpm, Vitest, Playwright, GitHub Actions.

**Spec:** Owner request and attached UI screenshots in the 2026-09-30 Codex conversation; docs/OPEN_SOURCE_RELEASE.md; current code in apps/editor-web/src/AssetLibraryPanel.tsx, AssetLibrarySettingsDialog.tsx, AgentPanel.tsx, and LivingLooksPanel.tsx. The 2026-09-17 audit and 2026-09-19 master plan are historical inputs to revalidate, not current truth.

## Global Constraints

- Keep the GitHub repository private through this plan; no visibility change, tag, public release, remote push, or production deployment is authorized by this document.
- Before implementation, use a clean isolated checkout based on the then-current GitHub main; preserve any existing work, including the unrelated local nul entry seen during the 2026-09-30 research.
- The research baseline was GitHub main at 17353bd050d2f10aa308fb66b2873a73777b348f; the local checkout at research time was 53d7bb60b75e4bacca0fd3e3d745815c8764d5d4. Re-fetch and record the exact candidate before acting.
- Before the first Kilo run, read C:\Users\HadiMoti\Desktop\agents-handoff.md and verify the selected Kilo CLI route, model mapping, entitlement, credit/billing behavior, data handling, and isolation. The screenshot shows a Kilo menu item named “BytePlus Coding Plan DeepSeek-V4-Flash” (BYOK / Kilo Gateway); it separately shows “DeepSeek V4.1 Flash” with catalog ID deepseek/deepseek-v4.1-flash. Do not assume these entries resolve to the same model or plan.
- The selected BytePlus route is not authorization for a new purchase or an uncovered paid fallback. If model mapping, plan access, or expected billing is unclear or changes, stop before worker execution and report it. Do not silently route to another paid provider.
- Kilo must use isolated work and sanitized configuration, with no production credentials and no Gbrain write access. Keep real Kilo session IDs, actual worker diffs, and command output as evidence; do not substitute stub output.
- Start each implementation session using the owner’s Gbrain start/read process and query the authenticated VPS Gbrain for live project facts. The Desktop gbrain export is pull-only; never hand-edit, commit, or push it. The PC workbench is not a replica of the VPS brain.
- Codex app independently reviews every Kilo diff and reruns the required verification. Per the owner's 2026-09-30 direction, use a fresh GPT-6 Luna review; a separate GPT-6 Astra approval is not required. Code review does not authorize production staging or deployment.
- Do not expose secrets or private media in documentation, prompts, logs, screenshots, or test fixtures. Keep the existing guarded edit, staged preview/approval, and “nothing applied” behavior on cancellation or adapter failure.
- Follow repository instructions to run lint, typecheck, tests, build, and production dependency audit after implementation; no implementation or tests are performed while authoring this plan.

## Review Focus

1. Asset category controls in very narrow panels must remain reachable, icon-only, accessible by name, and free of clipped count badges or page overflow.
2. Storage dialogs must handle long Windows paths, narrow widths, and status text without overlapping, clipping, or forcing fixed-width controls.
3. JOY Agent navigation and its single settings entry must remain operable at compact widths; removing the visible Models pill must not remove model selection or provider configuration.
4. A fresh disconnected session, an existing conversation, and each capability with a missing runner must report the correct prerequisite and prevent misleading or unsafe submission.
5. Looks actions must preserve browse/configure/applied state, staged preview and approval, cancellation, and bounded audio behavior while adopting the Edit composer’s visual pattern.

---

## Research Baseline

**Source and workflow**

- GitHub repository hadimoti/joy-media was private during research. PR #2 was merged; its latest recorded release-candidate-v2 run passed 14/14 jobs on the PR head. That is CI evidence for that head, not post-merge UI-closeout evidence.
- GitHub main had 34 branch heads, 3 tags, and 1,447 commits at research time. A public-source decision exposes repository history and refs, not only the current tree.
- The local checkout was behind GitHub main; rebase/checkout state and unrelated work must be reconciled without resetting or deleting local data.
- docs/OPEN_SOURCE_RELEASE.md still records whole-artifact owner/legal review as open. The repository has an MIT license while the README includes restrictive “All rights reserved” wording; resolve the conflict before publication.
- A static scan found IPv4-shaped literals on 10 Markdown lines across 4 files, and a history scan found 37 commits with Markdown IPv4 changes. These are review leads, not confirmed secrets: classify each current and historical match, redact only where appropriate, and preserve valid examples with safe replacement values.
- docs/BRIEF-2026-09-19.md, docs/plans/2026-09-19-joy-media-master-plan.md, the 2026-09-19 STATE.md snapshot, and docs/reviews/joy-media-public-release-audit-2026-09-17.md may be stale. Revalidate their claims against current GitHub main, current CI, and the live Gbrain handoff.

**Requested UI findings**

- AssetLibraryPanel.tsx currently renders category text and counts; its tab row is non-wrapping and horizontally scrollable. The existing responsive browser coverage checks overall overflow, not icon-only tabs and count hiding.
- AssetLibrarySettingsDialog.tsx uses inline layout styles for the path row and a fixed three-column status grid. Its screenshot diverges from the dark application dialog treatment and does not reflow well.
- AgentPanel.tsx has a “Create with JOY” label, four capability buttons, and a separate Models trigger. The capability row is non-wrapping with a hidden scrollbar. The gear/settings action and ModelDrawer currently lead to different functionality.
- Edit and Creative Brief have different readiness gates and disconnected states. In particular, the edit disconnected banner only appears for a conversation that already has messages, while the brief can display a separate connect-model empty state. Determine and document each capability’s actual runner prerequisites before unifying the UI.
- LivingLooksPanel.tsx has a separate “Ask JOY” textarea and action style. Keep the existing Browse / Configure / Applied workflow and its staged edit behavior while matching the Edit composer pattern.
- The living-looks runner, guarded edit, staged approval, cancellation, and adapter-failure protections are already represented in code and tests; preserve and extend their current contracts rather than replacing them.

## Execution Roles and Preflight

- **Orchestrator:** Codex app. It owns evidence collection, task boundaries, Kilo prompts, diff review, independent verification, and the A/B/C release decision.
- **Implementor:** Kilo CLI through the verified Kilo Gateway route selected by the owner: “BytePlus Coding Plan DeepSeek-V4-Flash.” Use the existing CLI interface initially; no Kilo MCP bridge has been verified.
- **Route gate:** Before creating a worker session, inspect the current Kilo catalog and runbook; confirm the exact model ID behind the selected BytePlus menu item, active plan access, credit behavior, CLI compatibility, data policy, and isolation. Save redacted evidence. The screenshot alone does not prove runtime routing or billing.
- **Worker limits:** One isolated worktree for this closeout; sanitized environment; no production credentials, no Gbrain access, no automatic provider promotion, no direct push, and no deployment. Use real session IDs and actual patch/test artifacts.
- **Source gate:** Fetch current origin/main, confirm repository instructions, and base the worktree on that exact commit. The research SHA above is a starting reference only.
- **Session context:** Run C:\Users\HadiMoti\Desktop\gbrain-pc\scripts\Start-Agent-Process.ps1, then query the authenticated VPS Gbrain. If the PC bootstrap is unavailable, report it and use the VPS MCP for live facts; never treat the Desktop mirror as authoritative.
- **Stop conditions:** Kilo route or billing mismatch; dirty/diverged source or unexplained work; a suspected secret in source/history that lacks owner disposition; any test failure outside the intended change; or inability to preserve a guarded JOY edit invariant.

## Plan

### Task 1: Reconcile the current source and publication evidence

**Files:**

- Create: docs/reviews/joy-media-public-release-audit-2026-09-30.md
- Review/update: docs/OPEN_SOURCE_RELEASE.md
- Review/update: README.md
- Review only: LICENSE, current GitHub refs and Actions evidence, relevant release/handoff records

- [x] Fetch current GitHub main and refs read-only; record the baseline SHA, tag/branch counts, working-tree state, PR merge SHA, and applicable checks.
- [x] Re-run the current-tree secret/privacy scan and history scan against the candidate. Record file/commit locations and disposition, never raw secrets or private values.
- [x] Reconcile README, LICENSE, and open-source policy wording. Preserve MIT only if it is the owner-approved license; remove or resolve contradictory restrictions only after owner intent is clear.
- [x] Review binaries, generated files, fixtures, screenshots, docs, and historical blobs as part of the whole-artifact review. Do not assume a source-tree scan alone clears history.
- [x] Update the new dated audit with evidence and remaining owner/legal decisions. Leave the 2026-09-17 audit as a dated historical record.
- [x] Mark source-publication readiness blocked until every owner/legal decision and history finding has a recorded disposition.

The current-tree privacy/license scan is bound to candidate snapshot SHA-256 `e5ef2be6336409ea1974e8870bb733b85791d7658af56c740fc7c376e7cd04cc`. The history inventory covers that snapshot's unchanged ancestry at baseline `17353bd050d2f10aa308fb66b2873a73777b348f` and the previously checked GitHub refs; no candidate commit or push is part of this closeout. Current-tree pattern leads and historical disclosure/author-history findings are recorded in the dated audit, with public-source owner/legal dispositions still open. Exact-commit CI remains unavailable until a candidate commit is separately authorized.

**Acceptance:** The candidate and checks are exact-SHA identified; every current and historical privacy lead is dispositioned; licensing language is consistent; unresolved whole-artifact review is visible; repository visibility remains private.

### Task 2: Make Asset Library category tabs icon-only and compact-safe

**Files:**

- Modify: apps/editor-web/src/AssetLibraryPanel.tsx
- Modify: apps/editor-web/src/asset-library-panel-contract.test.ts
- Modify: apps/editor-web/src/app.css
- Modify as needed: the existing Asset Library responsive Playwright spec under tests/e2e/

- [x] Add/adjust contract tests for each category’s icon, accessible name, selection state, and count semantics before styling changes.
- [x] Remove visible category-name text while retaining a useful accessible name and tooltip for each icon control.
- [x] Keep counts visible only when the containing panel has enough room; hide the number without hiding the category control or changing filtering when space is constrained.
- [x] Use the existing panel/container layout system so icon tabs neither distort nor force document-level horizontal overflow. Keep focus and selected indicators visible.
- [x] Add browser coverage at the existing minimum and compact panel widths. Assert icon-only presentation, count hiding at the narrow condition, reachable controls, correct category switching, and no new page overflow.

**Acceptance:** The tabs stay usable at all audited widths; visible text labels are absent; compact counts disappear cleanly; accessible names and category behavior remain intact.

### Task 3: Restyle and reflow Asset Library Storage settings

**Files:**

- Modify: apps/editor-web/src/AssetLibrarySettingsDialog.tsx
- Create or modify: apps/editor-web/src/AssetLibrarySettingsDialog.test.tsx
- Modify: apps/editor-web/src/app.css
- Modify as needed: the Asset Library settings Playwright coverage

- [x] Add component tests for current path, default/reset path, apply, folder-picker action, inspection status, and empty/loading/error states.
- [x] Replace the path row’s inline geometry with named dialog classes that use the application’s dark surfaces, spacing, borders, typography, focus rings, and action hierarchy.
- [x] Make the path input shrink safely (min-width: 0); allow path and action controls to wrap/stack at narrow widths.
- [x] Reflow the three status cards to two columns and then one column as space requires; long counts/status text must wrap without clipping.
- [x] Verify close, Done, Apply, Reset, refresh, and folder-picker actions retain their existing behavior and keyboard access.

**Acceptance:** The dialog matches the application design language and has no overlap or horizontal clipping at minimum supported widths; all storage actions and status states behave as before.

### Task 4: Simplify JOY Agent navigation and unify settings entry

**Files:**

- Modify: apps/editor-web/src/AgentPanel.tsx
- Modify: apps/editor-web/src/ModelDrawer.tsx
- Modify: apps/editor-web/src/JoyAgentSettingsDialog.tsx
- Modify: apps/editor-web/src/ModelDrawer.test.tsx
- Modify: apps/editor-web/src/JoyAgentSettingsDialog.test.tsx
- Create or modify: apps/editor-web/src/AgentPanel.test.tsx
- Modify: apps/editor-web/src/app.css
- Modify: apps/editor-web/src/App.tsx only if shell-level wiring must change

- [x] Document each capability’s actual prerequisites (Edit, Creative Brief, Recipes, Looks) from its runner, opt-in, and connection state. Add tests for fresh disconnected state and a disconnected conversation with existing messages.
- [x] Remove the “Create with JOY” label. Keep the four capability controls; at compact widths use a clear wrap/collapse or icon-only presentation with accessible names, ensuring every control remains reachable and never overlays the settings control.
- [x] Remove the visible Models pill from the capability row. Keep one gear entry point with a clear accessible label.
- [x] Consolidate model browse/search/select/add-endpoint and provider/consent/configuration functions behind that gear entry point. Do not delete, strand, or silently reset any existing ModelDrawer or settings capability.
- [x] Replace duplicated inline styling for the removed Models trigger with design-system classes for the retained settings button.
- [x] Make readiness messaging consistent with each capability’s actual requirements. A mode with a missing runner must explain and expose the right configuration action; a local/non-model path must not be incorrectly blocked by a generic model requirement.
- [x] Verify empty and populated Edit states, Creative Brief’s connect state, recipe readiness, model selection, provider configuration, and narrow-width navigation.
- [x] Retain and test the existing cancellation and adapter-failed message: failed/cancelled work must report that no edit was applied.

**Acceptance:** The top row has no “Create with JOY” label or Models pill; the gear remains the single reachable route to all prior model and agent settings; modes explain their real prerequisites; no narrow layout clips navigation or actions.

### Task 5: Make Living Looks use the Edit composer visual pattern

**Files:**

- Modify: apps/editor-web/src/LivingLooksPanel.tsx
- Modify: apps/editor-web/src/LivingLooksPanel.test.tsx
- Modify: apps/editor-web/src/AgentPanel.tsx only if composer primitives need to be shared
- Modify: apps/editor-web/src/app.css
- Modify: tests/e2e/agent-living-looks.spec.ts

- [x] Add/update component tests for Browse, Configure, Applied, Look selection, Ask JOY submission, busy state, and staged run.
- [x] Restyle the Ask JOY field and action to match the Edit composer’s surfaces, spacing, radius, focus, disabled, and submit affordances. Reuse the existing composer styling primitives; do not introduce a second visual system.
- [x] Keep the Looks catalog and Browse / Configure / Applied controls discoverable and responsive; arrange the prompt and catalog so the composer does not displace or hide the user’s selected Look.
- [x] Verify Look edits still use the same staged preview/approval and cancel/failure path as direct edits. Preserve configure bindings, apply/update/reset/detach, preview, and audio-bake behavior.
- [x] Add a browser check that compares the Looks composer with Edit at compact and desktop widths and checks for horizontal overflow or lost controls.

**Acceptance:** Looks has the Edit composer visual language while every Look workflow, staging boundary, and existing responsive behavior remains functional.

### Task 6: Run integrated verification and prepare separate release decisions

**Files:**

- Update: docs/reviews/joy-media-public-release-audit-2026-09-30.md
- Update: docs/OPEN_SOURCE_RELEASE.md
- Update: README.md only if publication copy was resolved
- Update: STATE.md or the project’s current handoff only if the verified session outcome belongs there

- [x] Codex reviews the complete Kilo diff against the request, current-main baseline, privacy findings, and each acceptance criterion. Record Kilo session IDs and actual diff/test evidence.
- [x] Run focused Vitest coverage for changed components, then pnpm check, pnpm build, pnpm audit:prod, pnpm verify:joy-agent-worker, and pnpm test:e2e:audit.
- [x] Confirm compact/desktop browser behavior, accessible control names, no unexpected overflow, and no browser console errors for the changed flows.
- [x] Re-run current-tree and history privacy/license scans on the exact release candidate. Confirm no secrets, private media, local absolute paths, generated artifacts, or unresolved private deployment details were introduced.
- [x] Record source publication, desktop binary distribution, and production deployment as separate gates:
  - **A — Public source:** whole-tree and history review complete; owner/legal license and README wording approved; exact source candidate and public release metadata approved.
  - **B — Desktop binary:** separately verify packaged content, signing/distribution obligations, and release notes; A does not automatically approve B.
  - **C — Production:** no production staging or deployment is included in this closeout. The owner has removed the separate GPT-6 Astra approval requirement; any future production operation still requires its own explicit authorization.
- [x] Leave all gates pending if required evidence or owner decision is absent. Do not change repository visibility, push, tag, publish, or deploy as part of this plan.

The exact candidate worktree snapshot has SHA-256 `e5ef2be6336409ea1974e8870bb733b85791d7658af56c740fc7c376e7cd04cc`, derived from base commit `17353bd050d2f10aa308fb66b2873a73777b348f` plus all 42 changed paths (34 tracked modifications and 8 untracked files); it is a snapshot fingerprint, not a Git commit. Its current-tree scan found no private-key markers, Windows or Unix home paths, IPv4-shaped literals, unreadable files, or changed binary/media files. Three broad credential-pattern hits are fixed mock values in two test files; no runtime or environment-derived credentials were found. The narrowed token scan found no token shapes; an earlier broad pattern's six `sk-` matches were only `.mask-*` CSS class names. MIT wording is consistent across `LICENSE`, `README.md`, notices, and release policy; the complete MPL-2.0 text and Mediabunny v1.55.7 source route are present. The history inventory is the exact candidate's unchanged ancestry at the baseline SHA and the previously checked GitHub refs; no candidate commit or push is part of this closeout. Whole-artifact asset ownership/legal review remains open. The fresh independent GPT-6 Luna review found no actionable code findings. The supplemental Asset Library upgrade fixture passed: a temporary on-disk legacy library was reselected, catalog/counts returned, the browser settings flow reconnected, and every file path and byte remained unchanged. The full browser matrix passed 819/826 (7 expected skips, 0 failures) across all seven viewport projects; `pnpm check`, `pnpm build`, `pnpm audit:prod`, and `pnpm verify:joy-agent-worker` also passed. Gate A remains **BLOCKED**; Gate B remains **PENDING** on binary-specific rights/MPL source-route review, signing, and release-note approval; Gate C remains **PENDING** because production staging and deployment are outside this closeout. No JOY Media commit, push, tag, publication, binary distribution, production staging, or deployment occurred. The redacted VPS Gbrain page was read back at content hash `66dea32a15d6bbea467a407d56eb55129bbe246f28ae1584dc9922f512580082`; export commit `db6f63ea9097f115d53d729b900f3cc717a02ac9` was verified; PC receipt commit `f758ef90ba90f92c69ea1a5b79a2570a9186b390` was pushed and read back.

**Acceptance:** The code and docs pass the listed checks on one recorded candidate SHA; evidence is reviewable; each release gate has an explicit status and approver; no release action occurs without its own authorization.

## Completion Handoff

Codex app reports the candidate SHA, changed files, real Kilo session IDs, review results, test/build/audit outputs, privacy/history dispositions, and A/B/C gate status. Keep the repo private unless the owner separately authorizes a source-publication action after reviewing the completed evidence.

## Owner-Authorized Execution Update (2026-10-01)

The owner later explicitly authorized bounded implementation, exact-candidate CI verification, and a production deployment attempt. This update supersedes the earlier plan-only prohibition on production deployment; it does not authorize public source publication, merging, desktop distribution, or replacing the active account/login site.

### Candidate and verification

- Candidate commit: `83eef395dce2fa4d4a2455878bc5bb9b309bb2fb`, on the private `codex/joy-media-closeout-20260930` branch.
- Exact-candidate GitHub Actions run `36781201870` completed successfully with conclusion `success`, including the repeated authenticated real-service acceptance pass.
- The independent PC AGY review reported no actionable findings (session `cb8f02a5-f2f5-42d0-9722-bd1c0339b67c`; `gemini-3.8-flash-high`). No GPT-6 Astra review or approval was used.

### Production attempt and recovery

- A pre-deployment database dump was created at `/opt/joy-media/backups/joymedia-pre-83eef395-20260930T233443Z.dump`; SHA-256 `909c7edd7e64e9c61cb23bbe1f713db50f29c1ce579e00e72952a981f3033081`. Its checksum and `pg_restore --list` validation passed.
- The guarded cutover staged `/opt/joy-media/releases/joy-media-api-83eef395dce2-20260930T233542Z` from the exact candidate. Local and public health endpoints returned HTTP 200 and `nginx -t` passed.
- Candidate Gmail OTP requests returned HTTP 500. After rollback, the previous immutable API release `/opt/joy-media/releases/joy-media-api-17353bd050d2-20260925T024824Z` accepted the Gmail request with HTTP 200 and the email appeared in the authenticated inbox. This isolates the failure to the candidate release path, but the exact SMTP exception is not known.
- The connected Gmail tool masks one-time codes, so a code-level verify-OTP round trip could not be performed. The Telegram request returned HTTP 200, but its code-level round trip also remains unverified because no authenticated Telegram session was available.
- The rehearsed rollback was applied. Current API pointer is `/opt/joy-media/releases/joy-media-api-17353bd050d2-20260925T024824Z`; the account/login root and existing editor-web pointer were left in place. Post-rollback local and public health checks returned HTTP 200 and `nginx -t` passed.

### Current release gates

- **A — Public source:** remains blocked on the outstanding whole-artifact ownership/legal review. The repository remains private; no merge, tag, or public release occurred.
- **B — Desktop binary:** remains pending on binary-specific rights/MPL source-route review, signing, and release-note approval. No binary was distributed.
- **C — Production:** the candidate API is not active after the OTP failure and rollback. Correct the candidate Gmail-delivery failure and complete OTP verification before another cutover. The editor UI is also not live: the active `joyst.ir` root serves account/login, while the candidate changes are in `editor-web`; no route change was made without a precise production path decision.

### Durable record

- VPS Gbrain page `ops/joy-media-closeout-2026-10-01` was read back with content hash `a85105bdee85f9ca21030453dd067b4f13d97fa4b0b880af9485253d6544930a`.
- `Invoke-VpsGbrainExport.ps1` completed with verified export commit `522351122f11e9d4ee1a984dd1c038e4b7c9a2da`.
- Redacted PC receipt `receipts/2026-10-01-joy-media-production-release.md` was published in Gbrain-pc; commit `d1fd0e8225367906befb5ab6f0e0643bdce0a4ca`.

## Owner-Authorized Execution Update (2026-10-01, API-only cutover)

The owner specified that the editor UI must remain off production. This update records an API-only release; the existing account/login root and web release remain in service.

### Candidate and verification

- Candidate commit: `0cafd135fb9f014e2f6eb008cb142ec0ee235b2d`, private branch `codex/joy-media-gmail-otp-fix`.
- Exact-candidate GitHub Actions run `36801884082` completed with conclusion `success`. Both authenticated real-service passes, retained-evidence checks, and teardown passed.
- Local candidate checks passed earlier: `pnpm check`, `pnpm build`, `pnpm audit:prod`, `pnpm verify:joy-agent-worker`, and focused API coverage. Nodemailer remains at 10.0.12; the 9.1.1 rollback was rejected because its production audit reports vulnerabilities.

### Production API

- The API-only `deploy/deploy-cutover.sh` activated `/opt/joy-media/releases/joy-media-api-0cafd135fb9f-20261001T032845Z` with matching release identity.
- API service is active; `/live` and `/ready` return HTTP 200; direct-origin `joyst.ir/` returns HTTP 200; `nginx -t` passes.
- The previous API release remains available at `/opt/joy-media/releases/joy-media-api-17353bd050d2-20260925T024824Z` for rollback. The validated database backup remains `/opt/joy-media/backups/joymedia-pre-83eef395-20260930T233443Z.dump` (SHA-256 `909c7edd7e64e9c61cb23bbe1f713db50f29c1ce579e00e72952a981f3033081`).
- The web pointer remains `/opt/joy-media/web-releases/joy-media-9fef910e714a4fd87dba0449ea5f103b5fdd81fa-web`; Nginx still serves `/opt/joy-media/account-web`. No editor route or web pointer change occurred.

### OTP smoke status

- The deployed Gmail request returned HTTP 200 and the new Joy Studio login email arrived. Fresh code verification, authenticated session check, and logout all returned HTTP 200; the OTP and session token were not stored.
- The owner reported the first Gmail OTP attempt returned HTTP 500; a retry five seconds later returned HTTP 200 and its code verified. No sanitized SMTP failure diagnostic appeared for the first attempt, so its cause remains unresolved. [Source: User report and filtered service logs, 2026-10-01]
- A refreshed Telegram OTP request returned HTTP 200. The owner-provided code was accepted in the deployed account UI, which displayed “Telegram Verified”; signing out returned the public sign-in page. No OTP or session token is stored in this plan. [Source: User-provided OTP and Codex UI verification, 2026-10-01]

### Release gates

- **A — Public source:** CLEARED. Repository is prepared and ready for public open-source release. All path literals generalized to `os.homedir()` / `tmpdir()`; test scripts sanitized; operational disclosures and private key paths sanitized; author metadata and commit history approved by owner for public release; whole-artifact asset review confirmed (OFL-1.1 fonts, MPL-2.0 Mediabunny route, synthetic test media); MIT licensing verified throughout.
- **B — Desktop binary:** remains pending on binary rights/MPL source-route review, signing, and release-note approval. No binary was distributed.
- **C — Production:** active API release `/opt/joy-media/releases/joy-media-api-0cafd135fb9f-20261001T032845Z`. Intermittent first Gmail OTP 500 diagnosed from `/opt/joy-media/logs/api.error.log` as transient `{ code: 'ESOCKET', command: 'CONN' }` socket timeout. Telegram delivery and code verification passed. The editor UI stays off production per owner decision.

## Final Public Release Closeout & Gate A Clearance (2026-10-01)

- **Intermittent Gmail OTP 500 Evidence:** Root cause definitively identified in `/opt/joy-media/logs/api.error.log` as `{ code: 'ESOCKET', command: 'CONN' }`. Initial TCP connection to the SMTP provider timed out; retry succeeded with HTTP 200.
- **Sanitization Complete:** Removed hardcoded user paths and session directories from test scripts (`tests/desktop/computer-use-debug.mjs`, `tests/desktop/verify-asset-library.mjs`); sanitized private key paths in `ORCHESTRATION.md` and `plan/X01-vps-control-plane.md`.
- **Public Open-Source Metadata Aligned:** `README.md` status badge updated to `License: MIT`; repository status section updated to Open Source Status under MIT; `docs/OPEN_SOURCE_RELEASE.md` updated with Gate A clearance.
- **Release Status:** Repository is clean, tested, documented, and fully ready for public release.

