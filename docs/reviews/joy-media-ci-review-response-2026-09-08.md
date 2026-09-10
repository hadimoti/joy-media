# CI v2 — response to the independent review

Independent review ran on `codex/joy-live-director-ci-opt` @ `8d9e27b4`. This
maps every finding to what changed. HEAD after this response: see `git log`.

## Blockers

| #      | Finding                                                                                                                                                    | Status    | What changed                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** | coverage-matrix doc falsely classified `wp35-universal-timeline` + `golden-path` as "functional"; their per-viewport layout / a11y assertions were dropped | **FIXED** | The 6-viewport sweep (`acceptance-responsive` job **and** `runDesktopMatrix`) now runs **3 layout specs** unioned via `--grep`: `wp32-responsive-checkpoints` + `golden-path` (login-gate overflow + axe) + `wp35`'s `renders backend track titles` test (loaded-timeline `.monitor-transport` / `.monitor-transport-end` / `.workspace` geometry). Doc table corrected. Verified 3/3 green at `desktop-compact`. |
| **B2** | `wp32-responsive-checkpoints` measures overflow once, in the default layout; no coverage of Joy Code / Creative Brief / 3D Scene                           | **FIXED** | Re-measures `body.scrollWidth <= clientWidth` **after each of 11 panel opens**; panel list gains `Joy Code`, `Enhance`, `3D Scene`, and an inline Creative Brief reveal.                                                                                                                                                                                                                                          |
| **B3** | `pnpm test:harness` (the node:test correctness suite) run by no workflow                                                                                   | **FIXED** | `release-candidate-v2` `linux-real-services` runs `pnpm test:harness` (full 31 cases on Linux) right after `verify:ci`; `ci-dev` `static-and-unit` runs the cross-platform subset.                                                                                                                                                                                                                                |
| **B4** | `prod-build-smoke` uses unscoped `pkill -f 'vite preview'` on the shared `joy-media-ci` runner + fixed ports 4990/4991                                     | **FIXED** | Servers run under `setsid` (own process group), PIDs to `$RUNNER_TEMP`; teardown signals by pgid with bounded SIGTERM→wait→SIGKILL→verify and **fails** if a server survives. Ports are `21000 + run_id%3000` (+5000), `--strictPort`.                                                                                                                                                                            |

## Major

| #      | Finding                                                                                                               | Status                  | What changed                                                                                                                                                                                                                                                                                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1** | `acceptance-responsive` dropped the OpenCLI guard + removal-verification `acceptance-primary` keeps                   | **FIXED**               | Its boundary step regained the candidate-SHA / node / pnpm / `JOY_MEDIA_OPENCLI_PROFILE` checks; its teardown regained the bounded-retry `test "$removed" -eq 1` proof.                                                                                                                                                                                                     |
| **M2** | repetition doc's "cold-cache resilience → mitigated" is false                                                         | **FIXED (doc)**         | Rewritten: runner-image / host drift / store integrity are **NOT** mitigated (both passes share one warm persistent runner); `windows-worker-clean` now builds once/gate; `prod-build-smoke` is a new single-execution required lane.                                                                                                                                       |
| **M3** | the "one automatic re-dispatch on infra failure" fallback does not exist                                              | **FIXED (doc)**         | Stated plainly: no retry / re-dispatch / infra-vs-product classification exists. New recommendation: a **periodic (not per-candidate) whole-workflow drift canary on `main` HEAD**, or keep 2×, or build a real taxonomy.                                                                                                                                                   |
| **M4** | `runDesktopMatrix` writes the profile matrix `passed` unconditionally; a zero-test run passes                         | **FIXED**               | Matrix `status` is derived from the per-leg summaries; a leg fails if `status != passed` **or** fewer than `minTests` (3 responsive / 80 primary) passed. `/tmp` report dirs gained `runAttempt`.                                                                                                                                                                           |
| **M5** | `journey-failure.json` written only for telemetry-assertion failures                                                  | **FIXED**               | The entire `recordJourney` walk is wrapped — **any** throw (locator timeout, non-201 upload, cancel/retry, telemetry) persists a phase-stamped `journey-failure.json` (with `thrown`) before propagating.                                                                                                                                                                   |
| **M6** | telemetry capture disabled across ~280 lines of the journey                                                           | **PARTIAL / follow-up** | Kept for now (the deliberately-failing `missing-source` request). Noted as a follow-up: narrow the mute or filter that one URL as a known-expected entry.                                                                                                                                                                                                                   |
| **M7** | the Vite dev-server stdout/stderr is discarded — the best `ERR_FILE_NOT_FOUND` artifact                               | **FIXED**               | dev server `pipe`d into a bounded (line+byte, chunk-split-safe) redacted ring buffer, flushed on **any** harness failure — journey, dev-server-startup timeout, `runDesktopMatrix` leg, observer, restore (the top-level `catch` calls `writeWebServerLog()`, not only `writeJourneyFailure`). Allowlisted, referenced from `journey-failure.json`. See Update 2026-09-09b. |
| **M8** | `retain-evidence.sh` had no `set -e` and every `perl` call swallowed its own error, so redaction could silently no-op | **FIXED**               | `command -v perl` + `sha256sum` required up front (FATAL if absent). All rules run in **one** `perl` invocation with the error-swallow removed — a `perl` failure fails the pass. Leak-guard extended to the url-encoded form + a generic Bearer / `X-Amz-Signature` / basic-auth scan. Dead `JOY_MEDIA_RELEASE_OBSERVER_TOKEN` dropped from `SECRET_VARS`.                 |
| **M9** | the "quarantine" test does not test quarantine                                                                        | **FIXED**               | `evidence-retention.test.mjs` stubs `perl` as a no-op so a literal secret survives redaction, then asserts the file is **not** persisted, `REDACTION-FAILURES.txt` names it, and `MANIFEST.quarantinedCount >= 1`.                                                                                                                                                          |

## Minor

| #       | Finding                                                                                                              | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **m1**  | unbounded `await realWorkerPromise` in teardown                                                                      | **FIXED** — 60 s bounded `Promise.race`; a wedged worker records a cleanup issue instead of blocking to the 120-min job timeout.                                                                                                                                                                                                                                                                                                                          |
| **m2**  | post-termination residue check only inspects the leader PID                                                          | **FOLLOW-UP** — add a `pgrep -f` for the run's `webPort` / `tempRoot` to `residue`.                                                                                                                                                                                                                                                                                                                                                                       |
| **m3**  | `removeDirWithRetry` swallows `fs.rm` errno; `residualEntries` is top-level names only                               | **FOLLOW-UP** — record `lastRmError?.code`; deep-walk residual entries.                                                                                                                                                                                                                                                                                                                                                                                   |
| **m4**  | `/tmp` Playwright report dirs leak on kill, not in the residue check                                                 | **PARTIAL** — gained `runAttempt` in the name; janitor still doesn't cover `/tmp`. Follow-up.                                                                                                                                                                                                                                                                                                                                                             |
| **m5**  | janitor: a total `mc ls` failure produces a green empty inventory                                                    | **FIXED** — `bucketInventoryComplete: false` + exit 1.                                                                                                                                                                                                                                                                                                                                                                                                    |
| **m6**  | `--sweep` TOCTOU (run id stable across re-run attempts)                                                              | **NOTED** — safe (re-run creates `_<attempt+1>_` namespaces, never touches the classified ones); a re-check before each delete is a follow-up. Inventory-only in v2 is unchanged.                                                                                                                                                                                                                                                                         |
| **m7**  | `sanitizeUrl` mishandles `data:` / `blob:`                                                                           | **FIXED** — returns `<scheme>:<opaque>` when `url.host === ''`; test cases added.                                                                                                                                                                                                                                                                                                                                                                         |
| **m8**  | `evaluateGateSummary` validates count, never lane identity                                                           | **FIXED** — now NAME-keyed off `toJSON(needs)`; a lane dropped from `needs:` or an unexpected extra lane fails; legacy count mode kept for back-compat. Both call sites pass explicit names.                                                                                                                                                                                                                                                              |
| **m9**  | `initialEditorJsBytes` is inert **and** redundant with `vite.config.ts` `bundlePolicy()` (build-time per-chunk gate) | **PARTIAL** — added `measure-entry-bundle.mjs` to `prod-build-smoke` (records the shipped entry + modulepreload graph, **raw AND gzip**: entry 451,373 / 133,184; eager graph 2,908,836 / 846,556; generous ceilings). The observer's `initialEditorJsBytes` predicate is **left as-is** but is now explicitly documented as a dev-lane sanity check, not production acceptance. Deleting it from the predicate is a follow-up decision for the reviewer. |
| **m10** | requiring the gate to redden on artifact-upload failure is defensible but should be re-argued                        | **ADDRESSED (doc)** — `open-items` §9.2 states the position: the upload is required, its failure reddens the gate, the durable checksum-verified copy guarantees no evidence is lost, and the owner clears the quota. Not demoted to a warning.                                                                                                                                                                                                           |
| **m11** | teardown-record write failure is dropped from the clean decision                                                     | **NOTED** — fail-safe today (the workflow catches a missing file); ordering fix is a follow-up.                                                                                                                                                                                                                                                                                                                                                           |
| **m12** | doc inconsistencies (16 vs 27 cases; §8 stale; `CANDIDATE_SHA` no length check)                                      | **FIXED** — §8 gets a "SUPERSEDED by §9.2" banner; the case count is corrected (now **31**, consistent across benchmark-results / open-items / this doc); `retain-evidence.sh` warns if the resolved sha is not 40 chars.                                                                                                                                                                                                                                 |
| **m13** | `ci-dev.yml` writes Playwright output into the checkout, unignored, no teardown                                      | **FIXED** — `$RUNNER_TEMP` paths + a `git status --porcelain` residue check.                                                                                                                                                                                                                                                                                                                                                                              |
| **m14** | scope-creep audit (`prod-build-smoke`, `ci-dev.yml`, janitor)                                                        | **NOTED** — `verify-agent-operation-coverage` / `font-assets.test.ts` are **not** in this diff (base code). `prod-build-smoke` is a net coverage gain but a new _required_ lane — hardened per B4/M1. `ci-dev.yml` is parked, dispatch-only, reviewed on its own merits.                                                                                                                                                                                  |

## The review's verdict — "must be fixed before v2 can replace v1"

B1, B2, B3, B4, M1, M4, M8 — **all FIXED**. M2/M3 doc rewrites — **DONE**.
The remaining named must-fixes are the two **owner-side** prerequisites the
review itself carved out: `JOY_MEDIA_CI_EVIDENCE_ROOT` on the runner and the
artifact quota. Until a full gate run is green on **both** passes with durable
checksum-verified evidence, the contract is **not demonstrated end-to-end** —
`benchmark-results` says this plainly and it is not softened here.

Follow-ups (M6, m2, m3, m4, m9-decision, m11): tracked above; none block the
next benchmark. M7 (log the dev server, flushed on any failure) landed in the
pre-freeze delta — see Update 2026-09-09b.

**A green benchmark still approves nothing.** The Astra `APPROVE_FOR_DEPLOY`
gate on the final R2 candidate is separate and unaffected.

---

## Update 2026-09-09 — owner's pre-benchmark checklist + M7

Commit `6779a375` on top of `06915066`:

- **M7 → FIXED (upgraded from follow-up).** `webProcess` stdio `ignore` → `pipe`;
  a 4000-line **redacted-at-capture** ring buffer (secret values, `://user:pass@`,
  `Bearer` scrubbed) flushed to `test-output/browser/web-dev-server.log` on
  **any** journey failure, allowlisted in `retain-evidence.sh`, referenced from
  `journey-failure.json`. Verified in `joy-media-ci-acceptance`: log captured
  (vite startup lines; a real transform/resolve error would land here), zero
  secret leak. **This does not resolve §9.1** — the intermittent
  `ERR_FILE_NOT_FOUND` is still open; M7 only makes the next occurrence
  diagnosable.
- **Coverage by test IDENTITY (owner check 3).** `runDesktopMatrix` now records
  `stats.passedTitles` and fails a responsive leg unless the **3 exact required
  test titles** (wp32 checkpoint / golden-path login-gate / wp35
  transport-geometry) each ran and passed — a minimum count cannot prove the
  intended tests ran. `tooling/release/assert-playwright-titles.mjs` does the
  same for the `acceptance-responsive` **job** at every one of the 6 viewports.
  Verified 3/3 identity-OK at `desktop-minimum`. Applies to both passes and both
  paths (the job and the real-service harness).
- **Bundle enforcement clarified (owner check 4 / decision 5).**
  `measure-entry-bundle.mjs` is **informational only** — it no longer exits
  non-zero on size, and its JSON `enforcement` field says so. The **enforced**
  entry-bundle budget is `vite.config.ts` `bundlePolicy()` (per-chunk, at build
  time; every gate lane runs `pnpm build`). **No new total-size threshold
  introduced.** Reference numbers on `83daea2f`: entry raw 451,373 / gzip
  133,184; eager modulepreload graph raw 2,908,836 / gzip 846,556.

**Two latent bugs the verification surfaced (both fixed in `6779a375`):**

1. `runDesktopMatrix` parsed the Playwright JSON from **stdout**, but `pnpm
exec` prints its own preamble ("Scope: … / Lockfile passes … / Done in Nms")
   whenever its periodic lockfile check fires → `JSON.parse` failed →
   `reportParseError` → the leg "failed" with 0 tests. **A benchmark would have
   failed intermittently on this.** Fixed: read `PLAYWRIGHT_JSON_OUTPUT_NAME`
   from a file, never stdout.
2. `writeJourneyFailure` / `journeyFailureWritten` were declared _after_ the
   top-level `try` that calls `recordJourney` → `ReferenceError` (TDZ) on the
   first real journey failure since the M5 commit (`bf93f1bc`). The M5 focused
   check used `FORCE_FAIL` (throws _after_ the journey) so it never hit this.
   Fixed: moved to module scope before the `try`.

**Owner-side prerequisites — DONE:**

- **`JOY_MEDIA_CI_EVIDENCE_ROOT`** — provisioned as a dedicated named volume
  `joy-media-ci-evidence → /opt/ci-evidence` on `joy-media-ci-acceptance`
  (Docker Desktop, so a named volume over a VM bind path). Runner reconnected
  without re-registration; persistence proven across `docker restart` + full
  container replacement + a fresh unrelated container; existing mounts and the
  other CI containers untouched. See `joy-media-ci-evidence-store-2026-09-08.md`.
- **Artifact quota** — the **44 unreferenced** artifacts deleted (references
  re-checked against `docs/qa/` first, unchanged; delete set cross-checked
  against the inventory table); **6 QA-referenced kept**. Storage now ~27.6 MiB
  (was 4.62 GiB). No purchase. See `joy-media-ci-artifact-inventory-2026-09-08.md`.

**Remaining follow-ups (do not block the benchmark):** M6 (the telemetry mute in
`recordJourney`'s `catch` spans ~280 lines of the walk, not the ~10 the inline
rationale explains — it also silences delivery cancel/retry recovery paths;
narrow to the specific expected-error assertions), m2 (grandchild sweep), m3
(`rm` errno), m4 (`/tmp` residue), m9-decision (delete `initialEditorJsBytes`
from the soak predicate?), m11.

## Update 2026-09-09b — pre-freeze delta (re-review of `6779a375`)

The second independent re-review's verdict was "ready for a full benchmark", with
two items to land **before** freezing rather than after. Both done on top of
`0cfb6ef8`:

- **M8 hard-fail (was: error-swallow removed but loop still bare).**
  `retain-evidence.sh` runs redaction in a `while … read` loop with no `set -e`;
  a non-zero `perl` exit was still discarded. Now `redact_file "$f" || { echo
"retain-evidence: FATAL — redaction engine failed on $f" >&2; exit 1; }` — a
  redaction-engine failure fails the pass and persists nothing. New
  `pnpm test:harness` case: _"a redaction-engine ERROR fails the pass (does NOT
  persist)"_ — stubs `perl` to `exit 3`, asserts non-zero exit + no
  `MANIFEST.json` under the persistent root. **31/31 green** in
  `joy-media-ci-linux`.
- **M7 top-level flush (was: only `writeJourneyFailure` flushed the buffer).**
  A `waitForHttp` dev-server-startup timeout and every `runDesktopMatrix` leg
  failure left the Vite ring buffer unflushed. The top-level `catch` in
  `real-service-acceptance.mjs` now calls `writeWebServerLog()` for **any**
  failure and appends the retained path to the error message. Startup failure is
  exactly the case the log exists for.

**§9.1 (`net::ERR_FILE_NOT_FOUND`) remains OPEN and unresolved.** M7 makes the
next occurrence diagnosable; it does not identify or fix the cause. A green gate
does not close it.

### Update 2026-09-09c — delta re-review found one blocker, fixed

The independent review of `0cfb6ef8..e3c1a049` returned **DO NOT FREEZE — 1
blocker** (M8 and M7 themselves confirmed correct):

- **blocker — the leak-guard widening in `e3c1a049` quarantined _correctly
  redacted_ evidence.** The new arm `X-Amz-…=[^&"' ]{8,}` matches redaction's own
  output `X-Amz-Signature=<redacted:presign>` (and `«redacted»` from the
  dev-server log); the pre-existing `://user:pass@` arm likewise matches
  `://<redacted:userinfo>@`. Result: a fully-redacted file is dropped from the
  manifest and the persistent copy and falsely recorded in
  `REDACTION-FAILURES.txt`. Test 7 was already silently quarantining
  `delivery/result.json` and still passing.
- **fix (this delta):** the generic scan now uses **positive** credential-shape
  classes that cannot match a `<redacted:…>` / `«redacted»` sentinel —
  `(X-Amz-)?(Signature|Credential|Security-Token)=[A-Za-z0-9%/+=_.~-]{16,}` and
  `://[^<>/[:space:]:@"]+:[^<>/[:space:]@"]+@`. The "lock-step with `redact_file`"
  comment is corrected to state the guard matches a _live_ credential shape only.
- **regression lock:** test 7 now asserts `manifest.quarantinedCount === 0` and
  no `REDACTION-FAILURES.txt`. Verified it fails with the `e3c1a049` pattern and
  passes with the fix. **31/31 green.**
- Review minors accepted as-is: M7's top-level-catch flush has no unit test (it
  is integration-shaped; the buffer mechanics are covered) — "FIXED" rests on
  code inspection for that path; the misleading `REDACTION-FAILURES.txt` wording
  is a follow-up nit.

**Fix re-review (`e3c1a049..6c21c589`) = SAFE TO FREEZE.** The reviewer read the
current script + test at `6c21c589`, ran the new guard patterns under the
container's byte-based `grep -E` (every redaction sentinel → zero matches; every
genuine credential shape → matched), and confirmed the test-7 regression lock
fails with the `e3c1a049` pattern and passes with the fix. No new findings; the
broader bare-`Credential=`/`Security-Token=` match is intentional defense in
depth. **31/31 harness green.**

**Frozen candidate — `6c21c589`:**

| field                                    | value                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| commit SHA                               | `6c21c589e47a8fc0fa1b843487de284e706329a2`                                                                                                                                                                     |
| tree SHA                                 | `bd52e21aeb9f5021e1be5b045f3b347eae8fab41`                                                                                                                                                                     |
| `pnpm-lock.yaml` — Git blob ID           | `4f2721172df53e834be167dc8d91d56bbaaacb88`                                                                                                                                                                     |
| `pnpm-lock.yaml` — content SHA-256       | `36426937a41309d10cc85fd16a3fc4d42a74c1e234c4cfb77cdd838f8427b0b3`                                                                                                                                             |
| `release-candidate-v2.yml` — Git blob ID | `b5a5880d2c8677e40dcb5b3f7090317093c9d681`                                                                                                                                                                     |
| reviewed workflow-definition commit      | last touched at `0cfb6ef8` (6 defensive lines implementing owner checklist item 4: unique/fresh Playwright report per pass, `rm -f` before + `test -s` after); unchanged through `6c21c589` and the branch tip |

The two `pnpm-lock.yaml` identifiers are different hashes of the same file — the
Git blob ID (`git hash-object`, SHA-1 of `blob <len>\0<content>`) and the raw
content SHA-256. Both are recorded so review/deploy tooling cannot conflate them.

**Workflow-revision pinning.** `gh workflow run` resolves the workflow YAML from
its `--ref`; checking out `candidate_sha` in each job pins only the _code_, not
the _workflow definition_. Dispatch therefore uses the tag
**`ci-v2-gate-frozen-6c21c589`** (→ `6c21c589`) as `--ref`, so GitHub runs the
reviewed workflow definition, and `-f candidate_sha=6c21c589e47a8fc0…` pins the
checkout. After dispatch, record both `gh run view --json headSha` (workflow
revision GitHub used) and the `validate-candidate` job's resolved candidate SHA.

**Next (owner pre-authorized, conditional dispatch approval stands):** benchmark
stays PAUSED until the `artifact-quota-check.yml` probe uploads green (bounded
poller, one probe / 90 min, deadline 2026-09-09T10:30Z). The repeated
`Artifact storage quota has been hit` is _consistent with_ GitHub's documented
6–12 h storage recalculation after the 44-artifact deletion, but that is a
**hypothesis, not a confirmed cause** — the probe is the test. On green →
dispatch ONE `release-candidate-v2` gate on the frozen tag, host quiet, no
implementation changes during the run. If the deadline expires still blocked →
stop probing, investigate account-wide Actions storage/billing + the exact
error (no storage purchase).
