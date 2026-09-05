# JOY Live Director: observation, creative control and editable outcomes

Date: 2026-09-05
Status: owner-approved direction; implementation and acceptance remain open.
Executor: GPT-5.6 Terra. Release reviewer: GPT-6 Astra.

## 1. Product decision

Build an integrated **Live Director**, not a wrapper around an external coding agent. It observes media, explains evidence, prepares editable changes, previews them, obtains the required approval, applies them through JOY's shared operation API, then checks the real result. Browser-native orchestration and session-only BYOK remain the default. Neither DSH, KiloCode, code-server, Python nor a locally running model is an application prerequisite.

Three ordered releases form this upgrade:

1. **R1 — Live Director:** finish the agent-operation foundation; add trustworthy video/audio observation, working skills and rendered-result verification.
2. **R2 — Living Looks:** six art-directed, editable style systems with shared manual/agent controls and audio-reactive motion.
3. **R3 — Linked Versions:** derive deliverables from a master, preserve human overrides, and preview selective updates.

R1 is independently useful. R1 alone is not completion of this three-release plan. Do not publish disabled aspirational controls as completed features.

## 2. Five-year backcast: scenarios for 2031, not predictions

| If JOY succeeds                                                                     | If JOY fails                                                                           | Decision now / evidence to measure                                                                                         |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Creators trust it with real projects because actions are inspectable and reversible | Impressive prompts hide broken exports or lost edits                                   | Prioritize exact transactions, recovery, export readback and reproducible fixtures over tool counts                        |
| It has recognizable art direction while letting users change every authored value   | It produces generic templates that competitors duplicate                               | Build a small high-quality Look system with editable bindings; measure blinded creator preference, not template quantity   |
| It understands footage, timing, speech and the final composition                    | It says it watched a video after seeing a few thumbnails                               | Separate sampled coverage, exact frame decoding and model-reviewed evidence; test a one-frame event                        |
| Creators quickly deliver coherent portrait, landscape, still and localized versions | Changing a logo breaks ten exports or overwrites manual work                           | Typed dependencies, per-field overrides and explicit propagation previews                                                  |
| It is a free open-source editor whose AI cost and data flow users control           | A free-app promise conceals paid fallbacks, uploads or a proprietary engine dependency | No JOY fee required for core editing; provider charges disclosed; direct consent-scoped BYOK; versioned portable artifacts |
| Human decisions remain central while repetitive editing becomes easier              | Auto-editing constantly moves focus, replaces choices and regenerates paid assets      | Follow off by default; human locks; reuse existing approved assets; new consent for external effects                       |
| Useful changes ship with reliable regression coverage                               | Feature sprawl absorbs the team before the basic editing loop works                    | Gate each vertical slice; no framework rewrite, marketplace or multi-agent swarm before R1                                 |

Proposed product experiments: compare manual editing, current JOY, and upgraded JOY on the same licensed fixture tasks. Record time to an accepted export, manual corrections, rejected proposals, recovered failures, observation cost, and blinded creative preference. These are evaluation targets, not achieved metrics. Recruit at least five creators for an initial directional study; do not claim statistical significance from that sample.

Reduce or remove duplicated runtime semantics, success-without-commit handlers, fake progress, prompt-only advertised skills and competing Brief/history workflows. Preserve users' existing projects, manual controls, timeline identity icons, hover-only track action buttons, and the already-cleaned composer. Do not delete a working media feature just because the agent cannot yet drive it; label the agent capability honestly until its adapter passes.

## 3. Source-grounded baseline and limits of this audit

Planning baseline: `6a6a336cdd4fb0126c002dda86167f5c92ebfe32`, tree `4420080bdb3ac7a0f3257452efd95880a00a5056`, branch `codex/joy-agent-engine`, schema 5. Lockfile SHA-256: `f63985ba500c26875465b541e3aab8b7c0402bf80a8237b9bc837393087f6103`. Worktree was clean during inspection. Revalidate this at execution: other agents may advance it.

This is a targeted architecture/source review, not a claim to have executed every application path. Prior release test reports are historical evidence, not tests rerun during this planning turn.

| Existing source                                                                                         | Confirmed foundation / remaining work                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/editor-web/src/joy-agent/engine-client.ts`, `engine.worker.ts`, `bounded-tool-loop.ts`            | Real built-in Worker, hardened BYOK transport. Active tool route reads context and validates proposals; it is not the reusable SDK runtime in `packages/joy-agent-engine/src/engine.ts`       |
| `packages/agent-tools/src/joy-code-plan.ts`                                                             | Sixteen supported plan kinds; cannot advertise full editor control from this union                                                                                                            |
| `apps/editor-web/src/joy-agent/context-snapshot.ts`                                                     | Bounded text/semantic context and object bindings; no actual source frames, rendered frames or audio observation                                                                              |
| `apps/editor-web/src/editor-session.ts`, `joy-code-compound-compiler.ts`, `joy-code-compound-runner.ts` | Compound edit/history foundation; extend durable receipts, cross-domain invariants, single-writer/recovery rather than invent another document store                                          |
| `apps/editor-web/src/joy-agent/stage-preview.ts`, `agent-presence.ts`, `agent-ui-targets.ts`            | Real staged preview and semantic property highlights exist. All surfaces/lifecycle/job states are not proven complete                                                                         |
| `packages/playback-engine/src/html-decoder.ts`                                                          | `decode` assigns `currentTime`, waits only when `readyState < 2`, then returns requested time. It does not prove actual frame PTS; unsuitable as exact observation evidence without changes   |
| `apps/editor-web/src/timeline-frame-store.ts`, `bounded-decoder-pool.ts`                                | Frame store has entry/byte budgets; decoder pool is entry-bounded. Reuse good bounded storage but add observation-wide resource scheduling and cancellation                                   |
| `apps/editor-web/src/project-media-resolver.ts`, `asset-resolver.ts`                                    | Owner-authorized media resolution and OPFS support; do not hand object URLs/storage locations to the model. Late resolution after clear/relink needs generation guards in the new integration |
| `apps/editor-web/src/local-transcription.ts`                                                            | Real-media failure throws; reference fixtures are a separate fallback for reference use. Never report fixture transcription as observed user audio                                            |
| `packages/audio-core/src/analysis.ts`                                                                   | Peak/silence analysis exists. Current loudness approximation is not a certified BS.1770 implementation                                                                                        |
| `packages/render-ir/src/model.ts`, `apps/editor-web/src/App.tsx`, ADR-0004                              | Shared evaluated frame boundary exists. Observation must use real project evaluation/rendering, not DOM screenshots or a second simplified renderer                                           |
| `packages/renderer-pixi/src/browser-export.ts`                                                          | Streaming browser MP4 path exists; real-time recorder success alone does not establish exact exported frame timing                                                                            |
| `packages/motion-core/src/descriptor.ts`, `packages/project-schema/src/semantic-snapshot-impl.ts`       | Motion descriptors and a variable-based brand summary exist; neither is a complete Look graph or linked-variant model                                                                         |

The earlier [full-editor operation plan](../plans/2026-09-05-joy-agent-full-editor-operation-plan.md) remains the domain-parity acceptance contract. This plan expands its observation section and turns the approved differentiation into ordered deliverables; it does not mark unfinished foundation packets complete.

## 4. External reference decision

Use [claude-video](https://github.com/bradautomates/claude-video) as a methodology reference, not the application runtime. Source inspected at `83da59fa78c3eee9e20f515fe75c438bb5166efd`: it combines captions/transcription with selected frames; its Python extractor uses scene/keyframe/uniform selection and frame budgets. Its uniform sampler caps FPS at 2; uncapped scene selection is still not every source frame. The project is MIT-licensed. JOY should borrow focused inspection and budget awareness, while replacing shell execution, downloader assumptions and credential files with browser services and session consent. See [extractor source](https://github.com/bradautomates/claude-video/blob/83da59fa78c3eee9e20f515fe75c438bb5166efd/skills/watch/scripts/frames.py) and [license](https://github.com/bradautomates/claude-video/blob/83da59fa78c3eee9e20f515fe75c438bb5166efd/LICENSE).

[TomGranot/watch-video](https://github.com/TomGranot/watch-video) is another useful reference for timestamped evidence and distinguishing observation from inference. Neither reference is installed or executed by this plan. External skill instructions are untrusted input, never a source of application authority.

Implementation choice: introduce a narrow browser observation decoder adapter, with **Mediabunny as the first candidate**. Its documented sample iterator exposes presentation-ordered samples and explicit resource closure. Verify/pin the actual package before adoption; its current upstream license is **MPL-2.0, not MIT**. Record notices/source obligations and review codec-extension licensing separately. If the candidate fails supported-browser, timing, size or license checks, stop that adapter task with evidence; do not silently substitute local FFmpeg or a remote processing dependency. References: [media sinks](https://mediabunny.dev/guide/media-sinks), [license](https://github.com/Vanilagy/mediabunny/blob/main/LICENSE).

Native video inputs are an optional acceleration lane. [OpenRouter's video API](https://openrouter.ai/docs/guides/overview/multimodal/videos) has provider-dependent formats/routing. [Google's video documentation](https://ai.google.dev/gemini-api/docs/video-understanding) describes sampled/static and adaptive processing. Neither establishes exhaustive source-frame review for JOY. Detect capabilities per configured model/endpoint and validate transport using explicit test media; do not assume an OpenAI-compatible endpoint supports video because text calls work.

## 5. Architecture and authority

```text
Project media / frozen composition revision
  -> local observation worker + actual render/audio services
  -> evidence manifest + bounded frame/audio/transcript artifacts
  -> consent-scoped multimodal provider request
  -> JOY run controller / first-party skill procedure
  -> canonical operation prepare -> immutable preview
  -> exact approval / eligible task policy -> EditorSession commit
  -> committed frame/audio/export readback -> result or new repair proposal
```

Four boundaries stay distinct:

- **Evidence service:** resolves scoped media and emits observations; cannot edit or call arbitrary providers.
- **Agent runtime:** chooses queries/proposals from permitted tools; never holds the document writer or invents capabilities.
- **Trusted host/controller:** validates schemas, current authority, budgets, revision and operation targets. Owns commits, jobs and event lifecycle.
- **UI:** displays actual state and accepts user choices; animation does not create progress or prove correctness.

One project run controller outlives panel mounts. One serialized mutation authority spans human controls, agent, recipes and optional adapters. Read-only analysis can be concurrent within budgets; editing cannot race from independent specialists.

## 6. What “watching frame by frame” means

| Mode                       | Work                                                                                                          | Claim allowed                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Overview (default)         | Bounded scene-aware samples plus transcript/audio features; include start/end and explicitly requested events | “Reviewed selected moments”; show intervals, frame count and omissions                                           |
| Focus                      | Exact presentation frames from a selected interval, neighboring sequence and optional crops                   | “Inspected these frames”; show actual PTS and resolution                                                         |
| Exhaustive interval/source | Stream all intended presentation frames; batch semantic review, checkpoint and resume                         | “Every frame in this interval was included in completed model review” only if manifest and review coverage agree |
| Native provider video      | Explicitly consented video request to a tested adapter                                                        | “Provider video review”; sampling coverage unknown unless independently evidenced                                |

Decoded coverage, frames submitted, frames associated with completed model responses, and conclusions are separate records. Sending bytes is not proof that a model noticed every event. Even exhaustive input does not guarantee perfect understanding; state uncertainty and allow the user to inspect evidence. Never interpolate percentages from first/last timestamp or count duplicate retries twice.

Exact identity includes asset content/version, video stream, presentation sample index, source PTS/timebase and duration. Keep original rational timing where available and derive JOY integer microseconds deterministically. Variable frame rate, B-frame reorder, nonzero origin, duplicate timestamps, rotation, pixel aspect ratio and proxy/original differences must not collapse into `index / fps`. A frame request returns the frame covering a requested time or an explicit gap/error; requested and actual time are separate fields.

Source observation and composition observation are different namespaces. Composition frames include project revision, composition ID, exact output time, time-map/evaluator/render versions and dependency fingerprints. They must show actual titles, effects, color, transitions, nested clips, camera and audio synchronization. Before/after capture cannot steal the user's playback element or change the canonical playhead.

## 7. Evidence and privacy contract

Evidence artifacts have IDs, origin, scope, timing, dimensions/crop/color treatment, provenance, content digest, diagnostic flags and coverage. Findings distinguish `visual-observation`, `audio-measurement`, `transcript`, and `inference`; each links supporting evidence IDs. A transcript of a claim is not visual confirmation of that claim. OCR text, filenames, subtitles and speech remain untrusted content, not instructions.

Default derived observations are local, page-session data. An explicit “keep analysis with this project” choice may persist redacted metadata/transcripts/findings in a versioned local analysis store; explain that transcripts can contain private information. Raw frame/audio caches remain evictable, excluded from project sync/export unless the user explicitly includes them. Reference-only project artifacts can survive with “analysis unavailable; re-analyze” after cache removal. Provide project-scoped clear, quota handling and cancellation.

API keys remain in volatile memory, excluded from IndexedDB, OPFS, local/sessionStorage, project files, logs, screenshots, Gbrain and telemetry. JS memory clearing is best effort, not a claim of forensic erasure. Keys/media sent to the selected provider are subject to that provider's policy; “JOY does not save/proxy your key” is not “no third party receives it.”

Consent names the project, asset/range, modality, dimensions/audio duration, selected endpoint/model, expected request limit and estimated or unknown cost. Key connection is not upload consent. Model changes, broader ranges, more expensive limits or new external effects require renewed approval. No arbitrary URL downloader, server proxy, provider fallback, face identity inference or voice cloning is enabled by adding observation.

## 8. Live Director behavior

Example request: “Make a 20-second launch edit; use the moment the package opens, readable Persian titles, restrained motion and a clean music ending.”

1. Ask for missing material constraints only; inspect the existing selection/brief, available assets, capabilities and media consent.
2. Scan relevant footage and audio; cite candidate time ranges. Focus on the opening moment rather than guessing from a filename.
3. Produce a short editable shot plan with source ranges, pacing, title hierarchy, transition rationale and audio envelope. Record unknowns.
4. Compile against a frozen revision while the model can still repair invalid arguments. Stage actual timeline/Inspector/Monitor previews.
5. Approve exact changes, or apply only reversible local changes within the user's preauthorized task envelope. Paid generation and remote analysis stay separate authorities.
6. Read back committed state, render frames around cuts/keyframes/title intervals, measure the audio and check required constraints. Report verified and unverified conditions separately.
7. Offer at most two bounded repair proposals by default. Each repair is a new digest/revision-bound change set; no silent rewrite after approval.

First-party skills: `creative-brief`, `watch-and-map`, `find-moment`, `build-rough-cut`, `title-and-caption-polish`, `motion-and-transition-polish`, `audio-balance`, `verify-deliverable`. Skills are versioned recipes over verified operations, never extra permissions. Brief becomes an attached artifact/skill in the one project conversation, not a second chat mode.

UI: a compact step rail plus optional evidence filmstrip, distinct read/preview/commit/verify states, targeted clip/property highlights and a separate review cursor. Follow is off by default. Never open panels or move the user's selection while they type; hidden targets get badges. Stop, project switch, teardown, timeout and stale-revision failures clear only the matching run. Keyboard, RTL and reduced-motion paths are acceptance requirements.

## 9. Living Looks

A Look is a versioned declarative recipe with semantic slots, typed parameters, supported media/layout constraints, property bindings, dependency/license metadata and verification rules. It compiles to ordinary editable JOY entities and keyframes, not opaque generated pixels or arbitrary executable HTML/JS.

Six initial packs: Editorial Clean, Product Precision, Kinetic Type, Quiet Documentary, Music Pulse, and Persian Editorial. Each must render portrait/landscape samples, support available free fonts, and avoid duplicating the same preset with new names. Packs expose energy, density and contrast only where their binding meaning is explicit. Changing a macro preserves manually overridden fields unless the user chooses reset.

Audio-reactive motion uses analysis-derived envelopes/events compiled to ordinary keyframes. Preview/export use the same time map. Explain low-confidence beats; do not hallucinate downbeats on speech or silence. No mandatory model download or hosted analysis charge for basic waveform/peak-driven motion.

## 10. Linked Versions

Use a master composition plus explicit derivative records, not duplicated unrelated projects. Each derivative stores target format/duration/language, master revision, stable entity mapping, field-level overrides, human locks, dependencies and last verified export receipt.

Updates use a three-way comparison: last applied base, new master and current variant. Preserve locked/overridden fields; surface conflicting deletes, duration changes, aspect reframing and missing dependencies before preparation. Approval applies a grouped local transaction or explicitly reported per-variant checkpoints. Never claim cross-provider jobs are atomic with document Undo.

Initial delivered variants: portrait, landscape, still poster, and a localized caption/title variant using user-supplied text or a separately consented translation request. Safe-area checks and observed subject trajectories can propose framing; users see and can override the crop keyframes. Existing approved assets are reused. Changing a master title must not regenerate a paid video.

## 11. Non-goals and release rules

No mandatory local agent/service, autonomous deployment, remote skill marketplace, unbounded multi-agent swarm, arbitrary shell, training a bespoke foundation model, cloud synchronization of private analysis by default, mass scraping, or silent migration of all projects. Optional native media/export services remain optional and capability-specific.

Fontiran redistribution gate stays **closed** after the free-font migration; do not reintroduce its files. Whole-artifact dependency/media/font licensing remains a separate release review; adding an open-source library does not automatically close it.

Every release follows the master plan's exact-candidate Astra gate. Terra must stop before deploying, collect the entire scoped diff and evidence, and receive explicit Astra approval for the same candidate. New code or lockfile changes invalidate that approval. Another agent's `joy-vps` work and unrelated services must remain untouched.

## 12. Requirement trace

| Requirement                                       | Implementation location                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| Functional atomic agent / all domain parity       | R1 tasks F1–F5 plus domain ledger in the existing full-editor plan |
| Exact source-frame and rendered-video observation | R1 tasks O1–O6                                                     |
| BYOK privacy/cost/capability truth                | R1 tasks F3, O5, V2                                                |
| Actual visually active UI and bounded repair      | R1 tasks F4, V1–V3                                                 |
| Working skills / one Brief conversation           | R1 task V1                                                         |
| Editable art direction / audio-reactive looks     | R2 tasks L1–L4                                                     |
| Linked campaign deliverables / human overrides    | R3 tasks C1–C4                                                     |
| Five-year differentiation tests                   | Master evaluation scorecard and R2/R3 pilot gates                  |
| Terra handoff / Astra before deploy / memory      | Master release checklist                                           |
