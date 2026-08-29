# JOY Media Final-Product Closure Plan

- Status: **NO-GO — implementation required**
- Effective date: 2026-08-29
- Repository: `C:\Users\HadiMoti\joy-media` only
- Production: `https://joyst.ir/` and `https://www.joyst.ir/`
- Audited source baseline: `615c36ad7dadb3fadf502944022d6c442e8f5abb`

This is the authoritative closure plan for JOY Media. It supersedes product-readiness and
"nothing remaining" claims in `JOY-MEDIA-FINISH-PLAN-2026-08-28.md`; that document remains
historical evidence. It does not supersede verified deployment identity, rollback, canary, or
Worker-delivery evidence. The standalone `joy-media` repository is the only product source;
`joy-vps` and its legacy JOY Media pointer are out of scope.

## 1. Final outcome

Deliver JOY Media as a secure, durable, honest, desktop-class editing product whose visible
features work end to end. Close every confirmed P0-P2 defect below, add proof for every P3
evidence gap, commit all work to `main`, push the same commit to the `github` remote
(`https://github.com/hadimoti/joy-media.git`) and the `vps` remote (`sweden:/opt/joy-media.git`),
deploy that commit through the standalone JOY Media checkout at `/opt/joy-media/repo`, verify
production in the authenticated Codex browser, and record the non-secret release result in Gbrain.

"Complete" means all of the following:

- No cross-account or cross-project data access or deletion path exists.
- A real imported project can be opened, edited, reloaded, exported, downloaded, and reopened.
- Every advertised Worker/provider job either produces a durable typed result or cannot be
  enqueued or shown.
- Every visible control works, is truthfully disabled with a reason, or is absent. Demo, fixture,
  placeholder, dead, and misleading success surfaces are not present in production.
- The editor and login experience comply with the reconciled `DESIGN.md` contract at supported
  desktop sizes.
- The Windows Worker installs, starts headlessly at logon, renews securely, recovers after a
  crash or network interruption, and reports its real capability state consistently.
- Tests, security checks, real-service integration, Windows packaging, browser journeys,
  rollback rehearsal, and production canary all pass on one immutable commit.

## 2. Fixed owner decisions

These decisions remove the need to stop for product clarification during execution.

1. **Language:** the binding rule at `DESIGN.md:5-11` wins: shipped product copy is English-only.
   Remove the stale Persian requirements at `DESIGN.md:278-315` and the conflicting editor
   README claim. Imported/user-authored multilingual media and captions remain unchanged.
2. **Viewport:** phone editing is out of scope for this release. Supported desktop checkpoints
   are 1024×768, 1280×800, 1440×900, and 1920×1080. Compact desktop must collapse secondary
   tools into overflow or tabs; it must not squeeze panels into unusable columns.
3. **Information architecture:** distinguish real Dockview panels from tools nested inside the
   Create and Enhance hubs. Add a saved-layout migration so legacy IDs remain recoverable. View
   lists every top-level Dockview panel; hub tools remain reachable through stable hub tabs.
4. **Visual colors:** application chrome is neutral gray plus the scarce amber/status tokens.
   Authored media pixels and instrumentation such as RGB scopes may use explicit, documented
   data-visualization tokens; they may not leak into application chrome.
5. **Experimental functionality:** hiding a broken surface is permitted only as a temporary
   containment step. Final completion requires a real implementation for current product
   surfaces, or a deliberate removal from the product contract and navigation with no dangling
   claims. Demo-only Plugins, stub Workflows, read-only Motion Code, and flattened 3D must not
   masquerade as finished features.
6. **Standing agent topology:** the root Codex orchestrator owns integration, decisions,
   deployment, and all browser work. The Codex in-app browser is the default browser route.
   If OpenCLI is required, profile `cefd9k77` remains orchestrator-only. Subagents are limited
   to non-browser source, test, implementation, and review work as defined in section 11.
7. **Autonomy:** do not wait for routine implementation choices or reversible in-scope actions.
   Use the safest design consistent with this plan. Tool-mandated confirmations, secret access,
   destructive data changes, paid provider actions, or an irreducible product choice still
   require the applicable safety boundary.

## 3. Evidence at the baseline

What is already proven and should be preserved:

- GitHub `main` on remote `github`, the standalone JOY Media bare VPS remote `vps`
  (`/opt/joy-media.git`), the deployment checkout `/opt/joy-media/repo`, and the immutable
  web/API release were aligned to `615c36a` before this audit. This is distinct from the
  `joy-vps` repository and its runtime paths.
- The previous strict gates collected 3,606 tests (3,604 passed, 2 skipped), the editor production
  build passed, and a 30-minute real-services canary had zero route/identity failures.
- The headless Windows Scheduled Task is currently running and the production UI reports one
  connected Worker with GPU preview ready. Effects category switching no longer crashes.
- Authenticated browser checks successfully loaded a GLTF file in Joy Code 3D, selected every
  Inspector subtab, played/paused/searched the timeline, opened every workspace, and found no
  recovery screen.

What the old gate did not prove:

- Cross-tenant object authorization or cross-project destructive isolation.
- Real PostgreSQL SQL correctness for project rename and the destructive/race paths below.
- A successful export of the current real showcase project.
- A durable end-to-end result for the advertised AI/Comfy job kinds.
- A clean Windows install, signed package, session renewal, restart recovery, or secret-safe logs.
- Whole-application `DESIGN.md`, authenticated accessibility, desktop compact-window, loading,
  error, and dead-control compliance.

## 4. Release blockers

### P0 — containment and first implementation wave

| ID     | Confirmed defect                                                                                                                                            | Evidence                                                                                                                                                                        | Required result                                                                                                                                                                                                                                                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-01 | An authenticated user can register a known `private-object` reference and retrieve another tenant's object.                                                 | `apps/api/src/http-server.ts:2336-2430`, `apps/api/src/control-plane.ts:1973-1980`                                                                                              | Public registration accepts only local/cache descriptors. Cloud object refs are server-created after an ownership-verified upload. Cross-account read/write/delete tests pass.                                                                                                                                                                  |
| EXP-01 | The production showcase export fails after 15 seconds with `Export preload timed out while resolving source`; the error does not name the offending source. | Authenticated browser reproduction; `apps/editor-web/src/App.tsx:3500+`, `apps/editor-web/src/export-preload.ts:1-80`                                                           | Export preflight resolves every source or identifies the exact clip/asset and recovery action. The real showcase and an imported project export, download, and replay successfully.                                                                                                                                                             |
| AI-01  | `image.comfy`, `text.openrouter`, `video.runway`, and `edit.higgsfield` can execute/bill but cannot complete through the Worker/API result contract.        | `apps/editor-web/src/control-plane-client.ts:558-582`, `apps/worker/src/runtime.ts:443-470`, `apps/worker/src/worker-daemon.ts:96-114`, `apps/api/src/http-server.ts:1960-2052` | Temporarily deny these kinds, then implement one typed, validated, durable artifact/result contract. Each adapter binds the provider's idempotency key to the canonical request, recovers from a crash between provider acceptance and local persistence, and demonstrates one provider-side effect producing exactly one durable typed result. |

### P1 — must close before release candidate

| ID      | Gap                                                                                                                                                                                                                                                                                                                           | Required result                                                                                                                                                                                                                                                                                                                        |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB-01   | PostgreSQL rename uses `$6` with four parameters.                                                                                                                                                                                                                                                                             | Real-Postgres rename succeeds, increments revision, and rejects stale CAS.                                                                                                                                                                                                                                                             |
| DB-02   | Asset/project deletion cancels jobs and deletes derivatives globally by asset ID.                                                                                                                                                                                                                                             | Every mutation is project/owner scoped or rejects referenced deletion; two-project adversarial tests pass.                                                                                                                                                                                                                             |
| JOB-01  | Cancel can race to successful completion; failed attempts stay open.                                                                                                                                                                                                                                                          | Atomic terminal state transitions; fail/cancel close the matching attempt exactly once.                                                                                                                                                                                                                                                |
| AUTH-01 | Disabling an allowed user leaves existing sessions valid.                                                                                                                                                                                                                                                                     | Disabled/deleted users lose access immediately or all sessions are transactionally revoked.                                                                                                                                                                                                                                            |
| REL-01  | Lease/body/OTP/rate state is insufficiently bounded.                                                                                                                                                                                                                                                                          | Per-route body limits, maximum lease, verification throttles, bounded maps, and cleanup jobs.                                                                                                                                                                                                                                          |
| REL-02  | Worker HTTP, provider requests, subprocesses, and object-store operations can hang indefinitely.                                                                                                                                                                                                                              | Abortable deadlines, process-tree kill, retry classification, lease recovery, and hang fixtures.                                                                                                                                                                                                                                       |
| IDEM-01 | Mistral idempotency is non-atomic and does not bind a key to the request hash.                                                                                                                                                                                                                                                | Hash mismatch conflicts; concurrent same-key calls invoke the provider once.                                                                                                                                                                                                                                                           |
| UX-01   | Project Library cannot import/open an external project source.                                                                                                                                                                                                                                                                | Versioned import/open path with validation, asset rebinding, reload, export, and trash/restore coverage.                                                                                                                                                                                                                               |
| UX-02   | Bundled Workflows run fixture/deferred handlers but report ordinary success.                                                                                                                                                                                                                                                  | All bundled flows produce durable inspectable outputs; no fixture default or false finished state.                                                                                                                                                                                                                                     |
| UI-01   | `DESIGN.md` token, shell, icon, typography, target-size, and async-state rules are systemically violated.                                                                                                                                                                                                                     | All UI gates in section 5 pass; no visual-contract waiver is implicit.                                                                                                                                                                                                                                                                 |
| UI-02   | Motion Studio's main canvas, sashes, and context menu are pointer-only.                                                                                                                                                                                                                                                       | Keyboard selection/manipulation, keyboard resizers, roving menu focus, Escape, and focus return work.                                                                                                                                                                                                                                  |
| WIN-01  | Pairing codes are persisted to `worker.log`.                                                                                                                                                                                                                                                                                  | Pairing secrets never enter stdout/stderr/task/crash/installer logs; prior offers/sessions are revoked as needed.                                                                                                                                                                                                                      |
| WIN-02  | Worker session expiry causes manual outage and local credential protection is not proven.                                                                                                                                                                                                                                     | Rotating device-bound renewal stored with DPAPI/Credential Manager; accelerated-expiry test passes.                                                                                                                                                                                                                                    |
| WIN-03  | `joy-worker.exe` depends on a source checkout and ambient runtimes.                                                                                                                                                                                                                                                           | Signed, versioned installer with bundled/verified runtime, update, repair, uninstall, rollback, and clean-VM CI.                                                                                                                                                                                                                       |
| WIN-04  | Current autostart can remain stopped after interruption until manually restarted.                                                                                                                                                                                                                                             | Logon start, `StartWhenAvailable`, crash/network recovery, singleton, health/version check, and bounded restart pass without a visible console.                                                                                                                                                                                        |
| OPS-01  | Code rollback has no schema N/N-1 or verified restore gate.                                                                                                                                                                                                                                                                   | Backup/restore rehearsal, schema compatibility policy, write-stop rule, and automated rollback evidence.                                                                                                                                                                                                                               |
| CI-01   | The owner reports the private repository's GitHub-hosted Actions minutes are exhausted. The only current workflow uses hosted `ubuntu-latest`; it also does not exercise real PostgreSQL/object storage, a real Worker, `joy-worker.exe`, clean Windows install/startup, or rollback, and its actions use movable `@v7` tags. | Self-hosted CI becomes the primary required path and consumes no GitHub-hosted runner minutes. Mandatory isolated Linux, Windows Worker, and real-service acceptance lanes in section 9 pass twice on the exact candidate with pinned action SHAs, sanitized evidence, verified cleanup, and no production credentials or data access. |

## 5. Whole-application UI closure register

The implementation must close this register against the reconciled `DESIGN.md`, not merely make
screens look better.

### 5.1 Design system and shell

| Surface         | Confirmed baseline gap                                                                                                                                                                                     | Acceptance                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens/colors   | `app.css` contains 586 hex occurrences, 560 outside the permitted `:root`, with 263 unique outside values; `login-gate.css` adds 38/26. Blue, cyan, purple, retired amber, and undefined variables remain. | A lint/AST gate reports zero hex outside the token block, zero undefined/retired variables, and zero chrome colors outside the documented palette. Data-visualization exceptions are named tokens. |
| Typography      | Login loads Inter, Rooyin, Segoe UI, Roboto, and decorative faces despite the Modam-only contract.                                                                                                         | Computed UI font is Modam Pro across login, library, editor, Motion Studio, Effect Studio, dialogs, and inputs.                                                                                    |
| Text/targets    | Normal control copy below 11px and 22-28px interactive targets are common.                                                                                                                                 | Normal UI text is at least 11px and every interactive hit box is at least 1.9rem square at every supported desktop checkpoint.                                                                     |
| Icon rules      | Production uses glyph/emoji icons (`🔑`, `⚡`, `⚠`, `↺`, `◒`, `▶`, `♪`, `▣`, `✓`, `×`) and one-off inline SVGs. At least 39 of 170 icon-style buttons miss `aria-label` or `title`.                        | Shared icons come from `icons.tsx`; no emoji/text substitutes; every icon action has stable `aria-label`, `title`, and state semantics.                                                            |
| Accent scarcity | Amber appears on resting controls, timeline timecode/dividers, category rails, and non-Export primary actions.                                                                                             | Computed-style audit permits amber only in the six `DESIGN.md` cases.                                                                                                                              |
| Async UI        | Several lazy surfaces can be blank; many busy actions lack `aria-busy` and adjacent live status.                                                                                                           | Named loading skeleton, local error/retry, disabled + `aria-busy`, and `aria-live` result for every async surface.                                                                                 |

### 5.2 Panel registry and navigation

- Split `DockPanelId` from Create/Enhance `HubToolId`; migrate existing saved layouts safely.
- Make the canonical default layout pass its own validator and test every registry entry for a
  label, render route, icon, navigation route, and recovery path.
- Fix the visible Creative Brief text fallback by adding the shared icon mapping. No
  `.panel-tab-fallback` may be visible in a supported desktop layout.
- Remove the CSS rule that reveals active Dockview text labels at wide widths; dock tabs remain
  icon-only at all widths and labels live in tooltip/ARIA/overflow.
- Creative Brief must use exactly one `PanelShell`; Library/Templates must not nest two shells;
  Joy Code must retain the centered title/icon; Flow must adopt the shell or be explicitly
  converted into the Timeline exemption rather than silently becoming a third exemption.
- Motion/Effects categories must use the shared tab contract. In inactive Presets/Spatial,
  Library/Scenes tabs remain enabled while only the dependent body is disabled and explained.
- Body is the only scroll owner; remove per-panel root repaints, grids, and overflow overrides.

### 5.3 Global interaction and accessibility

- Replace `window.confirm` and `window.prompt` in Assets, Jobs, Templates, and Motion with one
  accessible in-app dialog primitive: labelled modal, focus trap, Escape, return focus, busy,
  error, and destructive-action copy.
- Make Command Palette, shortcut dialog, menus, workspace switcher, Motion/Effect Studio
  overlays, and context menus follow the same focus lifecycle. Palette is a real dialog/listbox,
  not a labelled region.
- Fix Timeline's nested interactive model: a clip cannot be a button containing trim buttons.
- Caption timestamp controls activate with Enter and Space.
- Project Library tabs use tab/selected semantics; Jobs failures and Monitor loading/fallback
  states are live/alert regions.
- Add authenticated Axe and keyboard traversal for every top-level panel, hub tab, and modal.

### 5.4 Surface-by-surface product closure

| Surface               | Required closure                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Login                 | Correct toggle state, keyboard-selectable suggestions, busy/error announcement, Modam/tokens, shared key icon, no decorative font exception.                                                                                                                                                                             |
| Project Library       | Import/open-from-source; truthful local/cloud/readiness metadata; real previews or an intentional neutral empty design; semantic tabs; busy/error status; in-app rename/duplicate/trash/purge dialogs.                                                                                                                   |
| Media                 | Remove duplicate `Locate original` controls; replace glyph previews; make cloud/local/missing-original states singular and actionable; cover preview, locate, delete, drag, import, and retry.                                                                                                                           |
| Text                  | Add/edit/style/reload/export E2E; no unit-only release claim.                                                                                                                                                                                                                                                            |
| Captions              | Gate Generate by real audio source and Worker/provider capability; disabled reason when unavailable; add action metadata, Space activation, import warnings, edit/style/burn-in/reload/export proof.                                                                                                                     |
| Audio                 | Replace the contradictory `Local Worker disconnected` label when Jobs shows a connected Worker lacking only `audio.ml-denoise`; show exact capability absence. Mix only audio-bearing clips or clearly groups silent sources and never exposes raw internal IDs. Runtime install/update buttons must work or be removed. |
| Animate/Motion        | Tabs stay live when target is missing; full keyboard canvas/sashes/menu; real empty/inactive notes; no inaccessible pointer-only authoring.                                                                                                                                                                              |
| Transitions           | Resolve duplicate visible `Wipe Left` names; unique preview/tooltip/implementation identity; apply/edit/remove/reload/export E2E.                                                                                                                                                                                        |
| Effects               | Preserve the preview coordinator fix and all category stability. Replace cost glyphs; remove repeated per-card guidance clutter; delete or name the three empty `Untitled Effect Recipe` records; every visible effect is applicable or explicitly unavailable, not ambiguous `Preview only`.                            |
| Filters/Color/Adjust  | Shared tabs/shell/icons; no Unicode icon substitutes; truthful target state; reset/bypass toggles use stable names/state; apply/reload/export and scopes tests.                                                                                                                                                          |
| Inspector             | Icon action metadata; stable On/Off and bypass semantics; honest contextual tabs; verify Visual, Enhance, Mask, Effects, Audio, and Speed with selected and empty states.                                                                                                                                                |
| Timeline              | Preserve working play/pause and one-second seek; fix clip/trim accessibility; compact-window clipping; import/edit/split/trim/duplicate/delete/rate/freeze/undo/reload/export at all supported widths.                                                                                                                   |
| Monitor               | Named loading/error/retry; announced GPU connecting/fallback state; render/source diagnostics linked to the offending clip; zoom/fullscreen/transport keyboard proof.                                                                                                                                                    |
| Flow/Dual Lens        | Conform to shell architecture; prevent trace-label clipping/overlap at 1024; preserve Time/Flow/Split and shared viewport behavior.                                                                                                                                                                                      |
| Joy Code              | Replace the read-only Motion Code placeholder with editable, persisted, round-trippable source. Keep history/composer/3D loading and errors named.                                                                                                                                                                       |
| 3D                    | Promote from flattened PNG semantics to a versioned persisted scene (source refs, transforms, camera, light/material state) that can be reopened and edited after reload. Export derives a render without destroying scene editability. Until this passes, label it beta and do not claim an editable 3D layer.          |
| Workflows             | Remove `asset-demo-1`; execute real ports/jobs/project operations; show intermediate/manual/deferred output honestly; only durable completion is green/success.                                                                                                                                                          |
| Jobs/Worker           | Consistent global connection and capability state; group connected/disconnected/revoked clearly; stale devices are revocable/archivable; queue errors announced; pairing/submit busy and secure.                                                                                                                         |
| Creative Brief        | Shared shell/icon; opt-in/unavailable/error/stale/retry/reset E2E; no provider call before durable sync; disclosure remains explicit.                                                                                                                                                                                    |
| Plugins               | Replace Demo Panel with a supported catalog, permission model, enable/disable lifecycle, failure isolation, and at least one non-demo first-party plugin. Hide the panel during containment, not as the final implementation.                                                                                            |
| Motion/Effect Studios | Remove read-only Code and inaccessible overlays; real dialog semantics; shared icons/tokens; keyboard canvas/stack/inspector/timeline journeys; load/error recovery.                                                                                                                                                     |
| Compact desktop       | At 1024 and 1280, collapse secondary groups rather than squeezing. No wrapped Creative Brief fallback, clipped Flow trace, overlapping Process Center, hidden actions, document overflow, or unreachable panel.                                                                                                          |

## 6. Backend, data, and reliability closure register

In addition to the P0/P1 items above, close all of the following before final promotion:

1. Retry must explicitly version/retain or garbage-collect previous derivatives and objects.
2. Project deletion must remove/cascade `project_documents`; add foreign keys/checks or proven
   compensating invariants for projects, assets, jobs, attempts, events, derivatives, and docs.
3. If original upload succeeds but tag/DB persistence fails, roll back the exact object or enqueue
   durable cleanup. Object purge failures must enter a cleanup ledger/sweeper, not return 200 and
   disappear.
4. Add bounded cursor pagination to assets, revisions, jobs, attempts, and events.
5. Pairing offers need proof-of-possession, overwrite/rate protection, expiry, and atomic claim.
6. Clean expired OTPs, sessions, pairing offers, and rate buckets; enforce verification attempts.
7. Map validation/not-found/conflict/dependency errors to explicit 400/404/409/429/503 contracts.
8. `/ready` must cover every migration-owned critical table and dependency. Add request IDs,
   structured redacted logs, latency/status metrics, queue age, lease failures, provider spend,
   cleanup backlog, and alert tests.
9. Test object-store/network/database failure injection against real PostgreSQL and an S3-compatible
   store. Unit/pg-mem success alone is insufficient.

## 7. Windows Worker product closure

1. Replace the checkout-dependent SEA launcher with a signed installer/package and immutable
   version manifest. Verify publisher, hash, bundled runtime, prerequisites, update channel, repair,
   uninstall, and previous-version rollback on clean Windows VMs.
2. Store renewable device credentials with DPAPI/Credential Manager and restrictive ACLs. Do not
   log pairing/session secrets. Rotate tokens and prove another Windows user cannot read them.
3. Run headlessly after logon with singleton enforcement, health/version preflight,
   `StartWhenAvailable`, bounded restart/backoff, crash recovery, offline recovery, update recovery,
   and visible tray/status UX without a console window.
4. Before any Worker action that invokes a local command or subprocess, show a Windows notification
   naming the action, project, risk, and whether explicit consent is required. Sensitive commands
   carry a server-side immutable approval assertion; unapproved jobs cannot execute.
5. Add per-kind input byte/duration/pixel limits, free-space checks, wall-clock limits, Windows Job
   Object/process-tree termination, CPU/RAM/GPU policy, bounded/rotated redacted logs, and corrupted,
   huge, disk-full, no-GPU, cancel, crash, and restart tests.
6. Implement a versioned authenticated local IPC/status boundary for the future Windows app. It may
   expose health/capability/update state; it must never become arbitrary browser-to-shell execution.
7. Add Windows CI, self-hosted CI lanes, pinned action SHAs, least-privilege workflow permissions,
   secret/dependency/code scanning, signed provenance, SBOM, and artifact verification.

## 8. Dependency-ordered execution waves

Each wave begins with failing regression tests, ends with focused commits, CodeRabbit review, root
verification, and a clean worktree. Do not deploy between waves.

### Wave 0 — containment and truthful surface

- Deny unsupported AI/Comfy kinds in UI and API before any provider call.
- Reject client-supplied private cloud refs.
- Hide demo/placeholder entry points behind an internal development flag while their real
  implementation is built; replace misleading status/success copy immediately.
- Add P0 regression tests and redact pairing logs.

### Wave 1 — security, export, and typed job delivery

- Fix tenant object authorization and cross-project ownership rules.
- Build an export source-resolution preflight with per-clip diagnostics, cancellation, retry, and
  deterministic timeout behavior; make the two audited real projects export.
- Implement the durable generic result/artifact contract and exactly-once provider behavior.

### Wave 2 — durable data and failure semantics

- Fix real-Postgres rename, scoped deletion, cancel/complete/fail races, attempt closure, document
  cascade/integrity, derivative retention, cleanup ledger, pagination, error mapping, session
  revocation, idempotency, request limits, timeouts, and cleanup.
- Run adversarial real-Postgres/S3 suites and migration compatibility tests.

### Wave 3 — DESIGN.md reconciliation and mechanical UI foundation

- Reconcile the document contradictions using section 2 decisions.
- Introduce lint gates for tokens, variables, fonts, text size, target size, icons, button metadata,
  toggle semantics, registry coverage, and shell DOM order.
- Migrate literal colors/undefined variables, login typography, shared icons, panel registry,
  shell nesting/scroll ownership, fallback tabs, dialogs, and async primitives.

### Wave 4 — core editor journeys

- Project import, Media, Text, Captions, Audio, Enhance, Inspector, Timeline, Monitor, Flow, History,
  Project Library, process center, and export.
- Run populated, empty, inactive, loading, busy, error, retry, reload, undo/redo, and compact-desktop
  states for every surface.

### Wave 5 — advanced product surfaces

- Real Workflows, editable/persistent 3D, editable Motion Code, production plugin lifecycle,
  Creative Brief E2E, Motion Studio and Effect Studio accessibility/round-trip behavior.
- Remove the temporary containment flags only after each surface passes its own durable E2E.

### Wave 6 — Windows Worker productization

- Secure session/logging, signed installer, autostart/recovery, capability protocol, notifications
  and approval assertions, resource limits, local IPC, update/repair/uninstall/rollback, and
  self-hosted Windows CI.

### Wave 7 — release engineering and production proof

- Observability/alerts, DB backup/restore and N/N-1 rehearsal, signed provenance/SBOM, two clean
  strict gates, clean Windows install matrix, browser matrix, immutable deployment, origin checks,
  rollback rehearsal, and canary.

## 9. Required test matrix

### Source and real-service gates

- Typecheck, lint, formatting/diff check, dependency audit, secret scan, SAST, all unit/integration
  suites, all production builds, and CodeRabbit review with no unresolved blocking finding.
- Self-hosted CI is the primary required path because the GitHub-hosted minute allowance is
  exhausted. GitHub Actions remains the scheduler, but each `runs-on: [self-hosted, ...]` job runs
  on owner-controlled hardware and consumes no GitHub-hosted runner minutes. A GitHub-hosted run is
  optional when quota is available and is never required for completion. The current hosted
  workflow is not release proof: its browser server uses a memory control plane/object store and
  test authentication, its Worker tests use stubs/`pg-mem`, and it does not build
  `joy-worker.exe`.
- Real PostgreSQL migrations + CRUD/CAS + two-tenant/two-project adversarial isolation.
- Real S3-compatible object store with slow, hanging, partial, checksum, orphan, cleanup, and outage
  cases.
- Deterministic fake providers prove request-hash binding, crash windows, cancellation, timeout,
  durable typed result retrieval, and no invocation for rejected kinds. A non-billable provider
  sandbox/free test or provider ledger/receipt additionally proves adapter idempotency: one
  provider-side effect produces one durable result across retries and process restarts.
- Export fixtures for missing local source, missing cloud source, corrupt media, long preload, mixed
  media, 3D, captions, audio, effects, and imported projects.
- Windows 10/11 clean user profiles: install, sign/hash, pair, autostart, offline, crash, sleep/resume,
  session renewal, capability change, command notification/consent, update, repair, uninstall, and
  rollback. These tests run in self-hosted CI before release promotion.

### Mandatory self-hosted CI lanes

Register repository-scoped runners only for the private `hadimoti/joy-media` repository. The
practical zero-extra-host layout is one native Windows runner under a dedicated low-privilege
Windows account plus one isolated WSL2 Linux runner on the same PC, with all jobs serialized. A
separate disposable Linux VM is preferable when available. Do not install a general-purpose Actions
runner on the production Sweden VPS, and never run repository PR code on a machine that holds owner
browser sessions, production credentials, or writable production mounts.

1. **Linux real-services lane** — labels `self-hosted`, `linux`, `x64`, `joy-media-ci` on an
   ephemeral or freshly reset non-root runner. Pin Node 22, pnpm 11.15.0, FFmpeg, and FFprobe;
   install with `pnpm install --frozen-lockfile`; run `pnpm run verify:ci`, `pnpm run release:gate`,
   real migrations, API/readiness, two-tenant/two-project isolation, lease/queue/cleanup,
   provider-fake idempotency, export-headless, and N/N-1/rollback-compatibility tests against an
   isolated PostgreSQL 17 database and S3-compatible store.
2. **Windows Worker lane** — labels `self-hosted`, `windows`, `x64`, `joy-media-worker`; add `gpu`
   only on the recorded GPU runner. From a clean standard-user profile, run install/typecheck/lint/
   tests, the Worker TypeScript build, `pnpm worker:exe`, and the built
   `joy-worker.exe --joy-worker-self-test`. Then exercise the signed installer/portable package,
   isolated state, hidden Task Scheduler startup, singleton, reconnect/renewal, heartbeat/lease,
   completion/retry/cancel, notification/approval, bounded child-process termination, redacted log
   rotation, capability detection, crash/offline/sleep recovery, update, repair, uninstall, and
   previous-version rollback. Retain separate required CPU-only and GPU results.
3. **Real-service acceptance lane** — start the candidate API/editor against disposable real
   services and a real isolated Worker identity. Prove source-bound export, durable re-download,
   Effects soak, Timeline, 3D, Audio, Captions, Jobs, keyboard, and accessibility fixtures. Any
   automated browser is orchestrator-owned CI, uses only isolated non-production credentials, and
   never receives OpenCLI profile `cefd9k77`, owner cookies, or owner auth state. It supplements;
   it does not replace the orchestrator's authenticated production gate.
4. **Isolation and teardown** — assign one run ID to database/schema, bucket/object prefix,
   projects, Worker identity/state, ports, and temporary paths. In an unconditional finalizer,
   terminate API, Worker, FFmpeg, browser, and child process trees; drop run-owned DB/object state;
   release ports/locks; and fail the job if any process, object, volume, credential, or state file
   leaks. Serialize main/release candidates and GPU use; cancel superseded PR runs.
5. **Runner and artifact security** — never expose self-hosted runners or secrets to untrusted fork
   code or `pull_request_target`. Pin every GitHub Action by immutable commit SHA, use least-
   privilege workflow permissions and protected signing/deployment environments, and keep runners
   outside production trust paths. Upload only redacted JUnit/gate summaries, sanitized logs,
   manifests, hashes, SBOM, signatures, and provenance. Never upload `.env`, DB URLs/dumps, Worker
   state, pairing/session material, prompts/user media, owner auth state, or unredacted full logs.
6. **Workflow and quota rule** — trusted `main`/release pushes and manual `workflow_dispatch` may
   use the self-hosted runners; pull-request workflows stay source-only on an isolated disposable
   runner or remain disabled while hosted minutes are unavailable. Keep uploaded GitHub artifacts
   minimal because artifact/cache storage quotas are separate from runner minutes. A hosted mirror
   may run when allowance returns, but it is optional.
7. **Promotion rule** — the self-hosted source/release checks and all three self-hosted lanes pass
   twice consecutively on the exact clean candidate SHA and artifact manifest. CI never deploys
   automatically. Codex primary reviews provenance and owns promotion, direct-origin checks,
   authenticated browser verification, canary, and rollback.

### Orchestrator-only authenticated browser gate

The Codex orchestrator runs this matrix. Subagents do not use a browser.

1. Login/session restore and Project Library populated/empty/search/sort/grid/list/trash/restore.
2. Import a real versioned project; open, reload, and verify source binding.
3. Media preview/import/locate/delete/retry and cloud/local switch.
4. Text add/edit/style; captions add/edit/style/generate/import/burn-in; audio enhance/mix/runtime.
5. Timeline select/split/trim/duplicate/delete/rate/freeze/markers/undo/redo/play/pause/seek.
6. Every Inspector tab with valid and empty selection.
7. Every Animate, Transition, Effects category, Filter, Color, and Adjustment surface; apply, edit,
   remove, reload, export. Effects switching must not crash or enter a loop.
8. Joy Code History/Composer/3D: import GLB/GLTF, edit scene, add to timeline, reload/reopen/edit,
   export, and handle invalid/missing dependencies.
9. Real bundled Workflows, Creative Brief, Jobs, Worker pairing/recovery/capability changes, Plugin
   lifecycle, Motion Studio, and Effect Studio.
10. Export the real showcase and imported project; download and inspect playable output.
11. Repeat critical authoring at 1024×768, 1280×800, 1440×900, and 1920×1080. Phone is excluded.
12. At every step: no recovery overlay, relevant console error/warning, failed same-origin request,
    clipped action, visible dock text fallback, inaccessible modal, silent async failure, or stale
    success claim. Run Axe on authenticated landmark states.

## 10. Release and rollback gates

Promotion is blocked unless all are true:

- Zero open P0, P1, or P2 items in this plan. Every P3 missing-proof item has retained evidence.
- The UI mechanical gates return zero violations and every visible production action has durable
  behavior or a truthful unavailable state.
- Two consecutive clean strict gates pass on the exact candidate commit.
- Git worktree is clean; local `main`, remote `github`, remote `vps`, and deployment checkout
  `/opt/joy-media/repo` share the exact commit/tree/lockfile/schema identity. None of these
  checks may be satisfied by `joy-vps` or any legacy JOY Media pointer path.
- The self-hosted source/release checks and all three self-hosted CI lanes pass twice on the exact
  release candidate commit; teardown, redaction, hashes, signatures, SBOM, and provenance are
  verified. GitHub-hosted execution is optional and cannot block completion while its allowance is
  exhausted.
- Database backup restores in isolation; code rollback is proven safe against current schema.
- The signed Windows artifact and web/API artifacts have hashes, SBOM, provenance, and retained
  test evidence.
- Nginx validation and direct-origin `curl --noproxy '*' --resolve ...` checks pass before public
  route verification.
- Authenticated production browser matrix passes on the released assets.
- Canary runs at least 30 minutes with zero live/ready identity failures, export/job correctness
  errors, cross-tenant alerts, cleanup backlog growth, or Worker disconnect loop. Queue age,
  provider failures/spend, DB/object latency, and Worker resource saturation stay within recorded
  budgets.

Rollback on any gate/canary failure:

1. Stop promotion and disable the offending capability/provider enqueue path.
2. If schema compatibility is uncertain, stop writes before moving code pointers.
3. Restore the previous immutable web/API/Worker artifact; restore DB only from the rehearsed,
   verified backup when required.
4. Re-run origin identity/readiness and the smallest incident-specific browser/security proof.
5. Record the failure, rollback identity, data impact, and next corrective gate without secrets.

## 11. Team execution contract

| Role                         | Route                                       | Work                                                                                                                                                | Browser policy                                                                                                                      |
| ---------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator                 | Codex primary                               | Coordinate, integrate, decide, run authenticated/local/staging/live browser journeys, promote, deploy, rollback, and write the final Gbrain record. | Sole browser operator. Use the Codex in-app browser by default. If OpenCLI is needed, profile `cefd9k77` remains orchestrator-only. |
| Backend implementer          | Kilo CLI free route (`kilo/kilo-auto/free`) | API, schema, sync, polling, Worker, delivery, and backend reliability fixes.                                                                        | No browser, Chrome, OpenCLI, or profile access.                                                                                     |
| Adversarial reviewer         | Hermes CLI free route (`openrouter/free`)   | Security, failure modes, regression challenge, and release challenge.                                                                               | No browser, Chrome, OpenCLI, or profile access.                                                                                     |
| UI implementer               | Codex in-app subagent, Luna                 | UI state machines, performance, accessibility, and non-browser source/unit/integration interaction tests.                                           | No browser.                                                                                                                         |
| Integration/release reviewer | Codex in-app subagent, GPT-5.4              | Main reconciliation, tests, provenance, deployment review, and independent release verification.                                                    | No browser.                                                                                                                         |

- If Kilo-free or Hermes-free is unavailable, continue with Codex subagents instead of blocking.
- Agents share the worktree: claim non-overlapping files, communicate before touching shared
  registries/schema/CSS, inspect `git diff` before each commit, and never discard owner changes.
- Use focused commits per invariant, not one giant final commit. CodeRabbit reviews each wave and
  the release diff; every substantive finding is fixed or explicitly proven inapplicable.

## 12. Completion record

At completion, update:

- `STATE.md`, affected plans/ADRs, `DESIGN.md`, Worker docs, and release runbooks so they describe
  the implemented truth rather than historical intent.
- Gbrain page `ops/joy-media-worker-6a77940-2026-08-29` or a linked successor with final commit,
  changed paths, test counts, browser evidence, release identities, canary, rollback target, and
  remaining non-blocking future work. Store no credentials, pairing codes, tokens, object maps,
  customer data, or secret-bearing paths.
- `C:\Users\HadiMoti\Desktop\VPS-AGENT-BRIEF.md` only if the non-secret JOY Media operational map
  changed. Do not edit the `joy-vps` product repository.

The final handoff must state the exact commit, release identity, Windows package version/signature,
test/browser/canary results, rollback target, Gbrain commit, and confirm a clean worktree.
