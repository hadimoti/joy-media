# R1 coverage-ledger position — review input for Astra

Recorded: 2026-09-07 (Claude implementer). This is **not** a self-approval. It
states JOY's position on the one coverage-ledger question r1.md leaves to the
independent reviewer, so Astra can rule on it against the exact candidate.

## The ledger as it stands

`docs/reviews/joy-live-director-coverage.json` (schemaVersion 2) advertises
**16 bounded operations**; **8 editor domains are explicitly listed
unsupported**. Every advertised row is:

- `status: verified`, `modelVisibility: advertised`
- `verificationScope: bounded-proposal-path`
- `readback: { classification: not-verified }`
- `e2eEvidence: { classification: shared-host-lifecycle }`

`tooling/release/verify-agent-operation-coverage.mjs` passes: every advertised
kind has source, a focused unit test reference, and declared browser evidence;
no row claims a verification scope its evidence does not support; the 8
unsupported domains stay unadvertised.

## What each row actually proves today

1. **Canonical proposal preparation.** A model `validate_proposal` for the
   kind is compiled by `joy-code-compound-compiler` / `joy-code-timeline-compiler`
   (or the text/motion/caption/transition compilers), rejected with bounded
   repair diagnostics on failure, and — on success — turned into an immutable
   prepared change. Unit-tested per compiler; browser-tested through
   `agent-director-lifecycle` / `agent-director-runtime` (real Worker, real
   host RPC, repair path, revision-drift invalidation, cancellation).
2. **The shared approval + commit envelope.** The prepared change stages a
   live preview, requires a renderer acknowledgement, waits for explicit owner
   approval, then commits atomically through `joy-code-compound-runner`, and
   one Undo reverses it. Browser-tested end to end (`agent-live-preview`,
   `agent-director-lifecycle`).
3. **An F5 operation-specific project-state readback** after commit. `trim`,
   `move`, `split`, created-title opacity keyframe, and transition add/remove
   each have a `*-readback` adapter that re-reads the committed project and
   asserts the operation's own post-state (not just "a commit happened").
   Asserted in `joy-agent/*-readback` unit tests and `domain-parity.test.ts`.

## What no row claims

- **Rendered-frame verification per operation.** `composition-observer` and
  `render-verification` exist and are unit + browser tested, and the
  `final-encoded-export-decoder` gates export completion, but they are wired as
  an **export-time** consumer, not a per-operation ledger consumer. No row says
  `readback: rendered-output`.
- **Decoded-audio verification per operation.** `audio-observer` exists and is
  tested; no advertised row depends on audio, and `audio-balance` /
  `title-and-caption-polish` stay visible-but-unavailable for R1.
- **Operation-specific browser e2e.** Every row's `e2eEvidence` is
  `shared-host-lifecycle`: the browser proof is the shared director lifecycle
  spec set, not one Playwright spec per kind that drives that kind through the
  real UI and reads its rendered result back.

## JOY's position

For a **first release** the honest ledger state is the current one:
`bounded-proposal-path` + `readback: not-verified` + `shared-host-lifecycle`
e2e, with the F5 readback asserted at the unit / domain-parity level. We did
**not** upgrade any row to `readback: project-state-only` because the F5
readback is not yet proven by an `operation-specific` browser spec, and the
verifier correctly refuses the upgrade without one. Nothing is advertised
beyond what the evidence supports; the 8 unsupported domains are refused
outright; the recipe path adds no new advertised capability.

## The question for Astra

**Does R1's advertising bar require an operation-specific browser consumer —
a rendered-frame or decoded-audio readback — for every one of the 16
advertised kinds before they may be model-visible? Or is a first release
acceptable with: bounded proposal-path + the shared approval envelope +
unit/domain-parity F5 readbacks + the O6 decoders present as an export-time
gate (not per-op), all labelled honestly in the ledger?**

- If **acceptable as-is:** the ledger needs no change for R1; the per-op
  rendered/audio consumers become an R2 ledger task.
- If **an operation-specific browser spec is required per kind:** that is
  ~16 new Playwright specs (each: connect fake provider → propose the kind →
  approve → read the committed project state and/or a composed frame back),
  plus wiring `composition-observer` as a per-op consumer for the rows whose
  bar is rendered output. This is a substantial addition and would push the
  R1 candidate out; we would want Astra's explicit list of which kinds need
  rendered-frame vs project-state readback.

Either ruling is fine to implement; we need the ruling before the candidate
is final.
