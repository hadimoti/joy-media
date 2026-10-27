# Survives flake: loaded reproduction and diagnosis (2026-10-28)

Test: `apps/desktop/src/jobs/local-worker.integration.test.ts`, "survives a Worker killed mid-job". This is the one failure on
the release-gate list of flakes (`docs/qa/evidence/2026-10-26-v103-milestone-status.md`, "CI and flakes").

Host: Windows 11, 32 logical cores, Node 24.19.0, Vitest 3.2.7, FFmpeg 8.1.3. Load: 32 busy-loop processes, one per logical
core, each stopping on its own after 12 minutes.

## Results

| Configuration          | Load          | Runs | Failures | Recorded error                                                                  |
| ---------------------- | ------------- | ---- | -------- | ------------------------------------------------------------------------------- |
| Lease cap 3 s (before) | none          | 3    | 0        | none                                                                            |
| Lease cap 3 s (before) | 32 busy loops | 42   | 3        | `worker lease expired` for one failure; the other two predate the error message |
| Lease cap 20 s (after) | none          | 3    | 0        | none                                                                            |
| Lease cap 20 s (after) | 32 busy loops | 24   | 0        | none                                                                            |

The 42 loaded runs with the 3 s cap include runs made while the assertion message was changed. The pass condition did not
change. The first two failures failed at the last assertion with status `failed`, not `done`. The third recorded
`worker lease expired` on the restarted Worker's thumbnail job.

## Mechanism, from the code

- `apps/desktop/src/jobs/job-orchestrator.ts`: a lease lasts the smaller of the requested duration and the orchestrator's cap.
  A heartbeat renews it. `expireLeasesWithin` fails a running job whose lease has passed, with `worker lease expired`.
- `apps/worker/src/worker-daemon.ts`: the Worker heartbeats every 10 seconds, and again on each progress report.
- The test capped the lease at 3 seconds. A job that is slow to reach its first heartbeat expires by design when the machine is
  loaded. That is the lease rule working as written, under a configuration the Worker's heartbeat cannot meet.
- The shipped configuration is different: `createJobOrchestrator({ store })` uses the default cap, and the Worker asks for a
  30-second lease. The 10-second heartbeat keeps a margin of 20 seconds there.

## Change

- `LEASE_CAP_MS` in the test: 3 s to 20 s, above the 10-second heartbeat. The comment in the test gives the reason.
- The assertion on the restarted job now names the job's recorded error in its failure message. The condition is unchanged.
- No product code changed. The killed job still has to end as `failed` with the expired-lease error, and the restarted Worker
  still has to finish new work.

## What this does not prove

- 0 failures in 24 loaded runs is consistent with the fix, but not proof. At the earlier rate, about two failures were expected in
  24 runs; zero by chance has a probability of roughly 0.18. Watch the scheduled runs.
- The error text is recorded for one of the three failures only.
- One Windows host was used. Earlier WSL observations (the job stays `running` for about 540 ms) were made under other conditions.
- The root cause in the test's timing is supported by the code and by the recorded error. It is not measured directly. A direct
  measurement would log the time from lease grant to the first heartbeat under load.

## How to reproduce

```bash
node node_modules/vitest/vitest.mjs run apps/desktop/src/jobs/local-worker.integration.test.ts -t "survives a Worker killed mid-job"
```

Under load, run the same command while 32 busy-loop processes are running, one per logical core.
