# JOY Media CI v2 — independent review package

**Branch `codex/joy-live-director-ci-opt`.** Assembled 2026-09-08 for the
independent reviewer of the release-contract change. **A green benchmark approves
nothing and authorizes no deployment** — this package is the evidence; the
decision is the reviewer's, then the owner's.

## Revisions under review

| Artifact                                                                   | Revision                                 | Note                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Frozen benchmark-4 revision** (workflow + harness + app + this evidence) | **`83daea2f`**                           | `codex/joy-live-director-ci-opt` tip at dispatch. Contains R2 GAP 3 (`3eaa8cd7`, verified ancestor) + all CI-opt work. Every benchmark-4 job checked out this exact SHA (`candidate_sha` == `--ref` tip). `ca075c7c` = the same tree minus one later docs commit.                    |
| — app content within it                                                    | `3eaa8cd7` (R2 GAP 3)                    | the app code the gate runs against (ancestor of `83daea2f`)                                                                                                                                                                                                                          |
| Benchmark 1 (speed)                                                        | ran on `cdbb771f`                        | pre-hardening teardown → performance evidence only                                                                                                                                                                                                                                   |
| Benchmark 2 (failed)                                                       | ran on `498c45fe`                        | caught the janitor `pg`-resolution bug                                                                                                                                                                                                                                               |
| Benchmark 3 (hardened evidence)                                            | ran on `8c5a4445`                        | teardown enforcement + janitor + prod-build-smoke; **FAILED** — common deterministic `tempRoot` residue on both passes + a pass-1-only undetermined soak failure (see §6)                                                                                                            |
| Benchmark 4 (corrected revision)                                           | ran on `83daea2f` (`gh run 34264913791`) | Teardown fix **confirmed** (both passes `clean:true`). **FAILED** — pass 1 fully clean; pass 2 aborted in `recordJourney` on a nondeterministic `ERR_FILE_NOT_FOUND` console error (undetermined) + `upload-artifact` hit the account artifact-storage quota on both passes. See §5. |

`main` carries only the **dispatch-only** `release-candidate-v2.yml` (workflow
file only; `release-candidate.yml` and all product code untouched;
`workflow_dispatch`-only, runs nothing on push). Its copy is synced to
`185f18c6`; benchmark 4 runs the `ca075c7c` copy via `--ref` (main's copy is
re-synced to `ca075c7c` as housekeeping when this package goes to review).

## 1. Complete results, including all skipped tests, and the 4190 vs 4171 explanation

`verify:ci` → `check` → `test` → `vitest run` — the **same** command as a local
`pnpm test`. The vitest **total is identical** at every revision: **4244**
(`4206 passed / 38 skipped` locally on a Windows dev machine; `4171 passed /
73 skipped` on the headless CI Linux `joy-media-ci` runner).

**The 35-test delta is environment-gated tests that skip on the headless CI
runner** — not lost, not a v2 regression:

| Test file                                                 | CI-skipped | Gate                                                     | Why it skips in CI                                                                                              |
| --------------------------------------------------------- | ---------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `tooling/golden-render/src/first-party-scenes.test.ts`    | 31 (file)  | `describe.runIf(findChromiumExecutable() !== undefined)` | `linux-real-services` runs `verify:ci` **before** `playwright install chromium`, so no Chromium binary is found |
| `packages/html-scene-runtime/src/chromium-driver.test.ts` | 2 (file)   | `describe.runIf(chromiumAvailable)`                      | same                                                                                                            |
| `apps/api/src/whisper-transcribe.test.ts`                 | 1 (file)   | `describe.skipIf(!whisperAvailable)`                     | no Whisper model on the runner                                                                                  |

Those 3 fully-skipped files account for **34** of the 35-test delta (verified
from the CI log). The remaining **1** is a partial env `runIf`/`skipIf` inside a
file that still reports other passing tests; the CI log does not name it and it
was not chased further — the vitest **total is provably unchanged (4244)**, and
this same behaviour holds on the current gate. The **current**
`release-candidate.yml` runs the identical
`pnpm run verify:ci` on the identical `[self-hosted, linux, x64, joy-media-ci]`
runner (v1 lines 42, 77) → v1's gate **also** reports 4171/73 on Linux. The
golden pixel + Chromium-scene coverage is exercised separately by the Playwright
`acceptance-primary` / `prod-build-smoke` / `real-service-acceptance` lanes.

### Benchmark 1 lane results (measured, `cdbb771f`)

| Lane                                                                                                                                        | Result                                                                             | Time                     |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------ |
| validate-candidate                                                                                                                          | ✅                                                                                 | 43s                      |
| linux-real-services ×2 (`verify:ci`: **4171 passed / 73 skipped / 0 failed**)                                                               | ✅                                                                                 | 2m01s + 1m56s (serial)   |
| windows-worker-clean (2 internal passes)                                                                                                    | ✅ no flake                                                                        | 2m06s (parallel)         |
| acceptance-responsive ×2 (`wp32-responsive-checkpoints` × 6 viewports)                                                                      | ✅ 6/6 each, ~6.5s/viewport                                                        | 1m43s + 1m52s            |
| acceptance-primary ×2 (`tests/e2e` × desktop-primary `--workers=2`)                                                                         | ✅ **99 passed / 1 skipped / 0 flaky** each                                        | 3m06s + 3m14s            |
| real-service-acceptance ×2 (primary-full + 6-responsive vs real services + 30-min soak + delivery journey + N/N-1 restore + `release:gate`) | ✅ `release:gate` passed each                                                      | 39m23s + 39m17s (serial) |
| gate-summary                                                                                                                                | ❌ grep-parse bug on all-`success` input (**not a lane failure**) — replaced by §4 | 12s                      |

**End-to-end: 1h37m11s.** `acceptance-primary` reports the same `1 skipped` as a
local `playwright test tests/e2e --project=desktop-primary` (a pre-existing
`test.skip`, unchanged by this work — the CI log reports the count, not the
name).

## 2. Separate isolation evidence, per resource

Each pass derives every mutable name from `runId`, `runAttempt`, `pass`. Verified
live during benchmark 3 pass 1 (`ci_accept_34252332556_1_1`):

### Database

- `schema = ci_accept_<run>_<attempt>_<pass>`; `pool` opened with
  `options: -c search_path=${schema},public` — **every** query is schema-scoped.
- `CREATE SCHEMA` on start; `DROP SCHEMA … CASCADE` on teardown, then re-inspected.
- **Live (bench 3 pass 1):** the pass schema had **18 tables / 116 project rows**;
  `public` had **0** app tables (`projects/workers/jobs/media_assets`); **0**
  other `ci_accept%` schemas existed. A query without the search_path prefix
  finds nothing.
- The N/N-1 restore test uses a **separate** `ci_legacy_accept_<ns>` schema with
  its own create/drop/verify.

### Object storage

- `bucket = joy-media-<run>-<attempt>-<pass>`; `MinioObjectStore` built with
  `{ bucket }`; **every** `put`/`get`/`remove`/`probeReadiness` path is
  `joy-ci/${this.options.bucket}/…`.
- `mc mb` on start; `mc rm --recursive` + `mc rb` on teardown, then `mc ls`
  re-inspected.
- **Live (bench 3 pass 1):** exactly **one** bucket existed
  (`joy-media-34252332556-1-1`), holding this pass's export derivative +
  original chunks. No path can address another bucket.

### Browser profile / storage

- `chromium.launch({ headless: true })` fresh per pass; `browser.newContext({ viewport })`
  is an **ephemeral incognito context** — no `userDataDir`, no persistent profile.
- `playwright.config.ts` sets **no `storageState`, no `userDataDir`, no
  `launchPersistentContext`** (verified — none present).
- The session token is injected per-context via
  `context.addInitScript(() => localStorage.setItem(…))` — in-memory, gone on
  `context.close()` / `browser.close()`.
- `runDesktopMatrix` spawns **separate `playwright test` processes** (each its
  own browser) against a per-pass dev server on a `freePort()`-allocated
  `webPort`.
- Teardown: `browser.close()`, then the residue check confirms `webProcess.pid`
  is dead via `process.kill(pid, 0)`.

### Worker state

- `realWorkerId = real-service-render-worker-<run>-<pass>` — unique per (run, pass).
- Registered via `pairWorker` + `helloWorker` **into the pass's schema** — it can
  only lease jobs from that schema.
- The worker is an **in-process async loop**, not a subprocess;
  `realWorkerLifecycle.stopped = true` + `await realWorkerPromise` on teardown.
- Its scratch dir is `${tempRoot}/worker`, `tempRoot = mkdtemp('/tmp/joy-media-real-acceptance-')`
  (unique), removed + `stat`-verified on teardown.

### Non-coexistence (benchmark 1, sampled every 90s)

GitHub ran pass 2 then pass 1 (matrix order not guaranteed), serially on the one
`joy-media-acceptance` runner:
`_2` schema+bucket present → **`_2` dropped 15:31:53Z** → **`_1` created fresh
15:33:26Z** → `_1` dropped 16:10:52Z → post-run **0** `%<run>%` schemas/buckets.
**The two passes' resources never coexisted.**

## 3. Interruption recovery + authenticated janitor classification (measured)

`ci-namespace-janitor.mjs` classifies each CI namespace by the **owning workflow
run's status** (GitHub Actions API, `GITHUB_TOKEN` + `actions: read`) via
`ci-namespace-classify.mjs`: `current` (= `GITHUB_RUN_ID`) / `active`
(`in_progress`/`queued`/`waiting`) / `orphan` (**status exactly `completed`**) /
`not-found` (**404 — quarantined, never swept**) / `unknown` (API error).
`isSweepable()` is true **only for `orphan`**. Default **inventory** mode writes
`test-output/ci-janitor/inventory.json` and deletes nothing (v2 requires this
evidence file). `--sweep` (double-gated by `JOY_MEDIA_CI_JANITOR_SWEEP=1`)
deletes **only** `orphan`.

**Why 404 ≠ orphan (owner correction, corrected revision):** a 404 for a run id
can be a purged/very old run, a malformed or hand-created namespace, or a
token/permission gap. None of those prove "a completed CI run owns this", so
deletion requires proven CI ownership **and** a confirmed `completed` status.
`ci-namespace-classify.test.mjs` locks the table (current / active /
completed→orphan / **404→not-found** / unknown / future-state→unknown;
`isSweepable('not-found') === false`).

**Recovery test — corrected revision `61bc4c44` (2026-09-08, real CI Postgres +
MinIO, 4 disposable schemas), `GITHUB_RUN_ID=34252332556`:**

| Phase | Token                | `34239133175_9_1` (completed run)         | `34252332556_9_1/_9_2` (current run) | `99999999991_9_1` (404) | swept                                                  |
| ----- | -------------------- | ----------------------------------------- | ------------------------------------ | ----------------------- | ------------------------------------------------------ |
| 1     | **invalid**          | `unknown` → kept                          | `current` → kept                     | `unknown` → kept        | **`[]` — nothing deleted**                             |
| 2     | **valid**, `--sweep` | `orphan` (status `completed`) → **SWEPT** | `current` → **kept**                 | **`not-found` → KEPT**  | **`["ci_accept_34239133175_9_1"]`**, `sweepErrors: []` |

Survivors after phase 2: the two current-run schemas + **the 404 schema**. Only
the one namespace whose owning run status is provably `completed` was removed. An
eligible abandoned namespace is cleaned while the current run and every
unprovable namespace (404, unreadable) are untouched. All 4 test schemas dropped
on exit. `pnpm test:harness` locks the same table deterministically
(`ci-namespace-classify.test.mjs`).

**Note — first recovery run (revision `185f18c6`, superseded):** used the old
rule (`not-found` → `orphan`) and swept `99999999991_9_1` plus, as a
side-effect of exercising `--sweep` against the shared store, the 15 historical
leaked namespaces (all `completed`-run, empty schemas / 0-byte buckets —
identities preserved in `joy-media-ci-open-items-2026-09-08.md` §6). The v2
workflow runs inventory-only; `--sweep` is enabled only after this review.

## 4. Gate-summary — structured JSON parsing + regression cases

`tooling/release/src/ci-gate-summary.ts` (`evaluateGateSummary`) —
`JSON.parse(needs.*.result)`, require a non-empty array whose length equals the
expected lane count, and every entry `=== "success"`.
`ci-gate-summary.test.ts` — **10 tests, all green in `verify:ci`:**

| Case                                           | Expectation                                |
| ---------------------------------------------- | ------------------------------------------ |
| all `success` (6 lanes)                        | pass                                       |
| one `failure`                                  | fail, names `#i="failure"`                 |
| one `cancelled`                                | fail, names `#i="cancelled"`               |
| one `skipped` (required lane did not run)      | fail, names `#i="skipped"`                 |
| **missing required job** (short array, 5 of 6) | fail, "expected 6 … got 5"                 |
| empty array                                    | fail, "no lane results"                    |
| malformed JSON                                 | fail, "not valid JSON" (not a silent pass) |
| non-array JSON                                 | fail, "not a JSON array"                   |
| multiple problems                              | reports ≥ 2 reasons                        |
| non-integer expected count                     | fail                                       |

Both `release-candidate-v2` (6 lanes) and `ci-dev` (3 lanes) call it; both
summary jobs `checkout` first. This is a self-contained logic change with no
runtime/infra dependency, so it does not require its own full benchmark — the
grep form it replaces already completed the workflow end-to-end in benchmark 1's
happy path, and this form is strictly more correct.

## 5. Final measured runtime + the contract / coverage changes

**Benchmark 1** (speed, `cdbb771f`) and **benchmark 3** (hardened, `8c5a4445`)
both measured **one workflow ≈ 1h37m** end-to-end (16:38:52Z → 18:15:57Z for
b3), vs the current gate's ~4h20–4h32 per run. Contract
`2 workflow runs → 1 run, 2 isolated passes` → **end-to-end gate ≈ 1h37m vs ≈
8.7–9h ≈ 5.4× faster.** The 30-min effects soak is retained one-per-pass (2 per
gate, was 4); any 2→1 change is a **separate** proposal, not made here.

**Benchmark 3 did not pass** — the deterministic `tempRoot` teardown-ordering bug
on both passes (§6 / open-items §7) + a pass-1-only undetermined soak failure.

**Benchmark 4** (corrected revision, frozen `83daea2f`, `gh run 34264913791`,
verified-quiet host, **1h51m56s** end-to-end) — see
`joy-media-ci-benchmark-results-2026-09-08.md`:

- **Teardown fix confirmed on BOTH passes** (`clean: true`; bounded
  `terminateProcessTree` → `state "terminated"`, not escalated; no `tempRoot` /
  verify residue). Bench-3's deterministic bug is gone.
- **Pass 1 fully clean** — vitest 4254/0-failed; Playwright 105 passed / 1 skipped
  / 0 failed; delivery + N/N-1 restore + `release:gate` passed; **soak passed with
  wide margin** (heapGrowth 2.52% ≤20, longTask 0 <5, initialEditorJs 7,506
  ≤500k, all else at/under budget). This is one complete clean instance of the new
  1-run/2-pass contract with the restructured browser matrix.
- **Pass 2 FAILED** — `assertJourneyTelemetryClean` on a nondeterministic
  `Failed to load resource: net::ERR_FILE_NOT_FOUND` browser console error during
  `recordJourney`, ~7 min in, before the soak. Pass 1 ran the same journey 60 s
  later with 0 console errors. Root cause **undetermined** (the failing URL was
  captured in `failedRequests` but the assertion throws on `consoleErrors` first).
  Same class as R1's pre-existing real-service journey fixes (`b634d3cd`,
  `f7615432`). Not caused by, and not touching, the teardown / repetition /
  coverage changes.
- **`actions/upload-artifact` failed on BOTH passes** — `Artifact storage quota
has been hit` (account-level; same issue as the earlier hosted `r2-candidate`
  runs). `continue-on-error: true` masked it as a green step. **Durable evidence
  retention is non-functional** until the quota is freed. Pass 1's `test-output/`
  was manually rescued off the idle runner; **pass 2's structured evidence is
  permanently lost**. The retain/redact/leak-guard mechanism itself worked
  (`0 quarantined`).
- **Resource samples: no contention** — one CI container active at a time, load
  ≤ 6.9 on an 8-core / 30 GiB box, `joy-media-ci-linux` idle through both passes.

**Benchmark 4 is a FAIL under the "both passes + cleanup must pass" rule.** No
rerun, no threshold change. The two failures (journey flake; artifact quota +
silent masking) are for this review and the owner to weigh — a green gate that
loses required evidence is not an acceptable gate.

### Coverage / repetition changes for the reviewer

- **Browser viewport matrix** — full `tests/e2e` on `desktop-primary` (×2
  passes, `--workers=2`); `wp32-responsive-checkpoints` on the other 6 viewports.
  One Chromium engine → zero engine-coverage change. Every removed execution
  mapped in `joy-media-ci-coverage-matrix-2026-09-08.md`.
- **Real-service `runDesktopMatrix`** — 7 full suites → primary-full + 6
  responsive, still vs real services. Distinct real-service coverage kept.
- **`prod-build-smoke`** — NEW additive lane: the shipped `dist/` bundle through
  the public UI (import / decode-seek / export / Worker). Validated 5/5.
- **Contract** — `2 green workflow runs` → `1 run, 2 genuinely isolated passes`.
  Rationale + the "what a second whole run added" analysis + the minimal fallback
  (one auto re-dispatch on infra-only failure) are in
  `joy-media-ci-repetition-contract-2026-09-08.md`.
- **Teardown** is now a **required acceptance item** (no swallowed failures;
  runner re-inspected; `teardown.json` gate). **Interruption recovery** via the
  janitor. Both detailed in `joy-media-ci-open-items-2026-09-08.md` §1–2.

### Evidence files in this branch

`joy-media-ci-baseline-2026-09-08.md` · `…-benchmarks-…` · `…-coverage-matrix-…`
· `…-repetition-contract-…` · `…-open-items-…` · `…-benchmark-results-…` · this
file. Plus `ci-gate-summary.ts` + `.test.ts`, `ci-namespace-janitor.mjs` +
`ci-namespace-classify.mjs` + `.test.mjs`, the hardened + reordered
`real-service-acceptance.mjs` teardown, `real-service-teardown.mjs` + `.test.mjs`,
`retain-evidence.sh` + `evidence-retention.test.mjs`.

## 6. Benchmark 3 failure — deterministic `tempRoot` teardown-ordering bug (fixed)

**The two passes did not have identical overall failures.** Both hit the **same
deterministic teardown residue** — `tempRoot /tmp/joy-media-real-acceptance-XXXXXX
still present` after `rm(tempRoot)` ran without throwing. **Pass 1 additionally**
had an independent `release-performance-observer` (effects-soak) failure whose
exact exceeded budget was lost to the next job's `git clean`; **pass 2's soak
passed** on the same candidate. So: teardown residue = common + deterministic;
soak failure = pass-1 only + undetermined.

**Root cause (reproduced locally in `joy-media-ci-linux`):** the teardown's own
post-cleanup bucket check, `mc ls joy-ci/<bucket>`, ran with
`MC_CONFIG_DIR = tempRoot/mc`. `mc` **unconditionally recreates its config
directory** (writes `config.json`, `certs/`, `share/`) on every invocation, even
a failing one. Sequence: `rm(tempRoot)` succeeds → `mc ls` recreates
`tempRoot/mc` → `stat(tempRoot)` finds it → residue → pass fails. Ruled out:
process-death race (`isAlive` never tripped), open file handle, wrong deletion
path, un-awaited cleanup.

**Fix (corrected revision):**

- Post-cleanup bucket check uses a **throwaway `mc` config outside `tempRoot`**
  (`mkdtemp('/tmp/joy-media-real-verify-')`); that dir is also removed at the end.
- `tempRoot` is removed **last**, via `removeDirWithRetry` (bounded retry that
  **records** residual entry names — never hides a live writer), with **no `mc`
  call afterwards**.
- Web dev server (spawned `detached` → provably run-owned group) shut down by
  `terminateProcessTree`: SIGTERM → await-exit (≤15 s, ends on observed exit) →
  SIGKILL owned group (≤5 s) → verify gone. Replaces fire-and-forget `killTree`.
- `await worker.terminate()` on the export thread; `realWorkerPromise` awaited.
- `teardown.json` → schemaVersion 2 with `webTermination`, `tempRootRemoval`,
  `verifyRootRemoval` sub-records.

`ops/self-hosted/linux-runner/real-service-teardown.mjs` +
`real-service-teardown.test.mjs` — 16 `node:test` cases, green in
`joy-media-ci-linux`: SIGTERM exit / delayed exit / unresponsive→SIGKILL /
whole-group kill / **unrelated process untouched** / already-exited /
populated-dir removal / writer-recreates-path **reported** /
writer-stops-then-succeeds.

**Separately:** benchmark-3 pass 1's `release-performance-observer` also exited 1
(`status: "failed"`). The exact exceeded budget was in `effects-soak.json`, which
the next job's `git clean` removed before it could be read → **evidence
retention** was added (§ below). Pass 2's identical soak **passed** on the same
candidate. Cause **UNDETERMINED**; a passing pass 2 **supports, does not
confirm**, a contention/environment cause. **Observer thresholds unchanged.**

### Evidence retention (added — corrected revision)

`real-service-acceptance (pass 1)` and `(pass 2)` run serially on the one
`joy-media-acceptance` runner; pass 2's `checkout` `git clean`s pass 1's
`test-output/`. Two `if: always()` steps, **before** the teardown-verify step
(so a failed pass still runs them), stage + sanitize + upload:

- `retain-evidence.sh` copies an **explicit allowlist** of structured evidence
  JSON (never a blanket `cp -a`), then scrubs each file of: literal secret values
  **and their base64 / percent-encoded forms**, `Authorization: Bearer …`
  headers, presigned-URL params (`X-Amz-Signature` / `Credential` /
  `Security-Token` / `Signature`), and `scheme://user:pass@host`. A final
  **leak-guard** re-scans the staged tree and quarantines (removes + records in
  `REDACTION-FAILURES.txt`) any file that still matches a literal/base64 secret.
- `actions/upload-artifact@v4.6.2` (pinned SHA, `continue-on-error`,
  `overwrite: false`, 14-day) → artifact
  **`real-service-evidence-run<id>-attempt<n>-pass<p>`** (run id + attempt + pass
  in the name; each pass uploads from its own job before the next checkout).

`evidence-retention.test.mjs` (in `pnpm test:harness`) proves an
**intentionally-failed pass** fixture: the failure signal survives; the
non-allowlisted file is not copied; no secret survives in any encoding; the
leak-guard quarantines a file that would leak.

### Review scope + deployment gate (unchanged)

Independent review must cover **both** (1) the implementation (harness teardown,
bounded shutdown, janitor, evidence retention) **and** (2) the
**reduced-repetition / coverage contract** (`2 workflow runs → 1 run, 2 isolated
passes`; browser viewport matrix; `runDesktopMatrix` 7→primary+6; soak 4→2 per
gate). A green benchmark is **evidence, not deployment approval**.

An additional Opus review of CI v2 is welcome, but the **previously agreed
independent "Astra" review remains the deployment gate** — deployment still
requires Astra's explicit `APPROVE_FOR_DEPLOY <sha> <tree> <lock>` on the final
R2 candidate, then the owner's go-ahead. That requirement is unchanged here.

**On independent acceptance of the CI contract:** v2 replaces v1; `ci-dev.yml`
gets scoped triggers (PR + push-to-`main` only, not every `codex/**`); the
janitor `--sweep` is enabled. Then R2 completion resumes (GAP 1 / 2 / 4 / 5),
re-cut candidate → CodeRabbit → optimized gate → Astra → owner deploy go-ahead.
