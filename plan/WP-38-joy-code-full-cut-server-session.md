# WP-38 Joy Code Full-Cut Server Session Implementation Plan

> **For GPT Sol:** Use the test-driven-development skill and implement this plan task-by-task. Keep each task small, run the stated gate, commit it separately, and stop on any unexplained failure. This is a GPT-owned work package; do not delegate implementation or production decisions to Mistral Vibe, Kilo Auto, Hermes, or another coding agent.

**Goal:** Let an authenticated owner ask Joy Code for a complete, reviewable picture-mix edit using media already registered in the open project, including real trims/reordering, one code-owned title style, existing-caption styling, and curated transitions; apply the approved result as one reversible edit and prove preview, persistence, export, and one-step Undo in the browser.

**Architecture:** The server resolves the exact canonical project revision and sends only a bounded semantic summary plus the user's prompt to one pinned free OpenRouter model. The model returns an untrusted, allowlisted plan DSL through a forced tool call. The browser rechecks the revision, compiles the proposal deterministically into timeline and JoyProject document changes, dry-runs it, shows a plan card, and applies it only after explicit approval through EditorSession.dispatchCompound(). Neither the provider nor the server executes editor mutations.

**Tech Stack:** TypeScript, React 19, Node.js 22, Vitest, Playwright, PostgreSQL 17, pnpm workspaces, JOY Media command/history infrastructure, OpenRouter OpenAI-compatible HTTP transport, systemd encrypted credentials, Pixi preview/export, JOY Media immutable releases.

---

**Status:** Planned

**Authoring date:** 2026-08-20

**Canonical repository:** C:/Users/HadiMoti/joy-vps/joy-media-fix

**Measured starting revision:** 8f7d3b9, clean detached checkout with origin/main at the same reviewed WP-37 descendant. Before implementation, switch or fast-forward to the real main branch without rewriting history.

**Public application:** https://joyst.ir

## 1. Why WP-38 is next

WP-37 is honestly closed for its bounded Creative Brief surface. It proved canonical project-document sync, exact-revision S1/S2 context, owner consent, a zero-payable-spend OpenRouter runtime, a fixed-origin transport, encrypted credential loading, admission control, abort handling, browser integration, and a live canary.

Joy Code still cannot perform the owner's target workflow. Its current free-form path stops at this message:

> Free-form KiloCode responses will appear here once the server-session adapter is connected.

The repository already has most of the deterministic editing foundation:

- AgentPanel creates, dry-runs, approves, audits, and executes local timeline plans.
- The command bus persists real timeline commands.
- EditorSession.dispatchCompound() can commit timeline and JoyProject document state as one history entry and one Undo.
- Caption documents, caption templates, text templates, transitions, preview, burn-in, and export already exist.
- The Creative Brief runtime supplies a hardened example for safe remote planning.

The missing product layer is a strict bridge from free-form intent to a reviewable multi-surface plan. WP-38 adds that bridge without granting a model direct editing authority.

## 2. Definition of done

WP-38 is complete only when all of the following are true on a disposable owner project:

1. The project contains at least three registered, playable visual clips and an existing caption document. Raw OPFS attachments that are not registered project assets are not planner inputs.
2. The owner submits a free-form request such as:

   > Create a 25–30 second vertical product picture mix from the existing clips. Start with the strongest two-second hook, remove dead space, use clean dissolves, add the title “Build the moment,” apply a professional RTL caption style, and prepare it for review. Do not create or fetch new media.

3. Joy Code syncs the exact canonical project revision, obtains separate remote-planning consent, and returns a structured proposal.
4. The proposal names only existing clip/asset/caption IDs and code-owned title, caption, and transition presets.
5. Project bytes, timeline state, history, and preview remain unchanged before Apply.
6. The UI shows grouped Cut, Text, Captions, and Transitions changes, assumptions, blockers, and the remote-model disclosure.
7. Even when the user's Agent mode says Full Auto, this mixed-surface remote plan requires explicit Apply in WP-38 V1.
8. Apply creates exactly one compound history entry.
9. Preview plays the edited sequence with the chosen title, caption style, and transitions.
10. Export completes with the same visible title/caption treatment and no missing registered media.
11. One Undo restores byte-identical pre-run timeline and JoyProject document state. Redo and reload preserve the applied state.
12. A stale project revision, opt-out, provider outage, malformed output, nonzero/unknown cost, wrong model, disconnect, or compilation error makes no mutation and returns a bounded honest error.
13. The public browser uses joyst.ir. Test fixtures use example.invalid; no new media.joyteam.ir literals are introduced.

## 3. Honest scope

### Included

- Free-form, server-side planning over the canonical semantic project context.
- Picture-mix operations on clips and assets already registered in the project.
- Code-owned title/lower-third templates with bounded owner-provided copy.
- Existing-caption timing/text repair and code-owned caption styling.
- Curated transitions between validated adjacent visual clips.
- Explicit preview and approval.
- One atomic, reversible compound edit.
- Browser preview, persistence, Undo/Redo, reload, and export acceptance.
- Persian/RTL and English text.

### Explicitly excluded from WP-38 V1

- New media generation, web search, stock-media lookup, uploads, or provider-backed asset creation.
- Raw media bytes, faces, voices, paths, signed URLs, object-store references, or browser tokens in model input.
- Dynamic Kilo Auto Free or openrouter/free routing.
- Arbitrary model-generated commands, tool names, CSS, fonts, colors, shader parameters, JSON patches, or whole-project replacements.
- Autonomous execution without a visible plan and explicit Apply.
- Server-side mutation of the project.
- Fabricated caption transcripts. If no caption document exists, the plan reports a blocker or proposes only a title.
- A claimed audio mix. Existing audio must remain synchronized and unchanged in V1. The current agent audio helpers discard the immutable state returned by applyAudioCommand(), so professional gain/fade/ducking is a separately gated follow-up unless its persistence and one-Undo path are first repaired and tested.
- General-public or confidential-project rollout while the selected free NVIDIA endpoint is a logged trial service.

## 4. Locked decisions

| Decision              | WP-38 choice                                                                                                                   | Reason                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product surface       | Joy Code                                                                                                                       | This is the user-facing editor agent.                                                                                                                                       |
| Editing authority     | Local deterministic compiler plus EditorSession.dispatchCompound()                                                             | Provider output is advice, not authority.                                                                                                                                   |
| Remote actor identity | joy-code-server                                                                                                                | A direct OpenRouter call must not be falsely attributed to the KiloCode extension.                                                                                          |
| KiloCode role         | Existing code-server editing host and local deterministic host only                                                            | KiloCode is not an HTTP provider transport.                                                                                                                                 |
| Provider transport    | Existing fixed-origin OpenRouter transport                                                                                     | It is already hardened and live-proven by WP-37.                                                                                                                            |
| Initial model         | nvidia/nemotron-3.5-lightning:free                                                                                             | OpenRouter's current page lists it as free, optimized for high-throughput agentic workloads, and capable of tool calling.                                                   |
| Output protocol       | One forced submit_joy_code_plan tool call                                                                                      | The selected model currently supports tools but does not support response_format. Free-form assistant JSON is rejected.                                                     |
| Model routing         | Exact singleton allowlist; allow_fallbacks false                                                                               | No dynamic router, silent fallback, or paid model.                                                                                                                          |
| Spend                 | Exactly zero payable spend                                                                                                     | Request config, returned model, usage, and cost receipt must all prove the policy.                                                                                          |
| Model availability    | Reverify immediately before activation                                                                                         | Free-model availability is time-sensitive. If the exact ID is unavailable, remain disabled and use a reviewed code/config change; never silently switch.                    |
| Secret                | New opaque ref joy-media/openrouter/joy-code-planner/v1 mapped to the existing encrypted systemd credential openrouter-api-key | Separate audit identity without duplicating or exposing the owner-approved key.                                                                                             |
| Hermes .env           | Never read by JOY Media                                                                                                        | WP-37 already copied the owner-approved OpenRouter key into encrypted systemd credential storage. WP-38 reuses that credential and never reaches into Hermes runtime files. |
| Consent               | Separate versioned per-project Joy Code consent                                                                                | Creative Brief consent covers read-only briefing, not edit planning.                                                                                                        |
| Consent version       | openrouter-nvidia-free-edit-planning-v1                                                                                        | Missing or older consent reads disabled.                                                                                                                                    |
| Remote data           | Prompt, bounded semantic summary, caption text, and registered asset names/IDs only                                            | No media bytes or protected locations.                                                                                                                                      |
| Apply mode            | Manual approval for every remote mixed-surface plan                                                                            | Full Auto does not override this in V1.                                                                                                                                     |
| Operation cap         | 24 operations                                                                                                                  | Bounds prompt/output, reviewability, and execution time.                                                                                                                    |
| Request cap           | 8,000 prompt characters; selected ID arrays capped at 50                                                                       | Prevents context abuse and accidental bulk disclosure.                                                                                                                      |
| Provider budget       | 30-second timeout; at most 4,096 output tokens; response body at most 256 KiB                                                  | Interactive, bounded failure.                                                                                                                                               |
| Admission             | One in flight per owner/project, three per minute and twenty per day; shared global OpenRouter concurrency with Creative Brief | Protects the free endpoint and the API.                                                                                                                                     |
| Public origin         | https://joyst.ir                                                                                                               | media.joyteam.ir is not the production editor origin.                                                                                                                       |

External model evidence checked on 2026-08-20:

- OpenRouter model page: https://openrouter.ai/nvidia/nemotron-3.5-lightning%3Afree
- OpenRouter free-model collection: https://openrouter.ai/collections/free-models

The model page also warns that the free endpoint logs use for security/product improvement and should not receive confidential or personal information. The UI disclosure and owner-only experimental gate are mandatory, not optional copy.

## 5. Architecture and trust boundaries

```text
Owner prompt in Joy Code
  -> local deterministic intent matcher
       -> known direct intent: current local plan path, no remote call
       -> unmatched free-form request:
            -> sync exact JoyProjectV1 revision to owner-scoped server store
            -> POST /v1/projects/:projectId/joy-code/plans
                 -> authenticate and verify ownership
                 -> verify versioned Joy Code consent
                 -> validate bounded client envelope
                 -> shared OpenRouter admission gate
                 -> resolve exact stored revision
                 -> compute S1 snapshot + S2 intelligence + safe catalogs
                 -> forced OpenRouter tool call
                 -> verify exact model + zero cost + bounded response
                 -> strict JoyCodeModelPlanV1 validation
                 -> attach server-owned plan/revision/provenance
            -> browser rechecks session.projectRevisionId
            -> pure compiler validates every referenced ID/range/preset
            -> dry-run timeline and JoyProject document draft
            -> plan card + explicit Apply
            -> EditorSession.dispatchCompound()
            -> one persisted history entry
            -> preview / export / one Undo
```

### Trust rules

1. The browser never sends a full project document in the planning envelope. It first uses the existing authenticated document-sync route.
2. The server resolves the exact stored revision. It never trusts a client-supplied snapshot or intelligence object.
3. The server supplies code-owned operation and preset catalogs. The model cannot invent new tool names.
4. The model output does not contain project authority fields. The server attaches project ID, revision ID, plan ID, created time, and provenance.
5. The browser treats the entire proposal as untrusted and revalidates it against the current live session.
6. The compiler is pure. It returns either a complete draft or a typed error; it never partially mutates.
7. The only mutation is the existing compound dispatch boundary after exact-plan approval.
8. Audit events contain IDs, categories, timing, and redacted error codes—not prompt/caption text, model output, secret values, or project bytes.

## 6. Contract shape

Create two distinct contracts.

### Model output

JoyCodeModelPlanV1 contains only:

- schemaVersion: 1
- goal and summary
- operations: 1–24 discriminated operations
- assumptions
- blockedBy
- requiresHumanDecision

It must not contain plan ID, owner ID, project ID, revision ID, provider/model fields, approval state, raw commands, or execution status.

### Server proposal

JoyCodePlanProposalV1 wraps the validated model result with server-owned:

- planId
- projectId
- snapshotRevisionId
- createdAt
- planner provenance with adapter and exact model ID
- safe operation catalog version
- consent version

### Initial operation allowlist

| Operation                    | Required inputs                                                 | Compiler rule                                                                           |
| ---------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| timeline.trimClip            | compositionId, trackId, clipId, newStartUs, newEndUs            | Existing clip; positive range; within source/duration bounds.                           |
| timeline.splitClip           | compositionId, trackId, clipId, atUs                            | Split strictly inside clip; compiler creates deterministic derived ID.                  |
| timeline.moveClip            | compositionId, sourceTrackId, targetTrackId, clipId, newStartUs | Existing unlocked compatible tracks; no invalid overlap.                                |
| timeline.removeClip          | compositionId, trackId, clipId                                  | Existing clip; explicit destructive flag in plan card.                                  |
| timeline.insertExistingAsset | assetId, targetTrackId, startUs, durationUs                     | Asset already registered and playable; compiler creates deterministic clip/binding IDs. |
| text.insertTemplate          | templateId, content, startUs, durationUs, placementPreset       | Exact code-owned template; bounded text; deterministic object/clip IDs.                 |
| text.setContent              | objectId, content                                               | Existing text object; bounded plain text only.                                          |
| caption.setSegmentText       | captionClipId, segmentId, text                                  | Existing segment; bounded plain text.                                                   |
| caption.setSegmentTiming     | captionClipId, segmentId, startUs, endUs                        | Existing segment; valid non-overlapping range.                                          |
| caption.setTemplate          | captionClipId, templateId                                       | Exact joy-clean, joy-karaoke-pop, or joy-rtl-classic.                                   |
| caption.setBurnIn            | enabled                                                         | Project preference only; no renderer bypass.                                            |
| transition.addAtJunction     | outgoingClipId, incomingClipId, transitionId, durationUs        | Adjacent visual clips; only dissolve, wipe, or slide; bounded by both clips.            |
| transition.remove            | transitionId                                                    | Existing transition only.                                                               |

All operation objects reject unknown fields. Text is plain Unicode; Persian/RTL must round-trip unchanged. Initial transition durations are 100,000–1,500,000 microseconds and must be no more than half of either adjacent clip. Initial title durations are 500,000–10,000,000 microseconds. IDs, dependencies, and operation IDs are bounded and unique.

## 7. Execution discipline

- Start every task from a clean worktree on the canonical joy-media repository and a real main branch.
- Record the current SHA before editing.
- Write the failing test first, run it, and record the expected failure.
- Implement the smallest production change that makes that test pass.
- Run the focused suite, relevant package build, and git diff --check.
- Commit only the files listed for the task.
- Do not combine unrelated cleanup, formatting, package upgrades, GBrain changes, or VPS operations.
- Do not push or deploy until the local integration gate passes.
- If an existing test fails for a reason not explained by the task, stop and diagnose it; do not label it pre-existing without proving that at the parent SHA.
- No unsafe as any or as unknown as casts in new model-boundary code.
- No Date.now() or Math.random() inside pure planners/compilers. Inject clock/ID factories or derive deterministic IDs from server plan ID plus operation index.

## 8. Task sequence

### GPT-01 — Record the server-planner architecture decision

**Purpose:** Resolve the ADR-0020 identity conflict before code makes a direct OpenRouter planner look like KiloCode.

**Create:**

- docs/adr/0036-joy-code-server-planner-boundary.md

**Modify:**

- docs/adr/README.md
- docs/JOY-STUDIO-EXPANSION-BRIEF.md

**Requirements:**

- Partially supersede only the transport/identity portion of ADR-0020.
- Keep KiloCode as a code-server extension host.
- Name joy-code-server as the remote planning actor.
- State that OpenRouter is reasoning transport only.
- State that server/model output cannot execute or approve edits.
- State that local deterministic intents remain available without remote egress.

**Gate:**

```powershell
pnpm exec prettier --check docs/adr/0036-joy-code-server-planner-boundary.md docs/adr/README.md docs/JOY-STUDIO-EXPANSION-BRIEF.md
git diff --check
```

**Commit:** joy-media(WP-38): Define Joy Code server planner boundary

### GPT-02 — Add the strict Joy Code plan contract

**Create:**

- packages/agent-tools/src/joy-code-plan.ts
- packages/agent-tools/src/joy-code-plan.test.ts

**Modify:**

- packages/agent-tools/src/index.ts
- packages/agent-tools/src/index.test.ts

**RED tests:**

- Valid English and Persian model plans pass.
- Every allowlisted operation passes with exact fields.
- Unknown fields, arbitrary tool names, raw SpikeCommand payloads, whole JoyProject objects, provider fields, approval fields, and execution fields fail.
- More than 24 operations, duplicate IDs, invalid dependencies, cycles, invalid ranges, oversized text/arrays, malformed IDs, and empty required fields fail.
- Paths, URLs, signed URLs, object-store references, credential patterns, Authorization text, and secret-shaped values fail recursively.
- Model output with project/revision/provenance fields fails.
- Validator does not mutate input.
- Identical clean input produces byte-stable normalized output.

**GREEN implementation:**

- Define JoyCodeModelPlanV1, JoyCodePlanOperationV1, JoyCodePlanProposalV1, typed validation results, limits, and forbidden-data checks.
- Export only production contracts/validators from package root.
- Keep fake fixtures and factories test-file private.

**Gate:**

```powershell
pnpm exec vitest run packages/agent-tools/src/joy-code-plan.test.ts packages/agent-tools/src/index.test.ts
pnpm --filter @joy-media/agent-tools build
git diff --check
```

**Commit:** joy-media(WP-38): Define bounded Joy Code plan contract

### GPT-03 — Close project-document validation gaps

**Modify:**

- packages/project-schema/src/v1.ts
- packages/project-schema/src/v1.test.ts
- packages/project-schema/src/text-style.ts
- packages/project-schema/src/index.ts
- packages/project-schema/src/index.test.ts
- apps/editor-web/src/TextPanel.tsx
- apps/editor-web/src/motion-studio/MotionStudioInspector.tsx

**Create:**

- packages/project-schema/src/content-fonts.ts
- packages/project-schema/src/content-fonts.test.ts

**RED tests:**

- Invalid TextDocumentV1 and TextStyleV1 nested in a visual object produce diagnostics.
- Invalid CaptionClipV1 style produces diagnostics.
- Invalid transition ID/reference/range/duplicate produces diagnostics.
- Valid existing projects still pass.
- Canonical bundled family names are YekanBakh and Vazin, not the mismatched aliases.

**GREEN implementation:**

- Extend validateJoyProjectV1 without loosening existing diagnostics.
- Centralize the exact font-family names consumed by UI and render code.
- Provide migration/normalization for persisted Yekan Bakh and Vazirmatn aliases; do not make older projects unreadable.

**Gate:**

```powershell
pnpm exec vitest run packages/project-schema/src/v1.test.ts packages/project-schema/src/content-fonts.test.ts packages/project-schema/src/index.test.ts
pnpm --filter @joy-media/project-schema build
pnpm --filter @joy-media/editor-web build
git diff --check
```

**Commit:** joy-media(WP-38): Validate styled project document state

### GPT-04 — Build the pure timeline picture-mix compiler

**Create:**

- apps/editor-web/src/joy-code-timeline-compiler.ts
- apps/editor-web/src/joy-code-timeline-compiler.test.ts

**Modify only if a reusable helper is required:**

- apps/editor-web/src/agent-panel-intents.ts
- apps/editor-web/src/agent-panel-intents.test.ts

**RED tests:**

- trim, split, move, remove, and registered-asset insertion compile to real SpikeCommand transactions.
- All existing IDs, track compatibility, lock state, time ranges, overlaps, and composition bounds are revalidated.
- Insert-existing-asset rejects unregistered or unavailable assets.
- Derived clip IDs are deterministic from plan ID and operation index.
- Multi-step dependencies compile in order.
- A later failing operation rejects the entire draft and leaves input unchanged.
- Applying the resulting transaction to a clone produces the expected picture mix.

**GREEN implementation:**

- Create a pure compileJoyCodeTimelineOperations() function.
- Reuse existing command shapes and applyTransaction validation.
- Return commands, semantic diff entries, affected IDs, warnings, and typed errors.
- Do not dispatch or touch React/session/storage.

**Gate:**

```powershell
pnpm exec vitest run apps/editor-web/src/joy-code-timeline-compiler.test.ts apps/editor-web/src/agent-panel-intents.test.ts
pnpm --filter @joy-media/editor-web build
git diff --check
```

**Commit:** joy-media(WP-38): Compile Joy Code picture-mix operations

### GPT-05 — Add deterministic text-template operations

**Create:**

- apps/editor-web/src/joy-code-text-operations.ts
- apps/editor-web/src/joy-code-text-operations.test.ts

**Modify:**

- apps/editor-web/src/text-template-transaction.ts
- apps/editor-web/src/text-template-transaction.test.ts
- apps/editor-web/src/text-template-catalog.ts
- apps/editor-web/src/text-template-catalog.test.ts

**RED tests:**

- text.insertTemplate accepts only an exact catalog template and placement preset.
- It creates deterministic object, clip, binding, and track IDs without Date.now()/Math.random().
- It preserves Persian and multiline content.
- text.setContent changes only the selected existing text object.
- Unknown templates, arbitrary style blobs, invalid positions/times, locked tracks, collisions, and oversized text fail.
- No input mutation; byte-stable result for identical inputs.

**GREEN implementation:**

- Refactor existing insertTextTemplate() into a pure prepare function plus its current session wrapper.
- Keep the existing manual UI behavior.
- Let the Joy Code operation reuse the pure preparation seam.
- Do not expose raw TextStyleV1 or TextDocumentV1 to the model.

**Gate:**

```powershell
pnpm exec vitest run apps/editor-web/src/text-template-catalog.test.ts apps/editor-web/src/text-template-transaction.test.ts apps/editor-web/src/joy-code-text-operations.test.ts
pnpm --filter @joy-media/editor-web build
git diff --check
```

**Commit:** joy-media(WP-38): Add bounded Joy Code text operations

### GPT-06 — Add deterministic caption operations

**Create:**

- apps/editor-web/src/joy-code-caption-operations.ts
- apps/editor-web/src/joy-code-caption-operations.test.ts

**Modify only as required under regression tests:**

- packages/captions-core/src/editing.ts
- packages/captions-core/src/editing.test.ts
- packages/captions-core/src/styling.ts
- packages/captions-core/src/styling.test.ts
- apps/editor-web/src/caption-burn-in.ts
- apps/editor-web/src/caption-burn-in.test.ts

**RED tests:**

- Segment text/timing updates reuse canonical caption commands.
- Template selection accepts only joy-clean, joy-karaoke-pop, and joy-rtl-classic.
- Burn-in updates the canonical project preference.
- Persian/RTL text and word timing are preserved.
- Missing documents/segments, fabricated transcript text, overlaps, invalid time ranges, unknown templates, and raw replacement documents fail.
- A project without captions returns a blocker rather than an invented document.

**GREEN implementation:**

- Create pure preparation helpers that return the next JoyProjectV1 plus diffs.
- Keep caption.replaceDocument outside the agent surface.
- Normalize any bounded style patch through CaptionClipStyleV2 validation; prefer template-only for the initial canary.

**Gate:**

```powershell
pnpm exec vitest run packages/captions-core/src/editing.test.ts packages/captions-core/src/styling.test.ts apps/editor-web/src/caption-burn-in.test.ts apps/editor-web/src/joy-code-caption-operations.test.ts
pnpm --filter @joy-media/captions-core build
pnpm --filter @joy-media/editor-web build
git diff --check
```

**Commit:** joy-media(WP-38): Add bounded Joy Code caption operations

### GPT-07 — Add deterministic curated-transition operations

**Create:**

- apps/editor-web/src/joy-code-transition-operations.ts
- apps/editor-web/src/joy-code-transition-operations.test.ts
- packages/transition-shaders/src/catalog.test.ts

**Modify only if needed:**

- apps/editor-web/src/transition-panel-state.ts
- apps/editor-web/src/transition-panel-state.test.ts

**RED tests:**

- Add accepts only dissolve, wipe, or slide.
- The outgoing/incoming clips must exist, be visual, and be adjacent at the junction.
- Duration is within 100,000–1,500,000 microseconds and no more than half of either clip.
- Duplicate/conflicting transitions fail.
- Remove accepts only an existing transition ID.
- Deterministic IDs, no mutation, and byte-stable output.

**GREEN implementation:**

- Extract a pure transition update helper from the current App-level replacement logic.
- Do not expose GL shader IDs, arbitrary params, or uniform maps.

**Gate:**

```powershell
pnpm exec vitest run apps/editor-web/src/transition-panel-state.test.ts apps/editor-web/src/joy-code-transition-operations.test.ts packages/transition-shaders/src/catalog.test.ts
pnpm --filter @joy-media/editor-web build
git diff --check
```

**Commit:** joy-media(WP-38): Add curated Joy Code transition operations

### GPT-08 — Compile one mixed-surface compound draft

**Create:**

- apps/editor-web/src/joy-code-compound-compiler.ts
- apps/editor-web/src/joy-code-compound-compiler.test.ts
- apps/editor-web/src/joy-code-compound-runner.ts
- apps/editor-web/src/joy-code-compound-runner.test.ts

**Modify:**

- apps/editor-web/src/agent-plan-visualizer.ts
- apps/editor-web/src/agent-command-bus.test.ts
- apps/editor-web/src/editor-session.test.ts

**RED tests:**

- One proposal compiles timeline, title, caption, and transition operations against the same base revision.
- Dry-run returns grouped diffs without session mutation.
- Any failed sub-operation rejects the entire draft.
- Revision mismatch before Apply rejects.
- Approval binds exact plan ID, proposal hash, and base revision.
- Apply calls dispatchCompound once and creates one history entry.
- One Undo restores byte-identical timeline and JoyProject state.
- Duplicate Apply is idempotent.
- Remote plans require manual approval even when Full Auto is selected.

**GREEN implementation:**

- Define JoyCodeCompoundDraft with base revision, proposal hash, timeline transaction, next document, grouped diffs, warnings, and approval risk.
- Keep existing direct local intents on their current fast path.
- Do not broaden runPlanAtomically silently; either add a clearly typed mixed draft runner or extend it with full regression coverage.

**Gate:**

```powershell
pnpm exec vitest run apps/editor-web/src/joy-code-compound-compiler.test.ts apps/editor-web/src/joy-code-compound-runner.test.ts apps/editor-web/src/agent-command-bus.test.ts apps/editor-web/src/editor-session.test.ts
pnpm --filter @joy-media/editor-web build
git diff --check
```

**Commit:** joy-media(WP-38): Execute Joy Code plans as one compound edit

### GPT-09 — Prove professional text and caption render parity

**Modify:**

- packages/renderer-pixi/src/index.ts
- packages/renderer-pixi/src/editor-preview.test.ts
- packages/renderer-pixi/src/browser-export.ts
- packages/renderer-pixi/src/browser-export.test.ts
- packages/visual-object-renderer/src/index.ts
- packages/visual-object-renderer/src/index.test.ts
- apps/editor-web/src/caption-burn-in.test.ts

**Create:**

- apps/editor-web/src/font-readiness.ts
- apps/editor-web/src/font-readiness.test.ts

**RED tests:**

- TextNode spans render per-run highlight styling in Pixi.
- Persian RTL and highlighted English use the same Render IR in preview and export.
- Export waits for required bundled fonts or fails with a typed bounded error.
- Canonical YekanBakh/Vazin names resolve.
- joy-clean, joy-karaoke-pop, and joy-rtl-classic caption fixtures have deterministic layout.
- Existing base fill, gradient, stroke, shadow, and glow behavior does not regress.

**GREEN implementation:**

- Implement span-aware Pixi rendering.
- Add a bounded document.fonts readiness preflight for browser export.
- Keep headless placeholder limitations explicit; do not claim pixel parity from its bitmap glyph stub.

**Gate:**

```powershell
pnpm exec vitest run packages/visual-object-renderer/src/index.test.ts packages/renderer-pixi/src/editor-preview.test.ts packages/renderer-pixi/src/browser-export.test.ts apps/editor-web/src/font-readiness.test.ts apps/editor-web/src/caption-burn-in.test.ts
pnpm --filter @joy-media/renderer-pixi build
pnpm --filter @joy-media/editor-web build
git diff --check
```

**Commit:** joy-media(WP-38): Render professional Joy Code text consistently

### GPT-10 — Add an asynchronous Joy Code planner adapter contract

**Create:**

- packages/agent-tools/src/async-joy-code-adapter.ts
- packages/agent-tools/src/async-joy-code-adapter.test.ts
- packages/agent-tools/src/async-joy-code-plan.ts
- packages/agent-tools/src/async-joy-code-plan.test.ts

**Modify:**

- packages/agent-tools/src/index.ts
- packages/agent-tools/src/index.test.ts

**RED tests:**

- Deterministic valid fake outcome.
- unavailable, policy-denied, invalid-output, provider-failed, timeout, and cancelled categories.
- Already-aborted and mid-call abort.
- Input immutability, injected clock, bounded audit events, and no secret/prompt text in audit.
- Finalizer attaches server-owned plan/revision/provenance and validates again.
- Test fakes are not exported from package root.

**GREEN implementation:**

- Mirror only the proven async Creative Brief outcome conventions.
- Return JoyCodeModelPlanV1 from the adapter and JoyCodePlanProposalV1 from the finalizer.
- Do not add a provider or route in this task.

**Gate:**

```powershell
pnpm exec vitest run packages/agent-tools/src/async-joy-code-adapter.test.ts packages/agent-tools/src/async-joy-code-plan.test.ts packages/agent-tools/src/index.test.ts
pnpm --filter @joy-media/agent-tools build
git diff --check
```

**Commit:** joy-media(WP-38): Define async Joy Code planner boundary

### GPT-11 — Add the OpenRouter Joy Code codec and adapter

**Create:**

- packages/adapter-openrouter/src/joy-code.ts
- packages/adapter-openrouter/src/joy-code.test.ts

**Modify:**

- packages/adapter-openrouter/src/index.ts
- packages/adapter-openrouter/src/index.test.ts

**RED tests:**

- Request includes exact nvidia/nemotron-3.5-lightning:free, temperature 0, maximum 4,096 output tokens, no provider fallback, and exactly one forced submit_joy_code_plan tool.
- No response_format field is present.
- Prompt contains only the bounded semantic snapshot, intelligence summary, safe catalogs, selection, and user request.
- Paths, URLs, secrets, raw documents, provider credentials, and media bytes fail before secret resolution or transport.
- Only one assistant tool call with the exact function name is accepted.
- Missing/duplicate/wrong tool calls, invalid JSON arguments, unknown fields, invalid proposal schema, non-2xx, transport errors, timeout, and cancellation map to typed outcomes.
- Exact response model and zero/known usage cost are required.
- Response body is bounded to 256 KiB.
- No real network calls; all tests use injected in-memory transport.
- Creative Brief adapter regression suite remains green.

**GREEN implementation:**

- Reuse shared transport/policy primitives only after characterization tests.
- Do not weaken existing Creative Brief checks.
- Treat model content as opaque; never log it in an error.

**Gate:**

```powershell
pnpm exec vitest run packages/adapter-openrouter/src/joy-code.test.ts packages/adapter-openrouter/src/index.test.ts
pnpm --filter @joy-media/adapter-openrouter build
git diff --check
```

**Commit:** joy-media(WP-38): Add fail-closed OpenRouter Joy Code planner

### GPT-12 — Generalize the encrypted credential mapping safely

**Create:**

- apps/api/src/openrouter-systemd-credential-source.ts
- apps/api/src/openrouter-systemd-credential-source.test.ts
- apps/api/src/joy-code-secret-resolver.ts
- apps/api/src/joy-code-secret-resolver.test.ts

**Modify:**

- apps/api/src/systemd-credential-secret-source.ts
- apps/api/src/systemd-credential-secret-source.test.ts
- apps/api/src/creative-brief-secret-resolver.test.ts
- apps/api/src/creative-brief-production-runtime.test.ts

**RED tests:**

- One startup read captures openrouter-api-key.
- Exact logical refs creative-brief/v1 and joy-code-planner/v1 can map to that value only when code-owned.
- Unknown/blank/path-like refs never call or reveal the source.
- File read occurs once at startup, never per request.
- Missing/blank/read-error remains unavailable.
- No secret appears in returned config, errors, audit events, or snapshots.
- Existing Creative Brief canonical ref behavior is unchanged.

**GREEN implementation:**

- Extract a generic startup-captured source with an explicit readonly ref-to-credential-ID mapping.
- Keep caller-controlled paths and arbitrary refs impossible.
- Do not read Hermes .env or process.env in the resolver.

**Gate:**

```powershell
pnpm exec vitest run apps/api/src/openrouter-systemd-credential-source.test.ts apps/api/src/joy-code-secret-resolver.test.ts apps/api/src/systemd-credential-secret-source.test.ts apps/api/src/creative-brief-secret-resolver.test.ts apps/api/src/creative-brief-production-runtime.test.ts
pnpm --filter @joy-media/api build
git diff --check
```

**Commit:** joy-media(WP-38): Map Joy Code to encrypted OpenRouter credential

### GPT-13 — Add Joy Code runtime config, composition, and admission

**Create:**

- apps/api/src/joy-code-runtime.ts
- apps/api/src/joy-code-runtime.test.ts
- apps/api/src/joy-code-runtime-config.ts
- apps/api/src/joy-code-runtime-config.test.ts
- apps/api/src/joy-code-runtime-factory.ts
- apps/api/src/joy-code-runtime-factory.test.ts
- apps/api/src/joy-code-production-runtime.ts
- apps/api/src/joy-code-production-runtime.test.ts
- apps/api/src/joy-code-admission-gate.ts
- apps/api/src/joy-code-admission-gate.test.ts

**Modify under regression tests:**

- apps/api/src/creative-brief-admission-gate.ts
- apps/api/src/creative-brief-admission-gate.test.ts

**Configuration prefix:**

- JOY_MEDIA_JOY_CODE_RUNTIME_MODE
- JOY_MEDIA_JOY_CODE_RUNTIME_MODEL_ID
- JOY_MEDIA_JOY_CODE_RUNTIME_TIMEOUT_MS
- JOY_MEDIA_JOY_CODE_RUNTIME_SPEND_LIMIT_USD_CENTS
- JOY_MEDIA_JOY_CODE_RUNTIME_SECRET_REF
- JOY_MEDIA_JOY_CODE_RUNTIME_ALLOWED_FREE_MODEL_IDS

**RED tests:**

- Default and every malformed/unknown configuration is disabled.
- Enabled config requires the exact model, singleton allowlist, exact Joy Code secret ref, spend 0, and timeout 1,000–30,000 ms.
- Missing injected dependency is unavailable.
- Shared global OpenRouter concurrency covers both Creative Brief and Joy Code.
- Joy Code enforces one in flight per owner/project, three per minute, twenty per day.
- Wrong model, nonzero/missing cost, or invalid usage opens the fail-closed circuit until its bounded reset policy.
- No automatic retry or fallback.

**GREEN implementation:**

- Keep runtime disabled unless all dependencies and exact policy values are present.
- Reuse the fixed-origin transport and async outcome categories.

**Gate:**

```powershell
pnpm exec vitest run apps/api/src/joy-code-runtime.test.ts apps/api/src/joy-code-runtime-config.test.ts apps/api/src/joy-code-runtime-factory.test.ts apps/api/src/joy-code-production-runtime.test.ts apps/api/src/joy-code-admission-gate.test.ts apps/api/src/creative-brief-admission-gate.test.ts
pnpm --filter @joy-media/api build
git diff --check
```

**Commit:** joy-media(WP-38): Compose guarded Joy Code planning runtime

### GPT-14 — Add separate versioned Joy Code consent

**Modify:**

- apps/api/src/postgres-schema.ts
- apps/api/src/postgres-schema.test.ts
- apps/api/src/control-plane.ts
- apps/api/src/control-plane.test.ts
- apps/api/src/postgres-control-plane.ts
- apps/api/src/postgres-control-plane.test.ts
- apps/api/src/http-server.ts
- apps/api/src/http-server.test.ts

**Schema additions:**

- projects.joy_code_opt_in boolean not null default false
- projects.joy_code_consent_version text
- projects.joy_code_consent_accepted_at timestamptz

**Routes:**

- GET /v1/projects/:projectId/joy-code-opt-in
- PUT /v1/projects/:projectId/joy-code-opt-in

**RED tests:**

- New and legacy projects read disabled.
- Enable writes current version/time with revision CAS.
- Disable clears effective consent.
- Old/missing consent version reads disabled.
- Owner isolation and project-not-found behavior match existing control-plane conventions.
- The disclosure text states: prompt/semantic project summary/captions/asset names go to OpenRouter/NVIDIA; no raw media; free endpoint logging; non-confidential projects only; output is an untrusted plan; Apply is required.

**GREEN implementation:**

- Do not reuse or overwrite Creative Brief consent.
- Keep migration additive and idempotent.

**Gate:**

```powershell
pnpm exec vitest run apps/api/src/postgres-schema.test.ts apps/api/src/control-plane.test.ts apps/api/src/postgres-control-plane.test.ts apps/api/src/http-server.test.ts
pnpm --filter @joy-media/api build
git diff --check
```

**Commit:** joy-media(WP-38): Add versioned Joy Code planning consent

### GPT-15 — Resolve canonical planning input and expose the plan route

**Create:**

- apps/api/src/joy-code-client-request-validation.ts
- apps/api/src/joy-code-client-request-validation.test.ts
- apps/api/src/joy-code-input-resolver.ts
- apps/api/src/joy-code-input-resolver.test.ts

**Modify:**

- apps/api/src/http-server.ts
- apps/api/src/http-server.test.ts
- apps/api/src/server.ts

**Route:**

- POST /v1/projects/:projectId/joy-code/plans

**Client envelope:**

- schemaVersion
- projectId
- snapshotRevisionId
- prompt
- bounded selection containing selectedClipIds and optional playhead/range

**RED tests:**

- Reject client-supplied snapshots, intelligence, assets, full documents, provider/model fields, approval flags, commands, paths, URLs, and secrets.
- Order is auth → ownership → consent → validation → admission → exact-revision resolution → runtime.
- Resolve S1 snapshot/S2 intelligence from the exact stored JoyProjectV1 revision.
- Include only registered asset/clip/caption names and IDs plus code-owned catalogs.
- Snapshot truncation that omits selected targets returns a blocker/unavailable result; never guess.
- Stale revision maps to 409, opt-out to 403, rate policy to 429, timeout to 504, unavailable to 503, invalid provider output to 502, cancelled/disconnected without mutation.
- Request disconnect aborts the in-flight runtime.
- Default runtime remains unavailable.
- Injected fake runtime reaches a ready proposal.

**GREEN implementation:**

- Build a bounded JoyCodePlanningInputV1.
- Attach server-owned plan metadata after validation.
- Wire only six explicit non-secret environment keys in server.ts.
- Do not use /v1/providers/mistral/complete.

**Gate:**

```powershell
pnpm exec vitest run apps/api/src/joy-code-client-request-validation.test.ts apps/api/src/joy-code-input-resolver.test.ts apps/api/src/http-server.test.ts apps/api/src/joy-code-production-runtime.test.ts
pnpm --filter @joy-media/api build
git diff --check
```

**Commit:** joy-media(WP-38): Add authenticated Joy Code planning route

### GPT-16 — Add the browser client and exact-revision coordinator

**Create:**

- apps/editor-web/src/joy-code-request-coordinator.ts
- apps/editor-web/src/joy-code-request-coordinator.test.ts
- apps/editor-web/src/joy-code-server-session.ts
- apps/editor-web/src/joy-code-server-session.test.ts

**Modify:**

- apps/editor-web/src/control-plane-client.ts
- apps/editor-web/src/control-plane-client.test.ts
- apps/editor-web/src/project-document-sync.ts
- apps/editor-web/src/project-document-sync.test.ts

**RED tests:**

- GET/PUT Joy Code consent and POST plan use authenticated same-origin API paths.
- projectId is URL encoded.
- The coordinator syncs the current JoyProject document first.
- It sends the resulting exact revision, not a stale cached revision.
- No planning call occurs if sync, parity, consent, or validation fails.
- Abort cancels the network request and late resolution is swallowed.
- Typed HTTP errors remain typed.
- A project change while waiting rejects the proposal before compilation.
- No production test contains media.joyteam.ir; use example.invalid for isolated URL construction.

**GREEN implementation:**

- Mirror the hardened Creative Brief coordinator patterns without sharing its read-only consent.
- Keep provider details and credentials server-side.

**Gate:**

```powershell
pnpm exec vitest run apps/editor-web/src/control-plane-client.test.ts apps/editor-web/src/project-document-sync.test.ts apps/editor-web/src/joy-code-request-coordinator.test.ts apps/editor-web/src/joy-code-server-session.test.ts
pnpm --filter @joy-media/editor-web build
git diff --check
```

**Commit:** joy-media(WP-38): Coordinate Joy Code server planning

### GPT-17 — Integrate asynchronous planning into AgentPanel

**Create:**

- apps/editor-web/src/AgentPanel.test.tsx

**Modify:**

- apps/editor-web/src/AgentPanel.tsx
- apps/editor-web/src/joy-code-history.ts
- apps/editor-web/src/joy-code-history.test.ts
- apps/editor-web/src/app.css
- apps/editor-web/src/App.tsx

**RED tests:**

- Existing seven deterministic direct intents remain local and instant.
- An unmatched free-form prompt uses the server session.
- Opted-out state shows the disclosure and Enable control before remote egress.
- While planning, Stop aborts the request and leaves no mutation.
- Ready proposal renders grouped Cut/Text/Captions/Transitions diffs, assumptions, blockers, destructive markers, model disclosure, and exact base revision.
- Apply is disabled for stale/invalid/blocked proposals.
- Full Auto still requires explicit Apply for a remote mixed plan.
- Apply calls the compound runner once.
- One Undo control restores the pre-plan state.
- Retry creates a new request without auto-applying the old proposal.
- Persian prompt/copy render correctly.
- Typed failures are actionable and do not expose raw provider output.

**GREEN implementation:**

- Replace only the current server-session-not-connected fallback.
- Keep the Joy Code brand while labeling provenance honestly as Remote planner: OpenRouter / NVIDIA free.
- Persist proposal identity/status in task history, not provider content or credentials.
- Do not mount a second chat/agent UI.

**Gate:**

```powershell
pnpm exec vitest run apps/editor-web/src/AgentPanel.test.tsx apps/editor-web/src/joy-code-history.test.ts apps/editor-web/src/joy-code-compound-runner.test.ts apps/editor-web/src/joy-code-server-session.test.ts
pnpm --filter @joy-media/editor-web build
git diff --check
```

**Commit:** joy-media(WP-38): Connect Joy Code to reviewable full-cut plans

### GPT-18 — Add deterministic integration and export fixtures

**Create:**

- apps/editor-web/src/joy-code-full-cut.integration.test.ts
- tests/e2e/wp38-joy-code-full-cut.spec.ts
- docs/qa/evidence/wp38/README.md

**Modify only if reusable fixtures need extension:**

- packages/test-fixtures/src/index.ts
- packages/test-fixtures/src/index.test.ts

**Fixture:**

- 1080×1920 vertical composition.
- At least three registered/playable visual clips or stills.
- A deliberately weak opening and removable dead-space range.
- Existing Persian/English caption document.
- Existing audio retained unchanged.
- No external URL, path, credential, or unregistered attachment.

**Integration tests:**

- A deterministic fake model proposal produces the expected compound draft.
- Project/timeline bytes are unchanged before Apply.
- Apply changes cut, title, caption style, and transition together.
- Exactly one Undo restores byte-identical state.
- Redo/reload persists.
- Preview builds and export completes.

**Browser test:**

- Sign in with the existing authenticated harness.
- Open the disposable project.
- Accept versioned Joy Code consent.
- Submit the full-cut prompt.
- Verify no mutation before review.
- Apply once.
- Play representative junction/title/caption frames.
- Export a bounded clip and verify output exists/is decodable.
- Undo and verify restoration.

**Gate:**

```powershell
pnpm exec vitest run apps/editor-web/src/joy-code-full-cut.integration.test.ts packages/test-fixtures/src/index.test.ts
pnpm exec playwright test tests/e2e/wp38-joy-code-full-cut.spec.ts --project=desktop-primary
pnpm --filter @joy-media/editor-web build
git diff --check
```

**Commit:** joy-media(WP-38): Prove full-cut plan apply undo and export

### GPT-19 — Run the complete local release gate

**No code changes unless a diagnosed failure requires a separate fix commit.**

**Focused gate:**

```powershell
pnpm exec vitest run packages/agent-tools/src/joy-code-plan.test.ts packages/agent-tools/src/async-joy-code-adapter.test.ts packages/agent-tools/src/async-joy-code-plan.test.ts packages/adapter-openrouter/src/joy-code.test.ts apps/api/src/joy-code-runtime.test.ts apps/api/src/joy-code-runtime-config.test.ts apps/api/src/joy-code-runtime-factory.test.ts apps/api/src/joy-code-production-runtime.test.ts apps/api/src/joy-code-admission-gate.test.ts apps/api/src/joy-code-client-request-validation.test.ts apps/api/src/joy-code-input-resolver.test.ts apps/api/src/http-server.test.ts apps/editor-web/src/joy-code-timeline-compiler.test.ts apps/editor-web/src/joy-code-text-operations.test.ts apps/editor-web/src/joy-code-caption-operations.test.ts apps/editor-web/src/joy-code-transition-operations.test.ts apps/editor-web/src/joy-code-compound-compiler.test.ts apps/editor-web/src/joy-code-compound-runner.test.ts apps/editor-web/src/joy-code-request-coordinator.test.ts apps/editor-web/src/joy-code-server-session.test.ts apps/editor-web/src/AgentPanel.test.tsx apps/editor-web/src/joy-code-full-cut.integration.test.ts
pnpm --filter @joy-media/project-schema build
pnpm --filter @joy-media/captions-core build
pnpm --filter @joy-media/agent-tools build
pnpm --filter @joy-media/adapter-openrouter build
pnpm --filter @joy-media/api build
pnpm --filter @joy-media/renderer-pixi build
pnpm --filter @joy-media/editor-web build
pnpm check
pnpm build
git diff --check
git status --short
```

**Rules:**

- Record exact test files/counts and build output.
- If pnpm check is red, prove the failure at the parent SHA before any exception; WP-38-owned files must have zero errors.
- Run a secret scan over the diff and built editor assets.
- Confirm no OpenRouter key, credential bytes, protected paths, raw provider body, or media.joyteam.ir literal.
- Push only a clean, reviewed main descendant.

### GPT-20 — Deploy disabled, then run one owner canary

This task changes live state. Execute only after the local gate, clean push, exact-SHA review, and a fresh owner go-ahead for the deployment window.

**VPS rules:**

- JOY Media lives at /opt/joy-media/repo and its immutable release paths.
- Do not use the joy-vps scripts/sync-to-live.sh; that deploys the bot/webapp sibling.
- Never edit a live release directory.
- Never read or print the Hermes .env key.
- Reuse /etc/credstore.encrypted/openrouter-api-key and the existing systemd credential mount.
- Add only non-secret JOY_MEDIA_JOY_CODE_RUNTIME_* values to /etc/joy-media/api.env, mode 0600.

**Preflight:**

- Verify local/origin/VPS SHA ancestry and clean trees.
- Recheck the exact OpenRouter model page and free status.
- Verify key presence/mode without printing its value.
- Record current API/editor release symlinks and service state.
- Run nginx -t, health checks, disk check, database connectivity, and the established compressed PostgreSQL backup.

**Deployment order:**

1. Build new immutable API and editor releases from the frozen lockfile.
2. Deploy with Joy Code mode disabled.
3. Switch symlinks atomically and restart joy-media@api.
4. Verify direct/public health, auth, project sync, Creative Brief regression, and no Joy Code egress.
5. Add exact Joy Code non-secret config:

   - mode openrouter
   - model nvidia/nemotron-3.5-lightning:free
   - timeout 30000
   - spend 0
   - secret ref joy-media/openrouter/joy-code-planner/v1
   - singleton allowed model list

6. Restart API and confirm readiness without opting in any project.
7. Use one owner-approved, non-confidential disposable project.
8. Accept Joy Code consent and make exactly one bounded planning request.
9. Verify redacted logs, exact returned model, zero cost receipt, no fallback, and admission counters.
10. Review, Apply, preview, export, Undo, Redo/reload.

**Immediate rollback triggers:**

- Wrong/missing response model.
- Nonzero or unknown cost.
- Provider output/schema mismatch beyond the one canary.
- Secret/prompt/project text in logs.
- Any mutation before Apply.
- Partial compound apply or failed byte-identical Undo.
- Broken preview/export, auth, project sync, or Creative Brief regression.
- Service instability or public health failure.

**Rollback:**

1. Set Joy Code mode disabled and restart API.
2. If code/health is implicated, restore prior API/editor symlinks and restart.
3. Preserve the failed release and redacted evidence.
4. Do not retry with another model or dynamic router in the same window.

### GPT-21 — Close WP-38 with evidence

**Modify:**

- plan/WP-38-joy-code-full-cut-server-session.md
- STATE.md

**Create:**

- docs/qa/evidence/wp38/closeout.md

**Record:**

- Source commits and deployed immutable releases.
- Exact model, consent version, zero-cost proof, and admission policy.
- Focused/full test counts and builds.
- Browser screenshots or trace references for prompt, plan card, no pre-Apply mutation, applied result, export, Undo, and reload.
- Redacted runtime outcome/audit evidence.
- Previous release and rollback commands.
- Known limitations, especially no generated assets and no claimed audio mix.

**Do not mark complete if:**

- Only fake-adapter tests passed.
- The live runtime remained unavailable.
- The plan changed only timeline clips without real text/caption/transition output.
- Export or one-Undo proof is missing.
- Consent or cost proof is missing.
- Any WP-38-owned full-build error remains.

**Gate:**

```powershell
pnpm exec prettier --check plan/WP-38-joy-code-full-cut-server-session.md STATE.md docs/qa/evidence/wp38/closeout.md
git diff --check
git status --short
```

**Commit:** joy-media(WP-38): Close Joy Code full-cut server session

## 9. Acceptance matrix

| Area                  | Required evidence                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Canonical state       | Exact revision synced and resolved server-side; stale request rejected.                              |
| Privacy               | Payload inspection proves no raw media, URL, path, object-store ref, token, or secret.               |
| Consent               | Separate current-version Joy Code consent recorded before first egress.                              |
| Provider              | Exact nvidia/nemotron-3.5-lightning:free, no fallback, zero cost, bounded body.                      |
| Plan safety           | Strict tool-call output, allowlisted operations only, unknown fields rejected.                       |
| No premature mutation | Timeline/document/history byte comparison before Apply.                                              |
| Picture mix           | At least three existing visual clips actually trimmed/reordered/placed.                              |
| Text                  | Code-owned template with owner text visible in preview and export.                                   |
| Captions              | Existing captions use a code-owned template; Persian/RTL proof included.                             |
| Transitions           | Curated transition renders at a validated adjacent junction.                                         |
| Atomicity             | One Apply, one history entry, no partial state on failure.                                           |
| Reversibility         | One Undo byte-restores both timeline and JoyProject document.                                        |
| Persistence           | Redo/reload retains the applied cut.                                                                 |
| Export                | Bounded MP4/export artifact exists and is decodable with expected styled frames.                     |
| Failure behavior      | Opt-out, stale, cancel, timeout, provider failure, invalid output, and rate limits make no mutation. |
| Regression            | Creative Brief, auth, project sync, editor build, and existing export remain green.                  |
| Operations            | Disabled-first release, backup, health proof, canary, and rollback reference.                        |

## 10. Risks and mitigations

| Risk                                           | Mitigation                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Free model changes or disappears               | Exact singleton ID, activation-day recheck, disabled fallback, reviewed model-change commit only.         |
| Model emits plausible but invalid edits        | Forced tool call, strict schema, server validation, local ID/range revalidation, dry-run, explicit Apply. |
| Provider logging receives sensitive text       | Separate disclosure, owner-only non-confidential project, bounded semantic context, no raw media.         |
| Mixed timeline/document edit partially applies | Pure full-draft compilation and one dispatchCompound call; failure tests and byte-identical Undo.         |
| Model invents styles/shaders                   | Code-owned template/transition catalogs only.                                                             |
| Text looks different in export                 | Canonical fonts, span-aware Pixi, font readiness, preview/export tests.                                   |
| Existing audio drifts                          | Timeline compiler preserves synchronization; no audio-state mutation in V1.                               |
| OpenRouter load affects Creative Brief         | Shared global concurrency plus per-feature admission and no retries.                                      |
| KiloCode identity becomes misleading           | ADR-0036 and joy-code-server provenance.                                                                  |
| Old domain reappears                           | joyst.ir production origin; example.invalid test origins; repository scan.                                |
| Secret source widens                           | Exact logical-ref map to one fixed credential ID; startup capture; regression tests.                      |

## 11. First implementation session

The next GPT session must implement **GPT-01 and GPT-02 only**:

1. Confirm clean main at 8f7d3b9 or its reviewed descendant.
2. Add ADR-0036.
3. Add the strict Joy Code plan contract and tests.
4. Run the two stated gates.
5. Commit separately.
6. Report SHAs, files, test counts, builds, and remaining next task GPT-03.

Do not begin provider, API, UI, VPS, or deployment work in that first session. The contract must become stable before any remote output can enter the product.
