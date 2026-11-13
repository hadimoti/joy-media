# JOY Media v1.1.1 — live tool checklist

**Card:** T-L02 (the live tool checklist; document only). **Size:** S. **Risk:** low.  
**Author:** AG (Antigravity), worktree `v111-agy`, branch `v111/agy-work`.  
**Basis:** Code at `origin/integration/v1.1.1` and plan specifications (`BUGS-from-owner.md`: REQ-01, REQ-03, REQ-04, OB-17, OB-18).  
**Closes:** REQ-01b (the checklist document for the live tool pass).  
**Executed by:** CC (Claude Code) with Windows-MCP in session S31 / task T-L03.

---

## 1. How to read and run this checklist

### 1.1 Purpose

This document provides the definitive, granular checklist for the live acceptance pass of every editing, timeline, monitor, drag-and-drop, format, and header menu tool in JOY Media v1.1.1.

During session S31 (task T-L03), Claude Code executes each row through Windows-MCP exactly as a human editor would, verifies the observable behavior, records a screenshot, and marks the result as `pass` or `fail`. Any failure is logged with a defect ID in `docs/qa/v1.1.1/DEFECTS.md` and routed to the appropriate helper lane.

### 1.2 Execution rules (task T-L03)

1. **Launch rule:** Every test run must follow the standard launch discipline (`03-TASK-CARDS.md` section 0):
   - Active lock file `C:\jgp\LOCK-app-run.txt` with runner name, timestamp, and purpose.
   - Registry protocol verification: export `HKCU\Software\Classes\joy` and verify SHA-256 equals `AF05BE55222C86FECE27E738B7E8A931CB4261C9797261C67DDE3C71A4E5CAC0`.
   - Never touch the owner's real library or data folders (`AppData\Roaming\@joy-media`, `Documents\JOY Projects`).
   - Use an isolated scratch profile under `C:\jgp\v111\scratch-profile\` and scratch media folder.
   - Count files in the owner library before and after each run; the count must remain unchanged.
2. **Media assets:** Source test clips and images are taken from `C:\jgp\ui-shots-20261112\media-final\` (`Northern lights.mp4`, `Golden hour.mp4`, `Soft light.mp4`, `Alpine lake.png`, `Turquoise sunset.png`, `Autumn path.png`, `Neon rain.png`) plus scratch logo files.
3. **Screenshots:** Stored under `C:\jgp\v111\evidence\T-L03\` following the naming pattern `T-L03\LTP-xxx.png`.
4. **Header popup mutual exclusivity (OB-18):** Opening any menu or drawer must immediately close any other open header menu, drawer, or popover.
5. **Format synchronization (OB-17):** Canvas format choices (16:9, 9:16, 1:1, etc.) must remain in step with the export preset resolution.

### 1.3 Columns

| Column                   | Meaning                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| **ID**                   | Unique item identifier (`LTP-001` through `LTP-066`).                |
| **Tool / Action**        | The specific tool, menu, or control under test.                      |
| **How to do it by hand** | The exact human-like interaction steps (mouse, keyboard, shortcuts). |
| **What must be seen**    | The observable outcome required to declare a pass.                   |
| **Screenshot name**      | Evidence file relative to `C:\jgp\v111\evidence\`.                   |
| **Pass or fail**         | Result status: `pending` (checklist authored), `pass`, or `fail`.    |
| **Defect ID**            | Defect reference in `DEFECTS.md` if failed, or `-`.                  |

---

## 2. The live tool checklist

### 2.1 Timeline Selection & Navigation

| ID      | Tool / Action      | How to do it by hand                                                                                                                             | What must be seen                                                                                                                                                              | Screenshot name     | Pass or fail | Defect ID |
| ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------------ | --------- |
| LTP-001 | Select clip        | Click once on a clip in the timeline with the primary mouse button.                                                                              | The clicked clip receives a prominent selection border/highlight; the Inspector panel immediately populates with its properties; playhead position does not jump unexpectedly. | `T-L03\LTP-001.png` | pending      | -         |
| LTP-002 | Multi-select clips | Hold `Ctrl` (or `Shift`) and click multiple clips across tracks, or click and drag a marquee selection box across clips on the timeline surface. | All targeted clips receive selection outlines simultaneously; Inspector indicates a multi-selection state with shared properties editable.                                     | `T-L03\LTP-002.png` | pending      | -         |
| LTP-003 | Move clip          | Click and hold a clip on the timeline, drag it horizontally to a new time position, and release the mouse button.                                | A semi-transparent drag ghost follows the pointer; snapping guides indicate alignment; dropping places the clip at the new time without unintentional overlaps.                | `T-L03\LTP-003.png` | pending      | -         |
| LTP-004 | Move across tracks | Click and hold a clip on track V1, drag it vertically onto track V2, and release.                                                                | The clip moves vertically into track V2; visual tracks strictly accept visual elements and audio tracks strictly accept audio elements; no cross-family placement occurs.      | `T-L03\LTP-004.png` | pending      | -         |

### 2.2 Trimming & Splitting

| ID      | Tool / Action          | How to do it by hand                                                                                                                  | What must be seen                                                                                                                                                          | Screenshot name     | Pass or fail | Defect ID |
| ------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-005 | Trim start (in-point)  | Hover pointer over the left edge of a clip until the cursor changes to a bracket trim handle `[`, then drag to the right and release. | The clip in-point shifts later into the source media; clip duration shortens; adjacent clips remain in place; preview monitor updates live to display the new start frame. | `T-L03\LTP-005.png` | pending      | -         |
| LTP-006 | Trim end (out-point)   | Hover pointer over the right edge of a clip until the cursor changes to a bracket trim handle `]`, then drag to the left and release. | The clip out-point shifts earlier in time; total clip duration decreases; trailing timeline space becomes a gap; monitor displays the trimmed tail frame.                  | `T-L03\LTP-006.png` | pending      | -         |
| LTP-007 | Split clip at playhead | Position the timeline playhead within an active clip and press shortcut `S`, or select **Clip > Split at Playhead** from the menubar. | The clip splits cleanly into two contiguous clips at the exact playhead timestamp; source continuity is preserved with zero lost frames; undo step is created.             | `T-L03\LTP-007.png` | pending      | -         |

### 2.3 Deletion & Ripple Operations

| ID      | Tool / Action | How to do it by hand                                                                                     | What must be seen                                                                                                                                      | Screenshot name     | Pass or fail | Defect ID |
| ------- | ------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------------ | --------- |
| LTP-008 | Delete clip   | Select a clip on the timeline and press `Delete` or `Backspace`, or choose **Edit > Cut / Delete Clip**. | The selected clip is removed from the timeline; an empty space (gap) remains where the clip was; subsequent clips do not move; project remains intact. | `T-L03\LTP-008.png` | pending      | -         |
| LTP-009 | Ripple delete | Select a clip bounded by other clips, right-click and choose **Ripple Delete**, or press `Alt+Delete`.   | The selected clip is removed and all trailing clips on the track automatically shift left to close the gap completely; no gaps remain.                 | `T-L03\LTP-009.png` | pending      | -         |

### 2.4 Clipboard & Duplication

| ID      | Tool / Action  | How to do it by hand                                                                                 | What must be seen                                                                                                                                                      | Screenshot name     | Pass or fail | Defect ID |
| ------- | -------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-010 | Copy and paste | Select a clip, press `Ctrl+C`, move playhead to a later empty time on the track, and press `Ctrl+V`. | An exact replica of the clip (with identical trims, effects, and transform properties) is pasted at the playhead on the active track as a single undoable transaction. | `T-L03\LTP-010.png` | pending      | -         |
| LTP-011 | Duplicate clip | Select a clip and press `Ctrl+D`, or choose **Edit > Duplicate Clip** from the menubar.              | A duplicate of the clip is immediately created directly following the original on the same track, preserving all properties.                                           | `T-L03\LTP-011.png` | pending      | -         |

### 2.5 Snapping & Timeline Zoom

| ID      | Tool / Action   | How to do it by hand                                                                                                                                                | What must be seen                                                                                                                                                                   | Screenshot name     | Pass or fail | Defect ID |
| ------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-012 | Snapping toggle | Click the Snapping toggle button in the timeline toolbar (or press shortcut `N` / toggle key). Test dragging a clip with snapping ON, then with snapping OFF.       | When ON, dragging clips snaps magnetically to the playhead, clip boundaries, and markers within a 6 px threshold; when OFF, dragging allows smooth unconstrained frame positioning. | `T-L03\LTP-012.png` | pending      | -         |
| LTP-013 | Timeline zoom   | Drag the timeline zoom slider in the bottom timeline control strip, or use shortcuts `Ctrl+=` (zoom in) and `Ctrl+-` (zoom out), or click the ZoomIn/ZoomOut icons. | The horizontal timeline scale smoothly expands or contracts centered around the playhead; ruler intervals and timecode labels adjust dynamically and legibly.                       | `T-L03\LTP-013.png` | pending      | -         |

### 2.6 Markers

| ID      | Tool / Action          | How to do it by hand                                                                                                              | What must be seen                                                                                                                | Screenshot name     | Pass or fail | Defect ID |
| ------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-014 | Add marker             | Position the playhead at a specific timestamp and press shortcut `M`, or click the **Add Marker** button in the timeline toolbar. | A colored marker pin/icon appears on the timeline ruler at the exact playhead position with a distinct label (e.g. `Marker 1`).  | `T-L03\LTP-014.png` | pending      | -         |
| LTP-015 | Seek to marker         | Click directly on the marker icon in the timeline ruler header.                                                                   | The playhead instantly snaps to the exact marker timestamp; the preview monitor renders the corresponding frame.                 | `T-L03\LTP-015.png` | pending      | -         |
| LTP-016 | Edit and delete marker | Double-click or right-click the marker pin to inspect its dialog, then choose Delete or press `Delete`.                           | A marker properties popover opens allowing name/color adjustment; clicking delete removes the marker pin cleanly from the ruler. | `T-L03\LTP-016.png` | pending      | -         |

### 2.7 Track Management

| ID      | Tool / Action    | How to do it by hand                                                                                                    | What must be seen                                                                                                                                              | Screenshot name     | Pass or fail | Defect ID |
| ------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-017 | Add visual track | Click the `+` (Add Track) button located in the Visual track headers stack.                                             | A new visual track (e.g. `V2` or `V3`) appears in the visual stack above existing tracks; track ordering remains strictly visual-above-audio.                  | `T-L03\LTP-017.png` | pending      | -         |
| LTP-018 | Add audio track  | Click the `+` (Add Track) button located in the Audio track headers stack.                                              | A new audio track (e.g. `A2` or `A3`) appears in the lower audio stack; track displays audio-specific metering/controls.                                       | `T-L03\LTP-018.png` | pending      | -         |
| LTP-019 | Lock track       | Click the padlock icon on a track header (e.g. `V1`). Try selecting or dragging clips on that track.                    | The padlock toggles to locked state; track lane background displays a hatched/dimmed pattern; clips on this track cannot be moved, trimmed, split, or deleted. | `T-L03\LTP-019.png` | pending      | -         |
| LTP-020 | Mute track       | Click the speaker/mute icon on an audio track header (or eye/mute icon on visual track). Start playback with `Space`.   | Mute icon reflects active mute state; the track's media is excluded from the audio mix and visual compositor during preview playback.                          | `T-L03\LTP-020.png` | pending      | -         |
| LTP-021 | Solo track       | Click the Solo icon (headphone/star) on an audio track header when multiple audio tracks contain media. Start playback. | Only the soloed audio track is heard in the audio output; all other non-soloed audio tracks are automatically silenced.                                        | `T-L03\LTP-021.png` | pending      | -         |

### 2.8 Speed & Retiming

| ID      | Tool / Action            | How to do it by hand                                                                                                                              | What must be seen                                                                                                                                      | Screenshot name     | Pass or fail | Defect ID |
| ------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------------ | --------- |
| LTP-022 | Clip speed (slow / fast) | Select a video clip, open the Inspector panel, and adjust the Speed slider or input from `1.0x` to `0.5x` (slow motion) and `2.0x` (fast motion). | Clip duration on the timeline expands or contracts proportionally; playback speed in the preview monitor reflects the adjusted playback rate smoothly. | `T-L03\LTP-022.png` | pending      | -         |
| LTP-023 | Reverse clip             | Select a video clip and toggle the **Reverse** switch in the Inspector panel. Play the clip in the monitor.                                       | The clip plays backwards from tail to head in the monitor while maintaining its timeline boundaries and source window.                                 | `T-L03\LTP-023.png` | pending      | -         |

### 2.9 Fades

| ID      | Tool / Action      | How to do it by hand                                                                                                                          | What must be seen                                                                                                                                                         | Screenshot name     | Pass or fail | Defect ID |
| ------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-024 | Video opacity fade | Select a visual clip and drag the fade-in/fade-out corner handles at the head and tail, or adjust the Opacity Fade duration in the Inspector. | Visual fade indicators appear on the clip header; scrubbing the playhead reveals smooth opacity progression from black/transparent to full video and back to transparent. | `T-L03\LTP-024.png` | pending      | -         |
| LTP-025 | Audio volume fade  | Select an audio clip and drag the audio fade curve handles on the waveform head and tail, or adjust Fade In/Out duration in Inspector.        | Curved fade envelopes render over the waveform; audio volume ramps smoothly up from silence at head and down to silence at tail without pops or clicks.                   | `T-L03\LTP-025.png` | pending      | -         |

### 2.10 Transitions, Effects & Filters

| ID      | Tool / Action | How to do it by hand                                                                                                                                         | What must be seen                                                                                                                                       | Screenshot name     | Pass or fail | Defect ID |
| ------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-026 | Transitions   | Open the Transitions panel, select a transition (e.g. **Cross Dissolve** or **Fade**), and drag it onto the boundary between two adjacent clips on track V1. | A transition block appears centered over the clip cut with adjustable duration handles; playback across the boundary renders a smooth visual blend.     | `T-L03\LTP-026.png` | pending      | -         |
| LTP-027 | Effects       | Open the Effects panel, select an effect (e.g. **Gaussian Blur** or **Vignette**), and drag it onto a visual clip. Adjust its parameters in the Inspector.   | An FX badge appears on the clip; Inspector shows effect parameter sliders; moving sliders updates the preview monitor canvas in real time.              | `T-L03\LTP-027.png` | pending      | -         |
| LTP-028 | Filters       | Open the Filters panel, select a filter (e.g. **Black & White** or **Warm Texture**), and apply it to a clip.                                                | The filter attaches to the clip's filter stack; preview monitor renders the stylized look; filter intensity slider in Inspector alters appearance live. | `T-L03\LTP-028.png` | pending      | -         |

### 2.11 Colour Grading Tools

| ID      | Tool / Action                     | How to do it by hand                                                                                                                             | What must be seen                                                                                                                                  | Screenshot name     | Pass or fail | Defect ID |
| ------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-029 | Colour Wheels (Lift, Gamma, Gain) | Open the Colour workspace/panel, select a clip, and adjust the Lift (shadows), Gamma (midtones), and Gain (highlights) color wheels and sliders. | Color wheel reticles move; shadows, midtones, and highlights tint accurately in the preview monitor; numerical readouts update.                    | `T-L03\LTP-029.png` | pending      | -         |
| LTP-030 | Colour Curves                     | In the Colour panel, switch to the **Curves** tab. Click on the RGB curve line to add control points, and drag them to adjust contrast.          | S-curve bends smoothly; the preview monitor updates immediately with altered contrast and tonal response.                                          | `T-L03\LTP-030.png` | pending      | -         |
| LTP-031 | Colour HSL                        | In the Colour panel, switch to the **HSL** tab. Select a specific color range (e.g. Cyan/Blue) and adjust Hue, Saturation, and Luminance.        | Only pixels within the selected color range shift in hue and saturation; rest of the frame remains chromatically untouched.                        | `T-L03\LTP-031.png` | pending      | -         |
| LTP-032 | Colour Looks / LUTs               | In the Colour panel, switch to the **Looks** tab and click a preset Look card (e.g. Cinematic Teal & Orange).                                    | The chosen Look LUT is applied to the selected clip; footage is graded instantly in the preview monitor; active look card displays selected state. | `T-L03\LTP-032.png` | pending      | -         |

### 2.12 Text & Titles (English, Persian, Arabic)

| ID      | Tool / Action        | How to do it by hand                                                                                                         | What must be seen                                                                                                                                                      | Screenshot name     | Pass or fail | Defect ID |
| ------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-033 | English text / title | Open Text panel, add a Title element onto track V2, select it, and type English text: `JOY Media v1.1.1 — Mountain Journey`. | Text renders crisp LTR in the preview monitor; font size, weight, color, and outline controls in Inspector modify typography accurately.                               | `T-L03\LTP-033.png` | pending      | -         |
| LTP-034 | Persian text / title | Add a Title element, select it, and type Persian text with Persian digits: `جوی مدیا ۱.۱.۱ — سفری به کوهستان`.               | Text renders with correct Right-to-Left (RTL) reading order; cursive Arabic/Persian letterforms connect properly without detached/isolated letters or reversed glyphs. | `T-L03\LTP-034.png` | pending      | -         |
| LTP-035 | Arabic text / title  | Add a Title element, select it, and type Arabic text: `محرر الفيديو الاحترافي — تجربة المونتاج`.                             | Text renders with correct RTL alignment; ligatures and complex Arabic glyph connections shape accurately; diacritics and punctuation marks sit in proper positions.    | `T-L03\LTP-035.png` | pending      | -         |

### 2.13 Captions & Subtitles (English, Persian, Arabic)

| ID      | Tool / Action    | How to do it by hand                                                                                                                         | What must be seen                                                                                                                                   | Screenshot name     | Pass or fail | Defect ID |
| ------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-036 | English captions | Open Captions panel, add an English subtitle segment with text: `Welcome to the northern lights display.`, aligned to the playhead timecode. | Caption block appears on the subtitle track; caption text renders centered in the lower third of the monitor in sync with the playhead.             | `T-L03\LTP-036.png` | pending      | -         |
| LTP-037 | Persian captions | Add a caption segment with Persian text: `نمای شفق قطبی در شب‌های زمستان`.                                                                   | Caption renders in the lower third with proper RTL formatting, correct Persian font rendering, full letter shaping, and clean line-wrapping.        | `T-L03\LTP-037.png` | pending      | -         |
| LTP-038 | Arabic captions  | Add a caption segment with Arabic text: `المشهد الطبيعي الخلاب للبحيرة والجبال`.                                                             | Caption renders in the lower third with correct RTL layout, connected glyphs, proper baseline alignment, and clear subtitle background readability. | `T-L03\LTP-038.png` | pending      | -         |

### 2.14 Keyframing & Animation

| ID      | Tool / Action               | How to do it by hand                                                                                                                      | What must be seen                                                                                                                                            | Screenshot name     | Pass or fail | Defect ID |
| ------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------------ | --------- |
| LTP-039 | Add keyframe                | Select a clip, place playhead at start of clip, and click the stopwatch icon next to **Scale** or **Position** in the Inspector.          | The stopwatch highlights in active color; a diamond keyframe marker appears at the playhead position on the clip in the timeline and in the Inspector track. | `T-L03\LTP-039.png` | pending      | -         |
| LTP-040 | Animate keyframes over time | Move playhead 2 seconds forward and adjust the Scale value from `100%` to `150%` in the Inspector. Scrub playhead between the two points. | A second keyframe marker is created automatically; scrubbing playhead between keyframe 1 and keyframe 2 displays continuous smooth interpolation of scale.   | `T-L03\LTP-040.png` | pending      | -         |

### 2.15 History (Undo and Redo)

| ID      | Tool / Action | How to do it by hand                                                                                  | What must be seen                                                                                                                 | Screenshot name     | Pass or fail | Defect ID |
| ------- | ------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-041 | Undo          | Perform an edit (e.g. move a clip or change a slider), then press `Ctrl+Z` or choose **Edit > Undo**. | The last action is immediately reversed; timeline, inspector, and preview monitor revert to the exact state preceding the change. | `T-L03\LTP-041.png` | pending      | -         |
| LTP-042 | Redo          | Immediately after an Undo, press `Ctrl+Y` (or `Shift+Ctrl+Z`), or choose **Edit > Redo**.             | The previously undone edit is restored byte-for-byte; timeline and inspector accurately reflect the reapplied action.             | `T-L03\LTP-042.png` | pending      | -         |

### 2.16 Project Lifecycle & Persistence

| ID      | Tool / Action  | How to do it by hand                                                                                                                                                                   | What must be seen                                                                                                                                                     | Screenshot name     | Pass or fail | Defect ID |
| ------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-043 | Save project   | Select **File > Export Editable Project...** or trigger project save (`Ctrl+S`).                                                                                                       | Status indicator confirms project state is saved; JSON project definition or database record updates with latest revision timestamp.                                  | `T-L03\LTP-043.png` | pending      | -         |
| LTP-044 | Close project  | Select **File > Projects Library...** to exit the active project.                                                                                                                      | Editor closes smoothly without unhandled exceptions or dangling processes; the Projects Library view is displayed.                                                    | `T-L03\LTP-044.png` | pending      | -         |
| LTP-045 | Reopen project | In the Projects Library, click the project card created in LTP-043 to open it.                                                                                                         | The project loads with all tracks, clips, trims, markers, keyframes, transitions, and playhead position completely preserved.                                         | `T-L03\LTP-045.png` | pending      | -         |
| LTP-046 | Export project | Click the **Export** button in the header (or **File > Export**). In the dialog, verify export preset resolution matches canvas (1080p), click **Start Export**, and await completion. | Export progress bar advances to 100%; completion notification appears; output MP4 file is playable, valid in ffprobe, and contains expected audio and visual streams. | `T-L03\LTP-046.png` | pending      | -         |

### 2.17 Monitor Tools (REQ-04)

| ID      | Tool / Action           | How to do it by hand                                                                                                                                | What must be seen                                                                                                                                                                                 | Screenshot name     | Pass or fail | Defect ID |
| ------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-047 | Monitor wheel zoom      | Move mouse pointer over the preview monitor canvas and scroll the mouse wheel up and down (or pinch on trackpad).                                   | The canvas zooms in and out toward the cursor position within the range 10% to 800%; text and raster edges render crisp without pixelated blurring.                                               | `T-L03\LTP-047.png` | pending      | -         |
| LTP-048 | Monitor hand tool (pan) | Hold `Space` key and drag on the monitor canvas with the primary mouse button (or drag with middle mouse button). Tap `Space` without drag.         | While held with drag, cursor turns to a grabbing hand and the canvas pans smoothly; double-clicking hand icon or pressing `Ctrl+0` resets view to Fit; tapping Space without drag plays/pauses.   | `T-L03\LTP-048.png` | pending      | -         |
| LTP-049 | Monitor transform box   | Click a visual clip in the monitor canvas to display its free-transform bounding box. Drag corner handle, drag rotate handle, and press arrow keys. | 8 scale handles resize the element (Shift maintains aspect ratio); rotate handle rotates with 15° snap when Shift is held; center anchor point is draggable; arrow keys nudge 1 px (Shift 10 px). | `T-L03\LTP-049.png` | pending      | -         |

### 2.18 Drag and Drop from Windows Explorer (REQ-03)

| ID      | Tool / Action                     | How to do it by hand                                                                                                                     | What must be seen                                                                                                                                 | Screenshot name     | Pass or fail | Defect ID |
| ------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-050 | Drag from Explorer to Timeline    | Drag a supported media file (e.g. `Northern lights.mp4`) from an open Windows Explorer folder and drop it onto track V1 on the timeline. | Timeline highlights drop zone; drop indicator displays target track and timestamp; on mouse release, clip is inserted cleanly at the target time. | `T-L03\LTP-050.png` | pending      | -         |
| LTP-051 | Drag from Explorer to Monitor     | Drag a media file from Windows Explorer over the preview monitor canvas and release.                                                     | Preview canvas displays drop overlay; clip is imported and inserted at the current playhead position on the active visual track.                  | `T-L03\LTP-051.png` | pending      | -         |
| LTP-052 | Drag from Explorer to Media panel | Drag media files from Windows Explorer into the Asset Library / Media Panel drop target.                                                 | Asset Library drop zone illuminates; media files are ingested into project assets; thumbnails and duration metadata appear in the media grid.     | `T-L03\LTP-052.png` | pending      | -         |
| LTP-053 | Drag multiple / unsupported files | Drag a selection containing valid media plus an unsupported file (e.g. `.txt` or `.exe`) into the Media panel.                           | Valid media files are imported successfully; a non-blocking informative toast or banner lists the skipped unsupported file without crashing.      | `T-L03\LTP-053.png` | pending      | -         |

### 2.19 Canvas Format Control (OB-17)

| ID      | Tool / Action          | How to do it by hand                                                                                          | What must be seen                                                                                                                                  | Screenshot name     | Pass or fail | Defect ID |
| ------- | ---------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-054 | Canvas format dropdown | Click the Canvas Format selector in the header (e.g. `16:9 1080p`). Select `9:16 (Instagram Reels / Shorts)`. | The preview monitor canvas adjusts its aspect ratio to vertical 9:16 immediately; the header Export preset synchronizes with the format per OB-17. | `T-L03\LTP-054.png` | pending      | -         |

### 2.20 Header Menus & Single-Popup Enforcement (OB-18)

| ID      | Tool / Action            | How to do it by hand                                                                                            | What must be seen                                                                                                                                                                 | Screenshot name     | Pass or fail | Defect ID |
| ------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | --------- |
| LTP-055 | File menu popup          | Click **File** in the menubar. Then click **Edit**.                                                             | File menu opens showing project actions; clicking Edit immediately opens the Edit menu and closes the File menu; no two menus overlap.                                            | `T-L03\LTP-055.png` | pending      | -         |
| LTP-056 | Edit menu popup          | Click **Edit** in the menubar. Then click **Clip**.                                                             | Edit menu opens showing Undo, Redo, Cut, Duplicate; clicking Clip immediately opens the Clip menu and closes Edit.                                                                | `T-L03\LTP-056.png` | pending      | -         |
| LTP-057 | Clip menu popup          | Click **Clip** in the menubar. Then click **Joy Code**.                                                         | Clip menu opens showing Split at Playhead; clicking Joy Code immediately opens the Joy Code menu and closes Clip.                                                                 | `T-L03\LTP-057.png` | pending      | -         |
| LTP-058 | Joy Code menu popup      | Click **Joy Code** in the menubar. Then click **View**.                                                         | Joy Code menu opens showing Open Joy Code, Execution Mode, Settings; clicking View immediately opens the View menu and closes Joy Code.                                           | `T-L03\LTP-058.png` | pending      | -         |
| LTP-059 | View menu popup          | Click **View** in the menubar. Then click **Window**.                                                           | View menu opens showing panel toggle options; clicking Window immediately opens the Window menu and closes View.                                                                  | `T-L03\LTP-059.png` | pending      | -         |
| LTP-060 | Window menu popup        | Click **Window** in the menubar. Press `Escape` key.                                                            | Window menu opens showing panel focus commands; pressing Escape cleanly closes the Window menu; focus returns to trigger.                                                         | `T-L03\LTP-060.png` | pending      | -         |
| LTP-061 | Workspace switcher popup | Click the Workspace Switcher dropdown in the header (e.g. showing "Edit"). Then click the Export Preset button. | Workspace switcher opens showing workspace presets (Edit, Enhance, Audio & Captions, Automate, Custom); clicking Export Preset opens Export drawer and closes Workspace switcher. | `T-L03\LTP-061.png` | pending      | -         |
| LTP-062 | Export preset drawer     | Click the Export Preset button in the header. Then click the Workspace Switcher button.                         | Export preset drawer opens displaying format tiles (Instagram Reels, YouTube Shorts, YouTube, High bitrate); clicking Workspace Switcher closes the drawer immediately per OB-18. | `T-L03\LTP-062.png` | pending      | -         |
| LTP-063 | Canvas format popover    | Click the Canvas Format selector button. Click outside the popover on the timeline.                             | Canvas format popover opens with aspect ratio choices; clicking outside dismisses the popover cleanly.                                                                            | `T-L03\LTP-063.png` | pending      | -         |
| LTP-064 | Monitor zoom popover     | Click the Monitor Zoom button in the monitor header. Open the File menu.                                        | Monitor zoom popover opens showing Fit, 50%, 100%, 200%; opening File menu immediately closes the zoom popover.                                                                   | `T-L03\LTP-064.png` | pending      | -         |
| LTP-065 | Command palette overlay  | Press `Ctrl+K` or choose **Edit > Command Palette...**. Type `Split`. Press `Escape`.                           | Command palette modal opens centered with search input focused; shows filtered command results; pressing Escape closes the palette cleanly without affecting open panels.         | `T-L03\LTP-065.png` | pending      | -         |
| LTP-066 | Recent processes popover | Click the Tasks / Recent Processes button in the header toolbar (if present). Open the Edit menu.               | Recent processes popover opens showing background job status; opening any menubar menu immediately closes the processes popover.                                                  | `T-L03\LTP-066.png` | pending      | -         |

---

## 3. Coverage audit against REQ-01 and requirements

Every tool and capability named in REQ-01, REQ-03, REQ-04, OB-17, and OB-18 is accounted for in the table above:

| Requirement Group                       | Items Covered                                                                                 | Checklist IDs          |
| --------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------- |
| **Timeline selection & manipulation**   | Select, multi-select, move, move across tracks                                                | `LTP-001` to `LTP-004` |
| **Trimming & splitting**                | Trim start (both ends), trim end, split at playhead                                           | `LTP-005` to `LTP-007` |
| **Deletion operations**                 | Delete, ripple delete                                                                         | `LTP-008` to `LTP-009` |
| **Clipboard & duplication**             | Copy and paste, duplicate                                                                     | `LTP-010` to `LTP-011` |
| **Snapping & timeline zoom**            | Snapping switch (on/off), timeline zoom controls                                              | `LTP-012` to `LTP-013` |
| **Markers**                             | Add marker, seek to marker, edit and delete marker                                            | `LTP-014` to `LTP-016` |
| **Track controls**                      | Add visual track, add audio track, lock, mute, solo                                           | `LTP-017` to `LTP-021` |
| **Speed & timing**                      | Speed (fast/slow), reverse clip                                                               | `LTP-022` to `LTP-023` |
| **Fades**                               | Video opacity fade, audio volume fade                                                         | `LTP-024` to `LTP-025` |
| **Transitions, effects & filters**      | Apply transitions, apply effects, apply filters                                               | `LTP-026` to `LTP-028` |
| **Colour grading tools**                | Colour wheels, curves, HSL, looks/LUTs                                                        | `LTP-029` to `LTP-032` |
| **Text (English, Persian, Arabic)**     | English text, Persian RTL text, Arabic RTL text                                               | `LTP-033` to `LTP-035` |
| **Captions (English, Persian, Arabic)** | English captions, Persian RTL captions, Arabic RTL captions                                   | `LTP-036` to `LTP-038` |
| **Keyframes & animation**               | Add keyframe, animate parameters over time                                                    | `LTP-039` to `LTP-040` |
| **Undo and redo**                       | Undo (`Ctrl+Z`), redo (`Ctrl+Y`)                                                              | `LTP-041` to `LTP-042` |
| **Project lifecycle**                   | Save, close, reopen, export playable MP4                                                      | `LTP-043` to `LTP-046` |
| **Monitor tools (REQ-04)**              | Wheel zoom, hand pan tool, free-transform box                                                 | `LTP-047` to `LTP-049` |
| **Drag & drop (REQ-03)**                | Explorer to timeline, monitor, media panel; multi/unsupported                                 | `LTP-050` to `LTP-053` |
| **Format control (OB-17)**              | Canvas format dropdown, preset synchronization                                                | `LTP-054`              |
| **Header menus & popups (OB-18)**       | File, Edit, Clip, Joy Code, View, Window, Workspace, Export, Format, Zoom, Palette, Processes | `LTP-055` to `LTP-066` |

**Total checklist rows:** 66 rows.

---

## 4. Defect and retest tracking protocol (for session S31)

When running task T-L03:

1. Any row failing verification must be marked `fail` in the **Pass or fail** column.
2. A defect entry is added to `docs/qa/v1.1.1/DEFECTS.md` with:
   - Defect ID (e.g. `DEF-042`)
   - Checklist row ID (e.g. `LTP-026`)
   - Exact observed behavior vs expected behavior
   - Severity and owning task / agent
3. The defect ID is written into the **Defect ID** column of this checklist.
4. Following the fix and merge of the owning card, the failed row is re-run along with 10 randomly selected passed rows.
5. Task T-L03 closes only when a complete verification run completes with **zero failures**.
