# Owner checklist: release authorization (decision record)

This file records what a release decision needs. It authorizes nothing. Each of these needs your explicit approval in the same
message as the request: publishing, merging to `main`, dispatching a release run, the shadow pair, the cutover, and deleting
legacy workflows.

## Status (2026-10-28)

**NOT READY for release.** The verdict in `docs/qa/evidence/2026-10-26-v103-milestone-status.md` still stands. The work of
2026-10-28 added engineering evidence for the signing chain, for the attended receipts, and for the survives flake. It added no
release receipt and changed no gate.

## What the release still needs

| Item                          | What is still needed                                                                                                                    | Who                   | Status                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------- |
| L1 signed update              | Key ceremony (`signing-d2.md`), the pin in the next candidate, publishing the two assets, then a positive check on a pinned build       | you, then engineering | blocked (owner)       |
| L1 rollback and installer     | Lifecycle receipt on the release gate                                                                                                   | gate run              | pending approval      |
| L2 GPU                        | Session G1 (`gpu-g1.md`) and the decision between options A and B, then session G2 (30 default launches on the exact candidate)         | you                   | blocked (owner)       |
| L3 Persian captions           | Gate lifecycle caption receipt; decision D14 on the default caption face                                                                | gate run; you         | pending               |
| L5a held file                 | Gate lifecycle receipt                                                                                                                  | gate run              | pending approval      |
| L5b full disk                 | Wording decision D16                                                                                                                    | you                   | blocked (owner)       |
| L6 menus and keyboard         | Decision on Pause and Stop                                                                                                              | you                   | open                  |
| L7a account                   | Session A1 (`account-a1.md`), decision D10, and blockers 2 and 3 in that file                                                           | you, then engineering | blocked (owner)       |
| L7b upscale                   | Session A1 upscale step; the SSIM measurement tool (engineering); decision D12 on the licensed model                                    | engineering, then you | blocked               |
| L7c `cli.worker`              | Excluded from v1.0.3 unless you decide otherwise. Needs A1 with the licensed weights                                                    | you                   | excluded              |
| L8 CLI, F1 PATH, F2 installer | Gate lifecycle receipts                                                                                                                 | gate run              | pending approval      |
| L10 CI and evidence           | Shadow dispatch go (D18); the C0 choice; weekly repeat merge (D21); legacy deletion (D22); branch-protection check (D23); cutover (D19) | you                   | owner                 |
| Survives flake                | Diagnosed (below). Decide whether the test change stands                                                                                | you                   | fix on the dev branch |
| Packaged startup check in CI  | A runner and a policy decision                                                                                                          | you                   | open                  |
| Release notes wording         | Decision D15                                                                                                                            | you                   | open                  |

## The survives flake (diagnosed 2026-10-28)

- Unloaded, the test passed 3 of 3 runs, about 7 seconds each.
- Under full CPU load (32 busy processes on the 32 logical cores), the test with its 3-second lease cap failed 3 times in 42 runs.
  One of those failures recorded its error: `worker lease expired`, on the restarted Worker's thumbnail job. The other two
  predate the error message, and they failed at the same assertion with status `failed`.
- Cause, from the code: the test capped leases at 3 seconds, and the Worker heartbeats every 10 seconds
  (`apps/worker/src/worker-daemon.ts`). A job that runs past 3 seconds before its first heartbeat expires, by design.
  Production grants a 30-second lease with the same 10-second heartbeat, so this margin does not arise there.
- Change on the dev branch: the test's lease cap is now 20 seconds, which is above the heartbeat. The assertions are unchanged.
  The killed job must still end as `failed` with the expired-lease error, and the restarted Worker must still finish new work.
- Loaded result with the change: 24 of 24 passed, with 0 failures. At the earlier rate about two failures were expected in 24
  runs, so this supports the diagnosis but does not prove it. Watch the next scheduled runs.

## Decisions for you

1. **Minimum supported version.** None, or a version. A version forces older installs to update. Default: none.
2. **Key ceremony timing.** Before the next candidate is frozen (recommended), so the pin is in that candidate. See
   `signing-d2.md`.
3. **Server-side release key.** Remove it, or document why it stays. See `signing-d2.md`, "Open before you start".
4. **GPU shipped configuration.** Option A: keep the relaunch fallback, and make the acceptance harness drive the relaunched
   session. Option B: fix the default hardware path, then rerun the default build as a new candidate. Both need G1 first.
5. **One-attempt guard.** `validate-candidate` refuses any attempt other than 1. Keep it, or allow a gate re-run from retained
   artifacts. This is open in `docs/release/RELEASE-RULES.md`.
6. **Windows-only tests in equivalence.** Today a Windows-only test counts only when a lane records it. Open in
   `docs/release/RELEASE-RULES.md`.
7. **Fresh shadow pair.** Whether the shadow comparison needs a new v2 and v3 pair after the lane-recording fix, or whether offline
   replay plus one completed v3 run is enough. Open in `docs/release/RELEASE-RULES.md`.
8. **Packaged startup check.** Whether CI gets a packaged-startup check, which needs a runner.

## When you authorize a release (later, not now)

Each step needs its own approval:

1. Approve one candidate commit and one gate run, with the pass criterion written down first. Never cancel a running release run
   (`docs/release/RELEASE-RULES.md`, rule 4).
2. Confirm the receipt for every row marked "gate run" in the table above.
3. Build the update manifest from the frozen candidate's files, with `tooling/release/src/build-release-manifest.mjs`.
4. Sign it offline (`signing-d2.md`, step 5).
5. Publish the two assets, approved separately.
6. Verify from a pinned build (`signing-d2.md`, step 7).
7. Rollback path: the installer's `/rollback` restores the kept previous version. Sandbox evidence is in
   `docs/qa/evidence/2026-10-26-rollback-path-layout.md`.

## Not authorized by this document

Merging to `main`; dispatching `release-candidate-v2` or `release-candidate-v3`; the shadow pair; the cutover (D19); legacy
workflow deletion (D22); branch-protection changes (D23); publishing; deployment.

## Decision record (you fill this in; engineering does not)

| Decision          | Choice | Date | Your words, quoted |
| ----------------- | ------ | ---- | ------------------ |
| Candidate commit  |        |      |                    |
| Gate run approved |        |      |                    |
| Publish approved  |        |      |                    |
