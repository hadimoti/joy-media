# WP-29 Closeout Review Log

## STEP-00 report

- Status: READY-FOR-REVIEW
- Starting commit: `ea6ac7966ff0c57757582f62554f04d605a03ed0`
- Result commit: this STEP-00 commit
- Branch: `codex/wp29-closeout-20260810-0621`
- Files changed: `docs/qa/WP-29-closeout-review-log-20260810-0621.md`, `docs/qa/gpt-chrome-usage-audit-20260810-0621.md`
- Behavior implemented: sanitized STEP-00 preflight and audit baselines only; no product behavior changed
- Defects found/fixed: no product defect; removed filesystem and private-identity details from the run reports
- Tests run and exact outcomes: targeted Markdown formatting, `git diff --check`, privacy scan, and two-file diff guard all pass
- Browser/VPS evidence labels: `step-00/vps-preflight`, `step-00/aggregate-database-baseline`, and `step-00/restore-baseline`; no raw browser or private-object artifacts
- Console/network observations: independent production recheck unchanged: API release label `ccdb031-wp29-closeout-api`; editor release label `editor-web-20260810-ccdb031-wp29-closeout`; API active with restart count `0`; Nginx valid; health `OK` with control plane `true`; existing public index hash unchanged
- Signed-in browser capture: client-local Projects catalog count is `1`; the pre-existing current project was captured; identity/title omitted
- Security/privacy checks: no project IDs or titles, contacts, Worker IDs, object refs, endpoint addresses, credentials, tokens, secrets, or absolute filesystem paths are stored
- Rollback or recovery note: prior API/editor release labels and the pre-cutover database backup remain the documented restore targets; no mutation occurred
- Deviations from the step: Chrome/GPU/hardware-acceleration evidence is explicitly pending on the named reference host; VPS graphics are context only
- Remaining risk inside this step: the reference-host matrix, export, Worker, playback, and 37-case gates remain unrun
- Worktree status: clean after commit
- Next step: STEP-01 (NOT STARTED)

## Run identity

| Field               | Value                                      |
| ------------------- | ------------------------------------------ |
| Run ID              | `wp29-closeout-20260810-0621`              |
| Branch              | `codex/wp29-closeout-20260810-0621`        |
| Starting commit     | `ea6ac7966ff0c57757582f62554f04d605a03ed0` |
| Preflight time      | `2026-08-10T06:21:35Z`                     |
| Production mutation | `false`                                    |

## Sanitized operational baseline

| Aggregate                                       | Baseline                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| Deployed source                                 | `ccdb031f6ce881c077742928de8adf8a5216026d`                         |
| Active API release label                        | `ccdb031-wp29-closeout-api`                                        |
| Active editor release label                     | `editor-web-20260810-ccdb031-wp29-closeout`                        |
| API service                                     | active; restart count `0`                                          |
| Public/origin health                            | `ok`; control plane `true`                                         |
| Nginx validation                                | passed                                                             |
| Public index SHA-256                            | `d98d1bdefa0557e6db7ed8fae82a52241efaa78e9d9955a0664d35f412f943c2` |
| VPS OS                                          | Debian `13.6`                                                      |
| VPS Chrome                                      | `151.0.7922.71`                                                    |
| VPS graphics                                    | virtual adapter context only; not reference proof                  |
| VPS FFmpeg / FFprobe                            | `7.1.5` / `7.1.5`                                                  |
| Reference-host Chrome / OS / GPU / acceleration | `PENDING`                                                          |

## Aggregate database baseline

| Aggregate                                   |                                  Baseline |
| ------------------------------------------- | ----------------------------------------: |
| Projects active / trashed / revision sum    |                              `24 / 0 / 0` |
| Jobs total                                  |                                      `15` |
| Jobs canceled / completed / leased / queued |                           `2 / 6 / 2 / 5` |
| Workers total                               |                                       `6` |
| Workers not revoked / revoked               |                                   `1 / 5` |
| Workers with valid session                  |                                       `1` |
| Workers seen in prior two minutes           |                                       `0` |
| Assets count / bytes                        |                       `1273 / 1495353910` |
| Derivatives count / bytes                   |                               `1 / 29626` |
| Job attempts                                |                                      `15` |
| Job events                                  |                                      `75` |
| Pairing offers                              |                                       `7` |
| Enabled users                               |                                       `1` |
| Active sessions                             |                                       `4` |
| Active OTP                                  |                                       `0` |
| Location records                            |                                    `1277` |
| External object-store size                  | not asserted; prior measurement timed out |

## Restore and mutation boundary

| Item                         | Result                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| API rollback target          | retained: `e02f646-wp29-reliability-api`                                                                  |
| Editor rollback target       | retained: `editor-web-20260810-035553-e02f646-wp29-reliability`                                           |
| Database restore artifact    | retained as sanitized label `pre-cutover-database-restore`                                                |
| Project list/current project | client-local Projects catalog count is `1`; pre-existing current project captured; identity/title omitted |
| STEP-00 mutation             | none: no project, job, Worker, asset, database, production, or browser state changed                      |

At the STEP-00 snapshot, STEP-01 and later gates had not started; the appended sections below supersede that snapshot. The reports retain
only sanitized release labels, run metadata, versions, hashes, aggregate counts,
and restore status.

## STEP-01 — Export profile diagnostic

- Status: **READY-FOR-REVIEW**
- Diagnostic functional result: **FAIL**
- Product code changes: **none**
- STEP-02: **NOT STARTED**

### Accepted result

Three bounded 1080x1920 runs reached the intended timeline/profile and exact export click (**PASS** for each). In every run, exact combined H264/AAC MIME support was false, initiation was false, `captureStream` was 0, recorder events were 0, export frames were 0, and download was false. Durations were 10135 ms, 10144 ms, and 10107 ms. Each run ended with the local project purged and the browser closed.

Ratio: **0/3 pass; 3/3 consistent FAIL; not FLAKY**.

Accepted failure-evidence basenames:

- `wp29-step01-1080x1920-setup-only-1786350131655-sanitized.json`
- `wp29-step01-1080x1920-setup-only-1786350324166-sanitized.json`
- `wp29-step01-1080x1920-setup-only-1786350347167-sanitized.json`

Their `setup-only` filename text is historical; these three files are accepted failure evidence. Earlier refused-navigation, selector, fake-lower-snapshot, overlapping, and generic-export attempts are excluded setup-only attempts and are never included in the ratio.

### Capability result

| Capability                        | Default | Feature flag |
| --------------------------------- | ------- | ------------ |
| MediaRecorder                     | true    | true         |
| `video/mp4`                       | true    | true         |
| AVC1-only MP4                     | true    | true         |
| Exact `avc1.42E01E` + `mp4a.40.2` | false   | false        |
| `h264,aac`                        | false   | false        |
| VP8 + Opus                        | true    | true         |
| VP9 + Opus                        | true    | true         |

The default and feature-flag matrices are identical. The 320x180 and 720x1280 profiles are **BLOCKED-CAPABILITY** because the shared MIME guard fails before dimension-dependent renderer/readback. No fake comparison is claimed.

### Root cause and STEP-02 seam

Measured root cause: the App's exact combined MIME preflight exits before renderer creation and `captureStream`; the historical `readPixels` stall was not reached in these runs.

The STEP-02 seam is capability negotiation at the browser-export MIME/MediaRecorder boundary and App preflight, while preserving authored audio, progress, cancel, and cleanup. Risks are container/codec mismatch or audio loss. Validation must include 3x 1080x1920, lower profiles, and independent FFprobe/audio verification. Rollback applies only to the eventual STEP-02 product commit.

Security: evidence is named by basename only, with no paths, URLs, contacts, IDs, tokens, or private references. Local projects were purged, browsers were closed, and no production mutation occurred. Remaining later gates are Worker, playback, and 37 cases.

Next step: NOT STARTED

## STEP-02 — Export repair

## STEP-02 report

- Status: READY-FOR-REVIEW
- Starting commit: `732af0b95b66176719e40c35ca526f5b8d6f917e`
- Result commit: this STEP-02 commit
- Branch: `codex/wp29-closeout-20260810-0621`
- Files changed:
  - `apps/editor-web/src/App.tsx`
  - `apps/editor-web/src/AssetLibraryPanel.tsx`
  - `apps/editor-web/src/asset-library-state.ts`
  - `apps/editor-web/src/asset-library-state.test.ts`
  - `apps/editor-web/src/asset-library-panel-contract.test.ts`
  - `apps/editor-web/src/export-history.ts`
  - `apps/editor-web/src/export-history.test.ts`
  - `apps/editor-web/src/export-preload.ts`
  - `apps/editor-web/src/export-preload.test.ts`
  - `apps/editor-web/src/export-mp4-contract.test.ts`
  - `packages/renderer-pixi/src/browser-export.ts`
  - `packages/renderer-pixi/src/browser-export.test.ts`
  - `docs/qa/WP-29-step-02-export-repair-20260810-0621.md`
  - `docs/qa/WP-29-closeout-review-log-20260810-0621.md`
  - `docs/qa/gpt-chrome-usage-audit-20260810-wp29.md`
- Behavior implemented: browser MP4 MIME selection now prefers exact H.264/AAC,
  then generic MP4, then H.264-only MP4; recorder-reported MIME is retained.
  Successful imports are revealed immediately, export preload stages are bounded
  and abort-aware, and export-preset persistence occurs only after the browser
  download succeeds so project rerenders cannot revoke resolver URLs mid-export.
- Defects found/fixed: exact combined MIME was unavailable in the VPS Chrome;
  imported assets could remain hidden in a large catalog; an early
  `replaceVisualProject` call cleared the project media resolver and revoked the
  authored-audio Blob URL during preload.
- Tests run and exact outcomes: 24 focused export/preload/history/renderer tests
  passed; renderer and editor builds passed; the editor production build passed
  with 1277 transformed modules; scoped formatting and `git diff --check` passed.
- Browser/VPS evidence paths: sanitized basenames
  `wp29-step02-1080x1920-run-1-1786358706184-sanitized.json`,
  `wp29-step02-1080x1920-run-1-1786358746353-sanitized.json`, and
  `wp29-step02-1080x1920-run-1-1786358786631-sanitized.json`.
- Console/network observations: three consecutive fresh-state 1080x1920 runs
  emitted genuine downloads within the reference timeout. Same-server
  duplicate-card strict-locator blocks are excluded as harness contamination.
- Security/privacy checks: evidence uses basenames only; no secrets, contacts,
  private references, or absolute paths enter the repository.
- Rollback or recovery note: revert this STEP-02 commit; production was not
  changed.
- Deviations from the step: independent FFprobe and authored-audio validation are
  intentionally deferred to STEP-03.
- Remaining risk inside this step: no open STEP-02 blocker.
- Worktree status: clean after commit
- Next step: NOT STARTED

## STEP-03 report

- Status: BLOCKED
- Starting commit: `f436acd78e9a`
- Result commit: this STEP-03 evidence commit
- Branch: `codex/wp29-closeout-20260810-0621`
- Files changed: STEP-03 report and this review log.
- Behavior implemented: none; this step independently validated the STEP-02
  browser artifact.
- Defects found/fixed: generic `video/mp4` output is VP9/Opus rather than the
  required H.264/AAC pair.
- Tests run and exact outcomes: three fresh 1080x1920 downloads passed the
  download gate; independent FFprobe failed the H.264/AAC assertion 3/3.
  FFmpeg volume detection reported -21.1 dB mean and -17.6 dB max on each.
- Browser/VPS evidence paths: sanitized MP4 basenames and the STEP-03 report
  basename only.
- Security/privacy checks: mode 0600 evidence, basename-only references, and
  no secret-like values.
- Rollback or recovery note: no product or production mutation occurred.
- Deviations from the step: mute and gain-direction checks were deferred because
  the required codec gate failed first.
- Remaining risk inside this step: H.264/AAC browser export or verified remux
  remains required.
- Worktree status: clean after commit

## STEP-03 implementation closeout - 2026-08-10

- Added server-side browser-MP4 remux handoff and wired App to download only the
  verified result.
- Focused unit/API/renderer/editor checks pass (32 tests in the final focused
  run); API and editor production builds pass.
- Three fresh authenticated 1080x1920 journeys completed; independent FFprobe
  confirms H.264/AAC, one video plus one audio stream, at 30 fps, in all 3.
- No production deployment or live project mutation was performed.

## R4 probe review - 2026-08-10

The corrected continuous playback probe was run once and recorded 30 decoded /
57 presentation-dropped frames. The run is BLOCKED-INTEGRATION because the
Diagnostics panel was not selected through a stable locator and drift/stall
fields were absent; no performance PASS is claimed. R2 verification tests pass,
but a real connected Worker review/apply remains unrun.
