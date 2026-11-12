# ADR-0045: Joy Code can check a cut frame by frame, in two layers

Status: Proposed (to be sent once to Opus 5.5, plan mode, read-only; the answer is applied or answered point by point below)
Date: 2026-11-12
Owner of this note: MC (mcode CLI), worktree `v111-ui`, branch `v111/qc-design`
Closes: part of C-186 (the owner's request that Joy Code look at a timeline or an export frame by frame, find faults, fix them with approval, and write a short quality report)
Task: T-B01 of `03-TASK-CARDS.md:217-221`

## Context

The owner wants Joy Code to watch what they have actually made, find what is wrong, propose a fix, and write a short report. This note fixes the shape of that feature before any code is written, so the GB and CX cards do not each invent their own.

What the code actually does today (read 12 Nov 2026, read-only, in `v111-ui` at `integration/v1.1.1` = `6f16dbdd`):

- The model already has a **closed, product-owned tool vocabulary**. `JOY_AGENT_HOST_TOOL_NAMES` (`apps/editor-web/src/joy-agent/host-tool-contract.ts:7-27`) lists every tool the browser host will ever answer, and `isJoyAgentHostToolName` (`:31-34`) is the only door into it. The file says plainly that it lives below the provider catalog "so both boundaries validate the identical set". **Any new QC tool must be added here or it does not exist.**
- Six of the twelve names are the observation tools: `media_describe`, `media_observe`, `media_frames`, `media_transcript`, `evidence_read`, `evidence_coverage` (`host-tool-contract.ts:10-15`). The other four `look_*` names are the Living Look intent tools (`:23-26`).
- **The observation tools are metadata-only, and say so in their own descriptions.** `media_frames` "never returns frame pixels, blobs, URLs, or paths" (`apps/editor-web/src/joy-agent/bounded-tool-loop.ts:242`); `evidence_read` "reports coverage only, not media data" (`:301`); `evidence_coverage` "cannot clear, mutate, or export evidence" (`:325`). **Today the agent cannot see a single pixel of the user's work.** That is the gap this note closes.
- The tool schemas are strict and bounded: `strict: true`, `additionalProperties: false`, a required list, and `SAFE_OBSERVATION_IDENTIFIER_PATTERN` on every id (`bounded-tool-loop.ts:237-269` is the pattern to copy). The bounds are real constants: `MAX_OBSERVATION_FRAMES = 512`, `MAX_OBSERVATION_METADATA_BYTES = 32 * 1024`, `MAX_OBSERVATION_PAGE_SIZE = 128`, `MAX_OBSERVATION_CURSOR = 2_097_152` (`bounded-tool-loop.ts:72-76`).
- The model sees images through a **separate, deliberate path**: `multimodal-transport.ts` builds OpenAI-compatible content parts locally — `image_url` with a `data:` URL, `input_audio`, `video_url`, or text (`providerContentPart`, `:434-458`) — and the file comment says "OpenAI-compatible content is constructed locally; no public upload URL is ever produced" (`:433`). The request body is capped at `MAX_MULTIMODAL_REQUEST_BYTES = 32 * 1024 * 1024` (`:16`) and must be non-empty.
- A provider's ability to **see** is already proven by a probe, separately from its ability to call tools. `PROVIDER_MEDIA_CAPABILITY_PROBE_ACK` and `PROVIDER_MEDIA_CAPABILITY_MODALITIES = ['image', 'audio', 'video']` (`apps/editor-web/src/joy-agent/provider-capabilities.ts:30-31`), judged by `assessProviderMediaCapabilities` (`:124`) which returns `supported`/`unavailable` per modality and **never keeps the raw response**. The probe is "deliberately unrelated to the structured-tool probe above: media support never upgrades tool capability" (`:27-28`).
- Consent for sending media out is a real, separate object. `observation-consent.ts` has `issueObservationConsent` (`:101`), modalities `image | audio | video | transcript` (`:1`), and hard bounds: 512 evidence ids, 64 requests, 512 MiB per consent, a 6-hour range, and a **1-hour TTL** (`:MAX_OBSERVATION_CONSENT_*`).
- The privacy switch already exists: `AgentPolicyPreferences.privacyMode` is `'ask-before-remote' | 'local-only'` (`apps/editor-web/src/agent-policy-settings.ts:24`), default `ask-before-remote` (`:36`), and `approvalPolicyForAgentPolicy` turns `local-only` into `blockRemoteUploads: true` (`:98`). **The local-only mode is a one-line change, not a new feature.**
- The tool capability list is a fixed 12 names — `timeline.read`, `timeline.write`, `assets.read`, `assets.import`, `filesystem.read`, `filesystem.write`, `provider.generate`, `provider.spend`, `render.preview`, `export.write`, `project.overwrite`, `plugin.invoke` (`packages/agent-tools/src/approval.ts`, `ALL_TOOL_CAPABILITIES`) — and `requireApprovalFor` already lists `'remote-upload'` (`:122`). Sending a frame out is therefore already a thing the approval system knows how to name.
- The evidence store already models persistence as a choice: `EvidencePersistencePreference = 'ephemeral' | 'project-local-metadata'` (`apps/editor-web/src/media-observation/evidence-store.ts:6`) and the frame stages `'decoded' | 'submitted' | 'reviewed'` (`:7`). Every manifest carries a coverage summary whose `modelComprehensionGuaranteed` is the literal `false` (`evidence-store.ts`, `EvidenceManifestCoverageSummary`).
- The sampling rules already exist and are careful: `selectOverviewFrames` and `createCanonicalFrameSampler` (`apps/editor-web/src/media-observation/sampling-policy.ts:54`, `:113`), and `CanonicalFrameSamplingResult.completeSourceCoverage` is `false` for an explicitly sampled subset (`:36-41`).
- The Worker already runs ffmpeg jobs and already has a job-type switch (`apps/worker/src/runtime.ts:298` handles `render.export`; `upscale.image`/`upscale.video`, `mask.image`/`mask.video`, `image.comfy`, `audio.ml-denoise`, `text.lm-studio` are other branches). The job protocol lives in `packages/job-protocol/src/protocol.ts` and `agent-jobs.ts`.
- The audio maths is already written and unit-tested: `measurePeak`, `detectClipping`, `measureLoudness`, `detectSilence` (`packages/audio-core/src/analysis.ts:28`, `:51`, `:121`).
- A run is bounded hard: `MAX_JOY_AGENT_RUN_BUDGET_V1` is `maxToolSteps: 8`, `maxOutputBytes: 2 * 1024 * 1024`, `maxWallTimeMs: 60_000`, `maxRepairAttempts: 2` (`apps/editor-web/src/joy-agent/run-budget.ts:5-8`). **Eight tool calls is not enough for check, propose, apply, re-render, re-check.** See section 7.
- The Joy Code message body is a plain `string` (`apps/editor-web/src/joy-code-history.ts:4-9`), so a report cannot travel as structured parts yet.
- `AgentEvidenceFilmstrip.tsx` exists and is tested (`apps/editor-web/src/AgentEvidenceFilmstrip.tsx`, `AgentEvidenceFilmstrip.test.tsx`) but **nothing in the app renders it** — only its own test references it. The plan already says "exists, unused" (master plan, section 7).

---

## Decision

### 1. The shape: two layers, one report

Joy Code's quality check is **two layers that produce one report**.

**Layer 1 — the technical check.** No model, no network, no cost. The Worker runs ffmpeg and ffprobe filters over an exported file and returns numbers: black frames, frozen frames, scene cuts, loudness, silence, clipping, exposure, colour cast. For a timeline, the editor samples composed frames and measures safe areas and text legibility locally. **Layer 1 works with no model connected at all**, and its numbers are the same for every provider.

**Layer 2 — the seeing check.** Only for providers whose probe says `image: supported`. The model is handed a **bounded set of chosen frames** and asked what is wrong with the cut: is the subject cut off, is this title hard to read, is the picture too dark, does this shot feel empty. Layer 2 never re-measures what Layer 1 measured, and it never sees more frames than the budget allows.

**Why two layers, not one.** Layer 1 is deterministic, free and testable, so a fault that Layer 1 finds is a fact. Layer 2 is a judgement, so it must never be the only way a fault is reported, or the same film would get different verdicts on different days and with different providers. **A finding is "confirmed" when Layer 1 confirms it, or when Layer 2 confirms it and Layer 1 had nothing to say.** A Layer 2 finding that Layer 1 contradicts is marked `unconfirmed` and shown to the owner as a question, never applied.

**One report.** Both layers write into the same report object (section 6). The owner reads one document with one severity scale, not two result panels.

### 2. The four new tools

Added to `JOY_AGENT_HOST_TOOL_NAMES` (`host-tool-contract.ts:7-27`), following the strict and bounded shape of the six existing observation tools (`bounded-tool-loop.ts:237-269`).

**`media_qc_run`** — runs the technical check (Layer 1). Never sends anything out.

```json
{
  "target": "timeline" | "export",
  "assetId": "<string, SAFE_OBSERVATION_IDENTIFIER_PATTERN>",
  "range": { "startUs": 0, "endUs": 5000000 },
  "checks": ["black", "frozen", "scene-cut", "loudness", "silence", "clipping", "exposure", "colour-cast", "safe-area", "text-legibility"]
}
```

Returns a report id, the finding list (section 3), and the coverage facts. All of `target`, `assetId`, `range` and `checks` are required; `checks` is an enum array so the model cannot ask for a check that does not exist.

**`media_frames_view`** — hands the model the **pixels** of a small set of chosen frames (Layer 2). This is the tool that does not exist today.

```json
{
  "reportId": "<string, SAFE_OBSERVATION_IDENTIFIER_PATTERN>",
  "frameIds": ["<string>", "<string>"],
  "reason": "<string, maxLength 280>"
}
```

`frameIds` is capped at the per-check budget (section 4) and must be frame ids the model already saw listed in the report — a frame id that is not in the report is rejected, so the model cannot ask for a frame it was not shown. The tool returns **no pixels in the tool result**. The frames ride the next provider request as `image_url` content parts through `multimodal-transport.ts` (`providerContentPart`, `:434-458`), which is the only path that puts an image in front of a model. `reason` is stored with the evidence so the report can say why a frame was sent.

**`media_contact_sheet`** — one picture holding many small frames, for a broad look at the whole cut.

```json
{
  "reportId": "<string>",
  "frameIds": ["<string>", "..."],
  "columns": 4
}
```

Up to 24 frames on one sheet, burnt-in timecodes, one `image_url` part. It is the cheap way for the model to see the shape of the film without spending 24 separate sends.

**`qc_report_read`** — reads a saved report back.

```json
{ "reportId": "<string>", "includeFindings": true }
```

Returns the report of section 6. It reads only reports the owner has kept; it cannot delete one.

**Why `media_frames_view` returns no pixels.** Every other tool in this vocabulary keeps bytes out of the tool result and lets a dedicated transport move them (`evidence_read` "reports coverage only, not media data"). If the pixels came back inside the tool result they would land in the model's context as raw base64, blow the 2 MiB run budget (`run-budget.ts:6`) with no consent step, and would be written into the transcript. Instead the tool **selects** the frames and the transport **carries** them, which is the one place that already builds image parts, already caps the body at 32 MiB, and already sits behind the consent and approval gates.

### 3. Finding types

Ten types, in two groups. Each finding carries: `id`, `type`, `severity`, `startUs`, `endUs`, `label` (one plain sentence for the owner), `measured` (the numbers), `layer` (`technical` or `seeing`), `confidence` (`confirmed` or `unconfirmed`), and `evidenceIds` (the frames or samples behind it).

| Type | Layer | What it is | Where the number comes from |
|---|---|---|---|
| `black` | technical | A run of black frames | ffmpeg `blackdetect` |
| `frozen` | technical | A run of still frames | ffmpeg `freezedetect` |
| `scene-cut` | technical | A hard cut | ffmpeg `scdet` |
| `loudness` | technical | The loudness of the whole cut | ffmpeg `ebur128` |
| `silence` | technical | A silent stretch | ffmpeg `silencedetect`, or `detectSilence` |
| `clipping` | technical | The loud samples that distort | ffmpeg `astats`, or `detectClipping` |
| `exposure` | technical | Too dark or too bright | ffmpeg `signalstats` |
| `colour-cast` | technical | The picture leans one way | ffmpeg `signalstats` on the U and V planes |
| `safe-area` | technical | A title or caption outside the safe area | the title and caption boxes in the project |
| `text-legibility` | technical | Text too close in value to its background | a contrast measure against the sampled frame |

**Severity** is three words and nothing else: `blocker` (data loss, crash, wrong export, install failure), `major`, `minor`. The word list is the same one the defect log already uses (`03-TASK-CARDS.md:203`), so a QC finding and a test defect speak the same language.

**Layer 2 adds no new type.** The seeing layer adds findings of the same ten types, marked `layer: "seeing"`, and may only claim a `text-legibility` or `safe-area` fault when Layer 1 measured it. Everything else the model says is **a note**, not a finding: notes appear in the report under "What the model noticed" and never become a fix.

### 4. Budgets

Four numbers, each changeable in the Joy Code settings, each with a default:

| Budget | Default | Bound | Why |
|---|---|---|---|
| Frames per check | **12** | 1 to 48 | 12 frames at 512 px is one screen of contact sheet and about the most a model can compare at once |
| Frames per run | **48** | 12 to 96 | four checks, or one check plus two re-checks |
| Fix rounds | **3** | 1 to 3 | the master plan's "at most 3 rounds" |
| Long edge of a sent frame | **512 px** | 256 to 1024 | enough to judge a title's sharpness, small enough to send |

The 512 px long edge is the number that matters: a frame is downscaled before it is sent, so the pixels the model receives are 512 px on the long edge, not 1080. The report says so, so nobody mistakes a soft frame for a soft render.

**Layer 1 respects no frame budget.** It measures the file, not frames it sends, so it costs nothing and runs even with no model connected.

**The budget is spent by the run, not by the check.** A run that checks, applies a fix, re-renders and re-checks spends frames from the same 48. That is why the number is per run and not per check.

### 5. Consent, and the local-only mode

**Sending a frame out needs the same consent the app already asks for.**

1. `privacyMode: 'local-only'` (`agent-policy-settings.ts:24`) means **no frame ever leaves the PC**. Layer 1 still runs in full and the report still gets its technical findings. Layer 2 is simply not available, and the report says "The seeing check was off: your settings keep frames on this PC." `approvalPolicyForAgentPolicy` already sets `blockRemoteUploads: true` for this mode (`:98`), so the block is one existing line.
2. In `ask-before-remote` mode, the first `media_frames_view` or `media_contact_sheet` of a run raises **one cost card** naming how many frames, how many kilobytes, and which provider they go to. Approving it covers the whole run; the run does not ask again.
3. The approval system already has the right vocabulary: `requireApprovalFor` lists `'remote-upload'` (`approval.ts:122`), and `provider.generate` maps to that category (`:457`). The QC tools take the same path.
4. The consent object is the existing one: `issueObservationConsent` (`observation-consent.ts:101`), with its 1-hour TTL and its 512-evidence and 512-MiB bounds. A QC run cannot outlive its consent.
5. The provider must have proven it can see: `assessProviderMediaCapabilities` (`provider-capabilities.ts:124-140`) must return `image: 'supported'`. A model that cannot see images gets Layer 1 only, and the report says why.

**The owner's media never goes to an unapproved place.** There is no path in this design that writes a frame to disk in a place the owner did not ask for, and no path that uploads to a URL.

### 6. Where the evidence lives, and what the report is

**Evidence** goes in the project's existing evidence store, with the persistence choice the store already has (`evidence-store.ts:6`):

- `project-local-metadata` — the **report** and its numbers. Kept with the project, so the owner can reopen it.
- `ephemeral` — the **frames themselves**, by default. A frame sent to a model is not kept afterwards. The owner can turn on keeping them in the same settings that hold the budgets.

The frame stages are the store's own: `decoded` → `submitted` → `reviewed` (`evidence-store.ts:7`). A frame that was decoded but never sent stays `decoded`.

Every manifest keeps the honesty field the store already has: `modelComprehensionGuaranteed: false` (`EvidenceManifestCoverageSummary`). **JOY never claims the model understood the picture.** It claims what was sent and what came back.

**The report** is one Markdown file plus one JSON file, both inside the project:

- `qc-report-<reportId>.md` — the thing the owner reads. Plain words, one finding per block: what is wrong, where in the cut, how bad, and the one action to take.
- `qc-report-<reportId>.json` — the same findings in a stable shape, for the CLI (T-B08) and for the test suite.

The report opens with the facts a reader needs to trust it: what was checked, how many frames were sent and to which provider, which budget was hit, and the model's name or "no model". If no model was connected, the report is still complete — Layer 1 alone is a real report.

### 7. The fix loop: one proposal, one Undo, three rounds

**The agent proposes; the existing execution modes decide.** A fix arrives as a plan, not as an applied edit. The default mode is `preview-and-approve` (`agent-policy-settings.ts:33`), so the owner sees the change before it lands, exactly like every other agent edit.

**One plan is one transaction, so one Undo takes it back.** This is the existing compound-edit rule (`dispatchCompound`), not a new mechanism.

**A run holds 8 tool calls** (`run-budget.ts:5`). Check, propose, apply, re-render, re-check needs more than that. So:

- **One QC session is not one agent run.** A session is the outer loop, and each round inside it is its own run with its own budget of 8.
- A round is: run `media_qc_run` → read findings → propose → owner approves → apply → re-render → `media_qc_run` again on the new export.
- **The session stops after 3 rounds** (the fix-round budget, section 4) or when a round finds nothing new, whichever comes first.
- Every round that sent frames spent from the same 48-frame run budget, so a session cannot quietly become expensive.

### 8. What each card builds

| Card | Agent | Builds | Files |
|---|---|---|---|
| T-B02 | GB | Worker job `media.qc`: ffmpeg filters, one JSON report, time caps | `apps/worker/src/media-qc.ts`, `packages/job-protocol/src/protocol.ts`, `apps/worker/src/runtime.ts` |
| T-B03 | GB | Timeline sampler and contact sheets, safe area and legibility pass | `apps/editor-web/src/media-observation/qc-sampler.ts`, `contact-sheet.ts` |
| T-B04 | GB | The four tools, on the closed vocabulary | `host-tool-contract.ts:7-27`, `bounded-tool-loop.ts`, `tool-bridge.ts` |
| T-B05 | MC | Budgets, consent and privacy settings | `apps/editor-web/src/JoyAgentSettingsDialog.tsx`, `agent-policy-settings.ts` |
| T-B06 | GB | The fix, re-render, re-check loop with one Undo | `packages/agent-tools/src/atomic.ts`, `apps/editor-web/src/joy-agent/` |
| T-B07 | MC | The report card and the filmstrip in Joy Code | `apps/editor-web/src/AgentEvidenceFilmstrip.tsx` (built, unused), `joy-code-history.ts` |
| T-B08 | CX | `joy-media qc` command | `apps/cli/src/commands/qc-cmd.ts` |

**Two rules for the helpers.** First, the tool names in section 2 are the names: `media_qc_run`, `media_frames_view`, `media_contact_sheet`, `qc_report_read`. Second, every one of the four is added to `JOY_AGENT_HOST_TOOL_NAMES`, because a tool that is not in that list does not exist.

### 9. Review by Opus 5.5

Questions for the consult, in the order that matters:

1. **Is the two-layer split right?** Specifically: is "a Layer 2 finding that Layer 1 contradicts is `unconfirmed` and never applied" the right rule, or should Layer 2 be allowed to confirm a fault Layer 1 has no check for (a title that is legible but ugly)?
2. **Is `media_frames_view` returning no pixels the right call?** The alternative is to return the images inside the tool result. The reasons against are the run budget, the transcript, and the consent step; the reason for is one less moving part. Which wins?
3. **Is one consent per run the right granularity,** or should a cost card appear per send?
4. **Do the ten finding types cover what the owner will actually see in a bad cut?** Is something missing that is not a number (a "this shot feels empty" note)?
5. **Is the 8-call run budget workable per round,** or should a QC round get its own larger budget?

---

## What this note does not decide

- The ffmpeg filter list and their exact thresholds. T-B02 owns that.
- Which provider the owner will use. The probe decides what is possible, not what is chosen.
- Whether the CLI command takes a file path or a project id. T-B08.
- Whether the report is written into the project or beside it. T-B07, with one rule: it must not land in a folder the owner did not name.

## Consequences

**Good.** The owner gets a check that works with no model, a check that works with any model that can see, and one report that reads the same either way. Every frame sent is bounded, consented and listed. The technical numbers are free and repeatable. The fix loop is one Undo, not a mess.

**Bad.** Two layers is more code than one, and the QC track is bigger than it looks. The model still cannot see the whole film at once, only 48 frames, so a fault in a part nobody sampled will not be found — the report must say what it covered and what it did not, and the sampling policy (`sampling-policy.ts`) already knows how to say "this was a subset".

**Risky.** The Layer 1 thresholds (how dark is too dark, how long is too long) are guesses until T-B02 has run them on real cuts. The thresholds are settings, not constants, for that reason.
