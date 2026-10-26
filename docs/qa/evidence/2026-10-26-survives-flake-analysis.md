# Survives flake: analysis and reproduction attempts, 2026-10-26

Scope: the test "survives a Worker killed mid-job" in `apps/desktop/src/jobs/local-worker.integration.test.ts`, the flake
named in the L10 plan item. **Status: root cause not confirmed.** The source hold from `a165d51a` is in place, and the
timeout message now names the job's state, so the next failure says which cause it had.

## The failure on record

- ci-dev run `40118338118`, static job (ubuntu-24.04), commit `5d08272c`, created 2026-10-24 17:55 UTC. The test failed with
  `timed out waiting for the Worker to lease the job` after 60.4 s. The Worker had printed its hello, and nothing after it.
- That commit had no source hold in this test. `a165d51a` (2026-10-24, after the failure) added a 4-second hold, and its
  message gives the mechanism: a thumbnail job that finishes between two 100 ms polls is never seen as `running`.
- The three ci-dev runs since then that contain `a165d51a` (`6ae9be64`, `41f8431d`, `5103c444`) all succeeded, so this test
  passed in each of them.

## What the failure record cannot show

- The Worker's job log is an in-memory `BoundedLog` (`apps/worker/src/runtime.ts`) that nothing prints. Silence after the
  hello therefore says nothing about whether a lease happened.
- The old timeout message reported only the Worker's presence, not the job's state.

So the timeout has two possible causes, and the failure record cannot separate them:

1. The job ended before the wait saw it `running` (a fast completion or a fast failure). The lease did happen.
2. No Worker leased the job.

## Measurements on this PC (2026-10-26)

Environment: WSL2 Ubuntu 24.04, Node 22.23.3, pnpm 11.15.0, FFmpeg 6.1.1, 32 logical CPUs. The branch head `2b01e8f4` was
extracted with `git archive`, its dependencies were installed from the local pnpm store and the missing tarballs, and the
Worker was built with `tsc -b`. CI uses a pinned FFmpeg 8.1.3 build, so job timing here is only indicative.

| Run          | Test state                                                           | Result                                             |
| ------------ | -------------------------------------------------------------------- | -------------------------------------------------- |
| Control      | HEAD, hold present                                                   | pass, 4.7 s                                        |
| Single run   | hold removed                                                         | pass, 5.7 s                                        |
| Five runs    | hold removed, 2 cores pinned, 4 CPU burners pinned to the same cores | pass, 6.4 to 6.5 s each                            |
| Window probe | hold removed, job status polled every 1 ms                           | `running` seen; running to done 542.3 ms (one run) |

On this host the `running` window is about 540 ms, which is well above the 100 ms poll, and six runs without the hold did
not reproduce the timeout. The failure therefore needs either a job much faster than this host's, or a lease that never
happened. This host cannot tell us which, and the failing log cannot either.

## Diagnostics added

The timeout message now includes the job's status, attempts and error, next to the Worker's exit, presence and output tail.
Read the next failure this way:

- `job=done attempts=1` or `job=failed attempts=1`: the job ran and ended before the wait saw it `running`. Cause 1.
- `job=queued attempts=0`: no Worker leased the job. Cause 2.

## Not done

- No reproduction under the CI runner's conditions. The one failure is the only occurrence on record.
- The Worker's log is not printed, so Worker-side errors stay invisible to the test. A follow-up could print the log tail when
  a daemon job fails. That changes product code, so it is not part of this change.

## Full suite under load

Run on WSL with the same two-core pinning and two CPU burners. See the section below for its result.
