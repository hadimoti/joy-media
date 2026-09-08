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

- The harness wraps every cleanup step (`browser.close`, `killTree`,
  `apiServer.close`, worker stop, `DROP SCHEMA`, `mc rm`, `mc rb`,
  `rm tempRoot`), collecting — never swallowing — each failure.
- After cleanup it **re-inspects** the runner: a fresh pool checks
  `pg_namespace` for `ci_accept_<ns>` / `ci_legacy_accept_<ns>`; `mc ls` checks
  the bucket; `stat` checks the temp root; `process.kill(pid, 0)` checks the web
  process.
- Any residue, or any collected cleanup failure, becomes a `TeardownError`. If
  the run body already threw, the teardown failure is appended to it; either way
  the pass **fails**.
- The harness writes `test-output/operations/teardown.json`
  (`{ clean, verified[], cleanupIssues[], residue[] }`). The workflow step
  **requires** the file and fails on `clean !== true` — so even a harness that
  somehow exits 0 without a clean teardown is caught.

**Assertion:** each completed pass leaves **no run-owned schema, legacy schema,
bucket, object, temp directory or child process**.

## 2. Interruption-recovery design — `ci-namespace-janitor.mjs`

`ops/self-hosted/linux-runner/ci-namespace-janitor.mjs` inventories every
`ci_accept_* / ci_legacy_accept_*` schema and `joy-media-*` bucket and classifies
each by looking up the **owning workflow run's status** (GitHub Actions API,
`GITHUB_TOKEN` + `actions: read`):

| Class     | Rule                                                   | Action                                |
| --------- | ------------------------------------------------------ | ------------------------------------- |
| `current` | run id == `GITHUB_RUN_ID`                              | never touched                         |
| `active`  | run status `in_progress` / `queued` / `waiting`        | **never touched**                     |
| `orphan`  | run status `completed` (any conclusion) or `not-found` | eligible for sweep                    |
| `unknown` | API error / unreadable status                          | **never touched** (cannot prove dead) |

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

## Evidence still required before independent approval

- Benchmark on the **updated revision** (with items 1–4) — measured wall clock,
  pass/fail/skip per lane, the `teardown.json` records showing `clean: true`
  for both passes, the `ci-janitor/inventory.json` classification, the isolation
  sampler timeline, and the `prod-build-smoke` result.
- The revised repetition contract + coverage matrix reflecting the new lanes.
- Independent review. A green benchmark alone approves nothing and authorizes no
  deployment.
