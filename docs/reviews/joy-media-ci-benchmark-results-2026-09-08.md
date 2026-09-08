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
- `pnpm test:harness` — 31 `node:test` cases (teardown mechanics, classify,
  evidence retention incl. redaction-engine-error, chunk-split-safe Vite log),
  all green in `joy-media-ci-linux`.

## Benchmark 4 — corrected revision (frozen SHA `83daea2f`)

`gh run 34264913791`, dispatched 2026-09-08 18:45:16Z on a **verified-quiet host**
(resource sampler every 180s: only one CI container ever active, load ≤ 6.9 on an
8+ core / 30 GiB box, `joy-media-ci-linux` idle throughout both real-service
passes — **no contention**). **End-to-end 18:45:16Z → 20:37:12Z = 1h 51m 56s.**

| Lane                               | Result       | Wall                                                |
| ---------------------------------- | ------------ | --------------------------------------------------- |
| validate-candidate                 | ✅           | 4m                                                  |
| linux-real-services ×2             | ✅ ✅        | 3m + 1m                                             |
| windows-worker-clean (2 passes)    | ✅           | 9m                                                  |
| prod-build-smoke                   | ✅           | 18m                                                 |
| acceptance-primary ×2              | ✅ ✅        | 11m + 8m                                            |
| acceptance-responsive ×2           | ✅ ✅        | 2m + 7m                                             |
| **real-service-acceptance pass 1** | ✅           | **41m** — full soak + journey + gate                |
| **real-service-acceptance pass 2** | ❌           | 9m — aborted in `recordJourney` **before** the soak |
| gate-summary                       | ❌ (correct) | 0m                                                  |

**Pass 1 — complete and clean.** vitest `4254 collected / 0 failed`; Playwright
`105 passed / 1 skipped / 0 failed` (desktop-primary 99/1 + 6 responsive 1/1);
delivery journey + N/N-1 restore + `release:gate` all passed. **Soak PASSED with
wide margin:** durationMs 1,800,398 (≥1,800,000); heapGrowthPercent **2.52**
(≤20); uncaughtExceptions 0; navigationFailures 0; longTaskPercent **0** (<5);
initialEditorJsBytes **7,506** (≤500,000); maxMountedPreviews 11 (≤12);
maxPlayingPreviews 6 (≤6). `teardown.json` → **`clean: true`**,
`webTermination.state "terminated"` (not escalated, 200 ms), `tempRootRemoval` +
`verifyRootRemoval` removed on attempt 1, zero residue.

**Pass 2 — FAILED, `assertJourneyTelemetryClean`:**
`browser console errors observed: Failed to load resource: net::ERR_FILE_NOT_FOUND`
during the editor walk in `recordJourney` (Creative Brief / 3D Scene / Motion),
~7 min in, before the soak. `teardown.json` still `clean: true`. **Nondeterministic**
— pass 1 ran the identical journey on the identical candidate 60 s later with 0
console errors. Root cause **UNDETERMINED**: the failing URL was captured in
`telemetry.failedRequests` but `assertJourneyTelemetryClean` throws on
`console.errors` first (text has no URL), so it was never surfaced. Same class as
the pre-existing real-service journey issues fixed during R1 (`b634d3cd`,
`f7615432`).

### What benchmark 4 establishes — and what it does not

- **Teardown ordering fix — confirmed on BOTH passes** (`clean: true`, bounded
  `terminateProcessTree`, no `tempRoot`/verify residue). The deterministic bench-3
  bug is gone.
- 404-quarantine janitor: ran inventory-only, `0 namespaces`, no error.
- Redaction: `retain-evidence.sh` staged the allowlist both passes and its
  leak-guard flagged nothing. **This means no _known literal or base64 secret
  value_ survived redaction — it is not a proof that no secret of an
  unanticipated shape leaked.** (The v2 retention adds a checksum-verified
  manifest and an explicit gate check; see §evidence-retention below.)
- **Reduced-repetition / coverage contract: partially exercised.** Pass 1 is one
  clean instance of a single pass under the new contract (one workflow, the
  restructured browser matrix, soak one-per-pass). **The contract requires BOTH
  isolated passes plus cleanup to succeed — benchmark 4 did not demonstrate
  that.** It is not a completed two-pass contract.
- **Contention: none _observed_.** The sampler ran at 3-minute resolution and
  saw only one CI container active at a time with `joy-media-ci-linux` idle
  through both real-service passes. That is evidence of no competing workload at
  that sampling rate — **not proof that contention was impossible** (a sub-3-min
  spike, or scheduler/IO contention the sampler does not measure, could still
  occur).

### Two concrete failures from benchmark 4 — and the targeted fixes applied

**F1 — pass 2 journey flake (`ERR_FILE_NOT_FOUND`).** The gate correctly failed
on a real browser console error during `recordJourney`. Nondeterministic
(pass 1's identical journey on the same candidate was clean). The old
`assertJourneyTelemetryClean` threw on `console.errors` first, so the
URL-bearing `failedRequests` entry was never surfaced → root cause undetermined.

_Fix (`45022c7c`)_: `recordJourney` now tracks a `journeyPhase` through the walk;
`requestfailed` captures `url` / `method` / `resourceType` / `failureText`;
`console` captures `location`. New `inspectJourneyTelemetry()` reports every
issue class **together** and writes a sanitized `journey-failure.json` (phase,
`netErrorCodesObserved`, full per-entry detail) **before** the throw, with an
explicit note that `net::ERR_FILE_NOT_FOUND` is **not** proof of an HTTP 404.
A bounded diagnostic reproduction run is being done separately; the flake is
**not** being suppressed or waived.

**F2 — `actions/upload-artifact` failed on BOTH passes** —
`Failed to CreateArtifact: Artifact storage quota has been hit`. `continue-on-error: true`
reported the step as `success`. Pass 1's `test-output/` was manually rescued off
the idle runner; **pass 2's structured evidence was permanently lost**.

_Fix (`45022c7c`)_:

- `retain-evidence.sh` now **requires** a persistent root
  (`$JOY_MEDIA_CI_EVIDENCE_ROOT`, e.g. `/opt/actions-runner/ci-evidence`)
  **outside the checkout and `_work`/`_temp`**, refuses a path inside any of
  them, writes `MANIFEST.sha256` + `MANIFEST.json`, persists to
  `<root>/<candidateSha>/<run>-<attempt>-p<pass>/`, and **re-verifies every file
  against the manifest**. Non-zero exit fails the pass.
- New workflow step **"Verify retained evidence"** (no `continue-on-error`):
  re-runs `sha256sum -c`, requires `teardown.json` present + `clean:true`, and —
  when the harness step succeeded — the full required evidence set. A missing or
  corrupt file fails the gate.
- `upload-artifact`: `continue-on-error` **removed**, `if-no-files-found: error`.
  A failed upload now fails the job. **A durable fallback copy does not silently
  waive the required upload** — it just guarantees the evidence still exists to
  diagnose the failure.
- **Consequence:** the full gate cannot pass until the account artifact-storage
  quota is cleared (see the quota inventory below).

### Artifact storage quota — read-only inventory (2026-09-08)

`repos/hadimoti/joy-media/actions/artifacts`: **50 artifacts, 4,961,371,159 bytes
≈ 4.62 GiB, 0 flagged `expired`.** Every one is named `playwright-evidence*` and
was created **2026-08-11 – 2026-08-15** by the abandoned hosted `r2-candidate.yml`
/ `ci.yml` experiments. None are Live Director R1/R2 gate evidence (self-hosted
`release-candidate.yml` uploads no artifacts) and none are from the CI-opt
benchmarks. Top consumers: 3 artifacts at ~855 + 854 + 604 MiB; the top 12
account for ~4.2 GiB.

**Proposal (NOT executed — needs owner approval):** delete all 50. They are
3–4-week-old transient HTML reports/traces from superseded experiments; their
runs are long complete. Deleting them frees the full ~4.62 GiB and takes usage
to ~0. Command per id: `gh api -X DELETE repos/hadimoti/joy-media/actions/artifacts/<id>`.
**No historical evidence is lost** (these were debug aids, not gate records).
Do not purchase additional storage without approval.

### `initialEditorJsBytes` budget — flagged for review

The soak's pass predicate includes `initialEditorJsBytes <= 500_000`. In the
real-service lane the harness runs the **Vite dev server**, so this metric
measures the first `/(main|index)…\.js` **resource** — i.e. the dev-transformed
`/src/main.tsx` entry module (**7,506 bytes** in benchmark 4), **not** the
shipped entry bundle. Against the dev server this budget is effectively inert: it
can never approach 500 KB and says nothing about production bundle size. The
`prod-build-smoke` lane serves the real `dist/assets/index-*.js` but does not run
the observer. **To meaningfully enforce an entry-bundle budget, either run the
observer against `vite preview` of `dist/`, or add an explicit byte check on
`dist/assets/index-*.js`.** This predates the CI-opt work (it is in
`release-performance-observer.mjs`, untouched here) but is in scope for the CI v2
review because the soak predicate depends on it.

_All of the above is for independent review + the owner. No threshold change; no
rerun-to-green; the full gate run is deferred until the quota is cleared and the
focused checks pass._
