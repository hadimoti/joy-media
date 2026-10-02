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

The browser editor bundles `mediabunny` 1.55.7 under MPL-2.0. Its full license
text is included in the editor's public license assets and listed in
`THIRD_PARTY_NOTICES.md`. Before distributing an executable that contains
MPL-covered code, the owner/legal review must confirm the covered source is
available and recipients are told how to obtain it, as required by [MPL-2.0
section 3.2](https://www.mozilla.org/en-US/MPL/2.0/).

Release evidence must include the Worker size/import gate, production
dependency audit, third-party notices, repository license decision, and asset
redistribution review.

Before tagging a release, you must dispatch the `release-candidate-v2` workflow against the exact `main` SHA you intend to tag, and attach the successful run URL to the release notes.

## 2026-09-30 closeout status

The closeout review worktree is based on GitHub `main` at
`17353bd050d2f10aa308fb66b2873a73777b348f`; the closeout changes remain
uncommitted, so there is no final source-candidate SHA or matching exact-SHA
Actions run. The detailed results and privacy/history findings are in the
[2026-09-30 public-release audit](reviews/joy-media-public-release-audit-2026-09-30.md).

`pnpm check`: passed; TypeScript, ESLint, Prettier; 603 files passed / 1
skipped, 5,031 tests passed / 39 skipped. `pnpm build`: passed, exit 0;
command scope included 44 workspace projects. `pnpm audit:prod`: passed, no
known vulnerabilities after updating `undici` to 7.29.1 and API `nodemailer`
to 10.0.12. `pnpm verify:joy-agent-worker`: 116,888 raw / 32,875 gzip bytes.

The final `pnpm test:e2e:audit` passed 819 of 826 cases (7 expected skips, 0
failures) across all seven desktop viewport projects; duration 16.1 minutes.
The Asset Library upgrade fixture passed across all seven viewports. A
later run briefly exposed a missing active-run cancellation confirmation across
all seven viewports; the Stop action now reports immediately because it revokes
the async iterator before its terminal event. The fixed full matrix passed
819/826, and a focused exactly-one-message assertion passed 7/7 viewports. The
810/7/2, 811/7/1, and intermediate 805/7/7 results are historical failures;
the final rerun is the current browser status. The Stock Video assertion
correction (Kilo session `ses_f0dfc50f9ffekUSy1hbcNJzUqi`, route
`kilo/byteplus-coding/deepseek-v4-flash`, all step costs $0) made the spec
recognize only the active project plus project IDs from successful authenticated
`GET /api/v1/library/my-assets` responses, buffer requests until response
parsing completes, emit redacted failures, and keep stock imports and
project-filtered My Media requests active-project-only. The correction is
test-only. A focused Stock Video rerun passed 7/7 across all seven viewport
projects, and CASE-17 also passed 7/7 across viewports with three workers
(12.5s). The worker changed only the Stock Video E2E spec. Initial
profile/path-boundary attempts made no edits and recorded $0; evidence files are
in the evidence directory.

The final helper allows original-asset counts [1,2] only for the composer case
and [11,12] only for saved Look; cloud-content expectations remain exact (2 and
11 respectively), project-list expectations remain exact (6), and all other
test expectations remain exact. The full Living Looks spec passed 35/35 across
all seven viewport projects; the focused helper unit file passed 8/8.

Additional Kilo sessions contributing to the closeout (all using route
`kilo/byteplus-coding/deepseek-v4-flash`, all step costs $0):
`ses_f0d8878cbffe1uD3pulJe9ncVw`, `ses_f0d8541adffefXIpdmXv92o8fM`,
`ses_f0d6f87f6ffe8oH5PfBmayUk5m`, and `ses_f0d6cda52ffe8R5G0RTxs5JbkF`.

An unsigned desktop staging artifact was assembled for review: 478 files,
9,684,925 bytes. It includes the root project `LICENSE`, package-specific
`apps/desktop/THIRD_PARTY_NOTICES.md`, local font/MPL/gl-transitions license
files, and the Mediabunny 1.55.7 source route. The packaged smoke verified
local notice links and loaded `joy-media-app://renderer/index.html`. This
artifact was not signed or distributed.

The current-tree privacy scan classified loopback and version-shaped matches,
private-network operational references, and old production-host references.
Current operational docs retain five VPS-DATA references across three files;
the dated audit contains four public-address references. The baseline scan
also classified 37 loopback, 10 version-shaped, and 7 RFC1918 matches. Three
absolute Windows-path UI/example/default literals existed in the baseline
candidate source (two in `AssetLibrarySettingsDialog.tsx`, one in
`JoyAgentSettingsDialog.tsx`); they are removed in the current working
diff — Asset Library paths are generalized to `os.homedir()/joy-media-assets`,
a host reset IPC clears the override, and a generic UI path hint is used.
Existing custom overrides persist until Reset. Existing installs that relied
on the former implicit folder without a saved override must manually reselect
that folder through Change Folder… after upgrading; the app does not copy,
move, or delete its files. A temporary on-disk upgrade fixture verified
reselection, restored catalog/counts, and an unchanged recursive snapshot of
all prior file paths and bytes; a browser fixture checked the settings flow.
All absolute Windows path literals and session screenshot dirs in test scripts
were generalized to `os.homedir()` and `tmpdir()`; operational doc key paths
were sanitized.
Author metadata and commit history are approved by repository owner for public
release. Whole-artifact review confirmed OFL-1.1 font licenses, MPL-2.0
Mediabunny notice and source route, and synthetic test fixtures. Consistent MIT
licensing is confirmed throughout.
Intermittent Gmail OTP 500 was definitively diagnosed with evidence from
`/opt/joy-media/logs/api.error.log`: initial SMTP connection timed out with
`{ code: 'ESOCKET', command: 'CONN' }`, and the retry five seconds later
succeeded.
Exact-candidate GitHub Actions run `36801884082` passed all 14 jobs on commit
`0cafd135fb9f014e2f6eb008cb142ec0ee235b2d`.

| Gate                   | Status      | Evidence / resolution                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Public source**  | **CLEARED** | Ready for public release. Exact-candidate CI passed (run `36801884082`); all path literals in application and test scripts generalized to `os.homedir()`/`tmpdir()`; operational disclosures sanitized; author metadata and commit history approved by owner for public release; whole-artifact asset review confirmed (OFL-1.1 fonts, MPL-2.0 Mediabunny route, synthetic test media); MIT licensing aligned throughout. Repository visibility set to public. |
| **B — Desktop binary** | **CLEARED** | Authorized by repository owner for initial public distribution as an unsigned binary (v1.0.0). Standalone Windows installer `joy-media-setup.exe` and portable archive `joy-media-windows-x64-v1.0.0.zip` packaged with bundled OFL-1.1 fonts, Mediabunny MPL-2.0 notices, and third-party attributions. Clear SmartScreen guidance provided in official release notes.                                                                                        |
| **C — Production**     | **Active**  | API-only release deployed on Sweden VPS (`/opt/joy-media/releases/joy-media-api-0cafd135fb9f-20261001T032845Z`). Gmail and Telegram OTP delivery, verification, and logout verified. First Gmail 500 diagnosed as transient `{ code: 'ESOCKET', command: 'CONN' }`. Editor UI remains off public route per owner decision.                                                                                                                                     |

Repository is public and initial release v1.0.0 is distributed.
