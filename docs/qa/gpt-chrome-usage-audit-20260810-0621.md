# GPT Chrome Usage Audit

> **Historical checkpoint:** This STEP-00/STEP-01 skeleton records the original
> closeout baseline and failure reproduction. Its `NOT-RUN` and export-failure
> rows are superseded by
> [`WP-29-r5-browser-closure-20260810-0621.md`](WP-29-r5-browser-closure-20260810-0621.md),
> [`WP-29-step-03-ffprobe-audio-20260810-0621.md`](WP-29-step-03-ffprobe-audio-20260810-0621.md),
> and [`WP-29-export-recovery-20260811.md`](WP-29-export-recovery-20260811.md).
> The final candidate SHA, deployment, live cleanup, and GBrain closeout remain
> pending.

## STEP-00 report

- Status: READY-FOR-REVIEW
- Starting commit: `ea6ac7966ff0c57757582f62554f04d605a03ed0`
- Result commit: this STEP-00 commit
- Branch: `codex/wp29-closeout-20260810-0621`
- Files changed: `docs/qa/WP-29-closeout-review-log-20260810-0621.md`, `docs/qa/gpt-chrome-usage-audit-20260810-0621.md`
- Behavior implemented: sanitized preflight audit only; no production or browser mutation
- Defects found/fixed: no product defect; report privacy cleanup only
- Tests run and exact outcomes: targeted Markdown formatting, `git diff --check`, privacy scan, and two-file diff guard all pass
- Browser/VPS evidence labels: `step-00/vps-preflight`, `step-00/reference-host-pending`, and `step-00/aggregate-baseline`
- Console/network observations: independent production recheck unchanged: API release label `ccdb031-wp29-closeout-api`; editor release label `editor-web-20260810-ccdb031-wp29-closeout`; API active with restart count `0`; Nginx valid; health `OK` with control plane `true`; existing public index hash unchanged
- Signed-in browser capture: client-local Projects catalog count is `1`; the pre-existing current project was captured; identity/title omitted
- Security/privacy checks: no project IDs or titles, contacts, Worker IDs, object refs, endpoint addresses, credentials, tokens, secrets, or absolute filesystem paths are stored
- Rollback or recovery note: restore labels and backup presence are retained as sanitized metadata; no mutation occurred
- Deviations from the step: named reference-host Chrome/GPU and hardware-acceleration evidence remains pending
- Remaining risk inside this step: all functional, UI/A11y, export, Worker, playback, and 37-case evidence remains unrun
- Worktree status: clean after commit
- Next step: STEP-01 (NOT STARTED)

## Accepted VPS context

| Field                                                    | Value                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| OS                                                       | Debian `13.6`                                                      |
| Chrome                                                   | `151.0.7922.71`                                                    |
| Graphics                                                 | virtual adapter context only                                       |
| FFmpeg / FFprobe                                         | `7.1.5` / `7.1.5`                                                  |
| Public index SHA-256                                     | `d98d1bdefa0557e6db7ed8fae82a52241efaa78e9d9955a0664d35f412f943c2` |
| Reference-host Chrome / OS / GPU / hardware acceleration | `PENDING`                                                          |

The VPS graphics environment is operational context only. It is not evidence
for the named signed-in reference host. No functional Chrome usage audit cases
were run in STEP-00.

The signed-in browser capture was read-only and limited to the client-local
Projects catalog and pre-existing current project. The project identity/title
was omitted.

## Accepted aggregate baseline

| Aggregate                                    |                                  Baseline |
| -------------------------------------------- | ----------------------------------------: |
| Projects active / trashed / revision sum     |                              `24 / 0 / 0` |
| Jobs total                                   |                                      `15` |
| Workers total / not revoked / revoked        |                               `6 / 1 / 5` |
| Assets count / bytes                         |                       `1273 / 1495353910` |
| Derivatives count / bytes                    |                               `1 / 29626` |
| Attempts / events / pairing offers           |                             `15 / 75 / 7` |
| Enabled users / active sessions / active OTP |                               `1 / 4 / 0` |
| Location records                             |                                    `1277` |
| External object-store size                   | not asserted; prior measurement timed out |

## Results skeleton

Allowed verdicts: `PASS`, `FAIL`, `FLAKY`, `BLOCKED-CONSENT`,
`BLOCKED-INTEGRATION`, `BLOCKED-CAPABILITY`, `NOT-RUN`.

| Surface  | Verdict | 1639x1066 | 1366x768 | 1024x768 | Evidence / notes                          |
| -------- | ------- | --------- | -------- | -------- | ----------------------------------------- |
| Export   | FAIL    | NOT-RUN   | NOT-RUN  | NOT-RUN  | STEP-01 consistent 0/3 capability failure |
| Worker   | NOT-RUN | NOT-RUN   | NOT-RUN  | NOT-RUN  | Later step required                       |
| Playback | NOT-RUN | NOT-RUN   | NOT-RUN  | NOT-RUN  | Reference host pending                    |
| 37 cases | NOT-RUN | NOT-RUN   | NOT-RUN  | NOT-RUN  | Later batch execution required            |

## 37-case batch skeleton

| Batch     | Cases                         |  Count | Verdict     |
| --------- | ----------------------------- | -----: | ----------- |
| A         | file bridge                   |      6 | NOT-RUN     |
| B         | pointer and gesture           |      5 | NOT-RUN     |
| C         | captions                      |      7 | NOT-RUN     |
| D         | Worker and audio              |      4 | NOT-RUN     |
| E         | effects and color             |      6 | NOT-RUN     |
| F         | motion, camera, and templates |      7 | NOT-RUN     |
| G         | destructive and recovery      |      2 | NOT-RUN     |
| **Total** | **37 cases**                  | **37** | **NOT-RUN** |

## Cleanup reconciliation

| Item                                         | Result                                                    |
| -------------------------------------------- | --------------------------------------------------------- |
| Projects, jobs, Workers, assets, and exports | unchanged; no STEP-00 mutation                            |
| Browser-local state                          | unchanged; read-only catalog/current-project capture only |
| Restore state                                | unchanged; sanitized restore labels retained              |

## STEP-01 — Export audit

- Status: **READY-FOR-REVIEW**
- Export verdict: **FAIL**
- Product code changes: **none**
- STEP-02: **NOT STARTED**

For 1080x1920 runs 1-3, timeline/profile/exact export click passed. Exact combined H264/AAC MIME support was false in all three; initiation was false; `captureStream`, recorder events, and export frames were each 0; download was false. The bounded durations were 10135 ms, 10144 ms, and 10107 ms. Each run purged its local project and closed its browser. Ratio: **0/3 pass, 3/3 consistent FAIL, not FLAKY**.

Accepted failure-evidence basenames are `wp29-step01-1080x1920-setup-only-1786350131655-sanitized.json`, `wp29-step01-1080x1920-setup-only-1786350324166-sanitized.json`, and `wp29-step01-1080x1920-setup-only-1786350347167-sanitized.json`. Their `setup-only` filename text is historical, but these three artifacts are accepted failure evidence. Earlier refused-navigation, selector, fake-lower-snapshot, overlapping, and generic-export attempts are excluded setup-only attempts and never enter the ratio.

| Capability                        | Default | Feature flag |
| --------------------------------- | ------- | ------------ |
| MediaRecorder                     | true    | true         |
| `video/mp4`                       | true    | true         |
| AVC1-only MP4                     | true    | true         |
| Exact `avc1.42E01E` + `mp4a.40.2` | false   | false        |
| `h264,aac`                        | false   | false        |
| VP8 + Opus                        | true    | true         |
| VP9 + Opus                        | true    | true         |

The default and feature-flag capability matrices are identical. Lower-profile comparisons for 320x180 and 720x1280 are **BLOCKED-CAPABILITY**: the common MIME guard fails before dimension-dependent renderer/readback, so no fake comparison is reported.

Measured root cause: the App's exact combined MIME preflight exits before renderer creation and `captureStream`. The historical `readPixels` stall was not reached in these runs.

The STEP-02 seam is capability negotiation at the browser-export MIME/MediaRecorder boundary and App preflight. Authored audio, progress, cancel, and cleanup must remain intact. Risks are container/codec mismatch or audio loss. Validation requires 3x 1080x1920, lower profiles, and independent FFprobe/audio verification. Rollback is limited to the eventual STEP-02 product commit.

Security: basenames only; no paths, URLs, contacts, IDs, tokens, or private references. Local projects were purged, browsers closed, and no production mutation occurred. Worker, playback, and 37 cases remain later gates.

Next step: NOT STARTED
