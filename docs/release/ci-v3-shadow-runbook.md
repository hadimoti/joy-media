# CI v3 shadow comparison: runbook (decisions D17 and D18)

Status: prepared, not run. The shadow dispatches need one step that is outside this development authorization, described first.

## What blocks a shadow run today

1. **The v3 file is not on the default branch.** GitHub dispatches a workflow only when its file exists on the default branch
   (`main`). Dispatching `release-candidate-v3.yml` from the feature branch returns HTTP 404, as the repeat workflow did. Putting the
   file on `main` is a merge, and merges to `main` need the owner's approval. Until then no shadow run of v3 can happen.
2. **No run-summary writer yet.** `tooling/release/src/ci-v3-shadow-compare.mjs` compares two summaries. Nothing writes those summaries
   from a gate run, and neither workflow uploads them. Writing the summary and its artifact is a small follow-up, to be reviewed
   with the first shadow pair.

## What is ready

- `release-candidate-v3.yml` (dispatch-only): one pass per lane, the topology `single-pass` in the readiness record, the attempt guard,
  the exact-SHA checkouts, and `--retry=0` and `--retries=0` on every test command. Its policy is pinned by
  `tooling/release/src/release-candidate-v3.test.ts` (19 tests, including mutated copies that must be refused).
- The readiness builder and the evidence restore accept the single-pass topology (`create-readiness-evidence.mjs`,
  `restore-retained-evidence.mjs`). The two-pass gate keeps its values and its test expectations.
- `ci-v3-equivalence.ts` compares the executed Vitest test IDs and the verdict. `ci-v3-shadow-compare.mjs` adds the 17 check results,
  the scenario outcomes, the lifecycle transitions, the nine lanes and the attempt, with 12 negative controls.

## The shadow procedure, once the owner approves the merge

Each step is safe to repeat. Nothing here publishes, tags, deploys, merges or changes branch protection.

1. Freeze one commit C0 that holds the v3 files. Record its SHA in the evidence note.
2. Confirm the safety conditions on C0: `release-candidate-v3.test.ts` passes on C0, and `grep -n "gh release\|softprops\|deploy" .github/workflows/release-candidate-v3.yml`
   prints nothing.
3. Dispatch v2 and v3 on C0, one after the other, so the runner is not shared:

   ```bash
   gh workflow run release-candidate-v3.yml -R hadimoti/joy-media -f candidate_sha=<C0>
   ```

   v2 takes about three hours on the shared PC. Record both run IDs.

4. Each run writes its summary (once the summary writer exists). Compare the two summaries:

   ```bash
   node --experimental-strip-types tooling/release/src/ci-v3-shadow-compare.mjs <v2-run.json> <v3-run.json>
   ```

5. Negative runs on throwaway SHAs (never candidates): an injected failing unit test, a failing lifecycle step, one tampered artifact
   byte, a missing receipt, and a re-run of attempt 2. Each must make v3 fail.
6. Record the measured critical path of the Windows lane and of the acceptance runner. The design's 75-minute target depends on it,
   and it is a result to report, not an assumption to pass on.

## What the shadow run does not decide

The cutover (D19), the deletion of the legacy workflows (D22), the branch-protection change (D23) and any release authorization stay
with the owner. A passing shadow comparison is development evidence, not a release receipt.
