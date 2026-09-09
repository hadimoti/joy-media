# GitHub Support request — artifact uploads blocked after cleanup (DRAFT)

**Status:** draft, for the owner to review and submit if the Billing UI shows no
explicit explanation. Submit from https://support.github.com/ (Account &
billing → GitHub Actions) signed in as `hadimoti`.

---

## Subject

Artifact uploads still fail with "Artifact storage quota has been hit" ~11 h
after deleting all unreferenced artifacts — current usage is ~27 MB

## Account / repo

- Account: `hadimoti` (personal account)
- Repository: `hadimoti/joy-media` (private)

## What happened

1. On **2026-09-08 ~22:30 UTC** I deleted 44 unreferenced Actions artifacts from
   `hadimoti/joy-media`, keeping 6 QA-referenced artifacts. Storage dropped from
   ~4.62 GiB to ~27.6 MiB.
2. Since then, **every** workflow run that calls `actions/upload-artifact` fails
   at the upload step with:

   ```
   Failed to CreateArtifact: Artifact storage quota has been hit. Unable to
   upload any new artifacts. Usage is recalculated every 6-12 hours.
   ```

3. I waited well past the stated 6–12 h recalculation window. Bounded probe runs
   (a single 93-byte JSON artifact) at the following times all failed with the
   same message:

   | UTC time (2026-09-09) | Run ID | Result |
   |---|---|---|
   | 23:17 (09-08) | `34289879890` | quota error |
   | 00:48 | `34296486901` | quota error |
   | 02:19 | `34302674101` | quota error |
   | 07:46 | `34321315683` | (self-hosted runner offline — inconclusive) |
   | 09:15 | `34333645269` | quota error (verbatim message above) |

4. Current usage, measured via `gh api` across all my repositories: **6
   non-expired artifacts, ~27.6 MiB total, all in `joy-media`.** Every other
   repository shows 0.

## Possibly related

On **2026-09-08**, a dispatch of a GitHub-hosted workflow (run `34165045011`)
had 14 hosted jobs rejected before starting with: *"recent account payments have
failed or your spending limit needs to be increased."* I am not sure whether the
artifact-upload block is the same underlying issue or separate.

## Questions

1. What is the actual artifact-storage limit and current counted usage on this
   account right now? The `CreateArtifact` error implies a limit far below
   27 MiB, which does not match any documented plan allowance.
2. Is there a billing hold, failed payment, or $0 spending limit on the account
   that is blocking artifact uploads independently of storage usage? If so, what
   exactly needs to change?
3. Is the storage figure stuck / not recalculating after the 2026-09-08
   deletion? If so, can it be forced to recompute?

## What I have NOT done

- Not purchased additional storage (the numbers suggest that would not help).
- Not changed the payment method or spending limit (waiting to understand the
  actual restriction first).

---

## Internal notes (not part of the request)

- Deletion timestamp is approximate (~22:30 Z 2026-09-08); the owner can read the
  exact time from the account's artifact audit log if Support needs it.
- The one approved `release-candidate-v2` gate dispatch is intentionally blocked
  by this — its `Verify retained evidence` + `upload-artifact` steps have no
  `continue-on-error`. The frozen candidate `6c21c589` / tag
  `ci-v2-gate-frozen-6c21c589` / SAFE-TO-FREEZE reviews are unaffected.
- R2 feature work (Look agent tools, server-sync migration dev/test, GAP 2/4
  acceptance) does not depend on this and is proceeding.
