# JOY Media CI optimization — open items & required acceptance changes

**Branch `codex/joy-live-director-ci-opt`.** Additions after the owner's second
review of the benchmark plan. These are on a **new revision** and require their
own benchmark evidence before v2 goes for independent approval.

## 1. Teardown verification is now a required acceptance item

**Was:** `real-service-acceptance.mjs` `finally` did
`DROP SCHEMA … .catch(() => undefined)` / `mc rm … .catch(() => undefined)` —
deletion failures were swallowed, and a SIGKILL skipped `finally` entirely. The
workflow teardown step only checked `git status` + the OpenCLI env.

**Now:**

- The harness wraps every cleanup step (`browser.close`, web-server terminate,
  `apiServer.close`, worker stop, `DROP SCHEMA`, `mc rm`, `mc rb`, temp-root
  removal), collecting — never swallowing — each failure.
- After cleanup it **re-inspects** the runner: a fresh pool checks
  `pg_namespace` for `ci_accept_<ns>` / `ci_legacy_accept_<ns>`; `mc ls` checks
  the bucket; the temp root removal is verified; `process.kill(pid, 0)` checks
  the web process.
- Any residue, or any collected cleanup failure, becomes a `TeardownError`. If
  the run body already threw, the teardown failure is appended to it; either way
  the pass **fails**.
- The harness writes `test-output/operations/teardown.json` (schemaVersion 2:
  `{ clean, verified[], cleanupIssues[], residue[], webTermination,
tempRootRemoval, verifyRootRemoval }`). The workflow step **requires** the
  file and fails on `clean !== true` — so even a harness that somehow exits 0
  without a clean teardown is caught.

**Bounded shutdown + removal (corrected revision — see §7).** Ownership and
lifecycle are established before any escalation:

- The web dev server is spawned `detached: true` → its pid is a process-group
  leader, so the whole group is provably run-owned. `terminateProcessTree()`
  does request → await-exit (bounded 15 s, ends the moment the process is
  observed gone) → escalate the owned group to `SIGKILL` (bounded 5 s) → verify
  gone. Not a fixed sleep. Replaces the old fire-and-forget `killTree`.
- The export Worker thread is now `await worker.terminate()`d, and
  `realWorkerPromise` is awaited, so `tempRoot/worker` is quiescent before
  removal.
- `removeDirWithRetry()` removes the temp root **last**, after every producer has
  stopped, with a bounded retry that **records** residual entry names rather than
  hiding a surviving writer.
- The post-cleanup bucket check runs `mc` against a **throwaway config dir
  outside `tempRoot`** (`mkdtemp('/tmp/joy-media-real-verify-')`), because `mc`
  unconditionally recreates its `MC_CONFIG_DIR` on every call — see §7.

Mechanics extracted to `ops/self-hosted/linux-runner/real-service-teardown.mjs`
and covered by `real-service-teardown.test.mjs` (16 cases: SIGTERM exit, delayed
exit, unresponsive → SIGKILL, whole-group kill, unrelated process untouched,
already-exited, populated-dir removal, writer-recreates-path reported,
writer-stops-then-succeeds). `pnpm test:harness` runs them.

**Assertion:** each completed pass leaves **no run-owned schema, legacy schema,
bucket, object, temp directory or child process**.

## 2. Interruption-recovery design — `ci-namespace-janitor.mjs`

`ops/self-hosted/linux-runner/ci-namespace-janitor.mjs` inventories every
`ci_accept_* / ci_legacy_accept_*` schema and `joy-media-*` bucket and classifies
each by looking up the **owning workflow run's status** (GitHub Actions API,
`GITHUB_TOKEN` + `actions: read`):

| Class       | Rule                                                | Action                                    |
| ----------- | --------------------------------------------------- | ----------------------------------------- |
| `current`   | run id == `GITHUB_RUN_ID`                           | never touched                             |
| `active`    | run status `in_progress` / `queued` / `waiting`     | **never touched**                         |
| `orphan`    | run status **exactly `completed`** (any conclusion) | eligible for sweep                        |
| `not-found` | API returns 404 for the run id                      | **never swept** (quarantined — see below) |
| `unknown`   | API error / unreadable status                       | **never touched** (cannot prove dead)     |

**404 is not proof.** A 404 for a run id can mean a purged/very old run, a
hand-created or malformed namespace, or a token/permission gap — none of which
establish "a completed CI run owns this". `not-found` is therefore its own class
and is **never swept**; deletion requires proven CI ownership **and** a confirmed
`completed` run status. Classification is in
`ops/self-hosted/linux-runner/ci-namespace-classify.mjs`, unit-tested in
`ci-namespace-classify.test.mjs` (current / active / completed→orphan /
404→not-found / unknown / future-state→unknown; `isSweepable` returns true only
for `orphan`).

- **Default mode: `inventory`** — writes `test-output/ci-janitor/inventory.json`,
  deletes nothing. The v2 workflow runs it in this mode at the start of every
  `real-service-acceptance` pass and **requires the evidence file**.
- **`--sweep`** (guarded by `JOY_MEDIA_CI_JANITOR_SWEEP=1` as a second explicit
  gate) deletes only `orphan`-class namespaces. Not enabled in v2 yet — turned
  on after independent review, with the inventory evidence from the benchmark
  run showing the classification is correct.

The 14 historical namespaces (below) are **not** touched by this change.

## 3. "Fresh namespace" vs "pass 1 cleaned up" — reported separately

Both facts are verified and reported distinctly:

- **Fresh namespace (isolation):** pass 2 always uses
  `ci_accept_<run>_<attempt>_2` / `joy-media-<run>-<attempt>-2` — a name that has
  never existed. `CREATE SCHEMA` / `mb` on a name-unique namespace cannot inherit
  pass 1 rows or objects. The live isolation sampler logs the two passes'
  namespaces across the benchmark run to show they never coexist with data.
- **Pass 1 cleanup success:** the item-1 teardown verification proves pass 1's
  schema/bucket/temp/processes were actually removed. This is the fact the old
  harness could silently fail.

A green isolation result does **not** imply a green cleanup result and vice
versa — the benchmark report states each.

## 4. Production-build smoke through the public UI

`agent-observation-decode`, `final-encoded-export-decoder` and
`agent-director-skills` do `await import('/src/**/*.ts')` at runtime — a
Vite-dev-only mechanism. **They stay** (they run in full against the dev server
in `acceptance-primary` and `real-service-acceptance`). Production health is
**not** inferred from that.

**Added:** a `prod-build-smoke` job — `vite build` → `vite preview` of `dist/`
(with the new `preview.proxy` mirroring `server.proxy`) + the isolated e2e API →
runs `authenticated-smoke`, `wp32-real-project-journey`,
`wp30-animated-timeline-export`, `golden-path` against the **shipped bundle's
public UI**. These exercise: session/auth, disposable project,
register/upload/reload/read of a fixture original, **import → preview each asset
(decode/seek) → captions render**, **Export MP4 → verified download (encode +
Worker path)**, and the no-fatal-error / no-horizontal-overflow envelope.

**Validated 2026-09-08:** 5/5 passed in 20.6 s against `vite preview` of the
production `dist/`.

## 5. `ci-dev.yml` is `workflow_dispatch`-only

It was briefly auto-firing on `codex/**` pushes. It is now manual-only. This
stops unintended runs but **leaves automatic development feedback unresolved**.

**Proposed (separate, for review):** re-enable a scoped trigger —
`pull_request` (to any branch) + `push` to `main` only. Not `push` to every
`codex/**` (dozens of active forks → runner thrash). Concurrency
`cancel-in-progress: true` per ref. This keeps PR feedback automatic without the
fork-push storm. Enable only when `ci-dev.yml` replaces `ci.yml` as the
development gate.

## 6. Historical namespace inventory (do not bulk-delete)

Present on the shared CI Postgres / MinIO at 2026-09-08, from past
cancelled/SIGKILL'd runs (schema + matching empty 0-byte bucket each):

| runId       | attempt_pass | first seen (bucket date) |
| ----------- | ------------ | ------------------------ |
| 33316937092 | 1_2          | 2026-08-30               |
| 33340778678 | 1_2          | 2026-08-31               |
| 33391159800 | 1_2          | 2026-08-31               |
| 33400405228 | 1_1          | 2026-08-31               |
| 33409448913 | 1_1          | 2026-08-31               |
| 33418273845 | 1_1          | 2026-08-31               |
| 33427823352 | 1_2          | 2026-08-31               |
| 33468150652 | 1_1          | 2026-09-01               |
| 33473862273 | 1_1          | 2026-09-01               |
| 33480119139 | 1_2          | 2026-09-01               |
| 33489849728 | 1_1          | 2026-09-01               |
| 33509132164 | 1_2          | 2026-09-01               |
| 33561758579 | 1_2          | 2026-09-01               |
| 34042653454 | 1_1          | 2026-09-07               |
| 34051708934 | 1_2          | 2026-09-07               |

(15 rows — the earlier "14" undercounted by one.) All schemas were empty /
near-empty and all buckets 0 B. They are disposable CI namespaces from runs that
are long terminal. **Not deleted here.** The janitor's first `inventory` run on
the next benchmark will classify each (expected: all `orphan`); enabling
`--sweep` after review removes them and prevents recurrence.

## 7. Benchmark 3 root cause — deterministic `tempRoot` residue (fixed)

Benchmark 3 (`gh run 34252332556`, candidate `8c5a4445`) failed
`real-service-acceptance` on **both** passes. **The passes' overall failures were
not identical:** both hit the same deterministic teardown residue below; **pass 1
also** had an independent, undetermined observer-soak failure (§ below).

```
real-service teardown is not clean (pass N):
  - tempRoot /tmp/joy-media-real-acceptance-XXXXXX still present
```

- **Not** a process-death race — `isAlive(webProcess.pid)` did not trip.
- **Not** an open file handle, a wrong deletion path, or un-awaited cleanup —
  `rm(tempRoot, { recursive, force })` ran and did **not** throw; the path was
  correct; all cleanup was awaited.
- **Root cause (confirmed by local probe):** the teardown's _own_ post-cleanup
  bucket check, `runMc(['ls', 'joy-ci/<bucket>'])`, ran with
  `MC_CONFIG_DIR = tempRoot/mc`. `mc` **unconditionally recreates
  `MC_CONFIG_DIR`** (writes `config.json`, `certs/`, `share/`) on every
  invocation — even one that errors. So the sequence was: `rm(tempRoot)` succeeds
  → `mc ls` recreates `tempRoot/mc` → `stat(tempRoot)` finds it → residue → pass
  fails. Deterministic; reproduced in `joy-media-ci-linux` with a fresh
  `MC_CONFIG_DIR`.
- **Pass-1 soak failure (separate):** benchmark-3 pass 1 _also_ had
  `release-performance-observer` exit 1 (`status: "failed"`). The exact exceeded
  budget was in `effects-soak.json`, which the next job's `git clean` removed
  before it could be read (→ item 8). Pass 2's soak **passed** on the same
  candidate. Cause recorded **UNDETERMINED**; a passing pass 2 **supports, does
  not confirm**, a contention/environment cause. **Observer thresholds
  unchanged.**

**Fix (corrected revision):** dedicated throwaway `mc` config outside `tempRoot`
for the post-cleanup bucket check; `tempRoot` (and that throwaway) removed **last**
via `removeDirWithRetry` with nothing running `mc` afterwards; bounded
process-group shutdown; `await worker.terminate()`. See §1.

## 8. Evidence retention before workspace cleanup

**Was:** `real-service-acceptance (pass 1)` and `(pass 2)` run **serially on the
one `joy-media-acceptance` runner**. Pass 2's `actions/checkout` runs
`git clean -ffdx`, wiping pass 1's `test-output/` — including the observer's
per-metric JSON — before it can be inspected. There was no artifact upload, so a
failed pass left no retrievable structured evidence.

**Now:** two `if: always()` steps in `real-service-acceptance`, before the
teardown-verify step:

1. `ops/self-hosted/linux-runner/retain-evidence.sh test-output <RUNNER_TEMP>/…`
   — snapshots `test-output/` + `git status` + candidate SHA into `RUNNER_TEMP`,
   then redacts every literal secret value (`JOY_MEDIA_CI_S3_*`,
   `JOY_MEDIA_CI_DATABASE_URL`, observer token) with `perl \Q..\E` →
   `<redacted:NAME>`.
2. `actions/upload-artifact@v4.6.2` (pinned SHA, `continue-on-error: true`) →
   `real-service-evidence-p<pass>-<run>-<attempt>`, 14-day retention.

Runs on **success and failure**. Verified by `evidence-retention.test.mjs` — an
**intentionally-failed pass** fixture (`status: "failed"` soak JSON + `clean:
false` teardown.json + a file containing a fake secret): the test asserts the
failure signal survives the snapshot and the secret does not. The harness also
gained `JOY_MEDIA_REAL_ACCEPTANCE_FORCE_FAIL=1` (test-only) to force a non-zero
exit _after_ evidence is written, for the real dev-server integration check.

## Evidence still required before independent approval

- Benchmark on the **corrected revision** (items 1–4 + §7 + §8) — measured wall
  clock, pass/fail/skip per lane, the `teardown.json` records showing
  `clean: true` for both passes (with the new `webTermination` /
  `tempRootRemoval` sub-records), the `ci-janitor/inventory.json` classification
  (with the `not-found` quarantine), the isolation sampler timeline, the
  `prod-build-smoke` result, and a retrieved `real-service-evidence-*` artifact.
- `pnpm test:harness` green (18 cases) + the real dev-server / process-launch
  teardown integration run (normal shutdown / delayed exit / surviving child /
  unrelated process preserved) on a quiet host.
- Final benchmark on a **quiet host** — no competing real-service workload in any
  container sharing that host — with contention measurements recorded.
- The revised repetition contract + coverage matrix reflecting the new lanes.
- Independent review. A green benchmark alone approves nothing and authorizes no
  deployment.
