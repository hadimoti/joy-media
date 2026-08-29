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

| ID    | Gap                                                                                                                                                                                                                                                     | Required closure and acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-01 | Canonical lines diverge.                                                                                                                                                                                                                                | Start from `b6aa47e`; classify every candidate-only/main-only behavior by the reconciliation matrix; port focused contracts; no large blind merge. Final integration branch must be clean, reviewable, and based on current `github/main`.                                                                                                                                                                                                                                                      |
| P0-02 | Revisioned project document storage is not proven against the live schema, and schema changes still run from one mutable startup DDL blob.                                                                                                              | Keep the current `project_documents` contract backward-compatible, introduce immutable ordered migrations plus a durable schema-version ledger/lock, make application startup verify rather than invent migration order, add real old-schema→new-binary and new-schema→old-binary tests, and rehearse rollback on a production-schema copy.                                                                                                                                                     |
| P0-03 | Project bootstrap and cloud sync fail live.                                                                                                                                                                                                             | Make project ensure idempotent without routine POST→409→GET traffic; bootstrap a fresh V2 head, hydrate an existing head, preserve local recovery on all failures, and prove save/reload/restart/conflict/recovered-copy behavior.                                                                                                                                                                                                                                                              |
| P0-04 | Retry and polling amplifiers can load API/PostgreSQL.                                                                                                                                                                                                   | Integrate `b5b7404` (2s→60s sync failure backoff with stable idempotency), use one bounded/visibility-aware loop for Jobs, Audio, Enhance, Mask, and delivery status, deduplicate concurrent requests, add jitter, and load-test request/query rates. The editor loops are now bounded locally; endpoint/query-rate evidence is still required before closure.                                                                                                                                  |
| P0-05 | Verified delivery is unavailable.                                                                                                                                                                                                                       | Pair a real Worker, prove durable hello/lease/heartbeat/attempt exhaustion/manual retry/cancel, export a real artifact, retain it, run deep inspection, persist terminal state, and survive API/Worker restart.                                                                                                                                                                                                                                                                                 |
| P0-06 | Release evidence is mocked and not source-bound.                                                                                                                                                                                                        | Orchestrator runs `authenticated-editor-1.0` on real services, records commit/tree/lockfile/archive hashes, verified-delivery channel, passed inspection and post-Motion placement. Evidence must be <24h old and match a clean checkout.                                                                                                                                                                                                                                                       |
| P0-07 | Static release gate is incomplete.                                                                                                                                                                                                                      | Gate every emitted JS/CSS/font/Worker asset, both transition SVGs, all 33 effect PNGs, all 19 effect WebMs, manifest references, non-empty bytes, hashes and MIME signatures. Unknown asset-like paths must 404, never return SPA HTML.                                                                                                                                                                                                                                                         |
| P0-08 | Current production source/release identity is stale or unavailable.                                                                                                                                                                                     | `/live` proves process liveness; `/ready` proves PostgreSQL, schema version, object store where required, and validated non-secret release identity. Origin and public responses must identify the same released SHA/archive.                                                                                                                                                                                                                                                                   |
| P0-09 | No final main/deploy proof.                                                                                                                                                                                                                             | Run the full gate twice, fast-forward/merge reviewed integration to `main`, push GitHub and JOY Media VPS remotes without force, deploy the exact archive, canary, observe, and automatically roll back on any failure.                                                                                                                                                                                                                                                                         |
| P0-10 | CI does not produce real PostgreSQL/object-store/API/Worker/authenticated-browser release evidence.                                                                                                                                                     | Add an isolated real-service CI/release lane with PostgreSQL, private-object test storage, API, Worker/render host and orchestrator-produced authenticated evidence. Mock/`pg-mem` suites remain useful but cannot satisfy this gate.                                                                                                                                                                                                                                                           |
| P0-11 | Timeline track IDs are derived from current array length and can collide, hide, or overwrite rows after removal.                                                                                                                                        | Replace every toolbar/context/drop-created ID with one durable collision-free allocator shared by all command paths. Reject duplicate IDs in validators/loaders. Add randomized add/remove/import plus rapid-repeat tests, then prove exact track/clip identity through undo/redo, save/reopen, project switch, render, and browser reproduction of the live `2 → 4 → 3 → 4` sequence.                                                                                                          |
| P0-12 | Browser-visible My media/cloud assets are not always present in the active control-plane project. Selecting a real `assetId` and queueing a thumbnail currently returns `ASSET_NOT_FOUND`, so verified Worker delivery cannot complete from the editor. | Reconcile asset-library scope with job scope: either register/import the asset into the active project before enabling Queue thumbnail, or make the job API intentionally accept owner/shared-library assets with an audited project association. Add an authenticated browser test that selects a catalog asset, queues it, receives a Worker lease, uploads a derivative, and reaches verified inspection; never show an enabled queue action that is guaranteed to return `ASSET_NOT_FOUND`. |
| P0-13 | The rollback script switches immutable API/web pointers but leaves the final release identity environment in place; the previous binary therefore binds and serves `/live` while `/ready` is 503 (`releaseIdentity=false`).                             | Make rollback atomic across pointers and release identity: store per-release non-secret identity metadata beside each archive, switch `/etc/joy-media/api.env` to the target commit/tree/lock/schema before restart, restore the final identity on re-promotion, and require both `/live` and dependency-aware `/ready` to pass in the rehearsal.                                                                                                                                               |

### P1 — production function and UX closure

| ID    | Surface                                | Remaining work and acceptance                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-01 | Effects catalog                        | Port `71a98de`; interaction-test every category, search, favorites, add/drag, default params, recipe apply/reopen, and category counts. Initial render may never show a false empty state.                                                                                                                                                                                                                                                                  |
| P1-02 | Effects preview stability              | Only load/play previews in or near viewport; pause on hidden tab/panel; cap concurrent decoded videos; use poster fallback and accessible retry; cycle all categories repeatedly under memory/CPU/network observation with zero crash or unbounded growth.                                                                                                                                                                                                  |
| P1-03 | Effect recipes                         | Specify draft vs published recipe lifecycle; prevent accidental duplicate empty drafts; support rename/delete/close/reopen; preserve applied effect stack and autosave.                                                                                                                                                                                                                                                                                     |
| P1-04 | Transitions                            | Deploy SVG preview fix; distinguish duplicate-label transitions or consolidate them; stop ignoring `project.transitions` and edit/remove callbacks; track the actual selected transition; make cards keyboard-operable; test search/favorites/drag/click/edit/remove/reopen/adjacency errors, all preview pixels, retry fallback and preview/export parity.                                                                                                 |
| P1-05 | Project Library/recovery               | Test create/open/rename/duplicate/trash/restore, 100-project scrolling, offline/quota/corruption, local backup download, cloud reconnect, conflict/recovered copy and safe return from editor. No operation may replace recoverable local data.                                                                                                                                                                                                             |
| P1-06 | Media import/library                   | Prove image/video/audio and mixed invalid batches, atomic or per-file cleanup semantics, OPFS/private backup states, preview/reconnect/revoke, filtering/paging, no orphaned bytes/catalog rows and no private-reference leakage. If registration fails after cache write, remove only the exact just-written original and prove retry safety.                                                                                                              |
| P1-07 | Timeline/monitor                       | Prove every visible toolbar/menu/context/keyboard command through one transaction path: rapid add, remove, split/trim/ripple, markers and DnD. Lock must block destructive clip/track edits; lock/mute/solo must persist or be truthfully session-only and must reconcile with undo/redo. Prove save/reopen, real moving pixels/audio, actionable keyboard-operable missing/revoked-media recovery, handled fullscreen rejection and preview/export parity. |
| P1-08 | Canvas/aspect ratio                    | Reconcile the candidate ratio selector with main, persist named ratios as one reversible visual/timeline transaction, keep Fit view-only, and test reopen/export dimensions.                                                                                                                                                                                                                                                                                |
| P1-09 | Captions/transcription                 | Prove manual/SRT/VTT/provider transcription; an all-invalid import must preserve the current document, mixed-valid import must retain valid cues plus diagnostics, and undo/redo must work. Prove Persian/English `lang`/`dir`, text-span styles/background plates, browser/headless preview-export parity, edit/revert/delete, burn-in/sidecar, source unavailable/retry and provider consent/failure.                                                     |
| P1-10 | Joy Code                               | Reconcile main’s newer consent/session/planner contracts with candidate stale-response/duplicate-submit guards. Registered query tools must return real deterministic context or be hidden/unsupported—never “success” plus “not implemented,” fabricated empty selection, or false missing-media claims. Test bounded egress, attachment privacy, dry-run/reject/approve/apply/undo, project switch, timeout/cancel/provider failure and history.          |
| P1-11 | Motion/Effect Studio                   | Prove open/edit/save/publish/place/preview/reopen/undo/redo with real project persistence. Motion Code mode must be editable/apply/persisted with validation or hidden/truthfully unavailable; Add Image/Video must select a real asset rather than create source-less layers; save errors must preserve edits and offer accessible Retry. Keep unfinished advanced manipulation experimental.                                                              |
| P1-12 | Production Board                       | Prove loading/empty/error/retry, keyboard listbox, stale-revision fail-closed behavior, approve/cancel/retry pending state and request deduplication, live error recovery, lease-expired state and durable event/QA projections.                                                                                                                                                                                                                            |
| P1-13 | Delivery UX                            | Every blocked channel shows the exact reason and recovery action. Quick export and verified delivery must not share ambiguous state; concurrent submits deduplicate; history survives reload and reconciles terminal inspection.                                                                                                                                                                                                                            |
| P1-14 | Authentication/privacy                 | Test every supported login method, invalid/expired/rate-limited cases, reload/logout/back, trusted-proxy client IP, CSRF/origin/session policy, request limits and redacted logs. Never expose worker/local/private object references to browser DTOs.                                                                                                                                                                                                      |
| P1-15 | Accessibility/keyboard                 | Run axe plus real Tab/Shift+Tab/arrows/Escape/Enter/Space/focus-return journeys for login, menus, dock/panels, dialogs, category tabs, timeline, approvals and recovery alerts. Disabled controls need discoverable reasons.                                                                                                                                                                                                                                |
| P1-16 | Desktop layouts                        | Pass 1440×900, 1280×720 and 1024×768 with no clipped core controls or document overflow. At unsupported mobile width show a safe desktop requirement and backup/project access instead of a crushed editor.                                                                                                                                                                                                                                                 |
| P1-17 | Observability/performance              | Add bounded client error/resource/long-task metrics and server request/query latency/cardinality. Meet the numeric release budgets below for idle editor, category cycling, timeline mutation, import, playback and render. Code-split until the initial editor JS chunk is at most 500 kB minified and prevent per-route budget regression.                                                                                                                |
| P1-18 | Rate limiting                          | Either move API abuse/rate-limit buckets to a durable shared/edge store or make and enforce a documented single-instance invariant. Prove restarts and multiple peers cannot reset or split limits; verify trusted-proxy spoof resistance live.                                                                                                                                                                                                             |
| P1-19 | Provider approvals                     | Remove the fire-and-forget grant-persistence seam. No grant may become externally usable before durable save/audit succeeds; test storage failure, duplicate issue, expiry, revoke and redacted audit.                                                                                                                                                                                                                                                      |
| P1-20 | Worker manual retry                    | Exhausted attempts already terminalize, but explicit retry must create a fresh durable attempt/generation with an intact audit trail and must reject stale completion from older leases.                                                                                                                                                                                                                                                                    |
| P1-21 | Readiness depth                        | Private-object readiness must prove safe reachability (bounded stat/list/sentinel read) instead of only checking that a store object is configured. Keep the probe non-mutating and timeout-bounded.                                                                                                                                                                                                                                                        |
| P1-22 | Timeline empty/insertion state         | Clicking the container, icon, or explanatory text must all open the same import action; Enter/Space and drag/drop remain functional. Give virtual insertion lanes a semantic keyboard action or remove their false affordance. Disable empty playback or announce why it cannot start. Remove target-only click logic that makes child content inert.                                                                                                       |
| P1-23 | Effects keyboard/reduced motion        | Effect cards need a semantic keyboard add action and discoverable unavailable reason. Autoplay rejection/reduced-motion/hidden-tab paths must show a deterministic poster or fallback instead of silently blank media.                                                                                                                                                                                                                                      |
| P1-24 | Library destructive-operation recovery | Replace blocking-only removal UX with focus-safe confirmation/status; storage failure must keep the project card/data intact and expose accessible retry.                                                                                                                                                                                                                                                                                                   |
| P1-25 | Product identity                       | Choose JOY Studio or JOY Media as the canonical user-facing name and make HTML title, shell, login, project library, manifest, release docs and browser assertions agree.                                                                                                                                                                                                                                                                                   |
| P1-26 | Responsive timeline semantics           | At the authenticated 480×1370 breakpoint, the timeline's Duplicate, Ripple Delete and Add Marker controls leave the primary toolbar (`display:none`) and are reachable only through the unlabeled-icon overflow trigger; Zoom in/out and the `Timeline zoom` range input have no compact replacement at all. Repeated clips also expose duplicate accessible names (for example `Intro, 3.0s` and `Black Brush Stroke, 5.0s`), while track containers have no semantic role or accessible name. Give the overflow trigger a visible text/name and complete compact action coverage (including zoom), add unique clip labels/IDs and labelled track groups, then rerun the responsive matrix at 320/480/768/1024/1280/1440 widths. |

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
