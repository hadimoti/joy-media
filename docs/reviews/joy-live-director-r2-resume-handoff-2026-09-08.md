# JOY Live Director R2 ("Living Looks") — resume handoff

> **SUPERSEDED 2026-09-08 (later same day).** R2 was resumed and reshaped:
> the owner-delegated Opus taste review approved four packs and required fixes
> (`editorial-clean` `y`-sign, `kinetic-type` `phrase-2/3` treatment); the owner
> retired `persian-editorial` (English-only app) and `music-pulse` is held for
> R2.1. A **new candidate** was cut (the `93d1c082` triple below is stale). The
> current state of record is
> `docs/reviews/joy-live-director-r2-acceptance-bundle-2026-09-08.md` +
> `docs/reviews/joy-live-director-r2-look-scorecard-2026-09-08.md`. The 7-step
> plan below still describes the gate → CodeRabbit → Astra → owner go-ahead →
> deploy → closeout shape; only the candidate identity and pack count changed.

**Written 2026-09-08 ~07:40 UTC by session `joy-media-ef` (Sonnet).** The session
that was driving the R2 gate (`joy-media-ae` / `local_393b56e5…`) went idle at
**00:52 UTC — mid-run — and did not come back.** Gate run 1 finished green ~2.5h
after that with nobody watching. This document is the full brief to resume R2
from a fresh session.

---

## 0. TL;DR — where R2 is

- **R2 is code-complete.** Branch `codex/joy-live-director`, HEAD `ef9d540e`
  (1 docs-only commit past the candidate). Working tree clean.
- **R2 CANDIDATE = `93d1c082ef4f86e4caca00effef8a2082cfd5af0`**
  - tree `a92dce700411daef0366e09559eba18371c71afb`
  - lock `pnpm-lock.yaml` sha256 `36426937a41309d10cc85fd16a3fc4d42a74c1e234c4cfb77cdd838f8427b0b3` (**unchanged since R1 — R2 adds zero dependencies**)
  - base `855734cf` (R1, LIVE on joyst.ir since 2026-09-07) — confirmed ancestor
- **Gate run 1: `release-candidate.yml` run `34168068793` on `93d1c082` — GREEN, 20/20 jobs, `conclusion: success`** (finished 2026-09-08 03:21 UTC). Every lane: validate-candidate, linux-real-services ×2, windows-worker-clean (2 passes), acceptance 7 profiles ×2 (14/14), real-service-acceptance ×2.
- Local at HEAD: full `pnpm test` = **4211 passed / 38 skipped / 0 failed** (527 files); `tsc -b` + `eslint .` + `prettier --check` clean.
- **What is left** (steps 1–7 below): 2nd gate run ×2 → CodeRabbit round 3 → **owner taste verdicts on the 6 packs** → independent Opus "Astra" `APPROVE_FOR_DEPLOY` on `93d1c082` → **owner go-ahead** → guarded Sweden deploy → closeout.

The locked `/goal` still governs: finish R1→R2→R3, Claude-only, per the plan at
`C:\Users\HadiMoti\Desktop\joy-media-CLAUDE-agent-plan-2026-09-06.md`. **You never
self-approve. No OpenAI/Codex anywhere. Keep the BYOK browser engine. Fontiran
gate stays CLOSED. Don't touch the parallel joy-vps work. Never edit the pull-only
Desktop `gbrain` mirror.**

Check memory `joy-media-live-director-state` at session start — item 13 is the
live R2 status and may have moved past this doc.

---

## 1. Worktree / branch

| Thing     | Value                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worktree  | `C:\Users\HadiMoti\.config\superpowers\worktrees\joy-media\joy-live-director`                                                                       |
| Branch    | `codex/joy-live-director` (remote `github` = `https://github.com/hadimoti/joy-media.git`)                                                           |
| HEAD      | `ef9d540e` — `docs(r2): re-pin candidate to 93d1c082` (docs-only past the candidate)                                                                |
| Candidate | `93d1c082` — the SHA everything reviews/deploys against                                                                                             |
| **Never** | reset / clean / delete this worktree. WIP snapshot protected at `stash@{0}` + tag `wip-snapshot-2026-09-06` + branch `codex/joy-live-director-wip`. |

`git fetch github` first — another session may have pushed. If HEAD moved past
`ef9d540e` with only docs commits, the candidate is still `93d1c082`. If a
**source** file changed, you must cut a new candidate and re-run the gate from
step 1.

---

## 2. What R2 is (for the Astra bundle / your own orientation)

"Living Looks" = art-directed, deterministic Look packs an operator applies to a
composition through the **same bounded prepare → approve → atomic-commit → Undo
path** R1's agent edits and recipes use. **No new operation kinds, no model in
the apply path, no renderer in `motion-core`.**

- **L1** — `LookInstance` schema (`packages/project-schema/src/living-look.ts`),
  project schema **v3** additive over v2 (`v3.ts`, `lookInstances?`,
  `migrateV2ToV3`), write-guard `isLookBindingWritable`. Editor still reads
  `JoyProjectV1` (v2/v3 dual-lens dormant) → **no persisted-doc behaviour change**.
- **L2** — the pure compiler (`packages/motion-core/src/looks/`): a versioned,
  pinned `LookDefinition` with typed controls declaring exactly which binding
  targets they drive over a bounded range; `compileLook` → ordinary
  `motion.setKeyframe` + `*.setTemplate` operations, deterministic FNV-1a digest,
  never writes an overridden binding unless `resetBindingIds` names it, fails
  closed with zero operations. Editor adapter `look-operations.ts` (1:1 →
  JoyCode plan); `look-run-host.ts` `stageLookRun` → the **unchanged R1**
  `createJoyAgentProposalStagingHandler`. **KEY FIX (already in):**
  `contextProjectId = session.visualProject.id`, NOT `scope.projectId`.
- **L3** — six built-in packs as typed data
  (`packages/motion-core/src/looks/packs/`): editorial-clean, product-precision,
  kinetic-type, quiet-documentary, music-pulse, persian-editorial. Typography /
  palette via the **fixed** `TEXT_TEMPLATES` / `JOY_CAPTION_TEMPLATES`
  catalogues (Opus L3 ruling) — no new op kinds, no R1 re-review. "No fake
  slider" enforced mechanically.
- **L4** — audio-reactive baking (`audio-reactive.ts` +
  `apps/editor-web/src/joy-agent/look-audio-bridge.ts`): R1's
  `BeatEnvelopeEstimate` → bounded, editable `motion.setKeyframe` keyframes on
  one binding; hard key ceiling + reported approximation error; smoothing that
  can't overshoot the declared range; flat rest line for silence / confidence <
  0.15 (never an invented downbeat). `LookCompileInput.audioBakes` lets a baked
  track supersede the slider on its binding, like a hand-edit override.

### Documented scoped follow-ups (NOT defects — already in the acceptance bundle for Astra to note)

1. **L3 scope-downs** (Opus L3 ruling): product-precision does **not** reframe
   footage (timed emphasis on operator-bound objects); kinetic-type is
   **phrase-object-scoped**, not per-word; `text.insertTemplate` object creation
   for auto-placed callouts / per-word phrases is a compiler follow-up.
2. **L4 panel path.** Pure core + host bridge done & tested; feeding a decoded
   audio track's `audioBakes` from the panel into `runLook` (music-pulse) +
   `tests/e2e/living-looks-audio-motion.spec.ts` are the remaining wiring.
   **Recommendation in the bundle: ship music-pulse's audio path as an R2-first
   documented follow-up** (parallels R1's real-BYOK decision); slider-driven
   pulse is honest meanwhile.
3. **`LookInstance` persistence.** A Look currently commits its operations
   through the normal approve path (Undo works) but is not yet re-openable — the
   v1→v3 editor-document bridge (`project-package.ts` /
   `project-document-hydration.ts` still read `JoyProjectV1`) and
   `looks.prepareUpdate` are R2 follow-ups.
4. **L3b sample renders.** The numeric-tolerance harness landed as
   `packs-render-fidelity.test.ts` (12 tests). What remains is presentational
   only — a few sanitized sample renders for the scorecard's owner review. Not a
   pipeline gate.

---

## 3. Commit history since R1 (`855734cf`)

Read `git log --oneline 855734cf..HEAD` for the full list. The load-bearing ones:

| Commit                           | What                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `232b4d02` `3e728263`            | L1 — `LookInstance` schema, project schema v3 additive, `migrateV2ToV3`                                                                                                                                                                                                                                               |
| `98ed055b` `4d75201f` `02d23ac7` | L2 — pure compiler + validation + editor translation layer + the Opus L3-scope ruling applied (channel gating, "no fake slider")                                                                                                                                                                                      |
| `ab26160b`                       | L3 P0 — 3 RTL/Persian text templates on Vazirmatn (Fontiran gate stays closed)                                                                                                                                                                                                                                        |
| `beb55cad`                       | L3a — the six built-in packs + editor conformance tests                                                                                                                                                                                                                                                               |
| `0e5edc37`                       | L4 core — pure `bakeAudioReactive`                                                                                                                                                                                                                                                                                    |
| `af288212` `6ddedf2d` `261ad317` | L2 live wiring — `LivingLooksPanel.tsx`, AgentPanel "Looks" capability, `stageLookRun`, `agent-living-looks.spec.ts` e2e (green)                                                                                                                                                                                      |
| `5860f929`                       | L3b golden + the **flat-curve fix** (added `profile?` to drives + `settled?` to enum; all 6 packs re-authored with real rise/settle/pulse profiles)                                                                                                                                                                   |
| `3d2aa788`                       | **L4 host bridge** (`beatEnvelopeToLookEnvelope`, `bakeLookAudio`) + `LookCompileInput.audioBakes` compiler support                                                                                                                                                                                                   |
| `846ecc33` … `2bce3e6e`          | `.github/workflows/r2-candidate.yml` (GitHub-hosted gate) + fixes. **See §6 — this workflow's heavy lanes should be repointed at a CI-VPS or the workflow retired; do NOT dispatch it for R2 certification.**                                                                                                         |
| `56a26dd2`                       | PROVISIONAL creator scorecard `docs/reviews/joy-live-director-r2-look-scorecard-2026-09-08.md`                                                                                                                                                                                                                        |
| `6fc6109c`                       | L3b render-fidelity test `packs-render-fidelity.test.ts` (12)                                                                                                                                                                                                                                                         |
| `df0983d4` (+ prettier fixups)   | R2 guarded deploy runbook `docs/reviews/joy-live-director-r2-deploy-runbook-2026-09-08.md`                                                                                                                                                                                                                            |
| `c28a0d3e` `990a6c5b`            | drift the hosted `verify:ci` lane caught (prettier, dead eslint-disable directives, a comment that tripped the font-redistribution gate) + a flaky-test poll-budget widen                                                                                                                                             |
| `38dc2958` `7b8d351c`            | **CodeRabbit round 1** fixes (14 findings) — incl. quiet-documentary opacity bug (`Gentleness`→`Reveal` default 1), audio-reactive <2-sample reject, compile `audioBakes` dedup + rounded-time validation, LivingLooksPanel binding filter, AgentPanel `runLook` fail-closed, `text-align: start`, R1 doc corrections |
| `45e1c283` `7956dff3` `7cd1bdab` | acceptance-bundle updates + candidate pins                                                                                                                                                                                                                                                                            |
| `93d1c082`                       | **CodeRabbit round 2** fixes (4 findings) — kinetic-type real exit keyframe (`profile [0,1,1,0]`); R2 runbook C6 hard-fails under `set -e` (no `\|\| true` probe suppression), C5 health loop fails if unhealthy, C4 digest hashes path+content per file                                                              |
| `ef9d540e`                       | re-pin doc (docs-only)                                                                                                                                                                                                                                                                                                |

**CodeRabbit rounds 1 & 2 are both fully addressed in `93d1c082`.**

---

## 4. RESUME PLAN — do these in order

### Step 1 — dispatch gate run 2 (self-hosted `release-candidate.yml`, ×2 requirement)

The gate contract is **two full green `release-candidate.yml` runs on the exact
candidate**. Run 1 (`34168068793`) is green. Dispatch run 2 on the **same**
candidate `93d1c082`:

```bash
cd C:\Users\HadiMoti\.config\superpowers\worktrees\joy-media\joy-live-director
git fetch github --prune
# confirm candidate unchanged:
git rev-parse 93d1c082                       # 93d1c082ef4f86e4caca00effef8a2082cfd5af0
git rev-parse 93d1c082^{tree}                # a92dce700411daef0366e09559eba18371c71afb
git show 93d1c082:pnpm-lock.yaml | sha256sum # 36426937…8427b0b3
gh workflow run release-candidate.yml --repo hadimoti/joy-media \
  --ref codex/joy-live-director -f candidate_sha=93d1c082ef4f86e4caca00effef8a2082cfd5af0
gh run list --workflow=release-candidate.yml --repo hadimoti/joy-media --limit 2
```

- **Infra prerequisites (checked 2026-09-08 07:30 UTC — all up):** Docker Desktop
  - `joy-media-ci-linux` / `joy-media-ci-acceptance` / `joy-media-ci-minio` (healthy)
    / `joy-media-ci-postgres` (healthy) containers up 2 days; native Windows worker
    runner `Runner.Listener` PID 43840 running since 2026-09-06 (started via
    `C:\actions-runner-joy-media-worker\run-worker-ci.cmd` — sets
    `JOY_MEDIA_CI_WORKER_PROFILE=clean`, dies with the session, so if it's gone
    re-run that .cmd). The PC is a desktop (no battery), sleep/hibernate disabled
    on AC.
- Run ~4.5h. `real-service-acceptance` ×2 serialize on the acceptance runner
  (~80 min each). Monitor with a poll loop on `gh run view <id> --json status,jobs`
  (jq is NOT on PATH in non-interactive Bash — use `gh --jq`).
- **Gotchas from earlier runs (all already fixed in the harness, listed so you
  recognise them):** the 7 pre-existing acceptance/real-service failures fixed in
  R1 (`080bb9b5`, `f1daf140`, `b634d3cd`, `f7615432`); the async-finalize flake
  in `resumable-original-upload.test.ts` (poll budget widened).

Do **NOT** use `.github/workflows/r2-candidate.yml` (GitHub-hosted) for R2
certification — see §6.

### Step 2 — CodeRabbit round 3 on `93d1c082`

```bash
cd <worktree>
coderabbit review --committed --base-commit 855734cf0c875101a632426983db2638c2adddcd --agent
```

- CLI `coderabbit` / `cr` v0.7.5 on PATH; `coderabbit auth status` shows
  `hadimoti` signed in. The review **service WebSocket drops mid-review**
  sometimes (recoverable — just retry). Runs ~20-40 min; run it in the
  background.
- Round 1 = 14 findings, round 2 = 4, both fully fixed. Round 3 target: **clean,
  or only trivially-addressable findings**. Fix valid ones, re-run to confirm,
  and if a source file changes → new candidate → back to Step 1.
- Parse the `--agent` JSONL: `type:"finding"` lines carry `severity`,
  `fileName`, `codegenInstructions`.

### Step 3 — OWNER taste verdicts on the 6 packs (owner action; you cannot self-certify)

Per the Opus L3 ruling, the creator taste study + Persian-script idiom review are
**owner-gated**. The scorecard
`docs/reviews/joy-live-director-r2-look-scorecard-2026-09-08.md` has a table at
the bottom — every pack currently reads `OWNER_TASTE_REVIEW: PENDING`:

| Pack              | Verdict                                 |
| ----------------- | --------------------------------------- |
| editorial-clean   | PENDING                                 |
| product-precision | PENDING                                 |
| kinetic-type      | PENDING                                 |
| quiet-documentary | PENDING                                 |
| music-pulse       | PENDING                                 |
| persian-editorial | PENDING (+ Persian-script idiom review) |

**Ask the owner for `APPROVED` / `CHANGES_REQUESTED` / `REJECTED` per pack**, plus
a date and notes, and record them in that table. R2 does **not** ship a pack whose
line still reads `PENDING` — the owner may also make an explicit
"ship-with-N-packs, hold the rest for R2.1" decision, recorded the same way.
Offer to generate a few sanitized sample renders (L3b tail) if that helps their
review. If the owner wants changes to a pack, that's a source change → new
candidate → Step 1.

### Step 4 — independent Opus "Astra" review on `93d1c082`

Spawn a **fresh independent Claude Opus** agent ("Astra") with ONLY the release
bundle. The implementing session never self-approves.

- Bundle: `docs/reviews/joy-live-director-r2-acceptance-bundle-2026-09-08.md`
  (fill in the candidate triple + both gate run ids + CodeRabbit round-3 result
  - the owner taste verdicts before handing it over).
- Astra output contract: `APPROVE_FOR_DEPLOY <commit-sha> <tree-sha> <lock-sha256>`
  on the exact triple, or `CHANGES_REQUIRED` with specific blockers. (R1's Astra
  gave two rounds — expect the same discipline.)
- Astra should independently: open every cited file, run `pnpm test` (or a
  scoped subset), confirm the two CI runs check out `CANDIDATE_SHA`, and
  pressure-test the honesty/safety claims in the bundle (same trusted path,
  deterministic + bounded, no fake controls, operator edits win, audio never
  invents, fonts).
- Record Astra's verdict in the bundle's own "Astra" section (R1 bundle has the
  pattern).

### Step 5 — OWNER go-ahead (owner action)

Owner instruction 2026-09-06 ("use opus review and confirmations not me") means
Astra's `APPROVE_FOR_DEPLOY` is the review authority — but **a live production
deploy to joyst.ir is still a genuine human-in-the-loop moment.** Surface the
exact candidate + the deploy runbook + Astra's approval, and get the owner's
explicit "deploy R2" in chat before touching the VPS.

### Step 6 — guarded Sweden deploy

Follow `docs/reviews/joy-live-director-r2-deploy-runbook-2026-09-08.md` exactly.
Fill the candidate table (`PENDING` → the triple). Key facts (verified at branch
tip):

- **Web-bundle-only, cleaner than R1.** No Postgres migration (`POSTGRES_MIGRATIONS`
  byte-identical at `855734cf` and `93d1c082` — schema stays `5`); no `apps/api`
  runtime change (only a test-file poll-budget widen); **zero `pnpm-lock.yaml` /
  `package.json` delta** (R1 added `mediabunny`; R2 adds nothing); no `deploy/`
  change; no nginx change (joyst.ir served from the **shared**
  `/etc/nginx/conf.d/joy-wg-bot.conf` `root /opt/joy-media/web` — do NOT edit,
  the symlink swap is transparent).
- VPS: repo `/opt/joy-media/repo`, build worktree base
  `/opt/joy-media/builds/joy-media-<sha>`, web releases
  `/opt/joy-media/web-releases/*` + `/opt/joy-media/web` symlink, API releases
  `/opt/joy-media/releases/*` + `current-api`, env `/etc/joy-media/api.env`
  (merge only `JOY_MEDIA_RELEASE_*` via
  `deploy/joy-media-release-identity.sh merge`), unit `joy-media@api`, API origin
  `http://127.0.0.1:8790` `/live` `/ready`, public `/api/health`. `pnpm` on PATH
  (11.15.0). Build = root `CI=true pnpm build`. DB dump =
  `sudo -u postgres pg_dump --format=custom joymedia` (app role lacks LOCK).
  Origin check: `curl -k --noproxy '*' --resolve joyst.ir:443:127.0.0.1 https://joyst.ir/...`.
- The owner runs each VPS block in their `root@82.115.8.224` session and pastes
  output back; you verify every value against the candidate triple and call
  go/no-go at each checkpoint. Nothing is irreversible before C5 (the symlink
  switch). Rollback = `deploy/joy-media-rollback.sh --apply <good-api> <good-web>`
  or, for a web-only move, a one-line `ln -sfn` + `systemctl reload nginx`.
- **Production smoke** (Browser pane, owner logged in to joyst.ir — re-verify
  `GET /api/v1/auth/session` via the UI first; auth is a bearer token so test
  via the UI not raw fetch; disposable project only, trash it after; never the
  owner's real API key / browser media for paid calls): new project → Joy Code →
  **Looks** capability → six packs render with honest availability → bind a
  headline → run **Editorial Clean** → staged proposal
  (`data-agent-preview-ready="true"`) → **Approve** → keyframes on the object →
  one **Undo** restores → **Reject** path leaves the canonical project unchanged
  → reload is stable → served build identity matches the candidate.

### Step 7 — closeout (orchestrator only)

- Write the redacted R2 release result to **live VPS Gbrain**
  (`ops/joy-media-live-director-r2-deploy-2026-09-XX`), read it back. Gbrain via
  the HTTP MCP at `http://10.250.99.1:3131/mcp` (bearer in
  `/etc/joy-studio/gbrain-mcp.env` — SENSITIVE, never reproduce); the `gbrain`
  CLI's PGLite is locked by `gbrain serve`, so use the MCP. Tools: `put_page`
  (slug `ops/<topic>-YYYY-MM-DD`), `get_page`, `add_timeline_entry` (needs
  `slug` + `date` YYYY-MM-DD + `summary`).
- `Invoke-VpsGbrainExport.ps1` with **NO arguments**
  (`C:\Users\HadiMoti\Desktop\gbrain-pc\scripts\`); record the verified export
  SHA in a redacted `gbrain-pc` receipt; `Publish-PcReceipt.ps1 -ReceiptPath receipts/<name>.md`.
- Fresh-read + append the validated R2 release + limitations to Desktop
  `VPS-AGENT-BRIEF.md` (candidate/artifact identity, scope, tests, rollback, the
  4 documented follow-ups, next milestone = **R3 "Linked Versions"**); preserve
  concurrent `joy-vps` edits; no secrets.
- Update branch `STATE.md` with an "R2 deployment" section.
- **Never** edit / push the pull-only Desktop `gbrain` mirror.
- Update memory `joy-media-live-director-state`.

Then **R3 "Linked Versions" (C1–C4)** begins — plan at
`docs/superpowers/plans/2026-09-05-joy-live-director-r2-r3.md`.

---

## 5. Verification toolchain reference

- **Release gate:** CodeRabbit clean + **2× green self-hosted `release-candidate.yml`
  on the exact candidate** + independent Opus "Astra" `APPROVE_FOR_DEPLOY` +
  owner taste verdicts + owner go-ahead. The self-hosted `release-candidate.yml`
  is the KNOWN-GOOD instrument (R1 shipped through it, run `34123884446` 20/20).
- Self-hosted runners: `joy-media-ci-linux` + `joy-media-ci-acceptance` = Docker
  containers (auto-start with Docker Desktop) + `joy-media-ci-minio` +
  `joy-media-ci-postgres`. `joy-media-ci-worker` = native Windows runner at
  `C:\actions-runner-joy-media-worker\`, **not a service** — start per session
  with `run-worker-ci.cmd`. The `joy-vps-ci` / `joy-vps-smoke` services are the
  OTHER agent's — leave alone.
- `coderabbit` CLI v0.7.5. Full `pnpm test` ~45s collect + ~90s run. `pnpm run
verify:ci` = `check` (`typecheck && lint && format:check && test`) + `build` +
  `audit:prod`.

---

## 6. The CI / billing situation (Opus 5 ruling — for R3 / steady state)

An **independent Opus 5** ruled the CI topology (the owner delegated it:
"please ask Opus5 to make the choice"). **DECISION: permanent hybrid split by
machine class.**

- **GitHub-hosted:** `ci.yml` push CI, `validate`, `verify` ×2, `worker-package`
  ×2 (on `windows-latest`). Cheap (~25 billed min/gate + a few per push), always
  needed, PC-independent, and retires the fragile hand-started native Windows
  runner.
- **A dedicated CI VPS** (4 vCPU / 8–16 GB, Docker, **SEPARATE from the
  production Sweden VPS**, ~€7–15/mo flat): `acceptance` ×14 +
  `real-service-acceptance` ×2. Heavy, rare, zero marginal cost. The harness is
  already containerized (`ops/self-hosted/linux-runner/` `Dockerfile` /
  `entrypoint.sh` / `real-service-acceptance.sh` / env
  `JOY_MEDIA_CI_DATABASE_URL` / `JOY_MEDIA_CI_S3_*` / `JOY_MEDIA_CI_RELEASE_COMMAND`
  / `JOY_MEDIA_CI_REAL_ACCEPTANCE_COMMAND`) — a redeploy, not a rewrite.
- **`.github/workflows/r2-candidate.yml`** was built to run the whole gate
  GitHub-hosted. It PROVED the cheap lanes work hosted (run `34165045011`:
  `verify` ×2 + `worker-package` ×2 green), but **all 14 acceptance jobs were
  rejected before starting: "recent account payments have failed or your
  spending limit needs to be increased."** The account is at ~zero included
  Actions minutes / has a failed payment. Do NOT dispatch `r2-candidate.yml` for
  certification; per the Opus decision its heavy lanes should be repointed at the
  CI-VPS runner labels, or the workflow retired, so nobody drains the allowance.

### OWNER checklist (Opus)

1. **Fix the GitHub payment method** — blocks even the cheap hosted lanes AND
   `ci.yml` push CI (which is currently self-hosted Windows, so daily dev is also
   hostage to the PC).
2. Set an Actions spending limit ~$10–20/mo — a safety valve, NOT a budget.
3. Provision one CI VPS separate from production; hand Claude the host to port
   the runner containers + Postgres + MinIO + harness env.
4. (R2 gate does NOT need any of this — it runs on the existing self-hosted
   `release-candidate.yml`.)

---

## 7. Constraints (verbatim from the locked goal — do not violate)

- **You never self-approve.** No OpenAI / Codex anywhere in the toolchain.
- Keep the **BYOK browser engine** (no KiloCode / local-model / rewrite).
- **Fontiran gate stays CLOSED.** (Vazirmatn is Fontsource OFL and bundled;
  `tooling/release/src/font-assets.test.ts` scans runtime source for
  retired-foundry markers — don't spell the retired foundry name in code/comments.)
- **Don't touch the parallel `joy-vps` work** (its own agent's domain — VPS /
  WireGuard / Telegram infra, its own CI services).
- **Never edit / push the pull-only Desktop `gbrain` mirror.** Only the
  orchestrator writes a redacted result to live VPS Gbrain, reads it back, runs
  `Invoke-VpsGbrainExport.ps1` with **no arguments**.
- No deploy / service-restart / pipeline without Astra approval + owner go-ahead.
- Never reset / clean / delete the `joy-live-director` worktree.
- Treat credentials / env files / tokens / SSH keys as sensitive — never print,
  copy, summarize, commit, or store in chat / Git / Gbrain.

---

## 8. Coordination note

Two forked sessions worked R2. `local_393b56e5` (`joy-media-ae`) was the one the
owner was actively driving; it committed through `93d1c082` / `ef9d540e`, ran the
PC health check, dispatched gate run 1 (`34168068793`), then **went idle at
00:52 UTC and did not return.** `local_005a1e99` was the earlier primary fork.
`joy-media-ef` (this session, writer of this doc) did the CodeRabbit-round-1/2
code fixes and the L3b render-fidelity test + R2 deploy runbook, then stood down
from the branch per the coordination, and has been the only session tracking the
gate since.

If you resume from a fresh session: `git fetch` first, verify the candidate
triple, and check `list_sessions` — if `joy-media-ae` is running again,
coordinate before both of you drive the gate.

---

## 9. Key file paths

| Path                                                                                 | What                                                                        |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `docs/reviews/joy-live-director-r2-acceptance-bundle-2026-09-08.md`                  | the Astra bundle (fill candidate triple + CI + CodeRabbit + taste verdicts) |
| `docs/reviews/joy-live-director-r2-look-scorecard-2026-09-08.md`                     | per-pack scorecard + the OWNER taste-verdict table                          |
| `docs/reviews/joy-live-director-r2-deploy-runbook-2026-09-08.md`                     | the guarded Sweden deploy procedure                                         |
| `docs/reviews/joy-live-director-r1-*`                                                | R1 precedent (bundle / runbook / deploy record)                             |
| `docs/superpowers/plans/2026-09-05-joy-live-director-r2-r3.md`                       | R2 + R3 plan                                                                |
| `C:\Users\HadiMoti\Desktop\joy-media-CLAUDE-agent-plan-2026-09-06.md`                | the master plan (the locked goal)                                           |
| `packages/motion-core/src/looks/`                                                    | the pure L2/L3/L4 engine                                                    |
| `apps/editor-web/src/joy-agent/{look-operations,look-run-host,look-audio-bridge}.ts` | editor adapters                                                             |
| `apps/editor-web/src/LivingLooksPanel.tsx` + `AgentPanel.tsx` "Looks" capability     | the UI                                                                      |
| memory `joy-media-live-director-state`                                               | live status — read at session start                                         |

---

## 10. Gotchas

- `jq` is NOT on PATH in non-interactive Bash — use `gh ... --jq '...'`.
- `.test.tsx` needs a `// @vitest-environment jsdom` pragma + `createRoot`/`act`/
  `renderToStaticMarkup` (no `@testing-library`).
- React 19: no global `JSX` namespace — `import { type ReactElement }`.
- `git commit -m` with apostrophes breaks in this shell — use `git commit -F -`
  with a heredoc, or `-F /path/to/msg`.
- `workflow_dispatch` needs the workflow file on the default branch to be
  dispatchable — `release-candidate.yml` IS on `main`, so it dispatches fine
  from `codex/joy-live-director` via `--ref`.
- prettier occasionally re-wraps a checklist line with an inline-code span; run
  `prettier --write` on any doc you touch and `--check` before committing.
