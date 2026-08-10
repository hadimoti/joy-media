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

STEP-01 and every later gate remain `NOT STARTED` / `NOT-RUN`. The reports retain
only sanitized release labels, run metadata, versions, hashes, aggregate counts,
and restore status.
