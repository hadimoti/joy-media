# JOY Media Agentic Editing — Next-Agent Handoff

Date: 2026-07-26
Local machine: Hadi's Windows PC
Authoritative local checkout: `C:\Users\HadiMoti\joy-media`
Branch: `ui/adobe-polish` tracking `vps/fix/final-ui-polish`
Required starting commit: `bc771e4` or newer on the tracked branch

## Read this first

The Sweden VPS was rebuilt from scratch on 2026-07-26 after a compromise.
Historic server credentials, host keys, IP addresses, snapshots, and the old
private key are revoked. Do not reuse, restore, copy from, or reconnect to the
old box. Do not bring old VPS binaries, services, shell profiles, or system
backups into the rebuilt host.

Use only the rebuilt host details below. The private key itself must never be
copied into the repository, logs, prompts, or VPS.

```sshconfig
Host sweden sweden-vps
    HostName            82.115.8.224
    User                root
    IdentityFile        ~/.ssh/Joy-Vps-New.pem
    Port                22
    IdentitiesOnly      yes
    ConnectTimeout      20
    ServerAliveInterval 30
```

Windows key path:

```text
C:\Users\HadiMoti\.ssh\Joy-Vps-New.pem
```

Normal connection:

```powershell
ssh sweden
```

Rebuilt-host identity observed on 2026-07-26:

```text
hostname: srv7454295263
ED25519: SHA256:TlAiMawQnTgnACXSwMvCq2UjcyeBXJLvQL6SMHhRrZo
RSA:     SHA256:w4W3qHqP6UXlfHPA4hotJWOrYT+dDv+07iDo5o/Mhmk
```

If the host fingerprint changes, stop. Do not accept a replacement until Hadi
has confirmed the rebuild or key rotation.

## Current production state

- Public editor: `https://media.joyteam.ir`
- Live commit: `342868fd5c27f216a2a392fc76d63f25ea7ed222`
- Live web symlink:
  `/opt/joy-media/web -> /opt/joy-media/web-releases/342868f-agent-envelope`
- Rollback release retained:
  `/opt/joy-media/web-releases/b735a90-icon-hash`
- VPS working checkout: `/opt/joy-media/repo`
- Bare Git remote: `/opt/joy-media.git`
- Local Git remote: `vps`, URL `sweden:/opt/joy-media.git`
- API service: `joy-media@api`
- API health: `http://127.0.0.1:8790/health`
- Nginx service: `nginx`

Production was verified after deployment:

1. Public HTML loads `assets/index-Dg7cpXSn.js`.
2. The public JS SHA-256 equals the local build:
   `bd77b016edf2a69d023395116de8a363b3fdd42012d38a843ba75c9cf61bd86d`.
3. `joy-media@api` and `nginx` are active.
4. Chrome showed no console errors.
5. The live Agent action produced:
   `Dry-run: 3 clip(s) modified`.
6. Execute changed Intro from 10.0s to 8.0s and rippled Product and Outro left
   by 2.0s.
7. One `Undo this run` restored all three clips to their exact original
   positions.

An already-open browser tab may retain the prior `index.html`. Reload normally,
or use `https://media.joyteam.ir/?deploy=342868f` once to force a fresh HTML
request. The asset name is content-hashed.

## What is complete

Commit `342868f` proves the “shorten the intro” vertical slice end-to-end:

```text
query
  -> plan
  -> dry-run change set
  -> approval
  -> atomic transaction
  -> verification
  -> one-step undo
```

Implemented:

- Minimum agent command envelope:
  `schemaVersion`, `commandId`, `projectId`, `baseRevision`, `actor`,
  `transactionId`, `idempotencyKey`, and `preconditions`.
- `runPlanAtomically`, which stages all steps and commits only after every step
  succeeds.
- All-or-nothing failure behavior.
- Revision conflict rejection before commit.
- One history/undo entry for a multi-step run.
- The real ripple-edit recipe, “Shorten the intro by 2s”.
- Agent Panel integration through the atomic runner.
- ADR-0019 with the decisions and deliberately deferred gaps.

Two live bugs were fixed by this slice:

1. Multi-step agent plans previously created multiple undo entries, while the
   panel only issued one undo.
2. Agent commands previously reached the timeline without actor or revision
   metadata.

Validation already recorded:

- New tests: 22.
- Prior full suite: 1,300 tests.
- Current focused rerun: 41/41 passed
  (`shorten-intro.test.ts` plus `commands.test.ts`).
- Current `pnpm typecheck`: clean.
- Current editor build: clean, with only the existing large-chunk warning.

Read before editing:

- `ORCHESTRATION.md`
- the top handoff in `STATE.md`
- `docs/adr/0019-agent-command-envelope-and-atomic-runs.md`
- ADR-0002, ADR-0003, and ADR-0012
- `plan/P06-agent.md`
- `plan/WP-15-agent-editor-integration.md`

## Mission

Finish the agentic editing architecture without building a second editor,
letting agents manipulate the DOM, or widening into every provider at once.

The invariant is:

> JOY Media is the editor. Humans, agents, plugins, and automation are clients
> of the same semantic editing engine.

Every meaningful project mutation must be a structured domain command. UI-only
interactions such as hover, menu state, and panel resizing are not project
commands.

## Ordered remaining work

Complete one bounded milestone at a time. Keep each milestone independently
testable and commit it before starting the next.

### Milestone A — Durable revision and command contract — complete locally

Implemented after this handoff was created:

- `EditorSession.projectRevisionId` composes the verified durable timeline and
  document revisions into one opaque ADR-0012-compatible ID.
- The revision survives reload and advances for either project slice.
- The Agent panel captures the revision and immutable project snapshot when it
  creates the plan.
- An intervening human/agent edit rejects the stale plan; a fresh replan works.
- Project-scoped atomic-run idempotency receipts survive reload.
- Retrying the same completed logical plan is a successful no-op.
- A failed stage leaves project bytes and durable revision unchanged.
- A session reopened from durable state executes the three-command plan as one
  undo step.

Validation: 35/35 focused tests pass; typecheck and editor build pass. The full
suite reports 1,307 passing and two unrelated environment failures because this
PC lacks `faster_whisper` and `/opt/joy-media/data/rnnoise/cb.rnnn`. Lint
remains at the pre-existing 51 errors.

The original requirements remain below as the contract/evidence checklist.

Replace the Agent Panel's session-history cursor approximation with the durable
project revision/conflict model already present in `collaboration-core`.

Requirements:

1. Identify the canonical durable revision source used by persisted projects.
2. Carry that revision through query snapshot -> plan -> envelope -> atomic
   pre-commit check.
3. Preserve the revision across save/reload.
4. Reject execution after an intervening human or agent edit.
5. Keep human editing behavior and ADR-0003 undo semantics unchanged.
6. Do not move the entire core command bus into the envelope unless the tests
   prove that expansion is required. Record any required boundary change in a
   new ADR or an explicit ADR-0019 amendment.
7. Add tests for save/reload, stale-plan rejection, retry/replan, idempotency,
   and one-step undo after reload.

Exit gate:

- A plan created at revision N cannot commit at N+1.
- Revision identity survives project reload.
- The same idempotency key cannot apply the transaction twice.
- Failed or stale runs leave the project byte-for-byte unchanged.

### Milestone B — Fine-grained policy and four execution modes — complete locally

Replace coarse `ToolScope` booleans with explicit capabilities:

```text
timeline.read
timeline.write
assets.read
assets.import
filesystem.read
filesystem.write
provider.generate
provider.spend
render.preview
export.write
project.overwrite
plugin.invoke
```

Implement these modes:

1. Suggest Only
2. Preview and Approve — default
3. Auto-apply Low-Risk Changes
4. Full Auto Within Explicit Limits

Paid generation, external upload, overwrite, destructive file action, and
credential access require separate policy checks even in Full Auto. Raw API
keys must never reach browser code, project files, agents, plugins, or logs.

Implemented:

- `ToolScope.capabilities` contains the 12 explicit capabilities above; the
  coarse affected-area booleans are gone.
- All four modes exist in the Agent panel, with Preview and Approve selected by
  default.
- Suggest Only previews but cannot execute. Low-Risk auto-applies only local,
  reversible timeline edits. Full Auto still gates external egress, spend,
  filesystem writes, export, overwrite, plugins, and destructive operations.
- Credential-like tools fail closed.
- `requires-manual` no longer executes implicitly. The atomic runner requires
  a trusted-UI grant bound to the exact `planId`.

Validation: 115/115 focused tests pass. Full suite: 1,325 pass plus the same two
local environment failures (missing `faster_whisper` and RNNoise model).
Typecheck and editor build pass; lint remains at the pre-existing 51 errors.
The live localhost UI was checked in all three relevant states (manual,
non-executable suggestion, and low-risk auto approval). Production is not
updated.

### Milestone C — KiloCode/model/provider taxonomy — next

Model these as distinct concepts:

- Agent host/adapter: **KiloCode only**, through its extension in the VPS
  code-server/VS Code-fork UI (ADR-0020).
- Reasoning model: GPT, Claude, Gemini, local model.
- Media provider: image, video, speech, audio, transcription.
- Local execution: JOY Windows Worker, ComfyUI, FFmpeg.

Define an adapter capability manifest for supported tools, models, health,
cancellation, cost reporting, and settings. Reuse `provider-sdk`; do not create
a parallel provider framework.

Do not implement Hermes or a native JOY Agent editing adapter. Hermes is
reserved for VPN diagnostics and user-support work. The existing KiloCode API
credential is a live server secret: do not read, print, copy, commit, or send
its raw value. Resolve it only through a protected server-side secret reference
when deployment of the adapter is explicitly authorized.

### Milestone D — Async jobs and generation provenance

Connect `AgentEditPlan` job steps to the existing `job-protocol` and Worker
path:

```text
start -> progress -> cancel/retry -> result/fail -> project transaction
```

Heavy operations must not run inside the synchronous atomic command staging
loop. Commit the returned asset/reference only after the job succeeds and the
project revision is still valid.

Persist generation provenance:

- provider and model
- model version
- prompt
- seed when available
- input asset hashes
- parameters
- generated asset ID
- cost
- creation time

Command execution must be deterministic and replayable. Generation may be
nondeterministic; provenance is the reproducibility contract. Undo may remove
the generated asset from the project but cannot refund spent credits.

### Milestone E — Agent menu and settings UI

Only start this after Milestones A-D have stable contracts.

Add `Agent` beside `File · Edit · Clip · View · Window`. The menu is an entry
point, not a giant dropdown:

- Open Agent Panel
- New Task
- Active Agent
- Execution Mode
- Pause/Stop Task
- Agent Activity
- Agent Settings…

The settings surface owns Agents, Models, Media Providers, Permissions,
Budgets, Privacy, secrets references, and Local Worker configuration.

Keep the workspace Agent panel minimal:

- conversation and composer
- project-context chips/references
- plan/current step
- proposed change cards and before/after preview
- running state, stop, retry, resume
- apply, reject, revert
- cost estimate
- compact activity history

Do not put provider/API/model configuration into the creative workspace.

### Milestone F — JOY Dual-Lens Editing

This is the product-differentiating follow-on from the recovered planning
conversation. Start only after the agent transaction foundation above is real.

Build two synchronized views over one Creative Document:

- **Time View:** familiar Premiere/After Effects timeline.
- **Flow View:** composable graph for media, data, models, agents, and outputs.
- **Split View:** both views synchronized.
- **Frame-to-Flow Trace:** moving the playhead highlights the chain that
  produced the current picture and sound.

Treat text, audio, captions, script, prompts, model outputs, and agent change
sets as data lanes on the shared timeline. Keep advanced data lanes collapsed
by default so professional Adobe users see a familiar editor first.

Graph and timeline must never become separate project engines. They are two
projections of the same Creative Document. Specialized agents propose change
sets; only a validated transaction mutates the project.

Product line:

> Edit in time. Understand in flow.

## Engineering guardrails

- Agent code never clicks the UI or manipulates the DOM.
- Use stable IDs and asset IDs, never local/VPS filesystem paths in project
  commands.
- Queries are read-only; commands mutate; jobs are asynchronous.
- Preview/dry-run must not mutate the real project.
- No partial commit after a failed plan.
- No fake provider/job success.
- Do not reopen the microseconds/timebase decision; ADR-0002 governs it.
- Keep the existing unrelated untracked local files untouched.
- Do not deploy from an uncommitted or dirty product change.
- Do not restore anything from the compromised server.

## Local workflow

```powershell
Set-Location C:\Users\HadiMoti\joy-media
git status --short --branch
git log -1 --oneline
pnpm typecheck
pnpm test
pnpm --filter @joy-media/editor-web build
```

There are pre-existing unrelated untracked files in the checkout. Do not add,
delete, or modify them:

```text
EFFECTS_LAYOUT_BEFORE_AFTER.md
debug-env.js
fetch-patch.cjs
run-worker.bat
worker_output.txt
```

Stage explicit paths only; never use a blind `git add .` or `git add -A`.

## VPS build/deploy notes

Work locally first. Connect to the VPS for read-only inspection or an explicitly
requested deployment. The server's non-interactive SSH `PATH` does not contain
`pnpm`; use:

```text
/usr/local/lib/node_modules/corepack/shims/pnpm
```

A clean server checkout must build workspace packages before Vite:

```bash
cd /opt/joy-media/repo
CI=true npm_config_confirm_modules_purge=false \
  /usr/local/lib/node_modules/corepack/shims/pnpm install --frozen-lockfile
/usr/local/lib/node_modules/corepack/shims/pnpm typecheck
/usr/local/lib/node_modules/corepack/shims/pnpm \
  --filter @joy-media/editor-web build
```

Deploy web builds as a new immutable directory under
`/opt/joy-media/web-releases/`, verify it, then atomically flip
`/opt/joy-media/web`. Never overwrite an existing release directory. Retain the
previous symlink target for rollback.

API changes use immutable releases under `/opt/joy-media/releases/` and require
health verification before and after switching. Do not restart or redeploy the
API for a web-only change.

Minimum post-deploy smoke:

```bash
readlink -f /opt/joy-media/web
systemctl is-active nginx joy-media@api
curl -fsS http://127.0.0.1:8790/health
curl -fsS -H 'Host: media.joyteam.ir' http://127.0.0.1/ | \
  grep -oE 'assets/index-[A-Za-z0-9_-]+\.(js|css)'
```

Then test the public Agent vertical slice and one-step undo in Chrome.

## Prompt for the next coding session

```text
Continue JOY Media from the tracked branch tip after Milestone B on
C:\Users\HadiMoti\joy-media.

Read AGENTIC_EDITING_NEXT_AGENT.md, ORCHESTRATION.md, the current STATE.md
handoff, ADR-0020, ADR-0019, ADR-0012, ADR-0003, P06, and WP-15 before
editing.

Implement only Milestone C: model KiloCode as the sole editing-agent host,
separate from reasoning models, media providers, and local execution. Define
its adapter capability manifest for tools, models, health, cancellation, cost
reporting, and settings. Reuse provider-sdk. Do not build Hermes or a native
JOY Agent editing adapter. Do not read or copy the live KiloCode API value from
Hermes's .env; define only a protected server-side secret reference. Add
focused contract tests, run typecheck/full suite/editor build, and amend the
handoff. Do not start async jobs, Agent menu/settings, or Dual-Lens UI. Do not
deploy unless Hadi explicitly asks.
```
