# WP-27 — GPT Chrome 100-Scenario JOY Media Audit

**Status:** Completed through WP-29 remediation; final WP-29 deployment pending

**Target:** live https://joyst.ir/ in Google Chrome through the ChatGPT browser extension  
**Results:** historical audit
[`docs/qa/gpt-chrome-usage-audit-20260809.md`](../docs/qa/gpt-chrome-usage-audit-20260809.md);
remediation closure
[`docs/qa/WP-29-r5-browser-closure-20260810-0621.md`](../docs/qa/WP-29-r5-browser-closure-20260810-0621.md)

## Summary

Run 100 numbered end-user scenarios against the current live account and
project. Record separate functional, UI, accessibility, and persistence
verdicts. This audit is report-only: it does not fix application code.

## Remediation closure

The original live audit exercised 63 scenarios and left 37 as `NOT-RUN` where
safe completion required fixtures, authenticated file bridges, a Worker or
provider boundary, pointer/fullscreen automation, or controlled destructive
state. WP-29 subsequently closed those former 37 cases at all three required
viewports in installed Google Chrome:

- 108 direct R5 browser instances passed;
- three complementary R2 CASE-66 Worker instances passed;
- the reconciled matrix is 111/111, with 37/37 functional and UI/accessibility
  closure.

Fixture-backed cases remain explicitly labelled `PASS-FIXTURE`; this closure
does not relabel deterministic external-boundary evidence as a paid-provider or
production-live run. The final WP-29 commit, immutable deployment, live cleanup,
and GBrain reconciliation remain pending and are not claimed by this plan.

## Execution protocol

1. Launch Chrome, connect the enabled ChatGPT extension, authenticate, and
   record URL, timestamp, viewport, project, and release/commit when visible.
2. Create a History restore point before mutations. Pause if no reversible
   checkpoint is available.
3. Capture initial console errors and a full-workspace screenshot.
4. Run ten resumable batches of ten cases. Use 1639x1066, 1366x768, and
   1024x768 viewport checkpoints.
5. Ask for confirmation before uploads, downloads, deletes, sign-out, worker
   revocation, paid AI/cloud operations, plugin enablement, and permissions.
   Record declined actions as \`BLOCKED-CONSENT\`.
6. Save results, console errors, and failure evidence after every batch.
7. Reproduce every apparent defect once after refresh/restore; classify
   inconsistent outcomes as \`FLAKY\`.
8. Restore the live project checkpoint and remove temporary audit objects.
   List irreversible jobs, exports, and cloud operations.

## Scenario matrix

### Project and session (1–6)

1. Launch/authenticate — workspace opens without fatal errors or redirect loops.
2. Open Project Library — projects show correct names, thumbnails, metadata, and actions.
3. Create a temporary project — valid input creates and opens exactly one project.
4. Validate/cancel project creation — invalid input is explained and cancel is safe.
5. Switch current and temporary projects — no state leaks between projects.
6. Delete temporary project — confirmation is explicit and only the target is removed.

### Shell and layout (7–13)

7. Open File/Edit/Clip/Joy Code/View/Window menus — alignment, dismissal, and command states work.
8. Use command palette — search, keyboard navigation, execution, and empty state work.
9. Open keyboard shortcuts — content is accurate, readable, and keyboard accessible.
10. Open account/sign-out — account state is correct and sign-out is confirmed.
11. Switch vertical/widescreen layouts — panels rearrange without overlap or lost state.
12. Audit 1639x1066 — no clipping, overlap, or inaccessible control exists.
13. Audit 1366x768 and 1024x768 — scrolling/resizing preserves access to controls.

### Assets (14–24)

14. Browse image/video/audio categories — results and empty/loading/error states are correct.
15. Import PNG/JPEG — progress, cards, thumbnails, and metadata are correct.
16. Import short MP4 — upload completes once and media is editable.
17. Import WAV/MP3 — metadata and preview controls work.
18. Cancel/reject import — no partial asset remains and feedback is actionable.
19. Filter and sort — results and order match controls without stale cards.
20. Switch large/compact/list views — selection persists and text/controls do not clip.
21. Use collections — create/select/update/remove does not lose assets.
22. Preview and locate original — correct preview and missing-source behavior.
23. Multi-select/select-all/clear — count, styling, and bulk actions stay synchronized.
24. Cloud/AI/bulk-delete actions — confirmed operation targets only selected assets and reports progress.

### Timeline and history (25–42)

25. Drag asset to timeline — correctly typed clip appears at intended track/time.
26. Select clips and scrub — selection, preview, inspector, and timecode synchronize.
27. Play/pause/previous/next — transport and playhead update once per action.
28. Add/remove tracks — ordering and width remain stable; removal is confirmed.
29. Toggle track visibility — eye-state is visible and track-header width does not shift or overlap.
30. Lock/unlock tracks — locked edits are rejected clearly; unlock restores editing.
31. Solo track — state is unambiguous and monitor output matches selected tracks.
32. Move clips across time/tracks — drag, snap, and invalid-drop feedback are accurate.
33. Trim in/out — duration, handles, adjacent media, and preview update correctly.
34. Split at playhead — exactly two continuous valid clips result.
35. Duplicate clip — distinct editable duplicate appears at documented destination.
36. Ripple delete — selected clip is removed and only intended later content closes.
37. Freeze/rate controls — output, duration, labels, and undo match the command.
38. Add/remove markers — position, label, selection, and deletion stay synchronized.
39. Select/split tools — active styling, cursor, hit testing, and shortcuts work.
40. Zoom/fit timeline — playhead context is preserved and labels remain legible.
41. Clip/track context menus — commands target the right item and overlays dismiss cleanly.
42. Undo/redo/History restore — changes reverse/reapply exactly without corruption.

### Program Monitor and Dual Lens (43–51)

43. Program Monitor rendering — composition, transparency, aspect ratio, and status are correct.
44. Monitor/timeline playback sync — frame, timecode, playhead, and transport align.
45. Monitor zoom/fit — scaling is centered without crop or hidden controls.
46. Fullscreen enter/exit — playback continues and keyboard/visible exit works.
47. Dual Lens Time — tracks, clips, markers, and playhead match the primary timeline.
48. Dual Lens Flow — nodes/connections navigate and reveal correct timeline content.
49. Dual Lens Split — Time and Flow remain synchronized during selection/playback.
50. Dual Lens visibility — eye controls are visible, centered, usable, and width-safe.
51. Shared Dual Lens state — markers, lanes, selection, zoom, and visibility persist across modes.

### Captions (52–59)

52. Add/edit manual caption — text, timing, placement, and preview update together.
53. Delete/revert caption — only the intended caption state changes.
54. Apply Clean/Karaoke/RTL templates — styling and selected states are accurate.
55. Import SRT — text and multiline timing parse correctly.
56. Import WebVTT — valid cues import and malformed cues explain errors.
57. Export SRT/WebVTT — downloaded files contain valid current captions and encoding.
58. Automatic English transcription — progress, result, confidence, and errors work.
59. Automatic Persian transcription — RTL, punctuation, alignment, seeking, and confidence work.

### Audio (60–69)

60. Open Studio/Models/Master/Clips — tabs have stable sizing and active state.
61. Audit runtime cards — Local Worker, Cloud Brain, and Device boxes are equal height; icons align vertically.
62. Device/cache settings — selected values validate and persist.
63. Pair/inspect local worker — readiness, errors, and disconnect/recovery are clear.
64. Filter/inspect models — provider and install states match availability.
65. Select workflow presets — cards, descriptions, steps, resources, and active styling synchronize.
66. Run local-worker workflow — progress, completion, media, and failure recovery work.
67. Run Browser DSP/Cloud Brain — routing is correct and cost confirmation precedes execution.
68. Adjust master gain — output, numeric control, reset, undo, and persistence work.
69. Edit clip mute/solo/gain/pan/fades — controls align and survive tab changes.

### Effects, transitions, color, inspector (70–77)

70. Browse/favorite effects — categories, warnings, favorites, and cards update without duplicates.
71. Apply/manage effect — apply, enable, reorder, edit, and remove target the active clip.
72. Create Effect Studio recipe — validation, save, card, and application work.
73. Browse/apply transitions — valid junctions accept; invalid drops explain.
74. Favorite/replace transitions — state persists without damaging adjacent clips.
75. Manual color grade/reset — lift, gamma, gain, saturation, preview, undo, reset synchronize.
76. Apply LUT/scopes — LUT and parade/scopes update without blocking editing.
77. Inspector editing — transform, crop, keyframes, interpolation, expressions, effects, and audio target the active clip.

### Motion, camera, templates (78–85)

78. Navigate Motion sections — active and empty states are clear.
79. Create/open motion — data opens and keyframe edits update preview.
80. Rename/duplicate/delete motion — only target changes and action is reversible/confirmed.
81. Favorite/apply motion preset — favorite persists and preset applies.
82. Apply/remove HTML scene — safe render and correct restoration.
83. Create/save spatial path — controls, preview, saved state, and reopening work.
84. Create/configure camera — active camera, transform, FOV, parent, and preview synchronize.
85. Browse/apply/delete templates — view, application, confirmation, and project state are correct.

### Workflows, jobs, plugins, diagnostics (86–91)

86. Browse Saved/System workflows — refresh, selection, detail, and missing states work.
87. Run input/approval workflow — validation, approval, continue, dismiss, progress, and results work.
88. Initialize/queue derivative job — one accurate job appears with correct worker/output state.
89. Cancel/retry jobs and pair/revoke workers — correct record and confirmation.
90. Exercise plugin safe mode/demo — enable, disable, write, warning, and restriction behavior work.
91. Inspect Diagnostics/recovery — logs, warnings, failures, retry, empty, and timestamps are useful.

### Joy Code (92–96)

92. Navigate History/Composer/3D — state loads without layout shifts or lost conversation.
93. Start task, prompt, attach file — validation, preview/removal, send, and focus work.
94. Render response and plan card — streaming, Markdown, RTL, actions, and run status work.
95. Approve/execute agent edit — intended timeline mutation occurs and is undoable.
96. Refresh/retry Joy Code — history persists and retries do not duplicate prompts or edits.

### Export, persistence, recovery (97–100)

97. Select/validate export preset — resolution, orientation, format, and validation match.
98. Export MP4/re-download — one job, accurate progress, playable output, working recent-process download.
99. Refresh/reopen workspace — edits, layout, history, and process records recover correctly.
100.  Reload during queued/running operation — no duplicate jobs, lost data, or permanently stuck UI.

## Reporting

Each case records \`PASS\`, \`FAIL\`, \`FLAKY\`, \`BLOCKED-CONSENT\`, or
\`NOT-RUN\`, with separate functional and UI verdicts, expected/actual
behavior, repro steps, Chrome/viewport/project/build context, timestamp,
evidence path, console errors, related defects, reproduction count, and
workaround.

Defects use IDs such as \`JOY-QA-001\` and severities P0 (data loss/security/
outage), P1 (core workflow blocked/corruption), P2 (degraded behavior with
workaround), and P3 (polish/accessibility/consistency). Types are Functional,
UI, Accessibility, Performance, Data, and Integration. Duplicate symptoms are
consolidated with all affected case IDs.

## Acceptance criteria

- All 100 cases have Chrome outcomes.
- Every failure has evidence and reproducible steps.
- Functional and UI findings are separate.
- Timeline and Dual Lens visibility width/icon alignment are explicitly verified.
- Audio card heights/icon alignment are explicitly measured.
- Apparent failures are reproduced before confirmation.
- Live state is restored where possible; irreversible operations are listed.
- No secrets or personal paths are written to the report.
- No application code or production configuration is changed by the audit.
