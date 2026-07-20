# P09 gate review

**Reviewed:** 2026-07-20
**Verdict:** Accepted for the bounded P09 scope.

## Evidence

| Exit criterion                                                                            | Evidence                                                                                                                                                                                                                                             | Result |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Reviewed releases are publisher-verified, immutable, review-gated, revocable, and visible | `ReviewedCatalog` verifies the signed manifest/package, binds publisher key IDs, rejects duplicate coordinates, requires host authorization for registration/submission/review/revocation, records decisions, and exports/imports restart snapshots. | Pass   |
| Team assets and time-coded review survive comparison without source mutation              | `TeamCollaborationStore` clones records, requires host permissions for writes and decisions, records audit outcomes, returns JSON-pointer comparisons, and restores assets, versions, branches, and reviews from a snapshot.                         | Pass   |
| Collaboration preserves history and uses an approved conflict model                       | ADR-0012 plus `RevisionHistory` enforce actor-authorized fast-forward acceptance, retain stale proposals as conflicts, audit outcomes, and restore heads/revisions/proposals from a snapshot.                                                        | Pass   |
| Commercial/scale/mobile claims remain gated                                               | ADR-0013/0014 and their evidence registers keep the reviewed catalog private/team-scoped; no matching application implementation is present.                                                                                                         | Pass   |

## Verification

- `pnpm typecheck` passes.
- Focused P09 suites pass: reviewed catalog plus collaboration-core (6 tests).
- Focused lint, formatting, and `git diff --check` pass.
- The wider P05-era working-tree changes remain unstaged and were not included in this review; the full repository test suite is not used as P09 evidence.

## Scope boundary

The snapshot contracts are persistence seams: a host must durably save each snapshot and restore it at startup. P09 does not authorize a public marketplace, payments, payouts, multi-region service, GPU pool, mobile app, or real-time transport.
