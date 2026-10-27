# JOY Media release rules

Changed on 2026-10-28 by the owner's decision, after repeated release-CI loops. These rules govern how release and shadow CI are
used. They do not change the release gate code, its thresholds, the candidate pin, the one-attempt guard in `validate-candidate`,
or the equivalence rule in `ci-v3-shadow-compare`. Changing any of those is a gate-policy decision and needs the owner's written
approval.

## The rules

1. **Release CI is for release decisions.** A full v3 run, a shadow pair, or a dev CI dispatch needs the owner's explicit approval,
   given in the same message as the request. The approval names the head SHA and the candidate.
2. **Verify offline first.** Changes to evidence formatters, the readiness builder, the run-summary writer, the v2/v3 comparison,
   workflow reporting, or harness code are verified by offline replay against retained evidence and by isolated tests. Such a
   change is never a reason to dispatch a run.
3. **Batch the fixes.** Collect all known fixes before a run is requested. Each approved run has a pass criterion and a stop rule,
   written before it is dispatched.
4. **Let running release runs finish.** Do not cancel a running release run unless the owner asks. Cancelling mid-lifecycle leaves
   JOY Media install residue on the Windows runner, which blocks the next Windows lane.
5. **Keep the candidate pinned.** Edits to tests or scripts on the dev branch never reach a pinned candidate. Before changing a test
   for a candidate run, check which tree the job actually reads.
6. **Claim nothing without receipts.** A green run proves that run and its candidate only. Readiness claims need receipts on the named
   candidate.
7. **Product first.** Once the current run is reviewed, CI work stops until the next approved batch. Engineering time goes to the
   v1.0.3 plan items that do not need the owner.

## Still open (owner decisions, not changed here)

- Whether the gate job may re-run from retained artifacts. Today `validate-candidate` refuses any attempt other than 1.
- Whether the shadow comparison needs a fresh v2/v3 pair after the lane-recording fix, or whether offline replay plus one completed
  v3 run is enough.
- How Windows-only tests count in the equivalence rule. Today a Windows-only test counts only when a lane records it.

## Offline replay (verify a change without a CI run)

Use this before any dispatch. It rebuilds the readiness record, the run inputs, the run summary and the v2/v3 comparison from one
retained run, and compares each with what that run recorded. It starts no CI run.

1. Copy the run's folders from the durable store on the runner container (read-only), into `<store>/<candidate-sha>/` and
   `<store>/p3/<candidate-sha>/`: `<run>-1-pgate`, `<run>-1-p1`, `<run>-1-release-artifacts`, and `p3/<candidate-sha>/<run>-1-p1`.
2. Create two detached worktrees: one at the candidate SHA, and one at the run's workflow commit.
3. Run the replay with the run's gate log (the log the gate step printed), the two worktrees, and the v2 summary to compare with:

   `node tooling/release/src/ci-v3-offline-replay.mjs --store <store> --candidate-sha <sha> --run <run> --gate-log <gate.log> --candidate-tree <candidate-worktree> --workflow-tree <workflow-worktree> --v2 <v2-summary.json> --out-dir <dir>`

   Add `--lane-vitest <file>` three times when the run uploaded its Windows and P0 Vitest test IDs.

The replay ignores only the build time and the single-pass manifest's restore time, because both change on every restore. Any other
difference is reported in the output.
