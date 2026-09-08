# JOY Media CI — benchmark results (measured)

**Branch `codex/joy-live-director-ci-opt`.** Two runs of the optimized
`release-candidate-v2.yml` against the same application candidate. Numbers are
**measured**, not projected.

## Benchmark 1 — speed measurement (revision `cdbb771f`)

`gh run 34239133175`, dispatched 2026-09-08 14:34:30Z. This revision has the
**pre-hardening** teardown (still `.catch(() => undefined)`), no janitor, no
prod-build-smoke — so it is a **performance benchmark, not gate evidence.**

| Lane                                                                                                                                                        | Result                                                                                                                                                                                                                              | Wall time                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| validate-candidate                                                                                                                                          | ✅                                                                                                                                                                                                                                  | 0m43s                                                          |
| linux-real-services pass 1 (`verify:ci`: 4171 vitest passed / 73 skipped / 0 failed + real-service gate)                                                    | ✅                                                                                                                                                                                                                                  | 2m01s                                                          |
| linux-real-services pass 2                                                                                                                                  | ✅                                                                                                                                                                                                                                  | 1m56s (serial after pass 1 — same `joy-media-ci` linux runner) |
| windows-worker-clean (2 internal passes)                                                                                                                    | ✅                                                                                                                                                                                                                                  | 2m06s (**parallel** with linux; teardown fix — **no flake**)   |
| acceptance-responsive pass 1 (`wp32-responsive-checkpoints` × 6 viewports, ~6.5s each)                                                                      | ✅ 6/6 passed                                                                                                                                                                                                                       | 1m43s                                                          |
| acceptance-responsive pass 2                                                                                                                                | ✅ 6/6                                                                                                                                                                                                                              | 1m52s (serial)                                                 |
| acceptance-primary pass 1 (`tests/e2e` × desktop-primary, `--workers=2`)                                                                                    | ✅ **99 passed / 1 skipped / 0 flaky**                                                                                                                                                                                              | 3m06s                                                          |
| acceptance-primary pass 2                                                                                                                                   | ✅ 99/1/0                                                                                                                                                                                                                           | 3m14s (serial)                                                 |
| real-service-acceptance pass 2 (primary-full + 6 responsive vs real services + **30-min effects soak** + delivery journey + N/N-1 restore + `release:gate`) | ✅ `release:gate` passed                                                                                                                                                                                                            | **39m23s**                                                     |
| real-service-acceptance pass 1                                                                                                                              | ✅ `release:gate` passed                                                                                                                                                                                                            | **39m17s** (serial)                                            |
| gate-summary                                                                                                                                                | ❌ **bash parsing bug in the summary step** — every lane result was `success`, but `tr -d '[]" '` left newlines in the pretty-printed JSON so blank lines were counted as non-success. **Not a lane failure.** Fixed on `498c45fe`. | 0m12s                                                          |

**Total wall clock: 14:34:30Z → 16:11:41Z = 1h 37m 11s.**

### Isolation + cleanup (benchmark 1)

Live sampler of `pg_namespace` + `mc ls` every 90s. GitHub ran pass **2 before
pass 1** (matrix order is not guaranteed); both ran serially on the one
`joy-media-acceptance` runner.

| Time          | pass 2 namespace                                         | pass 1 namespace                                                           |
| ------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| 15:30:20Z     | `ci_accept_34239133175_1_2` (18 tables) + bucket `…-1-2` | —                                                                          |
| **15:31:53Z** | **dropped** (`schemas: none`)                            | —                                                                          |
| 15:32:01Z     | pass 2 job `success`                                     | pass 1 starts 15:32:06                                                     |
| **15:33:26Z** | gone                                                     | **`ci_accept_34239133175_1_1` (18 tables) + bucket `…-1-1` created fresh** |
| **16:10:52Z** | —                                                        | **dropped**                                                                |
| 16:11:23Z     | —                                                        | pass 1 job `success`                                                       |
| post-run      | —                                                        | —                                                                          |

- **Fresh-namespace isolation:** the two passes' schemas/buckets **never
  coexisted**. Each pass got a unique, never-before-used
  `ci_accept_<run>_<attempt>_<pass>` / `joy-media-<run>-<attempt>-<pass>`. Pass 1
  cannot have inherited pass 2's database, object-store, browser or Worker state.
- **Cleanup:** post-run, `SELECT nspname … LIKE '%34239133175%'` returns **0
  rows** and no `joy-media-34239133175-*` bucket remains. Both passes cleaned up.
  (This was the pre-hardening teardown — it worked here, but it _could_ have
  failed silently; `498c45fe` makes it a hard, verified pass/fail.)

## Improvement vs. the current gate

|                          | Current gate                   | Optimized (benchmark 1)       |
| ------------------------ | ------------------------------ | ----------------------------- |
| One full workflow        | ~4h20–4h32 (confirmed range)   | **1h37m** (~2.7× faster)      |
| Gate contract            | **2** full green workflow runs | **1** run, 2 isolated passes  |
| **End-to-end gate**      | **~8.7–9h**                    | **~1h37m**                    |
| **Measured improvement** |                                | **≈ 5.4× faster, ~7 h saved** |

The 30-min effects soak (retained, one per pass → 2 per gate, was 4) is now ~76%
of a real-service pass — the largest remaining fixed cost, and left untouched
pending a separate review.

## Benchmark 2 — hardened evidence run (revision `498c45fe`)

`gh run 34249975458`, dispatched 2026-09-08 16:15:48Z. Adds, over benchmark 1:

- **Enforced teardown** — `real-service-acceptance.mjs` re-inspects the runner
  and fails the pass on any run-owned residue; writes `teardown.json`; the
  workflow requires `clean: true`.
- **`ci-namespace-janitor.mjs`** inventory step (evidence required; deletes
  nothing).
- **`prod-build-smoke`** lane — the shipped bundle through the public UI
  (validated locally 5/5 in 20.6s).
- The `gate-summary` parsing fix.

**Result: FAILED to produce gate evidence.** `real-service-acceptance` never ran
its body — the new `ci-namespace-janitor` step crashed with
`Cannot find module 'pg'` (`createRequire(import.meta.url)` from
`ops/self-hosted/linux-runner/`, which has no `node_modules`). Fixed on
`8c5a4445` (`createRequire(new URL('../../../apps/api/package.json', …))`, the
pattern `real-service-acceptance.mjs` already used). Not a lane/app failure.

## Benchmark 3 — hardened run (revision `8c5a4445`)

`gh run 34252332556`, dispatched 2026-09-08 16:38:52Z. **Total wall clock
16:38:52Z → 18:15:57Z = 1h 37m 05s** (matches benchmark 1).

| Lane                               | Result | Notes                                                                                                                            |
| ---------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| validate-candidate                 | ✅     |                                                                                                                                  |
| linux-real-services pass 1 / 2     | ✅ ✅  | `verify:ci` + real-service gate                                                                                                  |
| windows-worker-clean               | ✅     | 2 internal passes, no flake                                                                                                      |
| acceptance-primary pass 1 / 2      | ✅ ✅  | `tests/e2e` desktop-primary `--workers=2`                                                                                        |
| acceptance-responsive pass 1 / 2   | ✅ ✅  | 6 viewports × `wp32-responsive-checkpoints`                                                                                      |
| prod-build-smoke                   | ✅     | shipped bundle, public UI                                                                                                        |
| ci-namespace-janitor (inventory)   | ✅     | ran, inventoried 29 namespaces                                                                                                   |
| **real-service-acceptance pass 1** | ❌     | (a) observer soak exited 1 — **cause UNDETERMINED**, metric lost to `git clean`; (b) teardown residue `tempRoot … still present` |
| **real-service-acceptance pass 2** | ❌     | soak **passed**; **only** failure = teardown residue `tempRoot … still present` (identical to pass 1)                            |
| gate-summary                       | ❌     | correct — two lanes failed                                                                                                       |

### Root cause (both passes, deterministic)

`tempRoot … still present` = the teardown's own post-cleanup `mc ls` bucket check
recreated `MC_CONFIG_DIR` (`tempRoot/mc`) **after** `rm(tempRoot)`. `mc`
unconditionally recreates its config dir on any invocation — reproduced locally
in `joy-media-ci-linux`. **Not** a process race / file handle / wrong path /
un-awaited cleanup. See `joy-media-ci-open-items-2026-09-08.md` §7.

The pass-1 soak failure is **separate and undetermined** — pass 2's identical
soak passed on the same candidate (supports, does not confirm, a
contention/environment cause). Observer thresholds left unchanged.

### Corrected revision (pending benchmark)

- Dedicated throwaway `mc` config **outside** `tempRoot` for the bucket check;
  `tempRoot` removed **last** via `removeDirWithRetry`, nothing runs `mc` after.
- Bounded process-group shutdown (`terminateProcessTree`: request → await →
  SIGKILL owned group → verify), `await worker.terminate()`.
- `not-found` (404) janitor class — **quarantined, never swept**.
- `if: always()` evidence retention → redacted `test-output/` snapshot +
  `actions/upload-artifact` (so a failed pass's observer metrics survive the next
  job's `git clean`).
- `pnpm test:harness` — 18 `node:test` cases (teardown mechanics, classify,
  evidence retention), all green in `joy-media-ci-linux`.

_Benchmark of the corrected revision to be run on a quiet host; results appended._
