# D18 shadow pair 1: INCONCLUSIVE, not PASS

**Classification:** INCONCLUSIVE. The pair cannot be compared, and it cannot pass.

**Run:** release-candidate-v2 [40401999522](https://github.com/hadimoti/joy-media/actions/runs/40401999522), workflow ref `proposal/v2-p0-scope` at `4e47d193`, candidate `f71e899d7054eb035e372d8d351960e45148ba16`, attempt 1, conclusion `cancelled`.

- Created 2026-10-26 21:09:49Z. The last job ended 22:09:49Z (the gate summary), about 60 minutes after the run began.
- Critical path: `windows-p0-real-services` (55 min 57 s), then `windows-worker-clean` (2 min 19 s, failed), then `gate-summary` (40 s, failed).
- v3 was not dispatched for this pair. Its outcome cannot change the INCONCLUSIVE classification, and the Windows runner was needed for the next pair.

## Why the pair is inconclusive

1. **Node 24 wrote no report.** Its FFmpeg step ran 38 min 41 s (21:10:45Z to 21:49:26Z). Node 22 ran the same step in 22 s. The CLI suite then started at 21:49:26Z and was cancelled at 21:55:18Z by the 45-minute job limit, before the Vitest JSON was written. The job is recorded as `cancelled`. See `logs/node_contracts__Node_24__-121850067186.txt`.
2. **Linux P0 pass 2 has no retained report.** Pass 2 finished its tests, but its report upload failed with `Failed to CreateArtifact: Unable to make request: ECONNRESET`. The step had `continue-on-error: true`, so the job still showed success. Pass 1's report is retained.
3. **`windows-worker-clean` failed on the candidate, not on infrastructure.** The installer integrity check stopped with `AssertionError [ERR_ASSERTION]: Required distribution file missing: joy.cmd` (`tests/desktop/installer-package-check.mjs:109`). Commit `7e31f4af` moved the CLI launchers into `bin/` (`cli-launcher-layout.mjs`: `CLI_LAUNCHER_DIRECTORY = 'bin'`), but the check still looks for `joy.cmd` and `joy-media.cmd` in the install root. The stale expectation is in the candidate tree, so this failure reproduces on every run of `f71e899d`. See `logs/windows_worker_clean__two_exact_passes__-121850656417.txt`.
4. **The gate produced no v2 verdict.** `gate-summary` stopped at its lane check: `lane result(s) not success: acceptance-primary="skipped", acceptance-responsive="skipped", node-contracts="cancelled", real-service-acceptance="skipped", windows-worker-clean="failure"`. The durable store step then found no readiness evidence, no gate report and no Windows acceptance file, so the v2 side has no 17 checks, no lifecycle transitions and no acceptance-lane evidence. See `logs/gate_summary_-121878593683.txt`.

## Matrix instances

| Instance                                                           | Job result              | Executed tests                                                  | Report retained | Note                                                              |
| ------------------------------------------------------------------ | ----------------------- | --------------------------------------------------------------- | --------------- | ----------------------------------------------------------------- |
| node-contracts, Node 22.17.0                                       | success                 | CLI 860 (842 passed, 18 pending, 0 failed); PG 1 passed         | yes             | Artifact `joy-media-v2-vitest-node-contracts-40401999522-1-f71e…` |
| node-contracts, Node 24                                            | cancelled at 45 min     | none written                                                    | no              | See reason 1                                                      |
| linux-real-services, pass 1                                        | success                 | 176 (173 passed, 3 pending, 0 failed)                           | yes             |                                                                   |
| linux-real-services, pass 2                                        | success (upload failed) | step completed; count not retained                              | no              | See reason 2                                                      |
| windows-p0-real-services                                           | success                 | P0 176 (176 passed); CLI 860 (835 passed, 25 pending, 0 failed) | yes             |                                                                   |
| p3-real-services, pass 1 and 2                                     | success                 | (no Vitest report)                                              | n/a             |                                                                   |
| windows-worker-clean                                               | failure                 | not reached                                                     | n/a             | See reason 3                                                      |
| acceptance-primary, acceptance-responsive, real-service-acceptance | skipped                 | not run                                                         | n/a             | Downstream of `windows-worker-clean`                              |

## Job timings (UTC, from the Actions API)

| Job                          | Start    | End      | Duration | Result    |
| ---------------------------- | -------- | -------- | -------- | --------- |
| validate-candidate           | 21:09:52 | 21:09:59 | 0:07     | success   |
| editor-web-bundle            | 21:10:01 | 21:11:09 | 1:08     | success   |
| prod-build-smoke             | 21:10:07 | 21:12:05 | 1:58     | success   |
| node-contracts (22.17.0)     | 21:10:01 | 21:23:20 | 13:19    | success   |
| node-contracts (24)          | 21:10:02 | 21:55:22 | 45:20    | cancelled |
| linux-real-services (pass 2) | 21:10:06 | 21:23:29 | 13:23    | success   |
| linux-real-services (pass 1) | 21:23:33 | 21:36:00 | 12:27    | success   |
| p3-real-services (pass 1)    | 21:12:09 | 21:23:21 | 11:12    | success   |
| p3-real-services (pass 2)    | 21:23:32 | 21:33:18 | 9:46     | success   |
| windows-p0-real-services     | 21:10:45 | 22:06:42 | 55:57    | success   |
| windows-worker-clean         | 22:06:45 | 22:09:04 | 2:19     | failure   |
| gate-summary                 | 22:09:09 | 22:09:49 | 0:40     | failure   |

## What is preserved

The raw evidence is kept in the project's durable evidence store on the acceptance runner, not in this repository. The raw files contain runner paths, which the documentation privacy scan rejects. The store copy is folder `40401999522-1-pair1-preserved` under candidate `f71e899d7054eb035e372d8d351960e45148ba16`. It holds:

- the five retained Vitest reports (the GitHub artifacts expire after one day, so this copy is the record);
- the run and job metadata, including every step's timing;
- the three job logs that explain the classification (the full logs stay on GitHub for the retention period).

Its `SHA256-ALL.txt` checksums verified 11 of 11 files on 2026-10-27. The report checksums are:

| Report                                 | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| node-contracts-cli.json (Node 22.17.0) | `a92ffe98cc589ac6379db495f00f4800606d74aec1070585454da497ab5b643a` |
| node-contracts-pg.json (Node 22.17.0)  | `7e8d6ed5f3a311aec367d7e3d1f8b40e7843ded6fabd40f206fb486777bdbf98` |
| linux-p0.json (pass 1)                 | `c293da1414d7657312497aa49271ea0cac3a9d9be5249c885aefcfa6ac67f1b5` |
| windows-p0.json                        | `c5df4f79b691125e4e17ce28b36fa3f0981fc827a953320ed09feaa6542fd678` |
| windows-cli.json                       | `80a5152497a1704468bcd59cbe275de60e56ce9f1ba6ccba5a9ce1401b685b67` |

## Durable store

The gate step wrote the v2 shadow inputs to the candidate's `40401999522-1-pgate` folder in the same store. It wrote only `v2-shadow/needs.json` and its checksum file. The readiness evidence, gate report and Windows acceptance files are absent, so the shadow comparison cannot read a v2 verdict from this run.
