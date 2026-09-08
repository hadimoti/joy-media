# JOY Media release gate — repetition contract change (for independent review)

**Branch `codex/joy-live-director-ci-opt`.** This proposes replacing the
"**two complete green `release-candidate.yml` workflow runs**" rule with
"**one green `release-candidate-v2.yml` run containing two genuinely isolated
passes**". It is **not self-approved** — it goes to the independent reviewer with
the coverage matrix, the benchmark evidence, and the isolation evidence.

## What the current rule is

- **In code / YAML:** `release-candidate.yml` already runs `pass: [1, 2]` for
  `linux-real-services`, `acceptance` (× 7 profiles), and
  `real-service-acceptance`. `windows-worker-clean` runs "two exact passes"
  internally. `tooling/release/src/gate.ts` evaluates each pass's evidence
  independently; GitHub requires **all** matrix jobs green for the workflow to
  be green, so one green workflow already means **both passes passed**.
- **In process / the handoff:** additionally, _the whole workflow must be
  dispatched and go green twice_ on the exact candidate.

So a candidate today is verified by **4 clean-state acceptance passes and 4
real-service passes** (2 in-workflow × 2 workflow runs).

## What is proposed

Keep the two in-workflow isolated passes. Drop the "run the whole workflow
twice" rule. A candidate is then verified by **2 clean-state acceptance passes
and 2 real-service passes**, each on a freshly-checked-out immutable candidate.

## Why the two in-workflow passes already satisfy the clean-state / repeatability requirement

The acceptance gate's stated purpose (master plan): _"repeated execution returns
the prior receipt; failure/reload and two writers do not duplicate/partially
apply"_ and a **clean-state** guarantee.

Each pass in `release-candidate-v2.yml`:

1. **Fresh checkout of the exact candidate SHA** (`actions/checkout` with
   `ref: CANDIDATE_SHA`, `fetch-depth: 1`).
2. **`git clean -xdf`** before the release checks (linux-real-services lane) —
   no build output from the other pass survives.
3. **Fully isolated mutable state per pass** — the real-service harness derives
   every namespace from `pass`:
   - Postgres schema `ci_accept_<run>_<attempt>_<pass>`
   - MinIO bucket `joy-media-<run>-<attempt>-<pass>`
   - Worker id `real-service-render-worker-<run>-<pass>`
   - temp root `mkdtemp('/tmp/joy-media-real-acceptance-')` (unique)
   - free-port allocation per pass; `RUNNER_TEMP`-scoped report/results dirs.
4. **Required teardown verification** (hardened on revision `84683cdc`): the
   harness attempts every cleanup step, records — never swallows — each failure,
   then re-inspects the runner for run-owned residue (schema, legacy schema,
   bucket, objects, temp dir, web process) and **fails the pass** on any. It
   writes `test-output/operations/teardown.json`; the workflow requires it and
   fails on `clean !== true`. Plus `git status --porcelain` empty and no OpenCLI
   profile leak.
5. **Interruption recovery** — `ci-namespace-janitor.mjs` runs (inventory mode)
   at the start of every pass, classifying every CI namespace by its owning
   run's status; `active` / `unknown` are never touched; the evidence file is
   required.
6. **Independent `pnpm run release:gate`** evaluation per pass.

Pass 2 therefore runs on a runner from which pass 1 has been fully torn down and
**verified** clean (not assumed clean) — which is exactly the "clean-state,
repeatable" evidence a second whole-workflow run was providing. A second workflow
run adds a _third and fourth_ repeat, not a _different kind_ of evidence.

**Fresh-namespace isolation and pass-1 cleanup are reported as two distinct
facts** (see `joy-media-ci-open-items-2026-09-08.md` §3): the first proves pass 2
cannot inherit pass 1 state (unique never-before-used names); the second proves
pass 1 actually removed its own state.

## What a second whole-workflow run did provide that this does NOT — honest accounting

**Corrected after independent review.** The earlier version claimed cold-cache
resilience was "mitigated"; it is not.

- **Runner-image / host drift, store integrity — NOT mitigated.** Both isolated
  passes run **serially on the one `joy-media-acceptance` runner** with a
  persistent workspace and a warm pnpm store (`benchmark-results` §"Isolation",
  `open-items` §9). A second `pnpm install --frozen-lockfile` against the same
  warm store on the same host, minutes later, does **not** exercise a rebooted
  runner, a re-provisioned image, an evicted/corrupted store, a re-downloaded
  Chromium, or a different day's transient infra. A second whole dispatch could
  land on a different runner or a different day and did exercise those. The v2
  contract gives that up. The `git clean -xdf` + per-job `pnpm build` inside one
  run is a **warm-path** rebuild, not a cold path.
- **`windows-worker-clean` — now built once per gate.** It does one
  `pnpm install` + one `pnpm --filter @joy-media/worker build` for both its
  internal passes. Under the 2× rule that install+build happened twice on the
  Windows runner; now once.
- **`prod-build-smoke` — a NEW _required_ lane with no pass matrix.** It runs
  `pnpm build` + `vite preview` + 4 specs **exactly once per gate**. Under the
  old rule the equivalent coverage (such as it was) got the 2× workflow repeat;
  now it is single-execution. Either give it `pass: [1,2]` or accept it as
  deliberately single-pass — this doc does not hide that it is single.
- **`validate-candidate`, `gate-summary`** — likewise single per gate (they were
  always cheap; noted for completeness).
- **Dispatch-path / transient flake** — `retries: 1` in `playwright.config.ts`
  and the bounded-retry teardowns absorb _some_ transient flake within a pass.

## The offered fallback — and its current status

The "one automatic re-dispatch on infra-only failure" mentioned earlier **does
not exist in `release-candidate-v2.yml`**. There is no retry, no re-dispatch, and
no infra-vs-product failure classification — `evaluateGateSummary` treats every
non-`success` identically and cannot tell an infra flake from a product failure.
Given the docs' own recorded journey-flake observation (`open-items` §9.1), an
automatic "re-dispatch on infra failure" would in practice be a human deciding a
red run was "infra" — which is the rerun-to-green pressure this change disclaims.

**So the honest position is:** a red `release-candidate-v2` run is re-dispatched
**only at owner discretion, with the reason recorded**, exactly as a red
`release-candidate.yml` run is today. No automatic retry is claimed or built. If
the reviewer judges the runner-drift / store-integrity margin worth keeping, the
options are (a) implement a real infra-failure taxonomy + one auto re-dispatch,
(b) keep a _periodic_ (not per-candidate) whole-workflow run on `main` HEAD as a
drift canary, or (c) keep the 2× rule. This doc recommends **(b)** as the
lowest-cost way to keep drift visible without doubling every candidate's gate.

## The effects soak stays at one-per-pass

Per the owner: retain one 30-minute effects soak in **each** of the two isolated
passes (2 per gate, down from 4). Any reduction to one soak per **gate** is a
**separate** proposal and is **not** made here.

## Contract artifacts to update once accepted (not before)

| Artifact                                                   | Change                                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `docs/reviews/joy-live-director-r2-acceptance-bundle-*.md` | gate line: "2× green `release-candidate.yml`" → "1× green `release-candidate-v2.yml` (2 isolated passes)" |
| `docs/reviews/joy-live-director-r2-deploy-runbook-*.md`    | C-block referencing the CI runs                                                                           |
| `docs/reviews/joy-live-director-r2-resume-handoff-*.md`    | the gate description                                                                                      |
| memory `joy-media-live-director-state`                     | the gate description                                                                                      |
| `tooling/release/src/gate.ts`                              | **no change** — it is already per-pass; add a comment noting the workflow provides the 2-pass repeat      |
| `.github/workflows/release-candidate.yml`                  | retire after v2 is accepted and has one green run on a real candidate                                     |

## Evidence supplied to the reviewer

- `docs/reviews/joy-media-ci-baseline-2026-09-08.md` — topology + first timings.
- `docs/reviews/joy-media-ci-benchmarks-2026-09-08.md` — measured numbers, prod-build parity result, Windows fix root cause.
- `docs/reviews/joy-media-ci-coverage-matrix-2026-09-08.md` — every removed execution mapped to retained coverage.
- This document.
- The part-9 verification results (one fixture job, one real-service job, two-job isolation, interrupted-run cleanup, before/after timing on the same candidate) — appended when complete.

**Never self-approve changes to acceptance gates.**
