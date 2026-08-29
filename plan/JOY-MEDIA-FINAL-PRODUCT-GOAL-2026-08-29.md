# Copy-paste `/goal` prompt — JOY Media final product

Use the following text as the goal prompt:

---

Finish JOY Media completely according to
`plan/JOY-MEDIA-FINAL-PRODUCT-CLOSURE-2026-08-29.md`. This is an implementation goal, not another
planning or reporting task. Continue until every release gate in that plan is satisfied, all work
is committed to `main`, pushed to remote `github` (`https://github.com/hadimoti/joy-media.git`)
and remote `vps` (`sweden:/opt/joy-media.git`), deployed through `/opt/joy-media/repo` as one
immutable production release, tested live, and recorded in Gbrain. Work only in the standalone
`C:\Users\HadiMoti\joy-media` repository and its JOY Media runtime; do not modify
`C:\Users\HadiMoti\joy-vps`, `/opt/joy-vps`, or any legacy `joy-vps/joy-media` pointer path.

Start by reading `AGENTS.md`, `DESIGN.md`, this goal file, the closure plan, the current `STATE.md`,
`C:\Users\HadiMoti\Desktop\VPS-AGENT-BRIEF.md`, and the authoritative Gbrain page
`joy-vps-agent-brief` as the operational input map. Read existing JOY Media completion evidence
from `ops/joy-media-worker-6a77940-2026-08-29` and write final release evidence back to that page
or its explicitly linked successor—not to the input brief alone. Preserve existing work. Verify
the branch, clean/dirty state, remotes, current production identity, Worker state, migrations, and
retained release evidence before changing anything.

Use this standing agent topology:

- Orchestrator: Codex primary. Coordinate, integrate, decide, run all authenticated/local/staging/live browser journeys, promote, deploy, rollback, and own the final Gbrain record. It is the sole browser operator; use the Codex in-app browser by default. If OpenCLI is needed, profile `cefd9k77` remains orchestrator-only.
- Backend implementer: Kilo CLI free route (`kilo/kilo-auto/free`) for API, schema, sync, polling, Worker, delivery, and backend reliability fixes. No browser or profile access.
- Adversarial reviewer: Hermes CLI free route (`openrouter/free`) for security, failure modes, regression challenge, and release challenge. No browser or profile access.
- UI implementer: Codex in-app subagent, Luna, for UI state machines, performance, accessibility, and non-browser source/unit/integration interaction tests. No browser.
- Integration/release reviewer: Codex in-app subagent, GPT-5.4, for main reconciliation, tests, provenance, deployment review, and independent release verification. No browser.

If Kilo-free or Hermes-free is unavailable, continue with Codex subagents instead of waiting. Use
CodeRabbit to review every implementation wave and the final release diff.

Do not wait for my confirmation for routine choices, reversible edits, tests, commits, pushes,
deploy steps, health checks, or rollback rehearsal already authorized by this goal. Make the safest
reasonable decision from the closure plan and continue. Never bypass tool-required confirmations,
secret protections, destructive-data safeguards, external billing consent, or an action whose
target cannot be proven. Do not expose credentials, tokens, pairing codes, Worker state contents,
customer data, or secret paths in chat, logs, Git, screenshots, test artifacts, or Gbrain.

Execute the dependency waves in order:

1. Contain the cross-tenant private-object path, broken AI/Comfy job kinds, misleading/demo UI,
   and pairing-secret logging. Add failing regression tests first.
2. Fix tenant/project isolation, the real-project export failure, and the durable typed
   Worker/provider result/idempotency contract.
3. Fix real-Postgres rename, destructive scoping, job races/attempts, session revocation,
   integrity/cleanup, pagination, error mapping, bounds, timeouts, readiness, and observability.
4. Reconcile and enforce `DESIGN.md`: English-only copy, desktop-only supported viewport matrix,
   token/font/icon/target-size/accent gates, panel registry/shell, dialogs/focus, loading/error/busy
   states, and authenticated accessibility. Fix the visible Creative Brief dock text fallback.
5. Complete every core UI journey: Project Library/import, Media, Text, Captions, Audio,
   Animate/Transitions/Effects/Filters/Color/Adjust, Inspector, Timeline, Monitor, Flow, History,
   Jobs, and export. Every visible action must work or be truthfully unavailable.
6. Complete the advanced product surfaces: real Workflows, persistent editable 3D, editable Motion
   Code, production Plugins, Creative Brief, Motion Studio, and Effect Studio. Temporary hiding is
   containment only, not the final answer.
7. Productize the Windows Worker: signed installer, DPAPI-backed renewable session, secret-safe
   rotated logs, headless logon start, crash/offline/update recovery, accurate capabilities,
   notification and approval assertion before local commands, limits, Windows CI, self-hosted CI,
   repair, uninstall, and rollback. The browser must show it connected after restart without
   manual help.
8. Run all source, real-service, hosted CI, self-hosted CI, Windows, security, accessibility,
   desktop viewport, authenticated browser, export, rollback, origin, and canary gates from the
   plan. Fix every failure and rerun.

The browser viewport matrix is 1024×768, 1280×800, 1440×900, and 1920×1080; phone view is out of
scope. Browser testing must include every top-level workspace and hub subtab, empty/populated/
inactive/loading/error/retry states, timeline editing/playback, every Effects category, GLB/GLTF
3D import-edit-reload-export, real Workflows, Worker recovery/capability state, real project import,
and successful export/download/playback. Do not accept a recovery screen, relevant console error,
failed same-origin request, clipped action, visible dock-label fallback, inaccessible dialog,
fixture success, dead CTA, or contradictory status.

Work in focused commits with tests and CodeRabbit review after each wave. Keep `main` clean and do
not overwrite unrelated owner edits. Deploy only a committed candidate that passes two consecutive
strict gates, including the required self-hosted CI lanes. Use immutable release directories,
validate Nginx, verify direct VPS origin before public routes, rehearse rollback and database
restore compatibility, then run the production browser matrix and at least a 30-minute monitored
canary. On any gate or canary failure, first stop promotion and disable the offending capability;
then follow the closure plan's schema-aware write-stop, code-pointer rollback, and verified-restore
procedure as applicable.

Do not mark this goal complete while any P0-P2 item or P3 evidence gap in the closure plan remains.
At the end, align local `main`, remote `github`, remote `vps`, deployment checkout
`/opt/joy-media/repo`, tree, lockfile, schema, web/API release, and signed Worker package; update
`STATE.md`, plans/ADRs/docs, and the authoritative Gbrain operational page without secrets. Update
`C:\Users\HadiMoti\Desktop\VPS-AGENT-BRIEF.md` if the non-secret operational map changed. Report
the exact commit/release/package identities, hosted and self-hosted CI results, test counts,
browser evidence, canary, rollback target, Gbrain commit, and clean worktree.

---
