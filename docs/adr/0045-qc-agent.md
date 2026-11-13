# ADR-0045: Joy Code can check a cut frame by frame, in two layers

Status: **Accepted** (13 Nov 2026). Reviewed by Claude Sonnet 5.5; every point of that review is answered in section 10 and every wrong claim is corrected against the code.
Date: 2026-11-12, revised 13 Nov 2026
Owner of this note: MC (mcode CLI), worktree `v111-ui`, branch `v111/qc-design`
Closes: part of C-186 (the owner's request that Joy Code look at a timeline or an export frame by frame, find faults, fix them with approval, and write a short quality report)
Task: T-B01 of `03-TASK-CARDS.md:217-221`

## Context

The owner wants Joy Code to watch what they have actually made, find what is wrong, propose a fix, and write a short report. This note fixes the shape of that feature before any code is written, so the GB and CX cards do not each invent their own.

What the code actually does today (read 12 Nov 2026, revised against `integration/v1.1.1` = `9601dd40` on 13 Nov 2026, read-only, in `v111-ui`):

- The model already has a **closed, product-owned tool vocabulary**. `JOY_AGENT_HOST_TOOL_NAMES` (`apps/editor-web/src/joy-agent/host-tool-contract.ts:7-27`) lists every tool the browser host will ever answer, and `isJoyAgentHostToolName` (`:31-34`) is the only door into it. The file says plainly that it lives below the provider catalog "so both boundaries validate the identical set". **Any new QC tool must be added here or it does not exist.**
- Six of the twelve names are the observation tools: `media_describe`, `media_observe`, `media_frames`, `media_transcript`, `evidence_read`, `evidence_coverage` (`host-tool-contract.ts:10-15`). The other four `look_*` names are the Living Look intent tools (`:23-26`).
- **The observation tools are metadata-only, and say so in their own descriptions.** `media_frames` "never returns frame pixels, blobs, URLs, or paths" (`apps/editor-web/src/joy-agent/bounded-tool-loop.ts:242`); `evidence_read` "reports coverage only, not media data" (`:301`); `evidence_coverage` "cannot clear, mutate, or export evidence" (`:325`). **Today the agent cannot see a single pixel of the user's work.** That is the gap this note closes.
- The tool schemas are strict and bounded: `strict: true`, `additionalProperties: false`, a required list, and `SAFE_OBSERVATION_IDENTIFIER_PATTERN` on every id (`bounded-tool-loop.ts:237-269` is the pattern to copy). The bounds are real constants: `MAX_OBSERVATION_FRAMES = 512`, `MAX_OBSERVATION_METADATA_BYTES = 32 * 1024`, `MAX_OBSERVATION_PAGE_SIZE = 128`, `MAX_OBSERVATION_CURSOR = 2_097_152` (`bounded-tool-loop.ts:72-76`).
- The model sees images through a **separate, deliberate path**: `multimodal-transport.ts` builds OpenAI-compatible content parts locally — `image_url` with a `data:` URL, `input_audio`, `video_url`, or text (`providerContentPart`, `:434-458`) — and the file comment says "OpenAI-compatible content is constructed locally; no public upload URL is ever produced" (`:433`). The request body is capped at `MAX_MULTIMODAL_REQUEST_BYTES = 32 * 1024 * 1024` (`:16`) and must be non-empty.
- **That transport is a one-shot, not a channel.** `prepareProviderRequest` builds exactly one request — `messages: [{ role: 'user', content }]` where `content` is the prompt plus one part per evidence item (`multimodal-transport.ts:414-420`) — and the reply is analysis **text**, capped at `MAX_MULTIMODAL_ANALYSIS_TEXT_BYTES = 16 * 1024` (`:25`). The response itself is read under a 64 KiB cap (`:23`). **Frames ride one request; they do not ride "the next provider request" of an ongoing tool loop.**
- **The transport takes at most 16 evidence items per batch** (`MAX_MULTIMODAL_EVIDENCE_PER_BATCH = 16`, `multimodal-transport.ts:12`), enforced when the evidence ids are normalised (`observation-review-controller.ts:760-771`).
- **The review controller deliberately forbids feeding analysis back into the tool loop.** `ObservationReviewAnalysis` is "bounded plain text plus the opaque evidence identities already approved by the local host. It is presentation data, **never tool-loop input**" (`observation-review-controller.ts:92-96`). The grant path is user-click only.
- A provider's ability to **see** is already proven by a probe, separately from its ability to call tools. `PROVIDER_MEDIA_CAPABILITY_PROBE_ACK` and `PROVIDER_MEDIA_CAPABILITY_MODALITIES = ['image', 'audio', 'video']` (`apps/editor-web/src/joy-agent/provider-capabilities.ts:30-31`), judged by `assessProviderMediaCapabilities` (`:124`) which returns `supported`/`unavailable` per modality and **never keeps the raw response**. The probe is "deliberately unrelated to the structured-tool probe above: media support never upgrades tool capability" (`:27-28`).
- Consent for sending media out is a real, separate object. `observation-consent.ts` has `issueObservationConsent` (`:101`), modalities `image | audio | video | transcript` (`:1`), and hard bounds: 512 evidence ids, 64 requests, 512 MiB per consent, a 6-hour range, and a **1-hour TTL** (`:MAX_OBSERVATION_CONSENT_*`). A consent is **per `runId`**, lists its `evidenceIds` up front, **cannot be replaced** ("active observation consent cannot be replaced without cancellation", `:144-146`) and **cannot be reused** after cancellation or completion (`:148-149`). A request is refused when its evidence ids are not all inside the consent (`:188`).
- `ObservationRange` requires a **domain**: `'source' | 'composition'`, and "source and composition ranges are never interchangeable" (`observation-consent.ts:5-12`). An export is neither: it is not a library asset and it has no composition.
- **The privacy switch does not reach the agent path on its own.** `AgentPolicyPreferences.privacyMode` is `'ask-before-remote' | 'local-only'` (`apps/editor-web/src/agent-policy-settings.ts:24`), default `ask-before-remote` (`:36`), and `approvalPolicyForAgentPolicy` turns `local-only` into `blockRemoteUploads: true` (`:98`). But `ApprovalEngine.evaluateStep` judges plan steps by `estimatedCost`, not by observation transfers (`packages/agent-tools/src/approval.ts:78-81`), and in `local-only` the panel sets `isEditReady = false` (`AgentPanel.tsx:568`), so the whole agent path is off. **A QC feature run by the model would have no entry point in local-only.**
- The tool capability list is a fixed 12 names — `timeline.read`, `timeline.write`, `assets.read`, `assets.import`, `filesystem.read`, `filesystem.write`, `provider.generate`, `provider.spend`, `render.preview`, `export.write`, `project.overwrite`, `plugin.invoke` (`packages/agent-tools/src/approval.ts`, `ALL_TOOL_CAPABILITIES`). Sending something out is already a thing the approval system names: `'remote-upload'` appears in `requireApprovalFor` at `:343` (preview-and-approve) and `:361` (auto-apply-low-risk), and `:122` is the **block** decision that fires when `blockRemoteUploads` is set (`:119-125`).
- The evidence store already models persistence as a choice: `EvidencePersistencePreference = 'ephemeral' | 'project-local-metadata'` (`apps/editor-web/src/media-observation/evidence-store.ts:6`) and the frame stages `'decoded' | 'submitted' | 'reviewed'` (`:7`). Every manifest carries a coverage summary whose `modelComprehensionGuaranteed` is the literal `false` (`evidence-store.ts`, `EvidenceManifestCoverageSummary`).
- The sampling rules already exist and are careful: `selectOverviewFrames` and `createCanonicalFrameSampler` (`apps/editor-web/src/media-observation/sampling-policy.ts:54`, `:113`), and `CanonicalFrameSamplingResult.completeSourceCoverage` is `false` for an explicitly sampled subset (`:36-41`).
- The Worker already runs ffmpeg jobs and already has a job-type switch (`apps/worker/src/runtime.ts:298` handles `render.export`; `upscale.image`/`upscale.video`, `mask.image`/`mask.video`, `image.comfy`, `audio.ml-denoise`, `text.lm-studio` are other branches). The job protocol lives in `packages/job-protocol/src/protocol.ts` and `agent-jobs.ts`.
- The audio maths is already written and unit-tested: `measurePeak`, `detectClipping`, `measureLoudness`, `detectSilence` (`packages/audio-core/src/analysis.ts:28`, `:51`, `:121`).
- A run is bounded hard: `MAX_JOY_AGENT_RUN_BUDGET_V1` is `maxToolSteps: 8`, `maxOutputBytes: 2 * 1024 * 1024`, `maxWallTimeMs: 60_000`, `maxRepairAttempts: 2` (`apps/editor-web/src/joy-agent/run-budget.ts:5-8`). **`parseJoyAgentRunBudget` throws on any value above the maximum** (`:77-83`), so a larger QC budget needs a new budget version, not a bigger number in the same one. **`maxOutputBytes` counts provider _response_ bytes** (`engine.worker.ts:1503-1515`), not tool results.
- The Joy Code message body is a plain `string` capped at **8 000 characters** (`apps/editor-web/src/joy-code-history.ts:4-9`, `:30`), so a report cannot travel as structured parts and the in-chat summary needs its own hard cap.
- `AgentEvidenceFilmstrip.tsx` exists and is tested but **nothing in the app renders it** — only its own test references it. **It is metadata-only**: `AgentEvidenceFilmstripEvidence` carries `id`, `timestampUs` and `coverage` (`apps/editor-web/src/AgentEvidenceFilmstrip.tsx:12-20`) and "intentionally does not accept media payloads, locations, or connection metadata" (`:12-15`). **It cannot show frames.**
- **One Undo for a compound edit lives on the editor session, not in `agent-tools`.** `session.dispatchCompound(label, { timeline, document })` is called from the editor's command bus (`apps/editor-web/src/agent-command-bus.ts:32`). T-B06 needs that file.
- **There is no project folder in v1.1.1.** The project persists as a document through the editor session, and the only "save as a file" path in the editor is a browser download (`apps/editor-web/src/browser-text-download.ts:28` `downloadBrowserTextFile`) plus the project **package** (`apps/editor-web/src/project-package.ts`).
- The desktop IPC allowlist is `apps/desktop/src/preload/ipc-channels.cjs`, with channels such as `desktop.media.asset.register`, `desktop.media.render.enqueue` and `desktop.media.job.status`; the handlers are `apps/desktop/src/main/ipc-handlers.ts`.
- The model's **system prompt hard-codes the six observation tool names** in the observation branch (`apps/editor-web/src/joy-agent/engine.worker.ts:1339-1350`). **A tool that is not in that list is invisible to the model**, even if it is in the host tool contract.
- There is **no export tool** in the agent vocabulary. The export is a desktop IPC channel, not a model tool.

---

## Decision

### 1. The shape: two layers, one report

Joy Code's quality check is **two layers that produce one report**.

**Layer 1 — the technical check.** No model, no network, no cost. The Worker runs ffmpeg and ffprobe filters and returns numbers: black frames, frozen frames, scene cuts, loudness, silence, clipping, exposure, colour cast. For a timeline, the editor samples composed frames and measures safe areas and text legibility locally. **Layer 1 works with no model connected at all**, and its numbers are the same for every provider.

**Layer 2 — the seeing check.** Only for providers whose probe says `image: supported`. A **host-run one-shot call** hands a bounded set of chosen frames to a model that can see and takes back **bounded analysis text**. Section 4 fixes the route. Layer 2 never re-measures what Layer 1 measured, and it never sees more frames than the budget allows.

**Why two layers, not one.** Layer 1 is deterministic, free and testable, so a fault that Layer 1 finds is a fact. Layer 2 is a judgement, so it must never be the only way a fault is reported, or the same film would get different verdicts on different days and with different providers.

### 2. The three states of a finding

Layer 1 and Layer 2 do not produce the same kind of claim, so they must not share one word.

| State                | Meaning                                                                      | Who can set it                                                 | Can it become a fix?                                                                                          |
| -------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **`measured`**       | Layer 1 measured it against a threshold. The number is in the report.        | Layer 1 only.                                                  | Yes, if its type is fixable (section 7).                                                                      |
| **`model-observed`** | The model saw something and said so. It carries the frame and the time code. | Layer 2 only.                                                  | **No, not automatically.** It is a question for the owner. The owner can promote it to a fix by approving it. |
| **`unconfirmed`**    | Layer 2 claims something Layer 1 has already measured clean.                 | Layer 2 only, and only when Layer 1 has a check for that type. | No. It is shown as a disagreement, and the report says which layer disagrees with which.                      |

**The rule in one sentence:** Layer 2 can never raise a `measured` finding's confidence, and Layer 2 can never claim a type Layer 1 has a check for unless it is downgraded to `unconfirmed`.

**Why `measured` and not `confirmed`.** The thresholds are admitted guesses (see "Risky" below). A threshold that is a guess produces a _measurement against a guess_, and calling it "confirmed" would overstate it.

**What Layer 2 adds.** Layer 2 may observe **anything**, including things Layer 1 has no check for — "the subject is cut off", "this shot feels empty", "the title is hard to read". These are `model-observed`, they carry the frame id and the time code so they are actionable, and they are never auto-fixed. "This shot feels empty" is a **note**, and a note is a `model-observed` observation with no fix attached (section 7).

### 3. The four tools, and the one host action

**Layer 1 is a host action, not a model tool.** The owner starts it — a button, a chat command, or the CLI. It returns a `reportId`. It is not in the model tool vocabulary, because a model-driven Layer 1 would hit the 60-second wall-clock cap on any real-length file and would have no entry point at all in `local-only` (the whole agent path is off there, `AgentPanel.tsx:568`).

| Entry point                                                             | Who runs it           | What it does                                                             |
| ----------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| **Button** — "Check this cut" in the Colour panel or the Joy Code panel | The owner             | Starts Layer 1 over the current timeline, shows progress, offers Cancel. |
| **Chat command** — the owner types a plain instruction                  | The owner             | Starts Layer 1 over the current timeline or the last export.             |
| **CLI** — `joy-media qc <file>`                                         | The owner or a script | Runs Layer 1 over a file and writes the report.                          |

All three land in the same place: a `reportId` and a report in the report store.

The **model** gets three tools, not four:

**`media_frames_view`** — asks the host to run the one-shot seeing call over a bounded set of frames the report already lists, and returns **the model's analysis text** (bounded), never pixels.

```json
{
  "reportId": "<string, SAFE_OBSERVATION_IDENTIFIER_PATTERN>",
  "frameIds": ["<string>", "..."],
  "reason": "<string, maxLength 280>"
}
```

`frameIds` must be frame ids the report already lists — a frame id not in the report is rejected, so the model cannot ask for a frame it was not shown. The tool returns no pixels: the transport carries them inside its own one-shot request (`multimodal-transport.ts:414-420`), and the reply comes back as ≤ 16 KB of text (`:25`). `reason` is stored with the evidence so the report can say why a frame was sent.

**`media_contact_sheet`** — one picture holding many small frames, for a broad look at the whole cut.

```json
{
  "reportId": "<string>",
  "frameIds": ["<string>", "..."],
  "columns": 4
}
```

Up to 16 frames on one sheet (the transport's per-batch limit, `multimodal-transport.ts:12`), burnt-in timecodes, one `image_url` part. It is the cheap way for the model to see the shape of the film without spending many sends.

**`qc_report_read`** — reads a saved report back.

```json
{ "reportId": "<string>", "includeFindings": true }
```

It reads only reports the owner has kept; it cannot delete one.

**The removed tool.** The first draft of this note proposed `media_qc_run` as a model tool. **It is withdrawn.** Layer 1 is a host action (above). A model that wants to know the state of a cut calls `qc_report_read`, and the owner starts the check.

### 4. How Layer 2 reaches a model — the one route

There are two possible routes, and this note picks the second.

**Route A — keep the review path as it is.** The owner clicks "analyse"; the analysis text goes into the report; the model never sees it in its own turn.

**Route B — a host-run one-shot that returns analysis text into the tool result.** The host takes the frames the model named, mints a consent for exactly those frames, runs the existing one-shot transport, and puts the ≤ 16 KB text into the tool result.

**This note chooses Route B**, as an explicit, narrow relaxation of one rule: `observation-review-controller.ts:92-96` says the review analysis is "presentation data, never tool-loop input". **Route B is allowed to break that rule for QC findings only, and only for the bounded analysis text.** It does not break it for media bytes, for paths, for credentials or for anything else.

Why B and not A: under A the model can never react to what it sees, so it cannot propose a fix in the same breath as the observation, and the whole "the agent finds a fault and fixes it" loop needs two human round trips per round. Under B the model reads the frames, reads its own text, and proposes one fix in one turn.

**The rules that keep B safe:**

1. **The host mints the consent, not the model.** The consent lists the exact `evidenceIds` of the call (`observation-consent.ts:29`), cannot be replaced (`:144-146`) and cannot be reused (`:148-149`). The model names frames; it never names a consent.
2. **Every round needs its own consent and its own cost card.** A consent is per `runId` and lists its frames up front, so new frames in a new round are not covered by the old consent. See section 5.
3. **The text is bounded and is not evidence.** The reply is ≤ 16 KB (`multimodal-transport.ts:25`), and the model may not quote it back as a media fact. The report records it as a note, not as a measurement.
4. **The batch is at most 16 frames** (`multimodal-transport.ts:12`), so one call is one batch and one consent request.
5. **The frames are never returned to the model as bytes.** Only the analysis text comes back.

### 5. Consent, and the local-only mode

**Sending a frame out needs the same consent the app already asks for.**

1. **`local-only` blocks Layer 2 entirely, and Layer 1 keeps working.** Layer 2 needs a model and a consent; `local-only` turns the agent path off (`AgentPanel.tsx:568`), so there is no Layer 2. **Layer 1 is a host action, so it still runs in full** — that is the whole reason Layer 1 is a host action and not a tool. The report says: "The seeing check was off: your settings keep frames on this PC."
2. **One cost card per round, not per session.** A consent is minted per `runId`, lists its evidence ids up front, and cannot be replaced or reused (`observation-consent.ts:29,144-149`). Its TTL is one hour (`:MAX_OBSERVATION_CONSENT_TTL_MS`). Every round of the fix loop has a new run and new frames, so **every round needs its own card**. Inside one round, one card covers that round's calls; the round does not ask again.
3. The card names how many frames, how many kilobytes, and which provider they go to.
4. The approval system already has the right vocabulary: `'remote-upload'` is in `requireApprovalFor` (`approval.ts:343` for preview-and-approve, `:362` for auto-apply-low-risk) and `blockRemoteUploads` is set from `local-only` (`agent-policy-settings.ts:98`).
5. The provider must have proven it can see: `assessProviderMediaCapabilities` (`provider-capabilities.ts:124`) must return `image: 'supported'`. A model that cannot see images gets Layer 1 only, and the report says why.

**The owner's media never goes to an unapproved place.** There is no path in this design that writes a frame to disk in a place the owner did not ask for, and no path that uploads to a URL.

### 6. Finding types

Fourteen types, in three groups. Each finding carries: `id`, `type`, `severity`, `startUs`, `endUs`, `label` (one plain sentence for the owner), `measured` (the numbers, when the type has them), `state` (`measured` / `model-observed` / `unconfirmed`), `fixable` (section 7), and `evidenceIds` (the frames or samples behind it).

**Severity** is three words and nothing else: `blocker` (data loss, crash, wrong export, install failure), `major`, `minor`. The word list is the same one the defect log already uses (`03-TASK-CARDS.md:203`), so a QC finding and a test defect speak the same language.

#### 6a. The ten Layer 1 types

| Type              | What it is                                | Where the number comes from                                                   | Target            | Fixable               |
| ----------------- | ----------------------------------------- | ----------------------------------------------------------------------------- | ----------------- | --------------------- |
| `black`           | A run of black frames                     | ffmpeg `blackdetect`                                                          | file + timeline   | no (advice)           |
| `frozen`          | A run of still frames                     | ffmpeg `freezedetect`                                                         | file + timeline   | no (advice)           |
| `scene-cut`       | A hard cut                                | ffmpeg `scdet`                                                                | file + timeline   | no (advice)           |
| `loudness`        | The loudness of the whole cut             | ffmpeg `ebur128`                                                              | file + timeline   | yes (gain)            |
| `silence`         | A silent stretch                          | ffmpeg `silencedetect`, or `detectSilence` (`audio-core/src/analysis.ts:121`) | file + timeline   | yes (trim or music)   |
| `clipping`        | The loud samples that distort             | ffmpeg `astats`, or `detectClipping` (`:28`)                                  | file + timeline   | yes (gain)            |
| `exposure`        | Too dark or too bright                    | ffmpeg `signalstats`                                                          | file + timeline   | no (advice)           |
| `colour-cast`     | The picture leans one way                 | ffmpeg `signalstats` on the U and V planes                                    | file + timeline   | no (advice)           |
| `safe-area`       | A title or caption outside the safe area  | the title and caption boxes in the project                                    | **timeline only** | yes (move)            |
| `text-legibility` | Text too close in value to its background | a contrast measure against the sampled frame                                  | **timeline only** | yes (move or restyle) |

**The check × target matrix.** Two of the ten are timeline-only, because they read the project document. The other eight read a stream of samples and work on both targets.

|                                                                                              | file (an export) | timeline (the current project) |
| -------------------------------------------------------------------------------------------- | ---------------- | ------------------------------ |
| `black`, `frozen`, `scene-cut`, `loudness`, `silence`, `clipping`, `exposure`, `colour-cast` | yes              | yes                            |
| `safe-area`, `text-legibility`                                                               | **no**           | yes                            |

For a timeline, the eight stream checks run over **sampled composed frames**, and the two document checks run over the document. For a file, only the eight apply.

#### 6b. The four types added on review

| Type                | What it is                                                                                       | Where it comes from                                 | Target            | Fixable                           |
| ------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ----------------- | --------------------------------- |
| `missing-media`     | A clip whose file is gone (OB-12)                                                                | the project's asset records against the library     | **timeline only** | no (the owner must find the file) |
| `unfitted`          | A clip that does not fill the canvas: letterbox bars, or a crop that cuts content (OB-17, T-D01) | the clip's fitted size against the composition size | **timeline only** | yes (fit, fill or reframe)        |
| `caption-collision` | Two caption lines or a caption and a title overlap, or a caption sits outside the safe area      | the caption boxes and title boxes in the project    | **timeline only** | yes (move or restyle)             |
| `audio-dropout`     | A click, a pop, or a short gap that is not silence                                               | the sample stream, gap and discontinuity detection  | file + timeline   | no (advice)                       |

**Why these four.** `missing-media` and `unfitted` are the two faults a designer meets most often and the app currently answers badly (OB-12 and OB-17 are both open). `caption-collision` is a fault only the project document can reveal, and it is the one that most often makes a film look broken. `audio-dropout` is separate from `silence`: a click is not a quiet passage.

#### 6c. Notes

A **note** is what the model says when it sees something no check covers — "this shot feels empty", "the subject is cut off", "the composition is off-centre". A note is a `model-observed` observation with:

- the **frame id** it was seen in,
- the **time code**,
- one sentence of plain text,
- and **no fix**. Notes are advice.

A note never becomes a finding, never counts towards a severity, and never blocks a release on its own. If the owner wants a note acted on, the owner promotes it by hand, the same way they would any other manual edit.

### 7. Which findings can be fixed, and how

**The fix loop.** The agent proposes; **the owner approves**. One plan is one transaction, so one Undo takes it back.

| Finding type                     | Fixable? | What the fix is                              | Who applies it                         |
| -------------------------------- | -------- | -------------------------------------------- | -------------------------------------- |
| `loudness`, `clipping`           | yes      | a gain change on the offending clip          | the model proposes, the owner approves |
| `silence`                        | yes      | trim the gap, or place music over it         | the model proposes, the owner approves |
| `safe-area`, `caption-collision` | yes      | move the title or caption box                | the model proposes, the owner approves |
| `text-legibility`                | yes      | move the text, or change its fill or opacity | the model proposes, the owner approves |
| `unfitted`                       | yes      | fit, fill or reframe the clip                | the model proposes, the owner approves |
| `black`, `frozen`, `scene-cut`   | **no**   | advice only. The owner decides what to cut.  | nobody                                 |
| `exposure`, `colour-cast`        | **no**   | advice only. The grade is a taste decision.  | nobody                                 |
| `audio-dropout`                  | **no**   | advice only. It points at the source.        | nobody                                 |
| `missing-media`                  | **no**   | the owner must find or relink the file       | nobody                                 |
| any note                         | **no**   | advice only                                  | nobody                                 |

**QC fixes always use preview and approve.** Even when the agent's execution mode is `auto-apply-low-risk` or `full-auto-limited`, **a QC fix is staged and shown to the owner before it lands.** A QC fix is not a cheap edit like a colour tweak: it changes the cut the owner made, and it is judged against a threshold that is a guess. So the QC path pins the approval to preview-and-approve regardless of the mode the rest of the agent runs in.

**One plan is one transaction.** The compound edit is applied through the editor session's `dispatchCompound` (`apps/editor-web/src/agent-command-bus.ts:32`), so one Undo restores the prior state.

**The fix loop re-samples the timeline; it does not re-export.** The agent vocabulary has **no export tool** — the export is a desktop IPC channel. So a round is:

1. `qc_report_read` — read the last report.
2. the model proposes one fix.
3. the owner approves; the fix is applied as one compound transaction.
4. **Layer 1 re-runs over the changed ranges of the timeline** (T-B06's wording, and the right one): the frames are re-sampled from the editor, not from a new export.
5. the report is updated in place, and the next round starts.

**An export check is a separate, final, owner-triggered step.** The owner runs Layer 1 over the exported file (the CLI or the button, with the file as the target), and that report is the one that goes into the release evidence. The agent never triggers an export.

### 8. Budgets

Four numbers, each changeable in the Joy Code settings, each with a default:

| Budget                    | Default    | Bound       | Why                                                                                                                                     |
| ------------------------- | ---------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Frames per check          | **12**     | 1 to 16     | 16 is the transport's hard per-batch limit (`multimodal-transport.ts:12`); 12 leaves room for a second batch if the first is not enough |
| Frames per run            | **16**     | 12 to 48    | total across all checks and fix rounds in one run                                                                                       |
| Fix rounds                | **3**      | 1 to 3      | the master plan's "at most 3 rounds"                                                                                                    |
| Long edge of a sent frame | **512 px** | 256 to 1024 | enough to judge a title's sharpness, small enough to send                                                                               |

**The 512 px long edge is the number that matters:** a frame is downscaled before it is sent, so the pixels the model receives are 512 px on the long edge, not 1080. The report says so, so nobody mistakes a soft frame for a soft render.

**Layer 1 respects no frame budget.** It measures the file, not frames it sends, so it costs nothing and runs even with no model connected.

**The run total spans every fix round.** Frames per check is the per-check/per-batch limit; frames per run caps the total across all checks and fix rounds in one run. Frames per check cannot exceed frames per run.

**Erratum (T-B05).** The earlier “per round” wording was wrong: section 5 gives each fix round its own run, so the 12–48 setting is a run total across fix rounds. The 16-frame limit cited in section 14 is the per-check/per-batch transport cap (`multimodal-transport.ts:12`).

**Layer 1 has its own time budget, and it is not the agent's.** The agent run budget caps wall time at 60 seconds (`run-budget.ts:7`) and throws on any value above the maximum (`:77-83`). Layer 1 is a **Worker job**, not an agent run, so it has no 60-second cap; it has its own timeout and a **Cancel** button. **No new agent budget version is needed**, because Layer 1 never runs inside an agent run.

### 9. Frame selection — the rule

**The report says what was not covered.** This is not optional: a QC pass that does not say what it skipped is misleading.

**The rule, in order:**

1. **Layer 1 hits come first.** Every black frame, every frozen run, every scene cut, every dropout gets a frame. These are the frames most likely to hold a fault.
2. **Then the cuts.** Every cut between shots gets a frame, because a fault often sits at a join.
3. **Then the rest is spread evenly.** The remaining budget is spread across the timeline at even intervals, so the whole film is seen at a glance.
4. **Never more than one frame per 250 ms of source.** Two frames 100 ms apart show the same thing.
5. **The report lists the coverage** — how many frames were sent, how many were skipped, and which seconds of the film were not sampled at all. The existing `completeSourceCoverage` flag (`sampling-policy.ts:36-41`) is exactly the honest word for this, and it stays `false` whenever the sample is a subset.

**Frames are chosen by the host, not by the model.** The model may ask to see a frame that the report already lists (`media_frames_view` rejects any other id). It cannot make the host sample something new; a new sample is a new Layer 1 run.

### 10. Where the evidence lives, and what the report is

**Evidence** goes in the project's existing evidence store, with the persistence choice the store already has (`evidence-store.ts:6`):

- `project-local-metadata` — the **report** and its numbers. Kept with the project, so the owner can reopen it.
- `ephemeral` — the **frames themselves**, by default. A frame sent to a model is not kept afterwards. The owner can turn on keeping them in the same settings that hold the budgets.

The frame stages are the store's own: `decoded` → `submitted` → `reviewed` (`evidence-store.ts:7`). A frame that was decoded but never sent stays `decoded`.

Every manifest keeps the honesty field the store already has: `modelComprehensionGuaranteed: false`. **JOY never claims the model understood the picture.** It claims what was sent and what came back.

**The report is one JSON file and one Markdown file, and it has two homes.**

| Home               | What                                                  | How it is written                                                                          |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **In the project** | The report and its numbers, as project-local metadata | the project's own document and save path                                                   |
| **As a file**      | The Markdown report the owner can read and keep       | the editor's existing browser download (`apps/editor-web/src/browser-text-download.ts:28`) |

**v1.1.1 has no project folder on disk**, so "inside the project" means the project document, and "as a file" means the download path. The report is never written somewhere the owner did not name.

**The report format.**

- `qc-report-<reportId>.json` — the findings, the coverage, the notes and the run facts, in a stable shape for the CLI (T-B08) and the test suite. This is the machine-readable half.
- `qc-report-<reportId>.md` — the same findings as a document the owner reads. Plain words, one finding per block: what is wrong, where in the cut, how bad, and the one action to take.

**The report opens with the facts a reader needs to trust it:** what was checked, the target (file or timeline), how many frames were sent and to which provider, which budget was hit, the frame-selection coverage, and the model's name or "no model". If no model was connected, the report is still complete — Layer 1 alone is a real report.

**The in-chat summary has a hard cap.** A Joy Code message body is capped at 8 000 characters (`joy-code-history.ts:30`). So the chat message carries a **short summary of at most 2 000 characters**: the count of findings by severity, the first few findings with their time codes, and a line saying where the full report is. **"Short" means that summary.** The full report is never pasted into the chat.

### 11. The report JSON schema

Published here so B02, B04, B07 and B08 write the same shape. **B02 owns this type and writes it first** (section 12).

```jsonc
{
  "version": 1,
  "reportId": "qc-report-…",
  "projectId": "…",
  "createdAt": "2026-11-13T00:00:00.000Z",
  "target": { "kind": "timeline" | "file", "assetId": "…", "range": { "domain": "source" | "composition", "startUs": 0, "endUs": 0 } },
  "run": { "layer1": true, "layer2": false, "modelId": "… | null", "framesSent": 12, "framesSkipped": 0 },
  "coverage": {
    "completeSourceCoverage": false,
    "sampledRanges": [{ "startUs": 0, "endUs": 5000000 }],
    "unsampledRanges": [{ "startUs": 5000000, "endUs": 9000000 }]
  },
  "findings": [
    {
      "id": "qc-finding-…",
      "type": "black",
      "state": "measured",
      "severity": "major",
      "startUs": 4000000,
      "endUs": 4200000,
      "label": "One and a half seconds of black at 00:04.",
      "measured": { "blackDurationUs": 1500000 },
      "fixable": false,
      "evidenceIds": ["…"]
    }
  ],
  "notes": [
    {
      "id": "qc-note-…",
      "frameId": "…",
      "timeUs": 12300000,
      "text": "The subject sits behind the title here."
    }
  ],
  "modelComprehensionGuaranteed": false
}
```

**`target.kind = "file"` has no `range.domain`.** A file has no composition and no source range in the consent sense; the two document-only check types do not run on a file (section 6a).

### 12. Which card owns which file

**This is the file-collision table.** Seven cards touch five shared files. Without this, two helpers edit the same file and one merge loses.

**T-B05 hand-off to T-B04:** this saved-settings notice is not consent. Live per-round consent must reuse `AgentObservationConsent`.

| Shared file                                                                                           | B02 (GB)            | B04 (GB)                           | B05 (MC)                             | B06 (GB)                            | B07 (MC)                           | B08 (CX)                | Owner                         |
| ----------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------- | ------------------------------------ | ----------------------------------- | ---------------------------------- | ----------------------- | ----------------------------- |
| **The report JSON type** (new file, `packages/qc-core` or `apps/editor-web/src/qc/`)                  | **writes it first** | reads                              | reads                                | reads                               | reads                              | reads                   | **B02**                       |
| `packages/job-protocol/src/protocol.ts` — the `media.qc` capability and job type                      | adds                | —                                  | —                                    | —                                   | —                                  | depends on it           | **B02**                       |
| `apps/worker/src/runtime.ts` — the job branch (`:298` area)                                           | adds                | —                                  | —                                    | —                                   | —                                  | depends on it           | **B02**                       |
| `apps/desktop/src/preload/ipc-channels.cjs` — the `desktop.media.qc.run` channel                      | adds                | —                                  | —                                    | —                                   | —                                  | —                       | **B02**                       |
| `apps/desktop/src/main/ipc-handlers.ts`                                                               | adds                | —                                  | —                                    | —                                   | —                                  | —                       | **B02**                       |
| `apps/editor-web/src/joy-agent/host-tool-contract.ts` — the tool names                                | —                   | **adds the two new names**         | —                                    | —                                   | —                                  | —                       | **B04**                       |
| `apps/editor-web/src/joy-agent/bounded-tool-loop.ts` — the tool schemas                               | —                   | **adds the two schemas**           | —                                    | —                                   | —                                  | —                       | **B04**                       |
| `apps/editor-web/src/joy-agent/engine.worker.ts:1339-1350` — the system prompt's hard-coded tool list | —                   | **adds the two names**             | —                                    | —                                   | —                                  | —                       | **B04**                       |
| `apps/editor-web/src/joy-agent/observation-review-controller.ts` — the review analysis type           | —                   | relaxes it for QC text (section 4) | reads                                | —                                   | —                                  | —                       | **B04**                       |
| `apps/editor-web/src/AgentObservationConsent.tsx` — the existing consent card                         | —                   | reads it                           | **reuses it, does not duplicate it** | —                                   | —                                  | —                       | **B05**                       |
| `apps/editor-web/src/JoyAgentSettingsDialog.tsx` / `.css`                                             | —                   | —                                  | **adds the QC budget settings**      | —                                   | —                                  | —                       | **B05**                       |
| `apps/editor-web/src/joy-code-history.ts` — `JoyCodeMessage`                                          | —                   | —                                  | —                                    | —                                   | **adds the report part**           | —                       | **B07**                       |
| `apps/editor-web/src/AgentPanel.tsx` — the panel (`:3043…3756`, the message list at `:3589-3640`)     | —                   | —                                  | —                                    | **the fix-loop section (`:3043…`)** | **the report card (`:3589-3640`)** | —                       | **split the work; B06 first** |
| `apps/editor-web/src/agent-command-bus.ts` — `dispatchCompound` (`:32`)                               | —                   | —                                  | —                                    | **adds the QC compound**            | —                                  | —                       | **B06**                       |
| `apps/cli/src/commands/qc-cmd.ts` — the new command                                                   | —                   | —                                  | —                                    | —                                   | —                                  | **writes it**           | **B08**                       |
| `apps/cli/src/cli.ts` — the command table (`:117-253`)                                                | —                   | —                                  | —                                    | —                                   | —                                  | **adds the `qc` entry** | **B08**                       |

**Three collisions the plan did not name, and how they are settled:**

1. **`AgentPanel.tsx` is touched by four cards** — B06, B07, and (outside track B) C05 and D06. **B06 goes first and takes the lower section; B07 takes the message list.** C05 and D06 come from other tracks and must not be in the same window as B06/B07. The one-line overlap that matters is the message list at `:3589-3640`, which B07 owns.
2. **The system prompt hard-codes the six observation tool names** (`engine.worker.ts:1339-1350`). A new tool that is not in that list is **invisible to the model**. B04 owns that file for this change. C04 (track C, `generate_media`) touches the same list — **B04 and C04 must not be in the same window.**
3. **The consent card already exists** (`AgentObservationConsent.tsx`). B05 must **reuse** it for the QC cost card, not write a second one, or the owner sees two different consent cards for the same act.

**Order, because two rows depend on an earlier one:** B02 writes the report type and the Worker job first; B04 and B07 then read it; B08 (the CLI) depends on B02's job and protocol and comes last of the QC chain.

### 13. The five questions, answered

The review asked five questions. Here they are, with the decisions they produced.

**Q1 — Is the two-layer split right? The rule was too strict.**
**Answer: the split is right; the rule is now three states, not two.** A Layer 2 claim that Layer 1 has measured clean is `unconfirmed` and is never applied. But the first draft let Layer 2 claim only `safe-area` and `text-legibility`, so "the subject is cut off" and "this is too dark" could never be a finding at all — which is most of what a designer wants to hear. **Now Layer 2 may observe anything.** Anything Layer 1 has a check for is `unconfirmed`; anything Layer 1 has no check for is `model-observed`, carries the frame and the time code, and is never auto-fixed. `confirmed` is renamed `measured`, because the thresholds are guesses and "confirmed" overstated them. Section 2.

**Q2 — Should `media_frames_view` return no pixels?**
**Answer: yes, but not for the reason the first draft gave.** The first draft said pixels would "blow the 2 MiB run budget". That was wrong: `maxOutputBytes` counts provider **response** bytes (`engine.worker.ts:1503-1515`), not tool results. The real reasons are that the review controller forbids analysis text as tool-loop input (`observation-review-controller.ts:92-96`), and that the transport is a one-shot (`:414-420`) that returns ≤ 16 KB of text (`:25`). So the decision stands — the tool returns **analysis text**, never pixels — and the route is written down explicitly in section 4 as Route B, with the single rule it relaxes and the five rules that keep it safe.

**Q3 — One consent per run, or per round?**
**Answer: per round.** A consent is minted per `runId`, lists its evidence ids up front, and cannot be replaced or reused (`observation-consent.ts:29,144-149`); its TTL is one hour. Every round has a new run and new frames, so every round needs its own card. Inside one round, one card covers that round's calls. Section 5.

**Q4 — Which finding types are missing?**
**Answer: four, and they are added.** `missing-media` (a clip whose file is gone), `unfitted` (letterbox bars or content cropped away), `caption-collision` (two captions, or a caption and a title, overlapping or outside the safe area) and `audio-dropout` (a click or a pop, which is not silence). "This shot feels empty" was already covered — it is a **note**, and notes now carry a frame id and a time code so they are actionable. Section 6.

**Q5 — Is the 8-call run budget workable?**
**Answer: the step count was never the problem; the wall clock was, and Layer 1 does not run inside an agent run.** The cap is 60 seconds (`run-budget.ts:7`) and `parseJoyAgentRunBudget` throws on anything above the maximum (`:77-83`), so a bigger QC budget would need a new budget version. But Layer 1 is now a **host action** — a Worker job with its own timeout and a Cancel button — so it never touches the agent budget. The model does three things per round (`qc_report_read`, `media_frames_view`, `validate_proposal`), which fits inside 8 steps comfortably. **No V2 budget is needed.**

### 14. Review by Claude Sonnet 5.5 — what was wrong, and what was done

Every claim in the review was checked against the code before anything was changed. All eleven were correct.

| #   | The review said                                                                   | Checked                                                                                                                                    | What this note does                                                                          |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| a   | "Frames ride the next provider request" is wrong; the transport builds a one-shot | confirmed: `multimodal-transport.ts:414-420`, analysis ≤ 16 KB (`:25`)                                                                     | Context now says so; section 4 fixes the route                                               |
| b   | The review controller forbids what T-B04 asks for                                 | confirmed: `observation-review-controller.ts:92-96`                                                                                        | Section 4 names the single rule Route B relaxes                                              |
| c   | "Would blow the 2 MiB run budget" is wrong                                        | confirmed: `maxOutputBytes` counts response bytes (`engine.worker.ts:1503-1515`)                                                           | Q2 says so                                                                                   |
| d   | `requireApprovalFor` is at `:343`/`:362`, not `:122`                              | confirmed: `:122` is the block decision                                                                                                    | Context corrected                                                                            |
| e   | "Local-only is a one-line change" is wrong; the agent path is off                 | confirmed: `AgentPanel.tsx:568` sets `isEditReady = false`; `approval.ts:78-81` judges by `estimatedCost`                                  | Context corrected; Layer 1 made a host action so it still runs in local-only (section 5.1)   |
| f   | `media_qc_run.range` has no `domain`; an export is not an `assetId`               | confirmed: `observation-consent.ts:5-12`                                                                                                   | The `media_qc_run` tool is **withdrawn**; the target is `timeline` or `file` (section 3, 11) |
| g   | Frames per check cannot be 48                                                     | confirmed: `MAX_MULTIMODAL_EVIDENCE_PER_BATCH = 16` (`multimodal-transport.ts:12`), enforced at `observation-review-controller.ts:760-771` | 16 is the per-check/per-batch cap; 12–48 is the per-run total across fix rounds (section 8)  |
| h   | The filmstrip is metadata-only                                                    | confirmed: `AgentEvidenceFilmstrip.tsx:12-20`                                                                                              | Context corrected                                                                            |
| i   | `dispatchCompound` is on the editor session, not in `agent-tools`                 | confirmed: `apps/editor-web/src/agent-command-bus.ts:32`                                                                                   | Section 7 names the file T-B06 needs; the collision table gives B06 ownership                |
| j   | "Inside the project" vs "the existing save path"; no project folder in v1.1.1     | confirmed: `project-package.ts`, `browser-text-download.ts:28`                                                                             | Section 10 gives the report two homes                                                        |
| k   | The header cites `6f16dbdd`; HEAD is `d448d68c`                                   | confirmed, and integration has since moved to `9601dd40`                                                                                   | Header corrected                                                                             |

**The review's five risks, answered:** the Layer 2 route is written down (section 4, Route B); Layer 1 is a host action (section 3); the fix loop re-samples the timeline and the export check is owner-triggered (section 7); the report schema is published inside the ADR (section 11); and the in-chat summary is capped at 2 000 characters against the 8 000-character message limit (section 10).

**The review's gaps, closed:** the frame-selection rule is section 9; "QC fixes always use preview and approve" is section 7; the entry points (button, chat command, CLI) are section 3; progress and cancel are section 8; the before/after state is a `measured` block on each finding and the report's `run` block (section 11); and "short" is now defined as the 2 000-character chat summary (section 10).

**Not done by the review:** no GBrain lookup, no tests, no CI. Those are not this card's job.

---

## What this note does not decide

- The ffmpeg filter list and their exact thresholds. T-B02 owns that.
- Which provider the owner will use. The probe decides what is possible, not what is chosen.
- Whether the CLI command takes a file path or a project id. T-B08.
- Whether the report is written into the project or beside it. **Both** (section 10).
- The exact wording of the report card.

## Consequences

**Good.** The owner gets a check that works with no model, a check that works with any model that can see, and one report that reads the same either way. Every frame sent is bounded, consented and listed. The technical numbers are free and repeatable. The fix loop is one Undo, not a mess. And the owner can start a check from a button, from the chat or from the command line — in local-only mode too.

**Bad.** Two layers is more code than one. The model still cannot see the whole film at once, only 48 frames a round, so a fault in a part nobody sampled will not be found — the report must say what it covered and what it did not, and the sampling policy (`sampling-policy.ts`) already knows how to say "this was a subset".

**Risky.** The Layer 1 thresholds (how dark is too dark, how long is too long) are guesses until T-B02 has run them on real cuts. The thresholds are settings, not constants, for that reason, and the findings they produce are `measured`, not `confirmed`.
