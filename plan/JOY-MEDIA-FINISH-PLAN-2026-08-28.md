# JOY Media finish plan — 2026-08-28

Status: **execution-ready; current production verdict is NO-GO**.

This plan finishes the standalone `joy-media` repository and JOY Studio at
`https://joyst.ir/` and `https://www.joyst.ir/`. It does not authorize work in the `joy-vps`
repository or changes to unrelated VPS services. The detailed branch choices are in
`plan/JOY-MEDIA-RECONCILIATION-MATRIX-2026-08-28.md`.

## Completion contract

The next execution goal is complete only when all of the following are true on the same immutable
source revision:

1. every production-visible action has working success, empty, loading, permission, failure, and
   retry behavior, or the action is hidden with truthful product status;
2. no reproducible P0/P1 issue remains in the production scope;
3. typecheck, lint, formatting, all tests, goldens, editor/API/Worker builds, static-asset checks,
   security scans, SBOM, and release provenance pass from two clean checkouts;
4. additive PostgreSQL migration and rollback rehearsals pass against a copy of the live schema;
5. a real authenticated project can save/reopen, import and play real media, edit, caption, apply an
   effect and transition, publish/place Motion, run Joy Code approval, render through a real Worker,
   pass retained inspection, and download/reopen the artifact;
6. the exact candidate is merged to `main`, pushed to the JOY Media remotes, deployed as an
   immutable JOY Media release, and verified at the origin plus both public hostnames;
7. the post-deploy canary and 30-minute observation window meet the numeric release budgets below,
   with zero unexpected page/console errors, wrong MIME/static fallbacks, readiness failures, or
   data-loss symptoms;
8. `deploy/joy-media-rollback.sh` is rehearsed against the previous immutable release and retained.
   Any named post-deploy gate failure runs it immediately without user input, then rechecks origin
   and both public hostnames.

“No bugs” means the measurable contract above. It must never be inferred only from unit tests or a
mocked browser run.

## Non-negotiable operating rules

- Use the local Gbrain page `joy-vps-agent-brief` and the redacted
  `C:\Users\HadiMoti\Desktop\VPS-AGENT-BRIEF.md` before infrastructure work. Never copy secrets,
  cookies, OTPs, tokens, private object references, or customer data into Git or reports.
- For any completed VPS change, write the confirmed non-secret operational result back to Gbrain.
  Treat an origin request made with `curl --noproxy '*' --resolve ...` as the authoritative routing
  check; obtain its private values from the brief at execution time and never copy them into Git.
- The next `/goal` run is pre-authorized to make normal in-scope implementation decisions and must
  **not wait for user confirmation or approvals**. It may merge/push/deploy only after the gates in
  this plan pass. It must not force-push, weaken a gate, destroy user data, or touch unrelated VPS
  services.
- Database work is additive/expand-contract until old-binary rollback is proven. Back up PostgreSQL
  and object-store metadata before production migration.
- Build once from a clean, capable runner; promote the same verified archive. Do not rebuild a
  different artifact on the memory-constrained VPS.
- Never conceal a failing capability behind optimistic UI copy. Hidden/experimental source is not a
  release blocker; a visible non-working promise is.

## Agent topology for the next goal

The Codex orchestrator owns integration, decisions, and **all browser work**. Sub-agents are
code/test/review workers only.

| Role                         | Route                                       | Work                                                                                                     | Browser policy                                                                                                                  |
| ---------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator                 | Codex primary                               | Coordinate, integrate, run all authenticated/local/staging/live browser journeys, promote and deploy     | Sole browser operator; use Codex in-app browser by default. If OpenCLI is needed, profile `cefd9k77` remains orchestrator-only. |
| Backend implementer          | Kilo CLI free route (`kilo/kilo-auto/free`) | API, schema, sync, polling, Worker and delivery fixes                                                    | No browser or browser profile access                                                                                            |
| Adversarial reviewer         | Hermes CLI free route (`openrouter/free`)   | Security, failure modes, regression and release challenge                                                | No browser or browser profile access                                                                                            |
| UI implementer               | Codex in-app sub-agent, Luna                | UI state machines, performance, accessibility, and non-browser source/unit/integration interaction tests | No browser                                                                                                                      |
| Integration/release reviewer | Codex in-app sub-agent, GPT-5.4             | Main reconciliation, tests, provenance, deployment review                                                | No browser                                                                                                                      |

After each tranche, at least one different agent reviews the diff and test evidence. The
orchestrator resolves disagreements and records accepted/rejected findings. Sub-agents may exchange
source reports through the orchestrator, but no sub-agent may run Playwright/OpenCLI/Chrome/Codex
browser tests. This restriction is for execution speed and reliability, not access.

Use the named routes when they are available. If a named route/model is unavailable, the
orchestrator must continue with the nearest same-scope non-browser substitute, record the
substitution, and cross-review its output; route availability is never a reason to wait for the
user.

## Evidence baseline

### Source and release state

| Evidence                | Current fact                                                                                                 | Release consequence                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Candidate line          | `codex/joy-media-implement-20260828`; baseline `abcb7d1`, with confirmed local fixes `71a98de` and `b5b7404` | Tested work exists but is not canonical or live.                                                                |
| GitHub main             | `2083ffc`; candidate divergence at capture: 407 main-only / 223 candidate-only commits                       | Blind merge or candidate overwrite is forbidden.                                                                |
| Main-native integration | `b6aa47e`, nine focused commits ahead of `github/main`                                                       | Use this as the reviewed starting line, then port remaining behavior with tests.                                |
| VPS main                | `1e4657f`                                                                                                    | VPS drift is evidence, not canonical product source.                                                            |
| Latest release gate     | `2026-08-28T17:53:26.723Z`, `passed:false`                                                                   | Commands/builds/2,442 tests/static/SBOM pass; provenance and real authenticated verified-delivery journey fail. |
| Existing journey        | `execution: mocked`, quick browser export, no inspection                                                     | Diagnostic only; cannot authorize release.                                                                      |

### Authenticated live-browser findings

The orchestrator inspected the user-owned authenticated JOY Studio tab without reading session
storage or credential-bearing response bodies.

| ID      | Observed production issue                                                                                                        | Evidence and current interpretation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LIVE-01 | Effects opens with `Pixel / B&W (0)` and an empty result although built-ins exist. All category counts remain `(0)`.             | Proven React readiness/memo invalidation bug. `71a98de` recomputes descriptors/counts after built-in registration and adds a failing-before/fixed-after test. Not live.                                                                                                                                                                                                                                                                                                                                                                                                |
| LIVE-02 | User reports Effects category clicks can make the site go down.                                                                  | One controlled pass through all nine categories did not navigate or throw; it loaded many PNG/WebM previews and produced one aborted media request. Keep open until candidate soak/performance evidence passes. Direct path is preview media/GPU/static delivery, not a database call.                                                                                                                                                                                                                                                                                 |
| LIVE-03 | Transition cards are blank and console repeatedly reports failed legacy `transition1.png`/`transition2.png` loads.               | Live release is stale and falls back incorrectly. Main-native line already carries source-controlled SVG previews and accessible failure/retry handling. Must be deployed and reverified.                                                                                                                                                                                                                                                                                                                                                                              |
| LIVE-04 | Banner says local recovery backup is available and cloud sync is unavailable.                                                    | The live editor is still on the legacy cloud-sync path. The current line keeps the existing `project_documents` contract, applies ordered migrations through the durable ledger, and exposes fail-closed readiness; migration/readiness/live proof remains open until the deployed release is verified.                                                                                                                                                                                                                                                                |
| LIVE-05 | Quick export and Verified delivery are unavailable.                                                                              | Real capable Worker plus retained inspection path is not proven in the deployed environment. P0 blocker.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| LIVE-06 | The app requested `/api/v1/workers` every two seconds; 58 successful responses appeared in one diagnostic window.                | `App.tsx` polls unconditionally and the PostgreSQL route queries `workers` each time. Add visibility/failure backoff or event-driven presence and prove bounded load.                                                                                                                                                                                                                                                                                                                                                                                                  |
| LIVE-07 | Three untitled, zero-effect recipes are visible.                                                                                 | Empty recipe creation is allowed and creates clutter. Define draft semantics, prevent accidental duplicate empty recipes, and test delete/rename/reopen.                                                                                                                                                                                                                                                                                                                                                                                                               |
| LIVE-08 | Timeline track identity loses a row after a non-tail remove/add sequence.                                                        | Orchestrator reproduced `2 → 4 → 3 → expected 4, observed 3`: after adding V3/V4, removing the non-tail V3 row, then adding, the deployed length-based generator reused existing ID `V4`; the rendered timeline had only three rows and one `V4` key instead of four unique rows. The sequence was fully undone to the two-track baseline. This is a P0 data-integrity blocker.                                                                                                                                                                                        |
| LIVE-09 | Timeline lock/mute state is disconnected from destructive commands and undo.                                                     | On the authenticated editor, locking `track-1` then clicking `Remove track track-1` changed the two-track baseline to one track. Undo restored the row but not a durable lock contract. Muting then Undo left `button "Mute track-1" [pressed]`, proving local track flags did not reconcile with the project command. All diagnostic mutations were restored by reload.                                                                                                                                                                                               |
| LIVE-10 | Empty-timeline and insertion affordances have silent/no-keyboard paths.                                                          | The empty-state root is focusable, but clicking its Persian child produced no visible dialog/status/action. Each of the 12 insertion lanes is a plain `SPAN` with only a `title` (`role=null`, `tabindex=null`) and a click produced no action. `Play proxy` remains enabled and becomes active on the empty timeline without playback or explanation.                                                                                                                                                                                                                 |
| LIVE-11 | Deployed timeline lanes are not fully discoverable to assistive technology, and the Effects path needs final release proof.      | Fresh authenticated smoke on 2026-08-29 (deployed `04c63b2`) opened the Inspector Effects tab and the Assets→Effects category, added an effect clip, and saw no recovery screen or alert. Locking `track-0` blocked Delete and mute toggled pressed/unpressed correctly. However, the empty visual lane exposed `role="button"`/`tabindex="0"` without an accessible name or keyboard shortcut, and repeated asset additions remained on the existing `track-0`; the pending UI tranche adds the missing lane/runway semantics and must be rechecked on the final SHA. |
| LIVE-12 | Worker lease-generation deployment initially failed at API startup because the new fields changed the mutable baseline checksum. | During the 2026-08-29 promotion, the new binary failed closed against the live ledger (`001-baseline` stored checksum `6044f0…`), and the rollback-safe service restored the prior pair. The fix is now an additive `003-worker-lease-generation` migration with the deployed baseline checksum pinned; startup must be rechecked as `joy-media` before the release is eligible again.                                                                                                                                                                                 |

Timeline browser follow-up is now an explicit certification sequence, not a visual spot-check:
reload the authenticated editor, verify the empty-state copy and every virtual lane by mouse and
keyboard (including accessible names/Enter/Space), verify empty playback is disabled/truthful, then
run the exact `2 → 4 → remove non-tail → add` identity sequence plus lock/remove and mute/undo/reopen
checks. Also open both Effects entry points, cycle every category, add an effect, and retain console,
network, recovery, and static-asset observations. The source remediation adds a collision-free
allocator, command-level duplicate rejection, lock guards, durable mute commands, state
reconciliation, and keyboard affordances; the sequence must still be rerun against the final
deployed SHA before LIVE-08/LIVE-09/LIVE-10/LIVE-11 can be marked closed. The API promotion also
requires the additive migration/startup check from LIVE-12 before any browser evidence is accepted.

No agent may claim the reported Effects outage is closed merely because the single live pass did not
reproduce it.

## Authoritative gap register

### P0 — release blockers

| ID    | Gap                                                                                                                                                                                                                                                                              | Required closure and acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-01 | Canonical lines diverge.                                                                                                                                                                                                                                                         | Start from `b6aa47e`; classify every candidate-only/main-only behavior by the reconciliation matrix; port focused contracts; no large blind merge. Final integration branch must be clean, reviewable, and based on current `github/main`.                                                                                                                                                                                                                                                                                                         |
| P0-02 | Revisioned project document storage is not proven against the live schema. The migration baseline is now frozen instead of reading mutable current DDL.                                                                                                                          | Commit `1fd9c15` adds the exact historical 001 schema (`postgres-baseline-schema.ts`) with checksum coverage, leaving 003/004 additive and preserving the durable ledger/lock. A real disposable PostgreSQL rehearsal on the deployed build applied frozen 001, upgraded with the new binary to all four ledger rows, then started the previous binary successfully against the upgraded schema; `generation`/`lease_token` were present and the temporary database was removed. Retain this evidence on the final source revision before closing. |
| P0-03 | Project bootstrap and cloud sync fail live.                                                                                                                                                                                                                                      | Commits `49aee1f` and `03d2732` add guarded ordinary-editor autosync plus recovery for two bootstrap dead-ends: a newer local edit now records the observed remote CAS base before retrying, and transient bootstrap reads leave the hydration barrier retryable with bounded 2s→60s backoff. Focused autosync/sync/hydration/control-plane/polling tests pass; authenticated save/reload/restart/conflict/recovered-copy evidence remains required.                                                                                               |
| P0-04 | Retry and polling amplifiers can load API/PostgreSQL.                                                                                                                                                                                                                            | Commit `1e78ea4` makes Jobs project bootstrap once per project ID and resets on project switch; existing loops remain bounded and deduplicated. Focused polling/document/client tests pass (72); endpoint/query-rate and visibility-aware budget evidence for Jobs, Audio, Enhance, Mask, and delivery status remains required.                                                                                                                                                                                                                    |
| P0-05 | Verified delivery is unavailable.                                                                                                                                                                                                                                                | Pair a real Worker, prove durable hello/lease/heartbeat/attempt exhaustion/manual retry/cancel, export a real artifact, retain it, run deep inspection, persist terminal state, and survive API/Worker restart.                                                                                                                                                                                                                                                                                                                                    |
| P0-06 | Release evidence is mocked and not source-bound.                                                                                                                                                                                                                                 | Orchestrator runs `authenticated-editor-1.0` on real services, records commit/tree/lockfile/archive hashes, verified-delivery channel, passed inspection and post-Motion placement. Evidence must be <24h old and match a clean checkout.                                                                                                                                                                                                                                                                                                          |
| P0-07 | Static release gate is incomplete.                                                                                                                                                                                                                                               | Gate every emitted JS/CSS/font/Worker asset, both transition SVGs, all 33 effect PNGs, all 19 effect WebMs, manifest references, non-empty bytes, hashes and MIME signatures. Unknown asset-like paths must 404, never return SPA HTML.                                                                                                                                                                                                                                                                                                            |
| P0-08 | Current production source/release identity is stale or unavailable.                                                                                                                                                                                                              | `/live` proves process liveness; `/ready` proves PostgreSQL, schema version, object store where required, and validated non-secret release identity. Origin and public responses must identify the same released SHA/archive.                                                                                                                                                                                                                                                                                                                      |
| P0-09 | No final main/deploy proof.                                                                                                                                                                                                                                                      | Run the full gate twice, fast-forward/merge reviewed integration to `main`, push GitHub and JOY Media VPS remotes without force, deploy the exact archive, canary, observe, and automatically roll back on any failure.                                                                                                                                                                                                                                                                                                                            |
| P0-10 | CI does not produce real PostgreSQL/object-store/API/Worker/authenticated-browser release evidence.                                                                                                                                                                              | Add an isolated real-service CI/release lane with PostgreSQL, private-object test storage, API, Worker/render host and orchestrator-produced authenticated evidence. Mock/`pg-mem` suites remain useful but cannot satisfy this gate.                                                                                                                                                                                                                                                                                                              |
| P0-11 | Timeline track IDs are derived from current array length and can collide, hide, or overwrite rows after removal.                                                                                                                                                                 | Replace every toolbar/context/drop-created ID with one durable collision-free allocator shared by all command paths. Reject duplicate IDs in validators/loaders. Add randomized add/remove/import plus rapid-repeat tests, then prove exact track/clip identity through undo/redo, save/reopen, project switch, render, and browser reproduction of the live `2 → 4 → 3 → 4` sequence.                                                                                                                                                             |
| P0-12 | Browser-visible My media/cloud assets are not always present in the active control-plane project. Selecting a real `assetId` and queueing a thumbnail currently returns `ASSET_NOT_FOUND`, so verified Worker delivery cannot complete from the editor.                          | Commit `b4f1072` fixes the backend mask path: `mask.image`/`mask.video` now resolve source kind through the durable `media_asset_access` association using the same authorization scope as ordinary asset reads. Add an authenticated browser test that selects a catalog asset, queues it, receives a Worker lease, uploads a derivative, and reaches verified inspection; never show an enabled queue action that is guaranteed to return `ASSET_NOT_FOUND`.                                                                                     |
| P0-13 | Rollback identity correctness was previously unproven. The implementation now switches immutable API/web pointers and the matching release identity atomically; only final deployed-source evidence must remain retained.                                                        | Keep per-release non-secret identity metadata beside each archive, switch `/etc/joy-media/api.env` to the target commit/tree/lock/schema before restart, restore the target identity on re-promotion, and require both `/live` and dependency-aware `/ready` to pass. Commits `54e0aa0`/`4ad10d3` plus the current immutable rehearsal satisfy the implementation and rollback-contract checks.                                                                                                                                                    |
| P0-14 | Worker derivative finalization must remain fail-closed in production. The source implementation now rejects missing/unregistered derivatives, cleans up only the exact failed upload, and isolates retry generations; a real Worker delivery/inspection journey is still absent. | Keep the generation-scoped retained-object and registration checks (owner, job, generation, checksum, size and MIME) on every derivative-producing completion route. Preserve exact-object cleanup and stale-generation isolation across retries/restarts. The API/PostgreSQL/HTTP/Worker contract suite is green on the candidate; closure still requires a real authenticated Worker lease → upload → completion → retained inspection → Motion placement journey on the deployed SHA.                                                           |

### P1 — production function and UX closure

| ID    | Surface                                | Remaining work and acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1-01 | Effects catalog                        | Port `71a98de`; interaction-test every category, search, favorites, add/drag, default params, recipe apply/reopen, and category counts. Initial render may never show a false empty state.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| P1-02 | Effects preview stability              | Commit `268e441` adds poster-first IntersectionObserver mounting, hidden-tab/reduced-motion pause/fallback, accessible autoplay/decode retry, and shared caps of 12 mounted/6 playing previews. A 30-minute all-category/search/favorites soak with memory/long-task evidence is still required before closing LIVE-02/P1-02.                                                                                                                                                                                                                                                                                                  |
| P1-03 | Effect recipes                         | Specify draft vs published recipe lifecycle; prevent accidental duplicate empty drafts; support rename/delete/close/reopen; preserve applied effect stack and autosave.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| P1-04 | Transitions                            | Deploy SVG preview fix; distinguish duplicate-label transitions or consolidate them; stop ignoring `project.transitions` and edit/remove callbacks; track the actual selected transition; make cards keyboard-operable; test search/favorites/drag/click/edit/remove/reopen/adjacency errors, all preview pixels, retry fallback and preview/export parity.                                                                                                                                                                                                                                                                    |
| P1-05 | Project Library/recovery               | Test create/open/rename/duplicate/trash/restore, 100-project scrolling, offline/quota/corruption, local backup download, cloud reconnect, conflict/recovered copy and safe return from editor. No operation may replace recoverable local data.                                                                                                                                                                                                                                                                                                                                                                                |
| P1-06 | Media import/library                   | Prove image/video/audio and mixed invalid batches, atomic or per-file cleanup semantics, OPFS/private backup states, preview/reconnect/revoke, filtering/paging, no orphaned bytes/catalog rows and no private-reference leakage. If registration fails after cache write, remove only the exact just-written original and prove retry safety.                                                                                                                                                                                                                                                                                 |
| P1-07 | Timeline/monitor                       | Prove every visible toolbar/menu/context/keyboard command through one transaction path: rapid add, remove, split/trim/ripple, markers and DnD. Lock must block destructive clip/track edits; lock/mute/solo must persist or be truthfully session-only and must reconcile with undo/redo. Prove save/reopen, real moving pixels/audio, actionable keyboard-operable missing/revoked-media recovery, handled fullscreen rejection and preview/export parity.                                                                                                                                                                    |
| P1-08 | Canvas/aspect ratio                    | Reconcile the candidate ratio selector with main, persist named ratios as one reversible visual/timeline transaction, keep Fit view-only, and test reopen/export dimensions.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| P1-09 | Captions/transcription                 | Prove manual/SRT/VTT/provider transcription; an all-invalid import must preserve the current document, mixed-valid import must retain valid cues plus diagnostics, and undo/redo must work. Prove Persian/English `lang`/`dir`, text-span styles/background plates, browser/headless preview-export parity, edit/revert/delete, burn-in/sidecar, source unavailable/retry and provider consent/failure.                                                                                                                                                                                                                        |
| P1-10 | Joy Code                               | Reconcile main’s newer consent/session/planner contracts with candidate stale-response/duplicate-submit guards. Registered query tools must return real deterministic context or be hidden/unsupported—never “success” plus “not implemented,” fabricated empty selection, or false missing-media claims. Test bounded egress, attachment privacy, dry-run/reject/approve/apply/undo, project switch, timeout/cancel/provider failure and history.                                                                                                                                                                             |
| P1-11 | Motion/Effect Studio                   | Prove open/edit/save/publish/place/preview/reopen/undo/redo with real project persistence. Motion Code mode must be editable/apply/persisted with validation or hidden/truthfully unavailable; Add Image/Video must select a real asset rather than create source-less layers; save errors must preserve edits and offer accessible Retry. Keep unfinished advanced manipulation experimental.                                                                                                                                                                                                                                 |
| P1-12 | Production Board                       | Prove loading/empty/error/retry, keyboard listbox, stale-revision fail-closed behavior, approve/cancel/retry pending state and request deduplication, live error recovery, lease-expired state and durable event/QA projections.                                                                                                                                                                                                                                                                                                                                                                                               |
| P1-13 | Delivery UX                            | Every blocked channel shows the exact reason and recovery action. Quick export and verified delivery must not share ambiguous state; concurrent submits deduplicate; history survives reload and reconciles terminal inspection.                                                                                                                                                                                                                                                                                                                                                                                               |
| P1-14 | Authentication/privacy                 | Test every supported login method, invalid/expired/rate-limited cases, reload/logout/back, trusted-proxy client IP, CSRF/origin/session policy, request limits and redacted logs. Never expose worker/local/private object references to browser DTOs.                                                                                                                                                                                                                                                                                                                                                                         |
| P1-15 | Accessibility/keyboard                 | The compact timeline menu now excludes disabled items from keyboard navigation and restores focus to its trigger on Escape/selection (`a0a41f3`, 20 focused tests). The complete axe plus real Tab/Shift+Tab/arrows/Escape/Enter/Space/focus-return matrix for login, menus, dock/panels, dialogs, category tabs, timeline, approvals, and recovery alerts remains required.                                                                                                                                                                                                                                                   |
| P1-16 | Desktop layouts                        | Pass 1440×900, 1280×720 and 1024×768 with no clipped core controls or document overflow. At unsupported mobile width show a safe desktop requirement and backup/project access instead of a crushed editor.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| P1-17 | Observability/performance              | Add bounded client error/resource/long-task metrics and server request/query latency/cardinality. Meet the numeric release budgets below for idle editor, category cycling, timeline mutation, import, playback and render. Code-split until the initial editor JS chunk is at most 500 kB minified and prevent per-route budget regression.                                                                                                                                                                                                                                                                                   |
| P1-18 | Rate limiting                          | Either move API abuse/rate-limit buckets to a durable shared/edge store or make and enforce a documented single-instance invariant. Prove restarts and multiple peers cannot reset or split limits; verify trusted-proxy spoof resistance live.                                                                                                                                                                                                                                                                                                                                                                                |
| P1-19 | Provider approvals                     | Remove the fire-and-forget grant-persistence seam. No grant may become externally usable before durable save/audit succeeds; test storage failure, duplicate issue, expiry, revoke and redacted audit.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P1-20 | Worker manual retry                    | Exhausted attempts already terminalize, but explicit retry must create a fresh durable attempt/generation with an intact audit trail and must reject stale completion from older leases.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| P1-21 | Readiness depth                        | Private-object readiness must prove safe reachability (bounded stat/list/sentinel read) instead of only checking that a store object is configured. Keep the probe non-mutating and timeout-bounded.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| P1-22 | Timeline empty/insertion state         | Clicking the container, icon, or explanatory text must all open the same import action; Enter/Space and drag/drop remain functional. Give virtual insertion lanes a semantic keyboard action or remove their false affordance. Disable empty playback or announce why it cannot start. Remove target-only click logic that makes child content inert.                                                                                                                                                                                                                                                                          |
| P1-23 | Effects keyboard/reduced motion        | Effect cards need a semantic keyboard add action and discoverable unavailable reason. Autoplay rejection/reduced-motion/hidden-tab paths must show a deterministic poster or fallback instead of silently blank media.                                                                                                                                                                                                                                                                                                                                                                                                         |
| P1-24 | Library destructive-operation recovery | Replace blocking-only removal UX with focus-safe confirmation/status; storage failure must keep the project card/data intact and expose accessible retry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| P1-25 | Product identity                       | Choose JOY Studio or JOY Media as the canonical user-facing name and make HTML title, shell, login, project library, manifest, release docs and browser assertions agree.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| P1-26 | Responsive timeline semantics          | Compact edit/zoom actions, unique clip labels, labelled track groups, keyboard metadata, and the visible overflow affordance are implemented. Commit `24436c9` adds the visible `More` label while preserving accessible menu semantics; the authenticated 320/375/480/600/768/1024/1280/1440 matrix now passes center-hit, focus, and action-coverage checks with no console errors (retained in `test-output/browser/timeline-a56bb0d.json`).                                                                                                                                                                                |
| P1-27 | Compact header hit-target overlap      | At 320px and 480px authenticated widths, the header's Brand menubar overlaps the Edit controls. Hit-testing the visible centers shows Undo/Redo/Command palette/layout toggles landing on File/Edit/Clip/Joy Code/View/Window menu buttons; the layout toggle is therefore visibly present but not operable, and the workspace preset can also be intercepted at 320px. Reflow the header into a bounded horizontal scroller or compact icon groups with non-overlapping hit targets, preserve accessible names/focus order, and add an automated center-hit/keyboard matrix at 320/375/480/600/768px.                         |
| P1-28 | Timeline continuity cues               | The authenticated showcase timeline contains a 10.3-second visual gap in the 3D Scene lane (12.5s–22.8s) while adjacent lanes continue. The gap may be intentional, but the empty span has no explicit “gap”/coverage cue or lane-level continuity summary, making it difficult to distinguish planned silence from missing media. Preserve intentional gaps, expose them to keyboard/screen-reader users, and add a visual/accessible continuity indicator plus a regression assertion for gap boundaries.                                                                                                                    |
| P1-29 | Timeline marker insertion              | Fixed in `856612f`: Classic and Dual Lens now allocate deterministic collision-free IDs from the current session marker list, with focused rapid-repeat coverage. Post-deploy browser verification on `8e1df6d` at 320px inserted a second marker successfully, collapsed the More menu (`aria-expanded=false`), kept the editor on `https://joyst.ir/`, and emitted no new console errors. Retain this assertion in the source-bound release journey.                                                                                                                                                                         |
| P1-30 | Jobs source-ready worker selection     | Fixed in `2a321d8`: queue readiness now evaluates every connected Worker and enables an operation when any capability-compatible Worker also advertises the selected source asset, instead of failing on the first capability-only Worker. Focused Jobs/polling coverage (19 tests) passed. Retain a live multi-Worker assertion and the source-bound delivery journey before closing P0-12.                                                                                                                                                                                                                                   |
| P1-31 | Timeline marker label uniqueness       | Fixed in `82290df`: generated `Marker N` labels now advance above all existing generated labels across Classic, Dual Lens, toolbar, overflow and ruler paths, while custom labels remain unchanged. Focused marker/context/timeline coverage (17 tests), typecheck, lint and formatting passed. Retain a save/reopen and non-tail-delete/reinsert assertion so visible labels remain unambiguous.                                                                                                                                                                                                                              |
| P1-32 | 3D workspace lifecycle                 | The authenticated 3D tab is stable and truthful when empty: it reports “Scene ready — load a GLB/GLTF file to preview,” exposes Import 3D model, and keeps Add current 3D view to timeline disabled until a scene exists. Commit `e81919e` now persists generated 3D PNG renders through the integrity-checked OPFS original cache before inserting their document metadata, closing the reload-without-pixels hole. A real GLB/GLTF import, preview/render, placement, cloud save/reopen, undo/redo and missing/revoked-source recovery journey is still required; keep 3D authoring experimental until that evidence exists. |

### LIVE-13 — timeline browser certification (2026-08-29)

The final deployed build was exercised from the authenticated in-app browser. A disposable empty
project confirmed that the empty timeline exposes a truthful disabled Play control, an actionable
Import/Browse path, and two empty lanes whose mouse, Enter, and Space activations do not double-fire.
The showcase project then passed the deterministic `2 → 4 → remove non-tail → add` identity check,
lock-blocked deletion, unlock/delete/Undo restoration, mute/unmute, and reload persistence. All 11
visible insertion lanes exposed `aria-keyshortcuts="Enter Space"` and descriptive titles. Inspector
Effects and the Assets Effects category were opened on empty and selected-clip states; every available
asset category (Browse, Brand marks, Arrows, Effects, Icons, Illustrations, Patterns, Photos, Shapes,
Text, and UI graphics) was cycled without a recovery surface, forced navigation, or console log.
The added Effect clip path also completed and was removed cleanly. This closes the browser portion of
P1-07/P1-22/P1-23 for the tested release, but not the real Worker-delivery gate: the editor exposed an
enabled Queue thumbnail action for `asset-intro`, cloud `joylib-*`, and `luna-test-timecode-tone-*`
clips while the API rejected each with `ASSET_NOT_FOUND` because those catalog records were not owned by
the active control-plane project. The failure is recorded as P0-12 and must be fixed before claiming
verified-delivery or source-bound release evidence.

### LIVE-14 — rollback identity rehearsal (2026-08-29)

The immutable previous API/web pair was dry-run validated and applied, and the old API eventually bound
successfully. Its `/ready` response remained 503 solely because the environment still advertised the
new release identity; restoring the target release's identity fields made the old pair ready. The final
`8c1d7b28a23443d5b2f834f87947016310046cee` pair was then restored and passed `/live` and `/ready` on
both `joyst.ir` and `www.joyst.ir`. This proves the binary/pointer rollback is recoverable but leaves
P0-13 open until the rollback script switches identity metadata atomically and its own health check
passes for the target release.

### LIVE-15 — timeline deep browser pass (2026-08-29)

The authenticated Codex in-app browser retested the currently deployed release after the original
Effects-outage report. The Effects asset category opened without navigation, recovery UI, or console
errors; adding an effect clip and undoing it returned the exact prior clip count. Transport playback
advanced the playhead, the video element reached `readyState=4`, and monitor screenshots changed
between samples, proving moving visual frames. The timeline panel's advertised Space shortcut
started and stopped playback, the Split tool produced two exact 3.0-second clips at the playhead,
Duplicate created a collision-free copy, keyboard trim nudged by 0.1 seconds, and Undo restored the
pre-edit duration. Locking Video 1 blocked Delete while leaving the clip intact; marker insertion
also round-tripped through Undo. No new P0 timeline failure was reproduced in this pass.

This pass does not close P1-07: the full 100-operation identity budget, drag/ripple-delete matrix,
independent audio-track audible playback, missing/revoked-media recovery, preview/export parity,
responsive layouts, and real Worker delivery still require final-release evidence. Browser mutations
were confined to the authenticated test project and the candidate branch remains **NO-GO** until
P0-12/P0-13, source-bound Worker inspection, and the release/canary gates are complete.

### LIVE-16 — cloud asset insertion hang (2026-08-29)

The final candidate was retested in a fresh authenticated Codex in-app browser tab at the narrow responsive
viewport. Opening the Effects library and the Inspector Effects/Audio/Transform tabs remained stable, and transport,
Space playback, track visibility, selection, trim nudge, duplicate/undo, and transition focus all responded. A real
shared-library asset (`Black Brush Stroke`) exposed a remaining P0/P1 boundary: clicking **Add to timeline** changed
the status to `Preparing Black Brush Stroke for this project…` and stayed there for more than 18 seconds with no clip,
toast, or document sync. CDP network evidence showed the association POST returned HTTP 200 and the project asset
refresh returned HTTP 200, but no subsequent document transaction was issued. This is not a database crash; it is a
silent client-side insertion/race failure after association (and the status has no timeout/retry).

Required closure: make catalog association and timeline insertion one awaited transaction with a bounded timeout;
refresh the active project/document before dispatching when the root composition is unavailable; clear status on
success; show an actionable error and retry on association or insertion failure; and add an authenticated browser test
that starts from an unassociated cloud asset, observes the 200 association, sees the new clip and document revision,
then reloads and confirms the clip remains. Repeat the same test for image, video, and audio assets and verify Undo.
Until that evidence exists, P0-12 and the timeline portion of P1-07 remain open.

### LIVE-17 — responsive timeline and semantic control pass (2026-08-29)

The authenticated Codex in-app browser retested the live `915b0d9` build at both the compact
480×1370 viewport and a 1366×900 desktop viewport. Inspector Effects/Audio/Transform and the
Effects asset category remained stable: the URL stayed `https://joyst.ir/`, no recovery surface
appeared, and the browser returned zero warning/error logs. Effect insertion completed with the
success status and was reverted with Undo.

The compact viewport exposed a release gap rather than a database outage. With a clip selected,
the Duplicate and Ripple Delete buttons were present but their parent edit toolbar had
`display:none` and zero-size geometry; Add Marker was likewise hidden. Those three actions were
available in the compact overflow popover, but the trigger is icon-only and the popover has no
zoom-in, zoom-out, or range-slider replacement; Fit is the only visible zoom affordance. The
same controls were visible at desktop width and keyboard duplication worked only after focusing
the timeline panel, which is not discoverable from the compact UI. The timeline also
contained duplicate accessible names (`Intro, 3.0s` and `Black Brush Stroke, 5.0s`) and its
track containers had no role or accessible name, making screen-reader navigation and precise
selection ambiguous. The playhead slider responded to arrows, but no keyboard shortcut is
advertised.

Required closure is tracked as P1-26/P1-07/P1-15: define and test a compact-layout overflow or
keyboard surface for every edit/zoom command (including disabled reasons), expose a reachable
zoom control, give each clip a unique accessible name that includes a stable identity/time range,
label track groups and playhead keyboard semantics, and rerun the responsive matrix with a fresh
project plus save/reopen and undo evidence. This pass does not reproduce the reported Effects
subtab crash, but it does not close the broader Effects soak or release gates.

### LIVE-18 — Automate workspace panel wiring (2026-08-29)

The same browser pass found that the Automate preset could not show Jobs even though the panel was
registered: the seeded `context` group contained only `inspector`, so selecting the preset's requested
`jobs` view was a no-op. Commit `6d98bff` adds the specialist context views (`inspector`, `motion`,
`audio`, and `jobs`) to that group and adds preset contracts for Enhance, Audio & Captions, and
Automate. After resetting the saved dock layout and selecting Automate in the authenticated browser,
Jobs rendered with Workers/Queue/Pair tabs and the current project context; the URL remained stable and
no browser errors were recorded. This closes the preset-wiring defect, but P1-26 remains open for the
compact edit/zoom affordances, unique clip names, labelled track groups, and the full responsive matrix.

### LIVE-19 — timeline semantic identity repair (2026-08-29)

Commit `4c0f4a1` closes the ambiguity portion of P1-26. Timeline clips now expose a unique accessible
name containing the display label, duration, time range, and durable clip ID, and are described as
`timeline clip`; track wrappers expose labelled `group` semantics (`V10 Video 1 track`, etc.). The
playhead slider advertises its Arrow/Home/End keyboard contract. The deployed browser verified distinct
names for the two split `Intro` clips and all three `Black Brush Stroke` clips, labelled track groups,
and the shortcut metadata with no recovery UI or console errors. Compact primary-toolbar hiding and the
missing compact zoom replacement remain open under P1-26 until the complete width matrix passes.

### LIVE-20 — compact zoom affordance repair (2026-08-29)

Commit `94c842d` adds Zoom out and Zoom in to the compact timeline overflow menu. The live
480×1370 browser verified both entries are enabled and that Zoom in changes the slider to Follow
mode; Fit then restores the prior Fit state. This closes the missing-compact-zoom portion of P1-26.
The primary edit toolbar remains intentionally collapsed at this breakpoint (Duplicate/Ripple
Delete/Add Marker are available in the overflow), so the visual affordance and full responsive
matrix at 320/480/768/1024/1280/1440 remain release work.

### LIVE-21 — compact header hit-target regression (2026-08-29)

The authenticated Codex in-app browser was exercised with the timeline visible at 320×900,
480×900, and 768×900. At 320px, the layout toggle center is intercepted by the Clip menu and the
workspace preset center by Joy Code; at 480px, Undo and Redo are intercepted by Joy Code/File,
Command palette by View, and the layout toggle by Window. The controls report enabled, visible
geometry, and correct accessible names, but a real pointer at their centers activates the menu
layer instead. At 768px the same centers resolve to their intended controls. This is a responsive
header stacking/hit-area defect that can make timeline undo, layout, and workspace recovery paths
unreachable on small screens; it is tracked as P1-27 and must be closed before the compact timeline
matrix can be certified. No URL change or browser warning/error was observed during this pass.

### LIVE-22 — compact header repair verification (2026-08-29)

Commit `2dc53c7` separates the Brand, Edit, and Deliver header rows at compact widths, constrains
each scrollable group, and preserves Brand → Edit → Deliver DOM order. The fix was deployed in
release `9379250e28df232ea138b19446cf08b81fe62075`. A fresh authenticated browser verified the
center hit targets at 320×900, 480×900, 768×900, and 1280×720: Undo, Redo, Command palette,
layout toggle, and Workspace preset no longer resolve to a neighboring menu. The layout toggle
also changed between Widescreen and Vertical at 480px without navigation or console warnings.
This closes the hit-target portion of P1-27; the remaining closure is the full 320/375/480/600/768
keyboard/focus matrix and regression coverage in the final release gate.

### LIVE-23 — timeline continuity and Effects subtab retest (2026-08-29)

On the authenticated live editor, the Inspector Effects tab and the Assets → Effects (21) category
were each opened repeatedly (four alternating cycles) while a selected Effects clip was present.
Every cycle retained `https://joyst.ir/`, rendered the expected Glow controls/catalog cards, and showed
no recovery surface or error text. The timeline DOM exposed durable clip ranges for all visible clips;
the only uncovered continuity gap is the 3D Scene lane's intentional-looking 12.5s–22.8s empty span
between `showcase-scene3d` and `24 7 Badge`. This is not a crash or database failure, but it is a
release UX/accessibility gap tracked as P1-28 until the product communicates planned empty spans and
the final keyboard/focus matrix asserts their boundaries.

### LIVE-24 — timeline gap indicator repair (2026-08-29)

Commit `7f75c76` adds deterministic interior-gap detection and renders each meaningful gap as a
striped, keyboard-focusable `timeline gap` note with start/end/duration labels. The helper merges
overlaps, ignores sub-frame slivers, and has focused unit coverage; the authenticated browser matrix
verified the corresponding 3D Scene gap at 12.5s–22.8s without changing clip identity. This closes
the implementation portion of P1-28; the final release evidence must still retain the gap assertion
alongside the full timeline keyboard/focus matrix.

### LIVE-25 — bounded cloud-asset timeline insertion (2026-08-29)

The earlier cloud-asset pass showed that association could succeed while the
timeline insertion callback remained unbounded, leaving the library on
“Preparing …” if the active composition or document transaction stalled. The
editor now treats association and insertion as one bounded operation (15-second
timeouts), refuses duplicate clicks for the same asset while work is pending,
and reports an actionable retry message when no insertion target is available.
The contract test covers the timeout, deduplication, and failure-status paths.
The authenticated browser journey still must verify image, video, and audio
catalog assets end-to-end with a persisted document revision and Undo; this
source fix does not replace that real-service evidence.

### LIVE-26 — Worker source preflight (2026-08-29)

The non-browser release audit confirmed that a Worker can lease a source-backed
job only when its hello advertises the selected asset ID in `localAssetIds`.
The Jobs panel previously enabled thumbnail/audio queue actions based only on
capability, allowing a guaranteed queued-but-unprocessable job for a cloud
catalog asset. Queueing now stays disabled with an explicit reason until a
connected compatible Worker advertises the selected source, and the focused
Jobs contract tests cover this fail-closed behavior. A real authenticated
journey must still exercise a source-backed asset through lease, upload,
inspection, and Motion placement before P0-12 is closed.

### LIVE-27 — post-fix backend gap audit (2026-08-29)

The non-browser audit after the timeline and Worker preflight repairs found the remaining
release gaps that must stay visible in this plan. P0-04 now coalesces concurrent Workers/Jobs
reads per project and token, and repeated polling-loop starts are idempotent, but the four
panel-specific polling loops still require one visibility-aware rate-budget evidence artifact.
P0-02 now serializes migration startup with a single transaction and PostgreSQL advisory lock,
with concurrent-startup coverage. A real PostgreSQL schema-copy rehearsal removed ledger rows
003/004 and their objects, ran the deployed migration binary twice, restored all four ledger rows
and objects, and left production data unchanged. P1-21 now wires the bounded, non-mutating
object-store probe into production readiness with a fixed 2500ms timeout; a real deployed probe
reached the configured store in 192ms. A staged cold-start/release-canary proof and retained
readiness artifact remain required.

P0-03 and the persistence half of LIVE-25 remain partially open: document saves now serialize per
owner/project and later writes reread the persisted CAS head, but the browser still needs GET
hydration plus reload, conflict recovery, and Undo evidence for image/video/audio. P0-12 also remains open until a real
authenticated source-backed Worker journey leases a selected asset, uploads a derivative, passes
inspection, and places at least two results in Motion. These are implementation/evidence gaps,
not evidence of the reported Effects-subtab crash; the Effects and timeline retests remain stable.

### LIVE-44 — hidden Windows Worker startup (2026-08-29)

The local Windows Worker now has a reproducible headless startup path. The existing `JOY Media Local
Worker` logon task was repointed from the retired `joy-vps` checkout to this standalone `joy-media`
checkout, configured with the canonical `https://joyst.ir/api`, a persisted Worker state path, hidden
execution, `StartWhenAvailable`, and bounded restart settings. The task is running with one Worker
process and no visible console window. This tranche adds `scripts/run-worker-headless.ps1`, an
idempotent `scripts/install-worker-autostart.ps1`, and updates `run-worker.bat`/Worker docs so the
setup is portable to the eventual Windows application package. This does not bypass owner pairing:
the first run still waits for one-time approval, after which the authenticated editor discovers the
connected Worker on open. A real source-bound lease/upload, retained inspection, Motion placement,
and final release evidence remain open until that owner-only pairing step is completed.

### LIVE-45 — final promotion evidence for the headless-worker tranche (2026-08-29)

Release `8d0878f6f8803e87c0ef866d5fcc3ac9bd7d4dae` (the headless-worker promotion, including the
`252393e` implementation) is active on both canonical public hostnames and its origin. The API
`/live`/`/ready` checks, database/object-store readiness, release identity, and zero-restart service
state all pass. Full repository tests pass (3,603 passed, 2 documented skips), CodeRabbit reports
zero findings, and the authenticated browser recheck cycles all nine Effects categories plus the 3D
surface without a crash, forced navigation, or console error. A final-source disposable PostgreSQL
rehearsal applied all four migrations twice and started the previous Worker/API binary against the
upgraded ledger successfully. The release gate therefore has only two intentional failures: missing
source-bound `authenticated-editor-1.0` evidence and its required `sourceProvenance`. Those cannot be
manufactured; they require the owner-approved Worker session and a real lease/upload/inspection/Motion
journey.

### LIVE-46 — native Windows Worker executable (2026-08-29)

The Worker now has a real Node 22 single-executable launcher at
`apps/worker/bin/joy-worker.exe`, built reproducibly by
`scripts/build-worker-exe.ps1` with pinned `postject@1.0.0-alpha.6`. The SEA
bootstrap launches only the fixed audited Worker entrypoint, keeps GPU/model
dependencies external, redirects diagnostics to the private Worker log, and
passes a self-test. The hidden `JOY Media Local Worker` logon task builds the
launcher when missing and starts it through the existing restart-safe runner;
`run-worker.bat` prefers the executable while retaining a Node fallback. This
is the Windows application-worker architecture described in
`plan/JOY-WORKER-WINDOWS-PLAN-2026-08-29.md`. It does not bypass owner pairing,
does not execute arbitrary shell commands, and still requires source-bound
Worker delivery evidence before the strict release gate can close.

### LIVE-29 — editor race hardening (2026-08-29)

The final source audit closed two deterministic editor races. `syncProjectDocumentBinding` now
serializes concurrent writes per owner/project, rereads the latest persisted binding before each
queued compare-and-swap update, and coalesces duplicate in-flight revisions. `BoundedPollingLoop.start()`
is idempotent, preventing duplicate timers when panels remount or re-enter view. Focused document-sync,
control-plane, creative-brief, Joy Code, polling, and timeline tests pass. Browser proof is still
required for GET hydration, reload/conflict recovery, Undo, and visibility-aware polling budgets.

### LIVE-30 — authenticated timeline browser certification (2026-08-29)

The orchestrator retested the deployed editor with a selected Effects clip: Inspector → Effects
rendered Glow controls, Assets → Effects (21) and all 12 asset categories survived four alternating
cycles, and the preview action remained on the editor URL without recovery/database errors. Timeline
zoom, 100ms keyboard playhead movement, and reload all remained stable; the 3D Scene lane exposed
the expected 10.3s empty span from 12.5s to 22.8s and the striped keyboard-focusable `timeline gap`
note remained present after reload. Evidence is retained in the ignored local artifact
`test-output/browser/timeline-5725c49e08c5.json`; this closes the reported Effects-subtab crash as
unreproduced and keeps only the source-bound editor/Worker journeys and final keyboard matrix open.

### LIVE-31 — Worker derivative integrity audit (2026-08-29)

The non-browser audit identified three P0-14 hazards: completion could issue a successful receipt
without a matching registered/retained object, registration failure could orphan the exact uploaded
bytes, and retry generations could collide with an earlier `media_derivatives` row. Commit
`15898ab` closes the implementation hazards with generation-scoped derivative IDs/object references,
owner/project/asset/kind/checksum/size/descriptor validation, exact-object cleanup, stale-lease
rejection, and Local/Postgres/HTTP/Worker regression coverage (130 focused tests plus API/Worker
builds). The daemon's normal order remains revalidate local derivative → upload → complete lease.
P0-14 is still a release blocker only because the real authenticated Worker lease/upload/completion,
retained inspection, and Motion-placement evidence has not yet been captured on the deployed SHA.

### LIVE-28 — stable promotion and canary (2026-08-29)

The final source revision is promoted only as an immutable API/web release after the release
identity, origin, and public-domain `/live` and `/ready` checks match. The guarded rollback
rehearsal passes, and each final promotion has a detached 30-minute canary with retained identity
checks against local origin plus `joyst.ir` and `www.joyst.ir`.

The release gate is clean for commands, tests, generated artifacts, manifests, builds, static
inventory, manifest, SBOM, and feature status. It intentionally remains NO-GO for the linked
browser evidence checks—source-bound `authenticated-editor-1.0` evidence is absent, and the real
authenticated Worker lease/upload/inspection/Motion journey (P0-12) still requires the browser
pairing safety step before it can be recorded. The implementation portion of P0-14/LIVE-31 is now
covered by `15898ab`; the retained delivery journey remains open. No new Effects-subtab or timeline
crash was observed in the prior authenticated matrix.

### LIVE-32 — final-source timeline and Effects retest (2026-08-29)

The orchestrator-only authenticated browser pass was repeated against the immutable `15898ab`
release at `https://joyst.ir/`. Inspector → Effects and Assets → Effects (21) remained on the
editor URL through four alternating cycles; the selected `showcase-effect` clip rendered its Glow
controls, all 12 observed asset categories loaded, and the browser reported no recovery/database/
uncaught-error text or console errors. The timeline exposed the intentional 3D Scene empty span as
an accessible, keyboard-focusable note: `12.5s–22.8s` (10.3s), “Gap in V7 3D Scene … no media in
this span”. This confirms the reported Effects-subtab outage is not reproducible on the final source
and that the continuity cue survived the browser pass.

The same live Jobs panel reported `Initialized · No worker connected`, `0 connected · 4 active`,
with pairing controls present but no pending one-time code/session. No pairing code was entered.
Consequently this artifact is timeline/Effects evidence only; it does not satisfy the required
`authenticated-editor-1.0` Worker delivery, retained inspection, Motion placement, persistence,
responsive keyboard matrix, or polling/soak budgets. The release remains **NO-GO** until those
source-bound gates are completed.

### LIVE-33 — rollback identity closure (2026-08-29)

The historical LIVE-14 rehearsal exposed a stale-identity failure when an old binary was restored.
That implementation gap is closed by `54e0aa0` and the cold-start tolerance follow-up `4ad10d3`:
rollback reads the target archive's release identity, updates the API environment with that exact
commit/tree/lock/schema, restarts the API, and checks `/live` plus dependency-aware `/ready` before
returning. The final `9179afdbc82ed69503bc0103f7edf37469144e3f` release passed the VPS rollback
rehearsal and origin/public identity checks. P0-13 is therefore closed at the implementation level;
the remaining NO-GO items are the real Worker journey and the other source-bound performance and
responsive evidence listed in LIVE-32.

### LIVE-34 — compact timeline affordance audit (2026-08-29)

The non-browser timeline audit found one remaining P1-26 usability defect: at compact widths the
overflow control was icon-only even though it contained the complete edit/zoom menu. Commit
`24436c9` adds the visible `More` label while retaining the existing accessible name and menu
semantics, with focused timeline/empty-state coverage (13 tests). The follow-up authenticated
responsive matrix must verify the label, hit targets, focus order, and menu action coverage at all
320/375/480/600/768/1024/1280/1440 widths before P1-26 can be closed.

The follow-up matrix subsequently passed on the deployed `a56bb0d` release: compact widths exposed
the visible `⋯ More` label and all six menu actions, opening focused `Add Marker`; desktop widths
exposed every direct edit/zoom control with correct center hit targets. Eleven labelled track groups
and the accessible 3D Scene gap note remained present, with zero browser console errors. Evidence is
retained in the ignored local artifact `test-output/browser/timeline-a56bb0d.json`; P1-26 is closed
for this release, while the separate source-bound Worker and performance gates remain open.

### LIVE-35 — immutable migration baseline audit (2026-08-29)

The non-browser backend audit found that migration 001 still imported mutable current DDL, so a
later schema edit could invalidate the deployed baseline checksum and make additive migrations
unsafe. Commit `1fd9c15` freezes the exact historical 001 schema in
`apps/api/src/postgres-baseline-schema.ts` and covers its checksum; focused API/migration/readiness/
Worker suites pass (176 tests). P0-02 remains open only for a retained real schema-copy rehearsal
covering old-schema/new-binary/new-schema and rollback to old-binary behavior.

### LIVE-36 — guarded ordinary-editor autosync (2026-08-29)

The non-browser audit found that ordinary timeline/media revisions were never passed to the durable
document CAS path; only Joy Code and Creative Brief requests persisted revisions. Commit `49aee1f`
adds a hydration-before-write barrier, owner/project-scoped debounce and coalescing, CAS serialization,
bounded 2s→60s retry, local-recovery preservation, and conflict stop/toast behavior. Seventy-eight
focused autosync/sync/hydration/control-plane/polling tests plus typecheck pass. Live authenticated
save/reload/restart/conflict/recovered-copy evidence is still required before P0-03 closes.

### LIVE-37 — Jobs bootstrap polling bound (2026-08-29)

Commit `1e78ea4` prevents JobsPanel from re-running control-plane project bootstrap every 10 seconds;
it ensures once per project ID and resets only on project switch. Seventy-two focused polling,
document, client, and Jobs contract tests pass. Endpoint/query-rate and hidden-tab budget evidence
for all five polling surfaces remains open under P0-04.

### LIVE-38 — real migration compatibility rehearsal (2026-08-29)

Against a disposable PostgreSQL database created on the JOY Media VPS, the deployed build applied the
frozen 001 baseline, upgraded to all four migration ledger rows with the new binary, and then ran the
previous `ef6aa92` migration binary successfully against the upgraded schema. The additive `jobs`
columns `generation` and `lease_token` were present; the temporary database was dropped by cleanup.
This is the migration/rollback evidence for P0-02; repeat or bind it to the final source revision
if another code change changes the release archive.

### LIVE-39 — compact timeline keyboard safety repair (2026-08-29)

Commit `a0a41f3` closes the remaining compact overflow keyboard trap: disabled actions are skipped by
initial focus and Arrow/Home/End navigation, and Escape or selection returns focus to the trigger.
Seven focused suites (20 tests), typecheck, lint, formatting, and diff checks pass. Full application
axe and keyboard journeys remain required under P1-15.

### LIVE-40 — timeline marker collision found and repaired (2026-08-29)

The orchestrator-only authenticated browser test against `8222771` reproduced a real timeline
failure at 320px: the existing playhead marker used `marker-0`, and More → Add Marker dispatched
the same ID. The API stayed on the editor route, but the client threw `RangeError: marker
"marker-0" already exists` and the overflow menu remained open. This is a UI/data-integrity gap,
not a PostgreSQL outage; it is tracked as P1-29.

Commit `856612f` adds the pure `nextTimelineMarkerId` allocator, reads the current session marker
list at dispatch time, and applies deterministic suffixes to both Classic and Dual Lens creation
paths. Focused marker/helper/context/timeline/overflow tests (17), typecheck, lint, formatting,
and diff checks pass. A post-deploy browser assertion that Add Marker succeeds without a new console
error and closes the menu is now green on the deployed `8e1df6d` release: the marker count advanced
from one to two, `aria-expanded` returned to `false`, the editor URL stayed stable, and no fresh
console error was recorded. P1-29 is closed for implementation and browser behavior; the remaining
release NO-GO is the separate source-bound Worker journey and its required end-to-end evidence.

### LIVE-41 — follow-up timeline and Jobs gap audit (2026-08-29)

The non-browser follow-up audit found two concrete correctness gaps that were not visible in the
earlier browser matrix. Jobs queue readiness used the first capability-compatible Worker, so a
second connected Worker with the selected source could be ignored; commit `2a321d8` now evaluates
all candidates and keeps queue actions fail-closed until one Worker has both capability and source.
The focused Jobs/polling suites (19 tests) passed. Marker IDs were already collision-safe, but
visible generated labels still reused `Marker N` after a non-tail deletion; commit `82290df`
advances generated labels above all existing generated labels across every marker creation path,
preserving custom labels. Focused marker/context/timeline suites (17 tests), typecheck, lint and
formatting passed. These source fixes close P1-30/P1-31 at implementation level; final release
closure still requires the authenticated source-bound Worker delivery/inspection/Motion journey,
save/reopen evidence, and the performance/accessibility gates listed below. The Effects audit also
confirms the remaining P1-02/LIVE-02 risk is preview-load pressure (all filtered cards mount and
attempt playback without viewport/concurrency gating), not evidence of a PostgreSQL crash loop.

### LIVE-42 — authenticated 3D tab audit (2026-08-29)

The orchestrator opened the authenticated 3D tab on the deployed editor. The scene surface stayed
on `https://joyst.ir/`, displayed the truthful empty-state message “Scene ready — load a GLB/GLTF
file to preview,” exposed an accessible Import 3D model action, and kept Add current 3D view to
timeline disabled until a model is loaded. No new browser console errors, recovery surface, or
forced navigation occurred. This closes the empty-state crash question but not P1-32: the real
GLB/GLTF import, render/preview, timeline placement, durable save/reopen, undo/redo, and
missing/revoked-source recovery journey remains unverified, so 3D authoring stays experimental.

### LIVE-43 — source closure tranche for Effects and Worker asset scope (2026-08-29)

Four non-browser gaps identified by the follow-up audit are now implemented on `main`. Commit
`03d2732` makes cloud bootstrap recovery retryable and records the observed remote CAS base before
persisting newer local edits. The live 3D check also exposed a persistence hole beyond the empty-state
behavior: commit `e81919e` writes generated 3D render PNGs to the integrity-checked OPFS original cache
before dispatch, so a reloaded document can recover its pixels locally instead of silently restoring only
an unusable asset reference. Cloud registration and cross-browser source durability remain gated by the
real 3D journey. Commit `b4f1072` makes associated owner/shared-library image sources valid inputs for mask jobs, matching
the control-plane asset authorization query and adding a regression contract for association teardown.
Commit `268e441` bounds Effects preview resource pressure: cards mount only near the viewport, at most
12 media nodes are mounted and at most 6 videos may play, hidden/reduced-motion states pause and show
deterministic posters, and autoplay/decode failures expose an accessible retry. Focused API and Effects
suites, typecheck, lint, formatting and diff checks passed. The live Worker delivery/inspection journey
and the 30-minute Effects performance soak remain release gates; no source-only change can substitute
for those real-service artifacts.

## Numeric release budgets and retained evidence

These are stop/go gates, not optional targets:

| Surface               | Budget                                                                                                                                                                                                                                   | Retained artifact                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Idle polling          | After a 60-second warm-up, each polling endpoint is at most 6 requests/minute while visible and at most 1 request/minute after the document has been hidden for 10 seconds; no duplicate in-flight request per key.                      | `test-output/release-performance/polling.json` with endpoint and PostgreSQL query counts |
| Effects               | A 30-minute all-category/search/favorites cycle has 0 uncaught exceptions or forced navigations, at most 6 concurrently playing previews and 12 mounted preview media nodes, and JS heap no more than 20% above the five-minute plateau. | `test-output/release-performance/effects-soak.json` plus sanitized trace summary         |
| Timeline identity     | A deterministic 100-operation add/remove/import sequence and the live `2 → 4 → 3 → 4` reproduction end with exact expected counts, globally unique durable IDs, correct clips, and identical save/reopen plus undo/redo state.           | `test-output/release-performance/timeline-integrity.json`                                |
| Editor responsiveness | During effects cycling, timeline edits and playback, long tasks consume less than 5% of measured wall time; the initial editor JS chunk is at most 500 kB minified.                                                                      | `test-output/release-performance/editor.json` and build manifest                         |
| Static inventory      | Every manifest reference plus all 33 effect PNGs, 19 effect WebMs and transition SVGs has source/dist SHA-256, non-empty size, expected signature/MIME, and public/origin result; unknown asset-like paths return 404.                   | `test-output/release-gate/static-assets.json`                                            |
| Production canary     | For 30 continuous minutes the isolated canary has 0 unexpected console/page exceptions, 0 canary HTTP 5xx, 0 readiness failures, 0 release-identity/hash/MIME mismatches, and all request/query rates remain within the polling budget.  | `test-output/release-performance/canary.json` bound to SHA/archive                       |

### P2 / explicitly non-GA surfaces

Templates, workflow authoring/provider ports, local/GPU job panels, plugin marketplace/demo, Dual
Lens durable graph, PSD apply flow, 3D authoring and MCP authoring remain hidden or experimental
unless their own real-service persistence/security/accessibility/browser matrices pass. Update
`docs/product/FEATURE-STATUS.md` from final mounted routes and flags. Source presence is not enough to
promote a feature. Replace synchronous FFmpeg/FFprobe subprocesses on long-lived API/Worker/render
hot paths, or prove by profiling that each remaining synchronous call is isolated outside service
event loops and cannot starve heartbeats/readiness.

## Execution waves

### Wave 0 — freeze evidence and create the canonical integration line

1. Refresh Gbrain brief, remotes, branch tips, merge base and clean status.
2. Preserve the current candidate and main-native branches as immutable recovery references.
3. Create the finish branch from reviewed main-native `b6aa47e` (or current `github/main` plus those
   nine reviewed commits if main moved).
4. Update the reconciliation matrix from `git range-diff`, contract tests and final agent reports.

Exit: every unique behavior has one owner/decision; no unclassified commit family remains.

### Wave 1 — database, sync, polling and static/runtime stability

Land P0-02 through P0-08, P0-10, P0-11, P1-01 through P1-04, and the supporting P1-17 through
P1-21 work in small tranches. Each tranche needs focused tests, cross-review, full
typecheck/lint/format, affected builds and a clean diff. Run schema tests against real PostgreSQL,
not only mocks.

Exit: local/staging editor saves to V2 and the named retained artifacts prove every numeric polling,
Effects-soak, editor-responsiveness and static-inventory budget above.

### Wave 2 — complete every production journey

Close every remaining P1 item through P1-25. The orchestrator runs browser journeys after
source/unit/integration checks pass; sub-agents never run browser tools. Fix observed failures
immediately and repeat the entire affected journey, not only the last click.

Exit: all production surfaces satisfy success/empty/loading/error/retry/permission and persistence
contracts with zero P0/P1 defects.

### Wave 3 — clean release candidate

Run from two clean checkouts:

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @joy-media/editor-web build
pnpm --filter @joy-media/api build
pnpm --filter @joy-media/worker build
pnpm verify:ci
pnpm exec vitest run tooling/release/src/gate.test.ts
git diff --check
git status --short
```

Also run gitleaks with redacted output, license review, CycloneDX validation, migration/rollback,
static archive/MIME checks and performance/soak budgets. Required result: zero failed critical gate,
zero high/critical unwaived production advisory, clean tree, matching reproducible hashes.

### Wave 4 — orchestrator-only browser certification

The orchestrator alone executes:

- real auth/session reload;
- project create/open/rename/recovery/conflict;
- real media import, playback and audio;
- every Effects category/search/favorite/add/drag plus repeated category soak;
- every transition preview and add path;
- timeline/monitor/captions/Motion/Effect Studio/Joy Code/Production Board journeys;
- real Worker verified delivery, passed inspection, download/reopen and restart recovery;
- 1440×900, 1280×720, 1024×768 and unsupported-width guard;
- console/page/network/MIME/accessibility/performance inspection.

Capture only sanitized failure artifacts plus final source-bound evidence. No browser evidence from a
sub-agent is admissible.

### Wave 5 — promote, deploy, verify, observe

1. Rebase/merge only reviewed changes; rerun the complete release gate on the final SHA.
2. Verify the `github` and `vps` remote URLs both identify this standalone JOY Media repository,
   then merge to `main` without force and push the same SHA to those two remotes only.
3. Verify database/object metadata backups and the tested rollback target.
4. Upload and verify the immutable archive/manifest/SBOM/hashes before activation. Rehearse
   `deploy/joy-media-rollback.sh` against the previous immutable release pointer.
5. Apply only rehearsed additive migration; activate API/web release atomically; restart only
   `joy-media@api` when required; reload Nginx only after `nginx -t`.
6. Verify direct origin first using `curl --noproxy '*' --resolve <hostname>:443:<origin-ip> ...`
   with private values read at runtime, then verify `joyst.ir` and `www.joyst.ir`: release identity,
   `/live`, dependency-aware `/ready`, auth/project reads, every manifest asset/MIME, and
   unknown-asset 404.
7. Run one isolated production canary and the full read-only smoke for 30 minutes. Any readiness,
   source/hash/MIME, authenticated journey, Worker/inspection, console/page-error, request/query
   budget, or canary-5xx failure immediately runs `deploy/joy-media-rollback.sh` without user input;
   verify the restored release at origin and both public hostnames.
8. Record the confirmed non-secret release/rollback result and relevant service state in Gbrain.

Exit: the completion contract is satisfied and a concise final report names the exact main SHA,
release archive/hash, migration, canary, inspection, public checks and rollback target.

### LIVE-46 — native Windows Worker executable (2026-08-29)

The Worker now has a real Node 22 single-executable launcher at
`apps/worker/bin/joy-worker.exe`, built reproducibly by
`scripts/build-worker-exe.ps1` with pinned `postject@1.0.0-alpha.6`. The SEA
bootstrap launches only the fixed audited Worker entrypoint, keeps GPU/model
dependencies external, redirects diagnostics to the private Worker log, and
passes a self-test. The hidden `JOY Media Local Worker` logon task builds the
launcher when missing and starts it through the existing restart-safe runner;
`run-worker.bat` prefers the executable while retaining a Node fallback. This
is the Windows application-worker architecture described in
`plan/JOY-WORKER-WINDOWS-PLAN-2026-08-29.md`. It does not bypass owner pairing,
does not execute arbitrary shell commands, and still requires source-bound
Worker delivery evidence before the strict release gate can close.

## Stop/continue rules for the autonomous goal

- Do not stop for ordinary design choices, review comments, test failures or retryable service
  errors; diagnose, fix and continue.
- Do not ask the sleeping user for confirmation. Existing task authorization covers scoped commits,
  branch reconciliation, main push, additive migration, JOY Media deployment and rollback after the
  gates pass.
- Never bypass authentication, security, destructive-data or release gates. Use the authenticated
  session already provided and safe disposable fixtures.
- If an external condition is genuinely impossible to change (for example an expired session that
  requires a human-only OTP), continue every independent task and retry safe alternatives. Mark the
  goal blocked only after the same external human-only blocker persists across three consecutive
  goal turns/runs, counting the original occurrence, after all independent work and safe retries are
  exhausted. Do not spin indefinitely and do not falsely mark complete.
