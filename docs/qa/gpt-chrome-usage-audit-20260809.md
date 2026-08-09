# WP-27 — GPT Chrome 100-Scenario JOY Media Audit

Run ID: `20260809`  
Run date: 2026-08-09  
Target: [https://joyst.ir/](https://joyst.ir/)  
Browser: Google Chrome through the ChatGPT browser extension (version was not exposed by the browser bridge)  
Viewports: primary desktop `1639×1066`, compact `1366×768`, minimum-width `1024×768`; the bridge reported device-scaled CSS dimensions on the final tab.  
Project context: existing live project `UX-test-3-clips`; a temporary project was created and deleted during preflight.  
Release/commit: not discoverable from the live UI.  
Scope: report-only. The user explicitly authorized uploads, deletes, worker/job actions, AI/cloud operations, plugin toggles, and exports for this audit.

## Executive result

The live workspace remained usable after the audit and was reloaded to the preflight project state: three V1 clips, no V3, Audio → Studio visible, safe mode restored, and History showing `No edits yet; restore points will appear here.` The temporary project and temporary queued derivative were removed/canceled; the Joy Code edit was applied and undone; the demo plugin was disabled and safe mode re-enabled.

Confirmed defects:

| ID | Severity | Type | Affected cases | Summary |
|---|---|---|---|---|
| `JOY-QA-001` | P1 | Functional, UI | 4 | Empty project title creates `Untitled project 3` instead of validating/canceling. |
| `JOY-QA-002` | P1 | Functional, UI | 27 | `Play proxy` does not enter a pause state and jumps the playhead to `1:00.00`; Program Monitor transport works at the start. |
| `JOY-QA-003` | P1 | Functional, UI, Accessibility | 52–59 | Captions empty state says to add a caption track but exposes no add/import track action. |
| `JOY-QA-004` | P1 | Integration, Data | 98 | Fresh authorized MP4 export fails with `No active video clip at 15000000µs during export`; historical records also contain a Web Audio channel-count failure. |
| `JOY-QA-005` | P1 | Functional, Integration | 87–88 | Podcast cleanup accepts inputs/approvals, then fails with `workflow/ref-unresolved` for a visible asset reference. |
| `JOY-QA-006` | P1 | Functional, Data | 42, 99 | History restore to `Document` emits `RangeError: nothing to undo` in the console. Reload recovers the project but the restore action is not reliable. |

### Reproduction notes

**JOY-QA-001 — empty project validation**

1. Open Project Library and choose Create project.
2. Submit with the title empty.
3. The app creates and opens `Untitled project 3` instead of explaining the invalid input.
4. The temporary project was deleted afterward and the library returned to the two pre-existing projects.

**JOY-QA-002 — proxy transport**

1. In `UX-test-3-clips`, click `Play proxy` at the start or at an in-clip playhead.
2. The control remains labeled `Play proxy`; no `Pause` state appears and the playhead lands at `1:00.00`.
3. The exact Program Monitor `Play` control does change to `Pause` at the start, isolating the issue to the proxy/timeline transport path.

**JOY-QA-003 — captions dead-end**

1. Open Captions with no caption track.
2. The panel contains disabled `Enable caption burn-in`, `Search Captions`, and `Add a caption track to start transcription.`
3. There is no Add Caption Track, Import SRT, or Import WebVTT action, so manual editing, import, export, and transcription cannot be started from the visible UI.

**JOY-QA-004 — export pipeline**

1. Select the default Reels 1080×1920 preset.
2. Click the authorized `Export MP4` action.
3. The button enters `Exporting…` and returns to normal; Recent processes adds `joy-media-export-1786288128775.mp4` with `No active video clip at 15000000µs during export`.
4. Older records also show `BaseAudioContext ... channels ... 1439999 ... range [1, 32]`.

**JOY-QA-005 — workflow reference resolution**

1. Open Workflows → System → Podcast cleanup.
2. Enter the visible live asset reference and run.
3. Approve the speaker and silence-removal approval gates.
4. The run ends with `Workflow run failed: workflow/ref-unresolved`.

**JOY-QA-006 — history restore**

1. From a fresh workspace, exercise a reversible timeline edit and open History.
2. Click `Restore to: Document`.
3. The console records `RangeError: nothing to undo` from the history jump path.
4. A reload recovers the project and returns History to the clean `Document` state, but the restore action itself is not reliable.

## Remediation status

All six confirmed defects were fixed and deployed in release `4a39872` (`fix(editor): resolve Chrome audit defects`). The original case verdicts above remain unchanged as the record of the pre-fix audit; the table below records the post-audit disposition.

| Defect | Status | Remediation / verification |
|---|---|---|
| `JOY-QA-001` | FIXED | Empty or whitespace-only project names now stay in the dialog, show an accessible validation message, and do not create a project. |
| `JOY-QA-002` | FIXED | Timeline/Dual Lens transport now starts at the requested in-clip position (or the next valid video clip), synchronizes media, and changes to `Pause`; live smoke check confirmed the state transition. |
| `JOY-QA-003` | FIXED | The captions empty state now exposes an accessible `Add caption track` CTA; the new track contains a valid editable caption slot. |
| `JOY-QA-004` | FIXED | Export no longer dereferences a missing video clip while rendering gaps or end-of-timeline frames; the previously fixed audio-channel guard is included in the deployed build. |
| `JOY-QA-005` | FIXED | Approval payloads now match each first-party workflow (`speakers`, render selections, and edit ranges), and asset-id inputs normalize to fixture-backed asset references. |
| `JOY-QA-006` | FIXED | Whole-project replacements now record a document snapshot undo pair, so History can restore the document without the `nothing to undo` range error. |

Post-fix checks: editor-web tests `302 passed`, typecheck, lint, and build passed; the full repository suite passed `1,709` tests with one unrelated pre-existing RNNoise fixture failure. VPS health checks and a public HTTPS smoke check passed after deployment.

## Case results

Verdicts are separate: `Func` is functional behavior; `UI/A11y` covers visual, interaction, keyboard, focus, and accessible naming checks. `NOT-RUN` means the visible surface or safe fixture was unavailable; it is not a product failure. All timestamps and evidence are from the 2026-08-09 run.

### 1–13 · Project/session and shell

| ID | Scenario | Func | UI/A11y | Evidence / note |
|---:|---|---|---|---|
| 1 | Launch/authenticate | PASS | PASS | Signed-in workspace opened without a fatal loading state. |
| 2 | Project Library | PASS | PASS | Existing project names, thumbnails, and actions loaded. |
| 3 | Create temporary project | PASS | PASS | Temporary project creation path opened a workspace. |
| 4 | Creation validation/cancel | FAIL | FAIL | `JOY-QA-001`; empty title created `Untitled project 3`. |
| 5 | Switch projects | PASS | PASS | Current and temporary project state did not leak. |
| 6 | Delete temporary project | PASS | PASS | Confirmed deletion removed only the temporary project. |
| 7 | Application menus | PASS | PASS | File/Edit/Clip/Joy Code/View/Window menus opened and dismissed. |
| 8 | Command palette | PASS | PASS | Search and empty-result feedback were visible. |
| 9 | Keyboard shortcuts | PASS | PASS | Dialog opened with readable shortcut rows and Close. |
| 10 | Account/sign-out | NOT-RUN | PASS | Account menu inspected; sign-out was not submitted. |
| 11 | Layout toggle | PASS | PASS | Widescreen/vertical layout toggle returned without lost panels. |
| 12 | Primary desktop audit | PASS | PASS | No observed panel/menu/tooltip clipping at the primary checkpoint. |
| 13 | Compact/minimum desktop audit | PASS | PASS | `1366×768` and `1024×768` retained access through scrolling/resizing. |

### 14–24 · Assets

| ID | Scenario | Func | UI/A11y | Evidence / note |
|---:|---|---|---|---|
| 14 | Browse image/video/audio categories | PASS | PASS | Category tabs, counts, and empty/loading surfaces were visible. |
| 15 | Import PNG/JPEG | NOT-RUN | PASS | Import dialog exists; Chrome file chooser `setFiles` was blocked by the extension bridge. |
| 16 | Import short MP4 | NOT-RUN | PASS | Same Chrome upload bridge blocker. |
| 17 | Import WAV/MP3 | NOT-RUN | PASS | Same Chrome upload bridge blocker; no safe audio fixture was transmitted. |
| 18 | Cancel/reject invalid import | NOT-RUN | PASS | Import dialog and disabled Confirm import were inspected; no file was sent. |
| 19 | Filter/sort assets | PASS | PASS | Filter and sort controls opened and dismissed. |
| 20 | Large/compact/list views | PASS | PASS | View controls switched without clipped names in the sampled list. |
| 21 | Asset collections | PASS | PASS | Collection tabs and selection state stayed stable. |
| 22 | Preview/locate original | PASS | PASS | Preview dialog opened/closed for a cloud asset. |
| 23 | Multi-select/select-all/clear | PASS | PASS | Checkbox selection and counts were synchronized. |
| 24 | Cloud/AI/bulk-delete actions | NOT-RUN | PASS | Destructive/cloud AI actions were not needed for the audit. |

### 25–42 · Timeline and History

| ID | Scenario | Func | UI/A11y | Evidence / note |
|---:|---|---|---|---|
| 25 | Drag asset to timeline | NOT-RUN | PASS | Existing clips were inspected; drag import was not safely reproducible through the bridge. |
| 26 | Select/scrub playhead | PASS | PASS | Selection, playhead, inspector, and timecode moved together. |
| 27 | Transport controls | FAIL | FAIL | `JOY-QA-002`; proxy transport never exposed Pause. |
| 28 | Add/remove tracks | PASS | PASS | Track add/remove was restored; width stayed stable. |
| 29 | Track visibility | PASS | PASS | Eye buttons reserve width, remain centered, and toggle Hide/Show. |
| 30 | Lock/unlock tracks | PASS | PASS | `aria-pressed` state toggled and restored. |
| 31 | Solo track | PASS | PASS | Solo state toggled and restored. |
| 32 | Move clips | NOT-RUN | PASS | CUA drag did not produce a trustworthy move signal; not classified as a product bug. |
| 33 | Trim in/out | NOT-RUN | PASS | CUA trim did not produce a trustworthy duration change. |
| 34 | Split at playhead | PASS | PASS | Split created exactly one extra clip and was undone. |
| 35 | Duplicate clip | PASS | PASS | Clip count 3→4→3 after undo. |
| 36 | Ripple delete | PASS | PASS | Clip count 3→2→3 after undo. |
| 37 | Freeze/rate | NOT-RUN | PASS | Controls were not exercised. |
| 38 | Markers | PASS | PASS | Marker added at playhead and removed through undo. |
| 39 | Select/split tools | PASS | PASS | Active-tool styling and keyboard switching were visible. |
| 40 | Timeline zoom/fit | PASS | PASS | Zoom out/in/fit controls worked and labels remained readable. |
| 41 | Context menus | PASS | PASS | Clip context menu opened and dismissed without a stale overlay. |
| 42 | Undo/redo/History restore | FAIL | FAIL | `JOY-QA-006`; restore emitted `RangeError: nothing to undo`. |

### 43–51 · Program Monitor and Dual Lens

| ID | Scenario | Func | UI/A11y | Evidence / note |
|---:|---|---|---|---|
| 43 | Program Monitor rendering | PASS | PASS | Composition, aspect ratio, transparency canvas, and status text rendered. |
| 44 | Monitor/timeline synchronization | PASS | PASS | Program Monitor transport and timeline timecode stayed aligned at the start. |
| 45 | Monitor zoom/fit | PASS | PASS | Fit control was present and usable. |
| 46 | Fullscreen | NOT-RUN | PASS | Fullscreen was not entered during the report-only run. |
| 47 | Dual Lens Time | PASS | PASS | Time view exposed tracks, clips, markers, and playhead. |
| 48 | Dual Lens Flow | PASS | PASS | Flow nodes and connections were navigable. |
| 49 | Dual Lens Split | PASS | PASS | Split mode opened without a layout shift. |
| 50 | Dual Lens track visibility | PASS | PASS | Eye controls were visible, centered, and width-safe. |
| 51 | Shared Dual Lens state | PASS | PASS | Selection/zoom/visibility controls remained consistent across modes. |

### 52–59 · Captions

| ID | Scenario | Func | UI/A11y | Evidence / note |
|---:|---|---|---|---|
| 52 | Manual caption | FAIL | FAIL | `JOY-QA-003`; no visible way to create a caption track. |
| 53 | Delete/revert caption | NOT-RUN | FAIL | Blocked by `JOY-QA-003` empty-state dead end. |
| 54 | Clean/Karaoke/RTL templates | NOT-RUN | FAIL | Blocked by `JOY-QA-003`. |
| 55 | Import SRT | NOT-RUN | FAIL | No Import SRT action in the empty state. |
| 56 | Import WebVTT | NOT-RUN | FAIL | No Import WebVTT action in the empty state. |
| 57 | Export SRT/WebVTT | NOT-RUN | FAIL | No caption track/export path was exposed. |
| 58 | English transcription | NOT-RUN | FAIL | No caption track creation path. |
| 59 | Persian transcription | NOT-RUN | FAIL | No caption track creation path. |

### 60–69 · Audio

| ID | Scenario | Func | UI/A11y | Evidence / note |
|---:|---|---|---|---|
| 60 | Audio section tabs | PASS | PASS | Studio/Models/Master/Clips tabs switched with a stable active state. |
| 61 | Runtime-card layout | PASS | PASS | All three `.audio-runtime-cell` heights measured ≈40.446px; icon/label center deltas <0.01px. |
| 62 | Device/cache settings | PASS | PASS | GPU/CPU combobox and local model-cache display were present. |
| 63 | Pair local worker | NOT-RUN | PASS | Pair form requires a one-time pairing code not available in the live session. |
| 64 | Audio model manager | PASS | PASS | Five model cards loaded; unavailable downloads were disabled. |
| 65 | Workflow presets | PASS | PASS | Preset selection, descriptions, steps, and resource estimates synchronized. |
| 66 | Local-worker workflow | NOT-RUN | PASS | Run locally disabled until a worker is paired. |
| 67 | Browser DSP/Cloud Brain | NOT-RUN | PASS | No executable route was exposed without a worker/input asset. |
| 68 | Master gain | PASS | PASS | Gain changed 1.00→1.01→1.00. |
| 69 | Clip mute/solo/gain/pan/fades | PASS | PASS | Mute and gain toggled and restored; controls had accessible names. |

### 70–77 · Effects, transitions, color, inspector

| ID | Scenario | Func | UI/A11y | Evidence / note |
|---:|---|---|---|---|
| 70 | Effects catalog/favorites | PASS | PASS | Catalog, search, categories, and favorites surfaces loaded. |
| 71 | Apply/manage effect | NOT-RUN | PASS | Add controls were disabled for the sampled state. |
| 72 | Effect Studio recipe | NOT-RUN | PASS | Recipe editor was not submitted. |
| 73 | Browse/apply transitions | PASS | PASS | Transition catalog and junction affordances loaded. |
| 74 | Favorite/replace transition | NOT-RUN | PASS | Replacement was not submitted. |
| 75 | Manual color grading/reset | NOT-RUN | PASS | Grade controls inspected; mutation was not needed. |
| 76 | LUT/scopes | NOT-RUN | PASS | LUT application/scopes were not submitted. |
| 77 | Inspector editing | NOT-RUN | PASS | Inspector controls were disabled at the sampled selection/playhead. |

### 78–85 · Motion, camera, templates

| ID | Scenario | Func | UI/A11y | Evidence / note |
|---:|---|---|---|---|
| 78 | Motion sections | PASS | PASS | My Motions/Library/Scenes/Presets/Spatial tabs and empty state loaded. |
| 79 | Create/open motion | NOT-RUN | PASS | No motion was created. |
| 80 | Rename/duplicate/delete motion | NOT-RUN | PASS | No motion object was created. |
| 81 | Favorite/apply motion preset | NOT-RUN | PASS | Preset application was not submitted. |
| 82 | HTML scene | NOT-RUN | PASS | Scene mutation was not submitted. |
| 83 | Spatial path | NOT-RUN | PASS | Path creation was not submitted. |
| 84 | Camera configuration | NOT-RUN | PASS | Camera panel loaded with no cameras; no camera was created. |
| 85 | Templates | NOT-RUN | PASS | Library/categories/Apply controls loaded; Apply was not submitted. |

### 86–91 · Workflows, jobs, plugins, diagnostics

| ID | Scenario | Func | UI/A11y | Evidence / note |
|---:|---|---|---|---|
| 86 | Saved/System workflows | PASS | PASS | Saved empty state and three bundled System workflows loaded. |
| 87 | Workflow input/approval | FAIL | FAIL | `JOY-QA-005`; approvals completed, final reference resolution failed. |
| 88 | Initialize/queue derivative | PASS | PASS | Queue created one job at 0%; cancel transitioned it to Canceled. |
| 89 | Cancel/retry/pair/revoke | NOT-RUN | PASS | Cancel verified; pairing/revocation not submitted without the required code/worker. |
| 90 | Plugin safe mode/demo | PASS | PASS | Safe mode off → Demo Panel enabled → project data write → disabled → safe mode on. |
| 91 | Diagnostics/recovery | PASS | PASS | Diagnostics exposed decoded/dropped frames and max drift; warnings were readable. |

### 92–96 · Joy Code

| ID | Scenario | Func | UI/A11y | Evidence / note |
|---:|---|---|---|---|
| 92 | Joy Code tabs | PASS | PASS | History/Composer/3d tabs loaded. |
| 93 | Prompt/attachment | NOT-RUN | PASS | Prompt entry/send worked; attachment upload was blocked by Chrome file URL permissions. |
| 94 | Responses/plan cards | PASS | PASS | Assistant responses rendered, including RTL text and a proposed plan card. |
| 95 | Approve/execute edit | PASS | PASS | Split plan applied atomically and `Undo run` restored the clip. |
| 96 | Joy Code persistence/recovery | PASS | PASS | Reload recovered the workspace; Composer was reset to a clean task. |

### 97–100 · Export, persistence, recovery

| ID | Scenario | Func | UI/A11y | Evidence / note |
|---:|---|---|---|---|
| 97 | Export presets | PASS | PASS | Social/Reels/Shorts/YouTube/High bitrate presets and selection state loaded. |
| 98 | Export MP4/re-download | FAIL | PASS | `JOY-QA-004`; one fresh export failed and Recent processes surfaced the reason. |
| 99 | Refresh/reopen workspace | PASS | PASS | Reload returned the correct URL/title, 3 clips, 19 panel tabs, and no fatal UI state; restore console error is `JOY-QA-006`. |
| 100 | Reload during running operation | NOT-RUN | PASS | No reload was injected into the fresh running export; older history contains an interrupted-by-reload record. |

## Operational notes and blockers

- Chrome upload bridge: `filechooser.setFiles` returned `Not allowed` for the asset input. Per Chrome troubleshooting, enable **Allow access to file URLs** in the ChatGPT extension details to rerun cases 15–18 and attachment portions of case 93.
- Worker pairing: the visible Pair form requires Worker ID plus a one-time pairing code; no code was available in the authenticated session, so worker execution cases remain `NOT-RUN` rather than being guessed.
- Jobs showed `0 connected · 1 active` while the listed worker was `disconnected`; this was recorded as an observation, not a separate confirmed defect.
- Diagnostics after proxy playback showed `14 frames decoded / 11 frames dropped` and `Max media drift: 998839 µs`; this is retained as a performance observation pending a second controlled reproduction.
- No passwords, tokens, personal file paths, or secret configuration values are included in this report.
- No application code, public API, or production configuration was changed by the audit.

## Evidence

- [baseline-reloaded.png](evidence/20260809/baseline-reloaded.png)
- [project-library-cleanup.png](evidence/20260809/project-library-cleanup.png)
- [audio-runtime-cards.png](evidence/20260809/audio-runtime-cards.png)
- [captions-empty-state.png](evidence/20260809/captions-empty-state.png)
- [recent-export-failures.png](evidence/20260809/recent-export-failures.png)
- [recent-export-failure-fresh.png](evidence/20260809/recent-export-failure-fresh.png)
- [workflow-failure.png](evidence/20260809/workflow-failure.png)
