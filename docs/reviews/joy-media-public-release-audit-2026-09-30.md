# Joy Media — Public-Release Audit (Task 1 — Incomplete)

**Audit date:** 2026-09-30

**Audit scope:** Candidate baseline, current-tree and history scans, integrated verification, production dependency remediation, and unsigned desktop staging review. Task 1 owner/legal decisions and whole-artifact rights review remain incomplete.
**Document status:** Draft — implementation and verification evidence is recorded; release gates remain open.

---

## Candidate / Source State

| Item                           | Value                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Repository                     | `hadimoti/joy-media`                                                                                                      |
| Visibility                     | **PRIVATE**                                                                                                               |
| Candidate SHA (GitHub `main`)  | `17353bd050d2f10aa308fb66b2873a73777b348f`                                                                                |
| PR #2 merge SHA                | `17353bd050d2f10aa308fb66b2873a73777b348f` (matches candidate)                                                            |
| PR #2 head SHA                 | `8c357bf7c59dbc2b278925e5b878dec0d00b0133`                                                                                |
| PR #2 merge date               | 2026-09-25                                                                                                                |
| GitHub refs (Task 6 rechecked) | 34 branch heads, 2 tags; `main` still resolves to candidate SHA                                                           |
| Original local checkout SHA    | `53d7bb60b75e4bacca0fd3e3d745815c8764d5d4` (branch `main` tracking `vps/main`)                                            |
| Worktree for this task         | Detached checkout with `HEAD` at candidate SHA `17353bd…`; Tasks 2–6 are uncommitted review changes, not a release commit |

### Baseline Collection Status

- [x] Candidate SHA recorded
- [x] Repository visibility and refs collected
- [x] PR/merge identity recorded
- [x] CI identifiers collected

---

## CI Evidence / Limits

- **No GitHub Actions run is bound to the exact merge SHA (`17353bd…`).** All CI evidence below is PR-head-only and does not verify the merge commit itself.
- **PR-head-only runs on `8c357bf…`:**
  - `release-candidate-v2` run 36073596216 — **succeeded** (14/14 jobs)
  - `release-candidate-v2` run 36063192460 — **succeeded** (14/14 jobs)
  - `ci` run 36062053525 — **succeeded**
- These results are **not** checks on the merge SHA and do not constitute merge-SHA CI verification.

**Limitation:** Merge-SHA CI gap exists. No automated pipeline result confirms the exact candidate commit passes the same checks.

---

## Current-Tree Scan Results

Heuristic scans of the working tree at the candidate SHA were performed. Findings are pattern matches (leads), not automatically confirmed secrets.

### IPv4-Shaped Markdown Scan (current tree)

| Category                             | Count | Notes                                                     |
| ------------------------------------ | ----- | --------------------------------------------------------- |
| Loopback addresses                   | 37    | Local-host references; not public-routable endpoints      |
| Version-like false positives         | 10    | Software/version metadata, not network endpoints          |
| Private-network endpoint occurrences | 7     | RFC1918 references across four operational documents      |
| Public-network endpoint occurrences  | 4     | Production-host references quoted in the 2026-09-17 audit |

The refreshed scan covered tracked and non-ignored untracked Markdown. The earlier audit had the version-like and RFC1918 categories reversed; the 58 total matches now reconcile as 37 loopback, 10 version-metadata, 7 RFC1918, and 4 public-network references. Current operational docs retain five VPS-DATA references across three files. The RFC1918 references are retained in Gbrain audit, index-plan, agent handoff, and WP-37 operational documents; they are not credentials, but remain private infrastructure details. `ORCHESTRATION.md:98` also retains a root SSH alias/key-path reference with a placeholder network value. The dated 2026-09-17 audit reproduces four public production-host addresses while describing an earlier disclosure; current status of those systems is not verified. These current-tree details are classified but not cleared for public release. The historical audit's `STATE.md:188` pointer is stale — current `STATE.md` has 97 lines.

### Credential / Key Material Scan (current tree)

- Heuristic text/path scans found no private-key marker or key-material file path in the current tree.
- Across all 34 advertised heads and 2 tags, **no key-material filename changes** were found.
- Credential-shaped matches were reviewed and classified as: synthetic test fixtures, redaction logic, and a retired localhost-only CI configuration. They were **not identified as production credentials**.

**Caution:** These are heuristic scan results, not a guarantee of absence.

### Media and Generated-Artifact Review (current tree)

- **321 raster images**, **4 SVG files**, and **37 audio/video files** are present in the candidate.
- Local metadata inspection found:
  - One short comment field in a test JPEG.
  - Comment fields in five motion-preview videos.
  - **None** contained email, IP, credential, local-path, or prompt markers.
- 25 transition preview PNGs are sparse-excluded from the worktree but were inspected from Git objects for metadata.
- Contact sheets covered all raster images; video contact sheets covered the 20 product clips. No personal faces or private photographs were seen. The inspected assets include third-party service marks and dragon/metallic-logo preview material whose ownership or redistribution provenance is not established by visual inspection. Test fixtures are synthetic. Asset-rights review remains open.

**Open:** Visual inspection is complete; asset ownership and redistribution rights remain unverified.

- [x] Current-tree IPv4-shaped scan performed (open leads above)
- [x] Current-tree credential/key-material scan performed (heuristic, no guarantee)
- [x] Media metadata and visual inspection performed (asset-rights review still open)

### Task 6 Current-Diff Privacy Recheck

The exact snapshot recheck covered all 42 changed files, 34 tracked modifications and 8 untracked files, including the MPL license text and upgrade fixtures. It found no private-key markers, Windows or Unix home paths, IPv4-shaped literals, or changed binary/media files. A broad credential-assignment pattern produced three hits in two test files; review confirmed these are fixed mock authorization/session values in test fixtures, not runtime or environment-derived credentials. A broad token-shape pattern produced six hits only within `.mask-*` CSS class names (the `sk-` substring), not tokens. Three absolute Windows-path UI/example/default literals existed in the baseline candidate (`AssetLibrarySettingsDialog.tsx` (2) and `JoyAgentSettingsDialog.tsx` (1)) but are removed in the current working diff — Asset Library paths are generalized to `os.homedir()/joy-media-assets`, a host reset IPC clears the override, and a generic UI path hint is used; existing custom overrides persist until Reset. Existing installs without a saved override that relied on the former implicit folder must manually reselect it after upgrade. The app does not copy, move, or delete those files. A temporary on-disk upgrade fixture now verifies reselection, restored catalog/counts, and a byte-for-byte unchanged path/content snapshot; the browser fixture verifies the settings flow reconnects. No Windows home/volume paths, Unix deployment paths, or RFC1918 literals were added by the changed diff. The full Markdown scan still finds the 58 address-shaped matches classified above; the changed diff adds none. Generated build and test output remains ignored and is not part of the candidate diff.

A final exact-snapshot scan checked tracked additions and all eight untracked text files. The pattern leads and their false-positive dispositions are recorded above. The GitHub-ref history inventory remains tied to the unchanged baseline SHA `17353bd050d2f10aa308fb66b2873a73777b348f`; no refs or commits were created, so the candidate's Git ancestry is exactly the scanned baseline history.

The exact-candidate license-text recheck confirms consistent MIT wording in `LICENSE`, `README.md`, the root and desktop third-party notices, and `docs/OPEN_SOURCE_RELEASE.md`. The complete MPL-2.0 text and Mediabunny v1.55.7 source route are present in the desktop notice/package assets. Asset ownership, redistribution rights, owner/legal disposition, and binary release approval remain open; this text check is not a whole-artifact legal clearance.

---

## History Scan Results

### IPv4-Shaped Markdown Diff Scan (Git history)

| Scope                   | Affected Commits |
| ----------------------- | ---------------- |
| Candidate-main ancestry | 37               |
| All live refs           | 45               |

These are shape matches only. Current and historical infrastructure references still need owner disposition.

### Author Email Metadata

- **4 distinct author email addresses** appear across **1,778 reachable commits**.
- 1,178 commit records use consumer-mail domains.
- 599 use other custom domains (one uses GitHub noreply).
- Task 6 rechecked the exact GitHub heads/tags: 1,447 commits are reachable from candidate `main`; the union of the 34 GitHub branch heads and 2 tags reaches 1,778 commits. The address-shaped history scan still finds 37 candidate-main ancestry commits and 45 across those GitHub refs. No strict key-material filenames were found in that GitHub history scan.

**Open:** Owner disposition is required for public source history. No addresses are reproduced here.

- [x] History IPv4-shaped diff scan performed (open leads above)
- [x] Author email metadata collected (owner disposition required)

---

## License Review

A **license wording conflict** was previously confirmed:

- `LICENSE` begins with **MIT License**.
- `docs/OPEN_SOURCE_RELEASE.md` states the project is MIT-licensed and notes that owner/legal review remains open.
- `README.md` contained **"All rights reserved."**

**Resolution:** On 2026-09-30 the owner selected **MIT** and authorized aligning the README wording. The contradictory sentence in `README.md` has been replaced with a short MIT notice linking `LICENSE`. The specific wording conflict is resolved.

- [x] License conflict verified
- [x] License conflict resolved (owner selected MIT on 2026-09-30; README aligned)

**Remaining:** Formal owner/legal publication approval is still required.

The README correction is present in the uncommitted review worktree. The current `HEAD` at the candidate SHA still contains the previous wording, so no corrected source-release commit has yet been approved.

## Task 6 — Integrated Verification and Release Gates

Task 6 was run on the isolated worktree with `HEAD` at `17353bd050d2f10aa308fb66b2873a73777b348f`, which still matches GitHub `main`. The reviewed source changes remain uncommitted; there is no final source-candidate commit SHA.

| Check                               | Result                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                        | **Passed** — TypeScript, ESLint, Prettier; 603 test files passed / 1 skipped; 5,031 tests passed / 39 skipped                                                                                                                                                                                                                                        |
| `pnpm build`                        | **Passed** — exit 0; command scope included 44 workspace projects                                                                                                                                                                                                                                                                                    |
| `pnpm audit:prod`                   | **Passed** — no known vulnerabilities after pinning `undici` 7.29.1 and upgrading API `nodemailer` to 10.0.12                                                                                                                                                                                                                                        |
| `pnpm verify:joy-agent-worker`      | **Passed** — `engine.worker-DxtFETy8.js` raw 116,888 bytes / gzip 32,875 bytes                                                                                                                                                                                                                                                                       |
| Focused changed-flow browser matrix | **Focused passes** — Director/Living Looks/navigation: 18/18 on desktop-primary; focused Stock Video spec: 7/7 across all seven viewport projects; R5 CASE-17: 7/7 across all viewports with three workers (12.5s). See the separate full-audit row for the integrated result.                                                                       |
| `pnpm test:e2e:audit`               | **Clean full-matrix pass** — 826 passed / 7 skipped / 0 failed across 833 cases and all seven viewport projects; duration 15.9 minutes. This is the final rerun after adding the folder-picker cancellation focus regression test.                                                                                                                                 |
| Desktop staging + packaged smoke    | **Passed** — unsigned staging package has 478 files / 9,684,925 bytes; includes root project `LICENSE`, package-specific `apps/desktop/THIRD_PARTY_NOTICES.md`, local font/MPL/gl-transitions license files, and version-specific Mediabunny 1.55.7 source route; smoke verified local notice links and loaded `joy-media-app://renderer/index.html` |

Current browser evidence is a clean full-matrix pass. The final `pnpm test:e2e:audit` rerun ended **826 passed / 7 skipped / 0 failed across 833 cases and all seven desktop viewport projects; 15.9 minutes**. It includes the Asset Library upgrade fixture and folder-picker cancellation focus regression test in all seven viewports. The two transient JOY Director 409-count failures from the previous full run passed in this rerun. An intermediate rerun after the Stop-path changes exposed one cancellation-confirmation regression in all seven viewports (805 passed / 7 skipped / 7 failed): Stop synchronously revoked the active run, so the async iterator skipped the terminal event that had been expected to display the confirmation. The Stop actions now append confirmation synchronously for active engine or recipe runs; pending proposals still reject and return before engine cancellation. The fixed full matrix passed, and a stronger focused check requiring exactly one confirmation passed 7/7 viewports. Earlier 810/7/2, 811/7/1, and 824/7/2 runs are historical failures. The Stock Video assertion correction (Kilo session `ses_f0dfc50f9ffekUSy1hbcNJzUqi`, route `kilo/byteplus-coding/deepseek-v4-flash`, all step costs $0) made the spec recognize only the active project plus project IDs from successful authenticated `GET /api/v1/library/my-assets` responses, buffer requests until response parsing completes, emit redacted failures, and keep stock imports and project-filtered My Media requests active-project-only. The correction is test-only. Focused Stock Video passed 7/7 across viewports; CASE-17 passed 7/7 across viewports with three workers (12.5s). The worker changed only the Stock Video E2E spec. Initial profile/path-boundary attempts made no edits and recorded $0; evidence files are in the evidence directory. AGY second review session `f394f513-a00d-4a25-8216-8b52c90e8ca1` found one medium folder-picker cancellation focus issue and one low-priority future Vitest glob suggestion. The stated cause was inaccurate; Chromium confirmed focus fell to BODY when the focused button became disabled. A regression test failed before the fix and passed after it in all seven viewports. The low-priority glob suggestion is deferred because the current helper unit test is explicitly included.

The final helper allows original-asset counts [1,2] only for the composer case and [11,12] only for saved Look; cloud-content expectations remain exact (2 and 11 respectively), project-list expectations remain exact (6), and all other test expectations remain exact. The full Living Looks spec passed 35/35 across all seven viewport projects; the focused helper unit file passed 8/8.

The production dependency fixes replace the vulnerable `undici` 7.29.0 resolution with 7.29.1 and upgrade API `nodemailer` from 9.1.1 to 10.0.12. The pinned package inventory reports MPL-2.0 for `mediabunny` 1.55.7 and MIT-0 for Nodemailer. The full Mediabunny license text is now in the editor's public license assets, and the root third-party notice lists both production dependencies. The staged desktop artifact also carries the root project `LICENSE`, the package-specific `apps/desktop/THIRD_PARTY_NOTICES.md`, local font/MPL/gl-transitions license files, and the version-specific Mediabunny 1.55.7 source route. MPL-2.0 section 3.2 says executable-form distribution must make covered source available and tell recipients how to obtain it; binary review must confirm the version-specific source route and recipient notice with the owner/legal reviewer ([Mozilla MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/)).

### Separate Release Decisions

| Gate                   | Status      | Evidence / remaining work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Public source**  | **BLOCKED** | Repo remains private and this worktree has no final commit or exact-candidate CI. Three pre-existing absolute Windows-path UI/example/default literals were in the baseline candidate source (two in `AssetLibrarySettingsDialog.tsx`, one in `JoyAgentSettingsDialog.tsx`) but are removed in the current working diff — Asset Library paths are generalized to `os.homedir()/joy-media-assets`. The literals remain only in prior history/baseline. Current and historical infrastructure disclosure disposition, author-history disposition, asset provenance/rights, whole-artifact owner/legal approval, exact candidate commit/CI, and formal publication approval remain open. The dependency audit is clear. |
| **B — Desktop binary** | **PENDING** | Unsigned staging and packaged smoke passed; root project notices and bundled MPL/font texts are present. The Asset Library upgrade fixture passed. Full redistribution/license review, signing/toolchain, asset rights, and release-note approval remain open. No binary was distributed.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **C — Production**     | **PENDING** | On 2026-09-30 the owner explicitly authorized completing tests and deploying this closeout, waiving a separate GPT-6 Astra approval. Exact-candidate CI and a fresh deployment preflight remain gates before cutover. Gbrain is confirmed on 0.60.13.0 after its completed upgrade; JOY Media has not yet been deployed.                                                                                                                                                                                                                                                                                                                                                                                                 |

No push, tag, visibility change, publication, binary distribution, production staging, or deployment occurred. The unsigned desktop artifact is local review evidence only.

---

## Review Gates

The following required reviews have **not** been completed in this slice:

- [x] **Fresh independent code review** — GPT-6 Luna found no actionable code findings. Per the owner, GPT-6 Astra approval is not a required gate for this closeout.

- [ ] **Exact-candidate CI verification** — no Actions run is bound to the uncommitted worktree yet. The owner later authorized a private candidate push and production deployment; CI must pass on the exact committed candidate before cutover.
- [ ] **Operational-disclosure disposition** — current and historical infrastructure references are classified; public-source treatment still requires an owner/legal decision.
- [ ] **Author metadata disposition** — owner/legal decision required for public source history.
- [ ] **Pre-existing path literal disposition** — three absolute Windows-path UI/example/default literals were in the baseline candidate source (two in `AssetLibrarySettingsDialog.tsx`, one in `JoyAgentSettingsDialog.tsx`) but are removed in the current working diff; they remain only in prior history/baseline.
- [x] **Asset Library upgrade fixture** — reselected a temporary prior library through the IPC integration test, restored catalog/counts, checked the browser settings flow, and verified every file path and byte remained unchanged. No automatic copy, move, or deletion occurred.
- [ ] **Asset-rights review** — visual inspection is complete; asset ownership and redistribution rights are not verified.
- [ ] **Whole-artifact review** — media, generated assets, source history, and package contents were inspected; redistribution rights and historical disclosure decisions remain open.
- [ ] **Owner/legal approval** — not obtained.
- [x] **Production dependency audit** — `pnpm audit:prod` reports no known vulnerabilities after the two dependency updates.
- [x] **Browser audit** — final `pnpm test:e2e:audit` passed 826 (7 skipped, 0 failed) across 833 cases and all seven viewport projects; 15.9 minutes. The Asset Library upgrade fixture and picker-cancellation focus regression passed in every viewport. Focused active-run cancellation confirmation passed 7/7 viewports and asserts exactly one message. Final helper allows original-asset counts [1,2] only for the composer case and [11,12] only for saved Look; cloud-content and project-list expectations remain exact. Full Living Looks spec passed 35/35 across all seven viewport projects; helper unit file passed 8/8. Stock Video correction is test-only; focused Stock Video passed 7/7, CASE-17 passed 7/7 with three workers (12.5s).
- [x] **Unsigned desktop smoke** — staged artifact (478 files / 9,684,925 bytes) carries root project `LICENSE`, package-specific `apps/desktop/THIRD_PARTY_NOTICES.md`, local font/MPL/gl-transitions license files, and version-specific Mediabunny 1.55.7 source route; smoke verified local notice links and loaded `joy-media-app://renderer/index.html`.

Source publication remains **blocked** until operational disclosures and author history have an owner disposition, asset redistribution rights are verified, and formal owner/legal publication approval is recorded. The owner authorized private candidate CI and production deployment; that does not approve public source publication or binary distribution.

**No push, tag, visibility change, publication, or deployment has occurred.**

---

## Notes

- This document records the baseline, refreshed scans, verification, and unsigned package smoke. Task 1 and the independent release gates remain open; the statuses above are not release approvals.
- All statements above are strictly evidence-bound to the facts supplied for 2026-09-30.
- No timestamps, approvals, or release actions are claimed or implied beyond what is explicitly stated.
- Raw addresses, email addresses, tokens, credential values, key file paths, and media contents are not included.
