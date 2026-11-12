# JOY Media v1.1.1 — the showcase film: shot list and checklist

**Card:** T-L04 (shot list and checklist; MC drafts, CC finishes). **Owner of the draft:** MC (mcode CLI), worktree `v111-ui`, branch `v111/showcase-film`.
**Written:** 13 Nov 2026. **Basis:** the code at `integration/v1.1.1` = `d448d68c`, read only. The app was not launched for this draft.
**Closes:** part of REQ-05a (the owner's request that one real, fully edited film be made and watched before the release).

---

## 1. How to read this

**What this file is.** The exact film CC will build by hand in the app (T-L05), scene by scene, with time codes, plus the one-page checklist the owner answers on (T-L06). Every item of REQ-05 (`BUGS-from-owner.md:238-253`) appears at least once and has a row.

**The "exists in the app" column.** This is the point of running this card early instead of in S32. For every item I read the code and wrote down what is actually there:

| Mark     | Meaning                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| **yes**  | A real implementation exists: a command, a schema field the renderer reads, or a UI control that dispatches it. |
| **part** | Part of it exists. The "notes" column says exactly which part.                                                  |
| **no**   | Nothing found. It cannot be put in the film today.                                                              |

**Where the file is.** `file:line` in the notes column, so CC can check any row in a minute.

**Two kinds of problem.** A **"no"** means a feature is missing and must be built (a card) or dropped (your yes). A **"part"** is worse in a way: the feature may look real in the UI and still not reach the exported video. Both need a decision **by day 3**, not in S32.

**What this draft does not decide.** Thresholds, exact wording and the final cut. CC finishes the shot list (the card says "MC drafts, CC finishes").

---

## 2. The film in one line

**"Five minutes in the mountains"** — 90 seconds, 1080p, 16:9, cut from the owner's own media in `C:\jgp\ui-shots-20261112\media-final`, with the colour, text and agent work done in the app. It is a real little film, not a feature demo: it has an opening, a middle and an end, and every tool the app has appears inside it without stopping the film to show off.

### The media we have (real files, 7)

| File                            | Kind  | Use in the film                                                 |
| ------------------------------- | ----- | --------------------------------------------------------------- |
| `Northern lights.mp4`           | video | The opener. The best material.                                  |
| `Golden hour.mp4`               | video | The middle movement; carries the slow and fast speed changes.   |
| `Soft light.mp4`                | video | The quiet beat; carries the freeze frame and the reversed clip. |
| `Alpine lake.png`               | photo | The wide still; a slow keyframed move (the Ken Burns moment).   |
| `Turquoise sunset.png`          | photo | Colour work: wheels, curves, HSL, a Look.                       |
| `Autumn path.png`               | photo | The lower third and the RTL title card.                         |
| `Neon rain.png`                 | photo | The picture-in-picture layer.                                   |
| `newlogo-2-preview.png` (owner) | logo  | The corner badge and the end slate.                             |

**Audio.** We have **no music file and no voice file** in the media folder. The film needs music ducked under speech, a crossfade and a loudness target. **The owner must supply one music track and one voice line** (or accept the film's audio being silence, which would make the audio half of the checklist meaningless). This is **Owner item 1** in section 6.

---

## 3. The shot list

90 seconds exactly. 11 scenes. Time codes are the film's own, so the owner's checklist points at the same moments the export does.

### Scene 1 — 00:00–00:07 · The cold open

| #   | Time  | What happens                                                        | Tool                         | Exists  | Notes                                                                                                                |
| --- | ----- | ------------------------------------------------------------------- | ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| 1.1 | 00:00 | `Northern lights.mp4` opens the film, full frame.                   | Import, first clip           | **yes** | `timeline.insertClip` (`commands.ts:235`)                                                                            |
| 1.2 | 00:00 | The clip is trimmed so the shot starts on the aurora, not on black. | Trim start                   | **yes** | `timeline.trimClipStart` (`commands.ts:240`)                                                                         |
| 1.3 | 00:03 | A cut splits the shot into two halves.                              | Split                        | **yes** | `timeline.splitClip` (`commands.ts:242`)                                                                             |
| 1.4 | 00:06 | A **Dissolve** transition joins the two halves.                     | Transition — Basic and fades | **yes** | `gl:fade`, shader `fade.glsl`; transition nodes are painted by the renderer (`renderer-pixi/src/browser.ts:857-964`) |

### Scene 2 — 00:07–00:14 · Title card

| #   | Time  | What happens                                                             | Tool                     | Exists  | Notes                                                                                                                       |
| --- | ----- | ------------------------------------------------------------------------ | ------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | 00:07 | A title appears over the aurora: "JOY Media — 1.1.1".                    | Title                    | **yes** | Titles panel (`TextPanel.tsx`), `joy.title` template (`content-template-catalog.ts`)                                        |
| 2.2 | 00:08 | The title fades in and out (opacity).                                    | Opacity fades            | **yes** | `opacity` is an animatable channel (`project-schema/src/v1.ts:100`)                                                         |
| 2.3 | 00:09 | The title has an **outline** (a stroke around the letters).              | Title with outline       | **yes** | `TextStrokeV1` (`packages/project-schema/src/text-style.ts:26-29`), drawn via `visual-object-renderer/src/index.ts:187-193` |
| 2.4 | 00:10 | The title is **rotated** a few degrees, and its scale changes over time. | Keyframed scale + rotate | **yes** | `scaleX`, `scaleY`, `rotationDeg` are animatable channels (`v1.ts:99-100`); rotation reaches the renderer (ADR-0046, T-M15) |
| 2.5 | 00:11 | A **Wipe** transition to the next scene.                                 | Transition — Wipes       | **yes** | `gl:wipeRight`, `wipeRight.glsl`                                                                                            |
| 2.6 | 00:12 | The music starts and fades up.                                           | Audio fade               | **yes** | `applyFade` (`packages/audio-core/src/processing.ts:33`)                                                                    |

### Scene 3 — 00:14–00:24 · The movement (speed, reverse, freeze)

| #   | Time  | What happens                                          | Tool                         | Exists  | Notes                                                                |
| --- | ----- | ----------------------------------------------------- | ---------------------------- | ------- | -------------------------------------------------------------------- |
| 3.1 | 00:14 | `Golden hour.mp4` starts, then plays **slow** (0.5×). | Speed change (slow)          | **yes** | `timeline.setClipRate` (`commands.ts:245`), rate 0.1–8×              |
| 3.2 | 00:17 | It then plays **fast** (2×).                          | Speed change (fast)          | **yes** | same command                                                         |
| 3.3 | 00:19 | The clip is **reversed**.                             | Reverse                      | **yes** | `timeline.toggleClipReverse` (`commands.ts:209`, applied at `:1147`) |
| 3.4 | 00:21 | A **freeze frame** holds one moment for one second.   | Freeze frame                 | **yes** | `timeline.freezeFrame` (`commands.ts:208`, applied at `:1016`)       |
| 3.5 | 00:23 | A **Cross Zoom** transition into the next scene.      | Transition — Zooms and spins | **yes** | `gl:CrossZoom`, `CrossZoom.glsl`                                     |

### Scene 4 — 00:24–00:34 · The colour work (this is the heart of the film)

| #   | Time  | What happens                                                                   | Tool                  | Exists   | Notes                                                                                                                                                                                                           |
| --- | ----- | ------------------------------------------------------------------------------ | --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | 00:24 | `Turquoise sunset.png`, full frame.                                            | Photo on the timeline | **yes**  | `timeline.insertClip`                                                                                                                                                                                           |
| 4.2 | 00:26 | The **Wheels** lift the shadows and push the warmth.                           | Colour wheels         | **yes**  | `wheels` in the colour schema (`project-schema/src/color.ts`), applied by `applyColorGradeV2` (`renderer-pixi/src/color-grade-math.ts`); panel tab `wheels` (`ColorPanel.tsx:26`)                               |
| 4.3 | 00:28 | A **Curve** pulls the horizon down and the sky up.                             | Colour curves         | **yes**  | `curves` in the schema; `getColorCurveLuts` / `buildColorCurveLut` (`color-grade-math.ts`); panel tab `curves` (`ColorPanel.tsx:27`)                                                                            |
| 4.4 | 00:30 | An **HSL** band shifts the teal toward blue.                                   | HSL bands             | **yes**  | `hsl` bands in the schema; `normalizeColorGradeHslBands` (`color-grade-math.ts`); panel tab `hsl` (`ColorPanel.tsx:28`)                                                                                         |
| 4.5 | 00:32 | A **Look** (Warm Cinema) is applied on top, then its intensity is pulled back. | Look                  | **yes**  | `lut` + intensity (`color.ts:82`); the look list is `ColorPanel.tsx:893-895`; panel tab `looks` (`ColorPanel.tsx:29`)                                                                                           |
| 4.6 | 00:33 | The **Scopes** are open in a corner while this happens.                        | Scopes                | **part** | The Scopes tab exists (`ColorPanel.tsx:30`) and the mini scope is in the shared footer. The plan's T-K05 moves scopes to one place; today the footer scope is still on every sub-tab. **See 4.6 in section 4.** |

### Scene 5 — 00:34–00:44 · Text: English, Persian, Arabic

| #   | Time  | What happens                                                 | Tool                           | Exists   | Notes                                                                                                                                                                                                                                                                                                                                         |
| --- | ----- | ------------------------------------------------------------ | ------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | 00:34 | A **lower third** comes up with a name and a role.           | Lower third                    | **part** | `joy.lower-third-bar` and `joy.lower-third-split` exist as HTML-scene templates (`content-template-catalog.ts`, category "Lower Thirds"). But they are **HTML scenes**, not a timeline title with a lower-third style — so the shot needs the template, and the template may not be adjustable like a normal title. **See 5.1 in section 4.** |
| 5.2 | 00:37 | A **Persian** title, right to left, with the Vazirmatn face. | RTL text                       | **yes**  | `direction: 'rtl'` templates exist (`text-template-catalog.ts:220-255`), the RTL caption style `joy-rtl-classic` exists (`joy-code-caption-operations.test.ts:43,48`), and the Motion Studio offers `auto / ltr / rtl` (`motion-studio/MotionStudioInspector.tsx:626`)                                                                        |
| 5.3 | 00:39 | An **Arabic** title next to the English one.                 | RTL text                       | **yes**  | Same path; the direction field is per-text, not per-language                                                                                                                                                                                                                                                                                  |
| 5.4 | 00:41 | A **motion template** animates the Persian title in.         | Motion template                | **part** | The **Animate / Motion** panel has 30 presets (`packages/motion-core/src/presets.ts:771-802`). But the **Templates** panel has no motion-template kind — all 10 library templates are `html-scene`. **See 5.4 in section 4.**                                                                                                                 |
| 5.5 | 00:43 | A **Slide** transition pushes the next scene in.             | Transition — Slides and pushes | **yes**  | `gl:Directional`, `Directional.glsl`                                                                                                                                                                                                                                                                                                          |

### Scene 6 — 00:44–00:53 · Captions

| #   | Time  | What happens                                                                                  | Tool                            | Exists   | Notes                                                                                                                                                                       |
| --- | ----- | --------------------------------------------------------------------------------------------- | ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | 00:44 | A caption track is added over the clip.                                                       | Captions                        | **yes**  | Captions panel (`CaptionsPanel.tsx`), `captionSlots` / `captionDocuments` in the project schema                                                                             |
| 6.2 | 00:45 | The captions are styled.                                                                      | Caption style                   | **yes**  | `styleRef` on a caption document (`joy-code-caption-operations.test.ts:48`)                                                                                                 |
| 6.3 | 00:46 | **Burn-in is switched on**, so the captions are in the exported picture, not a separate file. | Caption burn-in                 | **yes**  | `caption-burn-in.ts` merges caption nodes into the preview/export frame (`withCaptionBurnInNodes`), used in the export path (`App.tsx:3956`)                                |
| 6.4 | 00:48 | A second caption track in **Persian or Arabic**, also burned in, using the RTL caption style. | RTL captions, burned in         | **part** | The RTL style exists and burn-in exists. **Not yet proven:** that two caption tracks of different languages render at the same time in one frame. **See 6.4 in section 4.** |
| 6.5 | 00:51 | A **Glitch Displace** transition into the next scene.                                         | Transition — Glitch and digital | **yes**  | `gl:GlitchDisplace`, `GlitchDisplace.glsl`                                                                                                                                  |

### Scene 7 — 00:53–01:03 · Picture in picture, layers, crop, mask

| #   | Time  | What happens                                                                   | Tool                        | Exists   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----- | ------------------------------------------------------------------------------ | --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1 | 00:53 | A second track carries `Neon rain.png` over the video, smaller, in the corner. | Multiple tracks             | **yes**  | `timeline.addTrack` (`commands.ts:272`), `timeline.reorderTrack` (`:277`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 7.2 | 00:55 | The small layer is scaled and moved by **keyframes**, not by hand.             | Keyframed move              | **yes**  | `x`, `y`, `scaleX`, `scaleY` animatable (`v1.ts:99-100`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 7.3 | 00:57 | The picture-in-picture is a **nested composition**, not just a scaled clip.    | PiP as a nested composition | **part** | The schema has `CompositionClipV1` (`kind: 'composition'`, `compositionId`, `childOffsetUs` — `v1.ts:268-272`) and the command `timeline.createCompound` (`commands.ts:260`). But there is **no separate "picture in picture" button** — PiP is what you get by building a nested composition by hand. **See 7.3 in section 4.**                                                                                                                                                                                                             |
| 7.4 | 00:59 | The layer is **cropped** so only part of the picture shows.                    | Crop                        | **part** | The schema has `crop {left,top,right,bottom}` (`v1.ts:90-96`), the command `object.setCrop` (`property-system/src/index.ts:479`) and the Inspector has a real Crop section with four number boxes (`InspectorPanel.tsx:690-718`). **But the renderer never reads crop** — `crop` does not appear anywhere in `packages/render-ir/src` or `packages/renderer-pixi/src`, and in the renderer package it appears only as all-zero test fixtures. **This is a real defect: the crop boxes will move numbers and nothing will change on screen.** |
| 7.5 | 01:01 | A **mask** is applied to the layer.                                            | Mask                        | **part** | Masking exists as a **Worker job** (`apps/worker/src/local-masking.ts:68` `runMaskingJob`, `mask.image` / `mask.video` job types) and the Worker can read the mask derivative (`:131`). But there is **no mask on a timeline element** — no mask field in the Render IR, no mask in the visual object schema. A timeline mask does not exist. **See 7.5 in section 4.**                                                                                                                                                                      |

### Scene 8 — 01:03–01:13 · The filters and the effects (a montage)

REQ-05 asks for one filter and one effect **from each category**. The code's categories today are: filters in 4 groups (`FiltersPanel.tsx:13-18`) and effects in 6 registry categories (`visual-effects/src/types.ts:11`). So ten one-second shots, cut fast over the still — a normal film device, not a demo reel. **T-V07 re-cuts these category names; the shot list uses the names in the code today.**

| #    | Time  | What happens                                 | Tool                       | Exists   | Notes                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ----- | -------------------------------------------- | -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1  | 01:03 | Filter **Blur** — tilt-shift.                | Filter group `blur`        | **part** | `tilt-shift` is a real filter (`FiltersPanel.tsx:13-18`) and renders in preview. **But only 4 of 33 effects have an ffmpeg export path** (`visual-effects/src/ffmpeg-backend.ts:29-57`), so most filters and effects **do not reach the exported file**. **This is the biggest risk to the whole film. See 8.1 in section 4.**                                            |
| 8.2  | 01:04 | Filter **Texture** — noise.                  | Filter group `texture`     | **part** | same export-path question                                                                                                                                                                                                                                                                                                                                                 |
| 8.3  | 01:05 | Filter **Creative** — posterize.             | Filter group `creative`    | **part** | same export-path question                                                                                                                                                                                                                                                                                                                                                 |
| 8.4  | 01:06 | Filter **Looks** — vignette.                 | Filter group `looks`       | **part** | same export-path question                                                                                                                                                                                                                                                                                                                                                 |
| 8.5  | 01:07 | Effect **Color** — brightness-contrast.      | Effect category `color`    | **yes**  | `brightness-contrast` is one of the four with an ffmpeg export path (`registerBuiltins.ts:35`), so this one reaches the file                                                                                                                                                                                                                                              |
| 8.6  | 01:08 | Effect **Blur** — bloom.                     | Effect category `blur`     | **part** | same export-path question                                                                                                                                                                                                                                                                                                                                                 |
| 8.7  | 01:09 | Effect **Distort** — ripple.                 | Effect category `distort`  | **part** | same export-path question; also the preview loop is wrong for 14 of 33 cards (defect 8 in the defect log)                                                                                                                                                                                                                                                                 |
| 8.8  | 01:10 | Effect **Artistic** — halftone.              | Effect category `artistic` | **part** | same export-path question                                                                                                                                                                                                                                                                                                                                                 |
| 8.9  | 01:11 | Effect **Depth** — drop-shadow.              | Effect category `depth`    | **part** | same export-path question                                                                                                                                                                                                                                                                                                                                                 |
| 8.10 | 01:12 | Effect **Stylize** — crt.                    | Effect category `stylize`  | **part** | same export-path question                                                                                                                                                                                                                                                                                                                                                 |
| 8.11 | 01:12 | The still is **fitted** to the frame.        | Fit                        | **no**   | **There is no fit/fill command.** `commands.ts` has no `fit` / `fill` / `fitMode` entry; the only `fit` in the editor is the **monitor's** aspect-ratio selector (`MonitorAspectRatioSelector.tsx:9`), which is about the view, not the clip. T-D01 ("Fit a clip to the frame; Fit and Fill buttons") is CX's card and **has not been built**. **See 8.11 in section 4.** |
| 8.12 | 01:13 | A **Morph** transition into the agent scene. | Transition — Creative      | **yes**  | `gl:morph`, `morph.glsl`                                                                                                                                                                                                                                                                                                                                                  |

### Scene 9 — 01:13–01:20 · The agent's turn

| #   | Time  | What happens                                                                                               | Tool            | Exists  | Notes                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----- | ---------------------------------------------------------------------------------------------------------- | --------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.1 | 01:13 | In Joy Code, one **natural-language edit** is asked for and approved ("tighten the cut by half a second"). | Joy Code edit   | **yes** | `validate_proposal` in the host tool contract (`host-tool-contract.ts:9`), compiled and staged in `edit-proposal-staging.ts:135,159-164`, applied as one compound transaction (`joy-code-compound-runner.ts:113`)                                                                                                                                                                                   |
| 9.2 | 01:14 | The edit is **undone**, then redone, so the film shows the Undo path working.                              | Undo / redo     | **yes** | The agent applies through the same history as any other edit (`domain-parity.test.ts:158` asserts Undo and Redo restore the timeline)                                                                                                                                                                                                                                                               |
| 9.3 | 01:16 | A **QC pass** runs on the cut and finds one thing (say, a black frame at 00:04).                           | QC              | **no**  | **Nothing is built yet.** ADR-0045 (T-B01) is the design; the Worker `media.qc` job, the four agent tools and the `joy-media qc` command do not exist in the tree. T-B02 to T-B08 build them. **See 9.3 in section 4.**                                                                                                                                                                             |
| 9.4 | 01:18 | The MiniMax **picture** and **video** are placed on the timeline by the agent.                             | Generated media | **no**  | **Not built.** There is no generation folder under `apps/desktop/src/main/providers/`, no MiniMax image or video adapter, and the provider registry has no "can make pictures / videos" field (`packages/provider-sdk/src/registry.ts:98-115`). The vocabulary `image.generate` / `video.generate` exists in `provider-sdk/src/types.ts:49,54` but no provider claims it. **See 9.4 in section 4.** |

### Scene 10 — 01:20–01:27 · The sound

| #    | Time  | What happens                                                                              | Tool             | Exists   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ----- | ----------------------------------------------------------------------------------------- | ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.1 | 01:20 | Music under the whole film, faded in and out.                                             | Music + fades    | **part** | `applyFade` exists (`audio-core/src/processing.ts:33`). **But we have no music file** (section 2).                                                                                                                                                                                                                                                                                                                                                       |
| 10.2 | 01:21 | The **voice line** plays under the music, and the music **ducks** under it.               | Ducking          | **part** | Ducking exists **only inside the Joy Code workflow engine**: `transform.normalizeAudio` with `duckMusic: true` (`workflow-engine/src/library.ts:341-345`, `first-party.ts:77-79`) and the audio port (`apps/editor-web/src/first-party-handlers.ts:237-258`). **There is no ducking control on the timeline.** A `compressor` audio effect does exist in the editor (`App.tsx:5983`), which is the usual manual way to do it. **See 10.2 in section 4.** |
| 10.3 | 01:22 | A **crossfade** between two music clips.                                                  | Crossfade        | **yes**  | `applyCrossfade` (`audio-core/src/processing.ts:58`)                                                                                                                                                                                                                                                                                                                                                                                                     |
| 10.4 | 01:23 | The music **volume** is keyframed down and up.                                            | Volume keyframes | **part** | Volume is a property that can be keyed (`packages/property-system/src/index.ts`), but the film's music clip has to exist first.                                                                                                                                                                                                                                                                                                                          |
| 10.5 | 01:24 | Audio from the **video clips** is heard (the northern lights clip carries its own sound). | Clip audio       | **yes**  | `renderOfflineAudio` takes clips with samples (`audio-core/src/offline.ts:124`)                                                                                                                                                                                                                                                                                                                                                                          |
| 10.6 | 01:25 | **Left and right** are checked on the meters.                                             | Stereo balance   | **yes**  | `applyPan` (`audio-core/src/processing.ts:12`) and the meter (`audio-core/src/meter.ts:8`)                                                                                                                                                                                                                                                                                                                                                               |
| 10.7 | 01:26 | The whole mix is measured against **about −14 LUFS**, with no clipping.                   | Loudness target  | **yes**  | `measureLoudness` (`audio-core/src/analysis.ts:51`), `detectClipping` (`:28`), `normalizeDialogue` toward a target (`audio-core/src/normalization.ts:20`)                                                                                                                                                                                                                                                                                                |

### Scene 11 — 01:27–01:30 · The end slate

| #    | Time  | What happens                                                                     | Tool                          | Exists  | Notes                                                                                       |
| ---- | ----- | -------------------------------------------------------------------------------- | ----------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| 11.1 | 01:27 | The owner's logo appears, centred, with the Persian name beside the English one. | End slate, RTL                | **yes** | The `joy.end-slate` template exists (`content-template-catalog.ts`); RTL text is real (5.2) |
| 11.2 | 01:28 | The logo animates in with a motion preset.                                       | Motion preset                 | **yes** | 30 presets in `motion-core/src/presets.ts:771-802`                                          |
| 11.3 | 01:29 | A **Circle Crop** transition closes the film.                                    | Transition — Shapes and masks | **yes** | `gl:CircleCrop`, `CircleCrop.glsl`                                                          |
| 11.4 | 01:29 | The music fades out.                                                             | Fade out                      | **yes** | `applyFade`                                                                                 |

**Total: 01:30 (90 seconds).**

### After the film (no time code — these are actions, not moments)

| #    | What happens                                                                         | Tool                           | Exists  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------ | ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12.1 | The **canvas** is 16:9 and the **export preset** says YouTube 1080p, and they agree. | Canvas and preset in step      | **no**  | **They are still two controls, and the preset wins.** The export size is taken from the preset, not the canvas (`App.tsx:3881-3882` switches on `activeExportPreset` to produce width/height), and the preset lives in its own header dropdown (`App.tsx:6765`) while the canvas lives in the monitor's aspect-ratio selector. T-N01 and T-N02 have not been built. **This is OB-17, still open. See 12.1 in section 4.** |
| 12.2 | The project is **saved**, **closed** and **reopened**, and exported again.           | Save, close, reopen, re-export | **yes** | The project is persisted with the export preset (`App.tsx:4829`) and reopened through the editor session; the same export path runs again. The second file must match the first — that is T-L05's check.                                                                                                                                                                                                                  |
| 12.3 | The export is **MP4, H.264 and AAC, 1080p**.                                         | Export                         | **yes** | The preset list is `social-h264-aac`, `reels-1080`, `shorts-1080`, `youtube-1080`, `high-bitrate` (`apps/editor-web/src/export-job-request.ts:2`)                                                                                                                                                                                                                                                                         |

**Transitions used — all eight categories.** The eight category names are the ones the library audit proposes (`docs/qa/v1.1.1/LIBRARY-AUDIT.md`, section 6). **The code has no category field on a transition today** (`catalog.json` has only `id, glName, label, license, author, glslFile, defaultParams, paramsTypes`, and `TransitionsPanel.tsx` renders one flat list) — T-V08 adds the categories and 13 more transitions. Until then the eight shots below are marked by which category each one _belongs to_:

| Category           | Transition in the film   | Where             |
| ------------------ | ------------------------ | ----------------- |
| Basic and fades    | `gl:fade` (Dissolve)     | 1.4               |
| Wipes              | `gl:wipeRight`           | 2.5               |
| Slides and pushes  | `gl:Directional` (Slide) | 5.5               |
| Zooms and spins    | `gl:CrossZoom`           | 3.5               |
| Shapes and masks   | `gl:CircleCrop`          | 11.3              |
| Glitch and digital | `gl:GlitchDisplace`      | 6.5               |
| Light and glow     | `gl:LinearBlur`          | 1.4 (overlap cut) |
| Creative           | `gl:morph`               | 8.12              |

---

## 4. The "no" and "part" rows, and what each one needs

This is the part the owner and CC act on. Grouped by what they cost.

### A. Blocks the film (the film cannot be finished as written)

| Row      | Feature                                       | What is missing                                                                                                                                                  | What is needed                                                                                                                                                           | Owner                |
| -------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| 8.1–8.10 | Filters and effects in the **export**         | Only 4 of 33 effects have an ffmpeg export path (`visual-effects/src/ffmpeg-backend.ts:29-57`). The rest render in the preview but **not in the exported file**. | T-V03 settles this by a preview-vs-export compare, then T-V04 and T-V05 fix each one. **Until then the film can show effects in the monitor and lose them in the file.** | CX, with T-V03 first |
| 12.1     | Canvas and export preset in step              | Two separate controls; the preset overrides the canvas (`App.tsx:3881-3890`).                                                                                    | T-N01 (one Format control) and T-N02 (the export uses the canvas).                                                                                                       | CX                   |
| 9.3      | The QC pass in the film                       | Nothing is built.                                                                                                                                                | T-B02 to T-B08, on the ADR-0045 design.                                                                                                                                  | GB and CX            |
| 9.4      | MiniMax picture and video placed by the agent | No adapters, no registry fields, no generation folder.                                                                                                           | T-C02 to T-C08.                                                                                                                                                          | MC, CX, GB           |
| 8.11     | Fit and Fill                                  | No command, no buttons.                                                                                                                                          | T-D01.                                                                                                                                                                   | CX                   |
| 10.1     | The music and the voice                       | **We have no audio files.**                                                                                                                                      | The owner supplies one music track and one voice line.                                                                                                                   | **Owner**            |

### B. The film can be built, but the shot has to change

| Row  | Feature                       | What is missing                                                                                                                | What the shot becomes instead                                                                                | Owner                |
| ---- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------- |
| 7.4  | Crop                          | The numbers move; **the picture does not change** (crop is never read by the renderer).                                        | Either build the renderer crop, or cut the shot. **A visible defect if we leave it in.**                     | CX                   |
| 7.5  | Mask                          | Masking exists only as a Worker job for images and video, not on a timeline element.                                           | Apply a mask to a picture before import (Worker path), or drop the shot.                                     | CC to decide         |
| 7.3  | Picture in picture            | No PiP button; it must be built as a nested composition by hand.                                                               | Build the nested composition, and say so in the checklist so the owner is not confused.                      | CX                   |
| 10.2 | Ducking under speech          | Ducking exists only in the Joy Code workflow, not on the timeline.                                                             | Use the timeline **compressor** on the music instead, and say in the checklist that this is how it was done. | CX                   |
| 5.1  | Lower third                   | The lower third is an **HTML scene** template, not a title with a lower-third style.                                           | Use the `joy.lower-third-bar` template.                                                                      | CC to decide         |
| 5.4  | Motion template               | The Templates panel has no motion kind (all 10 are HTML scenes); the 30 motion presets live in the **Animate / Motion** panel. | Use an Animate preset and call it that in the checklist.                                                     | CC to decide         |
| 4.6  | Scopes                        | The mini scope is still in the shared footer of every colour sub-tab.                                                          | T-K05 moves scopes to one place. Until then the scope is shown in the footer as well.                        | MC (T-K05)           |
| 6.4  | Two caption languages at once | The RTL style and the burn-in both exist, but two tracks in different languages in one frame is not proven.                    | One language per scene if it fails, and the checklist says which.                                            | CX, at the live pass |

### C. A decision for the owner

**OA-23 (new, owner):** the film needs **one music track and one voice line**. There is no audio in `media-final`. Without them, the audio half of the checklist (ducking, crossfade, volume keyframes, loudness, balance) cannot be shown at all.

**OA-24 (new, owner):** the **fit, fill and crop shots.** Three features are missing or broken (A: fit/fill, B: crop). The owner can either say "build them, the film needs them" or say "drop them from the film". This is the "yes or no to removing a feature that cannot be made to work" decision (OA-21), asked one week earlier.

**OA-25 (new, owner):** the **effect export path**. If T-V03 finds that most effects do not reach the export, the film cannot show them. The owner may want the film to keep the effect shots (and the features fixed first) or to accept the film without them.

---

## 5. The one-page checklist for the owner

Put this beside the MP4 in `Desktop\joy-media-temps\showcase-film\`.

**How to answer.** Watch the film. For each row write what you see: "correct", or what is wrong. **Your "correct" opens the release** (T-L06). Every wrong item becomes a defect with a test.

| #   | Time  | Item                                                                                      | Your answer |
| --- | ----- | ----------------------------------------------------------------------------------------- | ----------- |
| 1   | 00:00 | The film opens on the northern lights, trimmed to start on the aurora                     |             |
| 2   | 00:03 | The shot splits and the two halves join with a dissolve                                   |             |
| 3   | 00:07 | The title appears, fades in, has an outline                                               |             |
| 4   | 00:10 | The title rotates and its scale changes over time                                         |             |
| 5   | 00:14 | The golden hour clip plays slow, then fast, then backwards                                |             |
| 6   | 00:21 | One moment freezes for a second                                                           |             |
| 7   | 00:24 | The sunset photo appears                                                                  |             |
| 8   | 00:26 | The colour wheels change the picture                                                      |             |
| 9   | 00:28 | The curve changes the picture                                                             |             |
| 10  | 00:30 | The HSL band changes the picture                                                          |             |
| 11  | 00:32 | The Look changes the picture                                                              |             |
| 12  | 00:34 | The lower third comes up                                                                  |             |
| 13  | 00:37 | The Persian title reads right to left                                                     |             |
| 14  | 00:39 | The Arabic title reads right to left                                                      |             |
| 15  | 00:44 | The captions appear                                                                       |             |
| 16  | 00:46 | The captions are burned into the picture (not only in the app)                            |             |
| 17  | 00:48 | A second caption language is burned in                                                    |             |
| 18  | 00:53 | A small picture sits over the video                                                       |             |
| 19  | 00:59 | The small picture is cropped                                                              |             |
| 20  | 01:03 | The tilt-shift filter changes the exported picture                                        |             |
| 21  | 01:04 | The noise filter changes the exported picture                                             |             |
| 22  | 01:07 | The brightness-contrast effect changes the exported picture                               |             |
| 23  | 01:08 | The bloom effect changes the exported picture                                             |             |
| 24  | 01:09 | The ripple effect changes the exported picture                                            |             |
| 25  | 01:10 | The halftone effect changes the exported picture                                          |             |
| 26  | 01:11 | The drop-shadow effect changes the exported picture                                       |             |
| 27  | 01:12 | The crt effect changes the exported picture                                               |             |
| 28  | 01:13 | Joy Code makes the edit you asked for                                                     |             |
| 29  | 01:14 | The agent edit is undone and redone                                                       |             |
| 30  | 01:16 | The QC pass finds a real fault                                                            |             |
| 31  | 01:18 | The generated picture and video are on the timeline                                       |             |
| 32  | 01:21 | The music ducks under the voice                                                           |             |
| 33  | 01:22 | The crossfade between the two music clips is smooth                                       |             |
| 34  | 01:23 | The music volume moves over time                                                          |             |
| 35  | 01:26 | The sound is clean: no clipping, both sides work, the level is about −14 LUFS             |             |
| 36  | 01:27 | The end slate with the logo and the Persian name                                          |             |
| 37  | after | The exported file is 16:9 and 1080p, and the picture in the file is the picture on screen |             |
| 38  | after | The reopened project exports the same file again                                          |             |

---

## 6. Owner items this card creates

| #     | What                                                                               | When        | Why                                                                                           |
| ----- | ---------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------- |
| OA-23 | Supply one music track and one voice line for the film                             | before S05  | No audio exists in `media-final`. Without it the audio half of the checklist cannot be shown. |
| OA-24 | Say "build them" or "drop them" for fit, fill and crop                             | before S05  | Two of the three are missing or broken. The film is written to include them.                  |
| OA-25 | Say whether the film keeps the effect shots if the effects do not reach the export | after T-V03 | The film's effect scenes depend on the answer.                                                |

---

## 7. What was read to write this

**Code read on 13 Nov 2026 at `integration/v1.1.1` = `d448d68c`, read only. The app was not launched.**

`packages/commands/src/commands.ts` (the command registry: trim, split, rate, freeze, reverse, addTrack, reorderTrack, createCompound, setCompositionDimensions) · `packages/project-schema/src/v1.ts` (transform, crop, animatable channels, `CompositionClipV1`) · `packages/project-schema/src/color.ts` (wheels, curves, hsl, lut) · `packages/project-schema/src/text-style.ts` (fill, stroke, direction) · `packages/property-system/src/index.ts` (`object.setCrop`) · `packages/visual-object-renderer/src/index.ts` (text fill and stroke) · `packages/render-ir/src/model.ts` (no crop, no mask) · `packages/renderer-pixi/src/browser.ts` and `color-grade-math.ts` (transitions, colour grade) · `packages/audio-core/src/processing.ts`, `analysis.ts`, `normalization.ts`, `offline.ts`, `meter.ts` · `packages/motion-core/src/presets.ts` · `packages/transition-shaders/src/catalog.json` · `packages/visual-effects/src/ffmpeg-backend.ts` and `types.ts` · `apps/editor-web/src/App.tsx` (export size, preset menu, burn-in, compressor), `InspectorPanel.tsx` (crop), `ColorPanel.tsx` (six colour tabs, looks), `CaptionsPanel.tsx` and `caption-burn-in.ts` (burn-in), `TransitionsPanel.tsx`, `TextPanel.tsx`, `text-template-catalog.ts`, `content-template-catalog.ts`, `joy-code-caption-operations.ts`, `joy-agent/host-tool-contract.ts`, `joy-agent/edit-proposal-staging.ts`, `joy-code-compound-runner.ts` · `apps/worker/src/runtime.ts` and `local-masking.ts` (mask job) · `apps/cli/src/cli.ts` (no `qc` command) · `packages/provider-sdk/src/registry.ts` and `types.ts` (no generation capability) · `apps/desktop/src/main/providers/` (no generation folder) · `docs/qa/v1.1.1/LIBRARY-AUDIT.md` (the filter, effect and transition lists, merged from T-V01).

**Media:** `C:\jgp\ui-shots-20261112\media-final` (7 files) and the owner's logo pictures in `C:\jgp`.

**Not checked:** I did not run the app, and I did not build or run any test. Every "yes" in this file means the code path exists and reaches the render or export path — it does **not** mean the feature has been seen working on screen. The live pass (T-L03) and the film build (T-L05) are what turn these into proofs.
