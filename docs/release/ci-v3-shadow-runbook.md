# CI v3 shadow comparison: runbook (decisions D17 and D18)

Status: the branch implementation is complete (D17, approved 2026-10-26; see [the design](../plans/2026-10-26-ci-v3-design.md)). The v3 file is on `main` through PR #13. It is dispatch-only and changes no release path. No shadow run has been dispatched. Dispatching needs the owner's go (D18), and the decisions below must be settled first.

Nothing in this runbook publishes, tags, deploys, merges, changes branch protection, or cuts over. The cutover (D19), the deletion of the legacy workflows (D22) and the branch-protection change (D23) stay with the owner.

## What blocks a shadow run

1. **Resolved: the v3 file is on the default branch.** GitHub registers a workflow only when its file exists on the default branch (`main`). A dispatch of a workflow that `main` lacks returned HTTP 404, as the repeat workflow did. PR #13 put `release-candidate-v3.yml` on `main`, with the tooling, policy tests and runbook its jobs use. v2 stays the production gate, and v3 is dispatch-only.
2. **C0 needs an owner decision.** The plan defines C0 as "v1.0.2 product code plus the CI changes". The repository has the `v1.0.2` tag, but the v1.0.3 tests and gate expect the v1.0.3 product, so a v1.0.2 product tree would fail them. The two options are:
   - (a) the literal plan baseline: a v1.0.2 product tree with the CI tree, built and checked on its own. The v1.0.3 tests would not be part of it.
   - (b) the feature-branch head after this change. This checks the mechanics of the two gates on one SHA, but it is not the plan's baseline.

   Recommendation: (b) for the first shadow pair, to prove the comparison works, and (a) only if the owner wants the plan's literal baseline.

3. **v2 keeps no record the comparison needs.** `release-candidate-v2.yml` is unchanged, so it still writes no run summary and no per-test report, and its readiness record is not in the durable store. The v2 summary therefore cannot be built from the v2 run as it stands. The open requirement is in "The v2 summary" below.

4. **Two decisions from the review of the graph (see [the design](../plans/2026-10-26-ci-v3-design.md), section 2.2).**
   - (a) On the v1.0.3 branch, the default suite declares `projects` (a serial-process project). `vitest.p0.config.ts`, the config that v2's P0 lanes use, would inherit them, so Vitest would run the default suite and none of the P0 files. `main`'s default suite declares no `projects`, so v2's P0 lanes are correct on `main` today. v3 uses `vitest.p0-v3.config.ts`, which clears any inherited projects. Merging the branch's default-suite config to `main` without first correcting v2 would change what the production gate runs, so that merge is an owner decision.
   - (b) The v3-only Windows deferral (`JOY_MEDIA_CI_WINDOWS_EVIDENCE=deferred`) is in the shared real-service harness, which PR #13 put on `main`. The default stays strict, and the final gate still requires and binds the Windows receipt. Its approval is an owner decision.
5. **The v2 pin differs between `main` and the branch.** `release-candidate-v2.yml` on `main` pins the v1.0.1 release. The branch's file pins v1.0.2, as the v3 file does. A pair that dispatches v2 from `main` would run v1.0.1 pins beside v3's v1.0.2 pins, so the two runs would not be comparable. Step 3 dispatches both from the branch. That is unverified until the first dispatch.

## The v3 summary (automatic)

The `gate-summary` job of release-candidate-v3 writes the run's summary after the gate. It builds the summary from the run's own files, with `tooling/release/src/ci-v3-run-inputs.mjs --topology single-pass` (the needs context, the gate report, the readiness record, the Windows acceptance file and the verified hosted-verify report), then checks it with `tooling/release/src/ci-v3-run-summary.mjs`. It puts the JSON in the job's step summary under "Shadow run summary". A missing or inconsistent input fails the job.

## The v2 summary (open requirement)

The comparison needs a v2 summary with the same shape. Its inputs are:

- the v2 run's needs context (`toJSON(needs)`, the nine lanes), from the job log or the API;
- the v2 gate report (`test-output/release-gate/report.json`), retained in the durable store;
- the v2 readiness record (`test-output/readiness/evidence.json`), which is **not** retained today;
- the Windows acceptance file of the gate pass (`test-output/windows/acceptance.json`), retained;
- the executed Vitest test IDs of v2, from a Vitest JSON run on the same commit (one reference job: `vitest run --retry=0 --reporter=json --outputFile=<file>`). v2 writes no per-test report.

Once those exist, the v2 summary is:

```bash
node tooling/release/src/ci-v3-run-inputs.mjs --topology two-pass --needs <needs.json> --gate <report.json> --readiness <evidence.json> --windows <acceptance.json> --vitest-json <reference.json> --candidate-sha <C0> --run-attempt 1 --out <v2-inputs.json>
node tooling/release/src/ci-v3-run-summary.mjs --input <v2-inputs.json> --out <v2-summary.json>
```

Choosing how to retain the v2 readiness record without changing v2 is an owner decision. The options are a retention step in a separate job, or accepting the scenario outcomes that the retained Windows file gives.

## The shadow procedure, once the decisions above are made

Each step is safe to repeat.

1. Freeze C0 (decision 2) and record its SHA in the evidence note.
2. Confirm the safety conditions on C0:

   ```bash
   node node_modules/vitest/vitest.mjs run --retry=0 tooling/release/src/release-candidate-v3.test.ts
   grep -n "gh release\|softprops\|git push\|git tag" .github/workflows/release-candidate-v3.yml
   ```

   The grep prints nothing, and the policy file passes.

3. Dispatch v2, then v3, one after the other, so the runner is not shared. v2 takes about three hours on the shared PC.

   ```bash
   gh workflow run release-candidate-v2.yml -R hadimoti/joy-media --ref v1.0.3/no-owner-tracks -f candidate_sha=<C0>
   gh workflow run release-candidate-v3.yml -R hadimoti/joy-media --ref v1.0.3/no-owner-tracks -f candidate_sha=<C0>
   ```

   Both take the branch's file through `--ref`, so the pair runs the same pins (item 5 above). Record both run IDs.

4. Build the two summaries (above), then compare them:

   ```bash
   node --experimental-strip-types tooling/release/src/ci-v3-shadow-compare.mjs <v2-summary.json> <v3-summary.json>
   ```

   The comparison passes only when both runs name the same candidate, the same verdict and the same 17 check results, the same scenario outcomes and lifecycle transitions, every lane of each run's own topology green, the first attempt in both, and every test v2 executed still executed in v3.

5. Negative runs on throwaway SHAs (never candidates). Each must make v3 fail:
   - an injected failing unit test: the hosted-verify merge refuses it (`hosted-verify.test.ts` covers the failed-test refusal);
   - a failing lifecycle step: the readiness builder refuses it (`create-readiness-evidence-single-pass.test.ts`);
   - one tampered artifact byte: the artifact check refuses it (`retain-release-artifacts.test.ts`);
   - a missing receipt: the restore refuses it (`restore-retained-evidence.test.mjs`);
   - a re-run of attempt 2: the attempt guard and the readiness builder refuse it (`release-candidate-v3.test.ts`, `hosted-verify.test.ts`).
6. Measure the critical path from the run timestamps of the v3 run (`gh run view <run-id> --json jobs`), and record the Windows lane and the acceptance chain separately. The design's 75-minute target depends on it. It is a result to report, not an assumption to pass on.

## Resources, cost, evidence and boundaries of one shadow pair

The v2 figures are measured on run `40148387453` (candidate `7f2b826d`, see [the design](../plans/2026-10-26-ci-v3-design.md), section 1). Every v3 figure is an estimate or unmeasured: no v3 job has run on GitHub.

| Runner (label)                                                 | Jobs in v3 (timeout cap, min)                                                                                                                                    | v2, measured (min)                                                                                        | v3                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| GitHub-hosted `ubuntu-24.04`                                   | validate 5; hosted-verify-shard ×3 at 90 each; hosted-prepare 60; hosted-verify 30; node-contracts ×2 at 45 each; editor-web-bundle 30; acceptance-responsive 20 | node-contracts 11.3 and 11.6; editor-web 0.8; responsive 4.3 and 4.1; validate 0.1 (total 32.2)           | shards, prepare and verify unmeasured on hosted runners (the rehearsal was local) |
| Self-hosted `joy-media-ci` (Linux)                             | linux-real-services, 90                                                                                                                                          | 9.4 and 9.0 (two passes)                                                                                  | one pass, unmeasured                                                              |
| Self-hosted `joy-media-worker-docker` (Windows)                | windows-candidate, 240                                                                                                                                           | 70.7 for the equivalent Windows work                                                                      | unmeasured for v3                                                                 |
| Self-hosted `joy-media-acceptance` (Linux, one runner, serial) | real-service-acceptance 120; fixture-acceptance 60; p3-real-services 360; gate-summary 240                                                                       | real-service 44.6 and 44.4; acceptance-primary 5.5 each; p3 7.1 and 7.0; prod smoke 1.2; gate-summary 9.0 | one pass each, unmeasured                                                         |

**Cost.**

- GitHub-hosted Linux minutes: v2 used about 32 minutes per run (measured). v3 is estimated at 70 to 115 minutes. The shard and prepare jobs install dependencies on a hosted runner, and the rehearsal did not measure that. Check the account's included minutes before any dispatch.
- Runner occupancy: v2 holds the acceptance and Windows runners for about 3 hours (measured, 180.3 minutes). The v3 critical path is estimated at about 70 to 75 minutes, which is the Windows lane (about 70 minutes, v2's equivalent) or the acceptance chain (about 65 to 70 minutes), whichever is longer, plus the gate. It is not a measured result. The 75-minute target is reported only after a shadow run measures it.
- Run v2 and v3 one after the other on the shared runners. Check that each runner is idle before the dispatch. Together the pair takes about 4 to 4.5 hours of runner time.

**Evidence.**

- v3 keeps the gate report, the readiness evidence, the hosted-verify report and the run summary (the step summary "Shadow run summary"). The hosted-verify report is a one-day artifact. `gate-summary` copies it, with the readiness record and the run summary, into the durable store as `v3-receipts/`, with checksums. The Windows acceptance and lifecycle receipts are kept there as well.
- v2 keeps the gate report and the Windows acceptance file. It keeps no readiness record and no per-test report, so its summary is the open requirement in "The v2 summary".

**Boundaries.**

- Both workflows are `workflow_dispatch` only. Neither runs on push or on a schedule.
- v3 publishes nothing: no release, tag, release upload, push or deploy. The grep in step 2 checks this.
- Both workflows take the same `candidate_sha`, and the attempt must be 1. A re-run is refused by design, and a re-run is never evidence.
- Negative runs use throwaway SHAs only, never a candidate.
- Branch protection, secrets and environments are not changed. v2 stays the release gate. A passing comparison is development evidence, not a release receipt.

## What the shadow run does not decide

The cutover (D19), the deletion of the legacy workflows (D22), the branch-protection change (D23) and any release authorization stay with the owner. A passing shadow comparison is development evidence, not a release receipt.
