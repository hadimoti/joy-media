/**
 * TL-01 timeline control inventory for live QA.
 *
 * Inventory only: each row names one visible or conditional control on the
 * timeline surfaces (TimelinePanel toolbar, track list, track rows, track color
 * menu, track header context menu, marker row, clip row, runways). No driver is
 * implemented here; a later slice adds executable drivers by `id`.
 *
 * Row shape: { id, label, scope, prerequisite, expected, evidence }, all strings.
 *   - `label` is the accessible name as rendered. `<track code>`, `<track name>`,
 *     `<clip label>`, `<marker label>`, `<duration>`, `<start>` and `<end>` are
 *     placeholders for runtime values.
 *   - `scope` is the surface a repeated label is scoped to: `toolbar.*`,
 *     `track-list.*` (the empty-track strip below the tracks) or `track-row.*`
 *     (inside one track row).
 *
 * Baseline status: every row describes the current build except
 * `toolbar.split-at-playhead`, which is absent in baseline and pending implementation.
 */

function row(id, label, scope, prerequisite, expected, evidence) {
  return Object.freeze({ id, label, scope, prerequisite, expected, evidence });
}

const PANEL = 'apps/editor-web/src/TimelinePanel.tsx';
const VISIBILITY = 'apps/editor-web/src/TimelineTrackVisibilityButton.tsx';
const COLOR_MENU = 'apps/editor-web/src/TimelineTrackColorMenu.tsx';
const COMMANDS = 'apps/editor-web/src/commands/timeline-commands.tsx';

export const timelineControlCases = Object.freeze([
  // Transport
  row(
    'toolbar.play',
    'Play',
    'toolbar.transport',
    'Timeline is stopped and has at least one clip. Otherwise the button is disabled and described by #timeline-play-disabled-reason.',
    'Starts playback. Name switches to Pause while playing. Space shortcut.',
    `${PANEL}:3276-3291`,
  ),
  row(
    'toolbar.pause',
    'Pause',
    'toolbar.transport',
    'Timeline is playing.',
    'Stops playback. Name switches back to Play. Separate state of the same button as toolbar.play.',
    `${PANEL}:3279`,
  ),
  row(
    'toolbar.back-1s',
    'Back one second',
    'toolbar.transport',
    'Playhead is after 0.',
    'Seeks the playhead back by 1 s, clamped at 0. Left arrow shortcut.',
    `${PANEL}:3297-3304`,
  ),
  row(
    'toolbar.forward-1s',
    'Forward one second',
    'toolbar.transport',
    'Playhead is before the timeline end.',
    'Seeks the playhead forward by 1 s, clamped at the timeline duration. Right arrow shortcut.',
    `${PANEL}:3305-3312`,
  ),

  // Add
  row(
    'toolbar.add-marker',
    'Add marker at playhead',
    'toolbar.add',
    'onAddMarker is wired for this timeline (conditional).',
    'Adds a marker at the playhead with the next marker label. M shortcut.',
    `${PANEL}:3318-3328`,
  ),
  row(
    'toolbar.add-video-track',
    'Add video track',
    'toolbar.add',
    'Always rendered in the toolbar.',
    'Adds an empty visual track. T shortcut.',
    `${PANEL}:3330-3339`,
  ),
  row(
    'toolbar.add-audio-track',
    'Add audio track',
    'toolbar.add',
    'Always rendered in the toolbar. Same label as track-list.add-empty-audio-track; the toolbar placement is the one that is scoped here.',
    'Adds an empty audio track. A shortcut (title: "Add audio track (A)").',
    `${PANEL}:3340-3349`,
  ),

  // Tools
  row(
    'toolbar.select-tool',
    'Select tool',
    'toolbar.tools',
    'Always rendered.',
    'Activates the select tool (aria-pressed=true) and deactivates the split tool. V shortcut.',
    `${PANEL}:3355-3371`,
  ),
  row(
    'toolbar.split-tool',
    'Split tool',
    'toolbar.tools',
    'Always rendered.',
    'Activates the split tool (aria-pressed=true) and deactivates the select tool. B shortcut.',
    `${PANEL}:3372-3388`,
  ),
  row(
    'toolbar.snapping-enabled',
    'Snapping enabled',
    'toolbar.tools',
    'Snapping is on (aria-pressed=true).',
    'Click turns snapping off; the label changes to Snapping disabled. N shortcut.',
    `${PANEL}:3389-3399`,
  ),
  row(
    'toolbar.snapping-disabled',
    'Snapping disabled',
    'toolbar.tools',
    'Snapping is off (aria-pressed=false).',
    'Click turns snapping on; the label changes to Snapping enabled. N shortcut.',
    `${PANEL}:3389-3399`,
  ),

  // Edit
  row(
    'toolbar.copy-clip',
    'Copy clip',
    'toolbar.edit',
    'A clip is selected (canCopy). Otherwise disabled.',
    'Copies the selected clip. Ctrl+C shortcut.',
    `${PANEL}:3405-3413`,
  ),
  row(
    'toolbar.cut-clip',
    'Cut clip',
    'toolbar.edit',
    'A clip is selected and its track is unlocked (canCut). Otherwise disabled.',
    'Cuts the selected clip. Ctrl+X shortcut.',
    `${PANEL}:3414-3422`,
  ),
  row(
    'toolbar.paste-clip',
    'Paste clip',
    'toolbar.edit',
    'Clipboard holds a clip and the paste target is valid (canPaste). Otherwise disabled.',
    'Pastes the clipboard clip at the playhead. Ctrl+V shortcut.',
    `${PANEL}:3423-3431`,
  ),
  row(
    'toolbar.duplicate-clip',
    'Duplicate clip',
    'toolbar.edit',
    'A clip is selected and its track is unlocked (canDuplicate). Otherwise disabled.',
    'Duplicates the selected clip. Ctrl+D shortcut (Cmd on macOS).',
    `${PANEL}:3432-3443`,
  ),
  row(
    'toolbar.ripple-delete-clip',
    'Ripple delete',
    'toolbar.edit',
    'A clip is selected, its track is unlocked and no marker is selected. Shown in place of Remove marker when no marker is selected.',
    'Ripple-deletes the selected clip (clip removal, not marker removal). Delete shortcut.',
    `${PANEL}:3444-3459`,
  ),
  row(
    'toolbar.remove-marker',
    'Remove marker',
    'toolbar.edit',
    'A marker is selected. Same button as Ripple delete; the label switches when a marker is selected.',
    'Removes the selected marker only (marker removal, not clip removal). Delete shortcut.',
    `${PANEL}:3444-3459`,
  ),
  row(
    'toolbar.split-at-playhead',
    'Split at playhead',
    'toolbar.edit',
    'Playhead is inside a clip on an unlocked track.',
    'A toolbar button named Split at playhead splits the clip under the playhead once, like the S shortcut; disabled when no eligible clip, on a locked track, or at a clip edge.',
    `Present: aria-label "Split at playhead" at ${PANEL}:3475; S shortcut at apps/editor-web/src/keyboard-shortcuts.ts:228; the same command is in the clip context menu at ${COMMANDS}:601.`,
  ),

  // Zoom
  row(
    'toolbar.zoom-out',
    'Zoom out',
    'toolbar.zoom',
    'Always rendered.',
    'Divides pixels-per-second by 1.25. - shortcut.',
    `${PANEL}:3465-3473`,
  ),
  row(
    'toolbar.timeline-zoom',
    'Timeline zoom',
    'toolbar.zoom',
    'Always rendered.',
    'Range slider (role=slider) that sets pixels-per-second directly.',
    `${PANEL}:3474-3483`,
  ),
  row(
    'toolbar.zoom-in',
    'Zoom in',
    'toolbar.zoom',
    'Always rendered.',
    'Multiplies pixels-per-second by 1.25. = shortcut.',
    `${PANEL}:3484-3492`,
  ),
  row(
    'toolbar.fit-width',
    'Fit timeline to width',
    'toolbar.zoom',
    'Always rendered.',
    'Fits the timeline to width; aria-pressed mirrors autoFit. Shift+Z shortcut.',
    `${PANEL}:3493-3502`,
  ),

  // Conditional toolbar groups
  row(
    'toolbar.back-to-parent',
    'Back to parent timeline',
    'toolbar.navigation',
    'Compound (merged) timeline view is open (isCompoundView).',
    'Leaves the merged view and returns to the parent timeline.',
    `${PANEL}:3254-3266`,
  ),
  row(
    'toolbar.data-lanes',
    'Data Lanes',
    'toolbar.data-lanes',
    'Data lanes are available (dataLanes defined). Accessible name is the visible text plus the item count.',
    'Toggles the data-lanes panel; aria-expanded mirrors the open state.',
    `${PANEL}:3508-3523`,
  ),

  // Empty-track strip below the tracks
  row(
    'track-list.add-empty-visual-track',
    'Add track',
    'track-list.add-empty-track',
    'Always rendered below the tracks.',
    'Adds an empty visual track (same action as toolbar.add-video-track).',
    `${PANEL}:4326-4336`,
  ),
  row(
    'track-list.add-empty-audio-track',
    'Add audio track',
    'track-list.add-empty-track',
    'Always rendered below the tracks. Same label as toolbar.add-audio-track; scoped to the empty-track strip.',
    'Adds an empty audio track (same action as toolbar.add-audio-track).',
    `${PANEL}:4337-4346`,
  ),

  // Runways (conditional)
  row(
    'track-list.runway-visual',
    'Visual runway. Open media library to add a layer.',
    'track-list.runway',
    'No visible, unlocked visual track exists (visualRunwayNeeded).',
    'Opens the media library (Enter or Space, or click) to add a visual layer.',
    `${PANEL}:861-900 and 3655-3662`,
  ),
  row(
    'track-list.runway-audio',
    'Audio runway. Open media library to add a layer.',
    'track-list.runway',
    'No visible, unlocked audio track exists (audioRunwayNeeded).',
    'Opens the media library (Enter or Space, or click) to add an audio layer.',
    `${PANEL}:2292-2294, 4316-4323`,
  ),

  // Track row header controls (one set per track; <track code> is V1, A1, etc.)
  row(
    'track-row.change-label-color',
    'Change label color for <track name>',
    'track-row.header',
    'Track row is rendered. Unnamed tracks use their track code.',
    'Opens the track color menu (aria-haspopup=menu); aria-expanded mirrors the open state.',
    `${PANEL}:3801-3818`,
  ),
  row(
    'track-row.lock',
    'Lock <track code>',
    'track-row.header',
    'Track row is rendered.',
    'Toggles the track lock. aria-pressed mirrors locked; title switches between Lock track and Unlock track.',
    `${PANEL}:3819-3828`,
  ),
  row(
    'track-row.hide',
    'Hide <track code>',
    'track-row.header',
    'Track is visible (eye button shows the open eye).',
    'Hides the track. Uses TimelineTrackVisibilityButton; aria-pressed mirrors visible.',
    `${VISIBILITY}:4-24 and ${PANEL}:3829-3833`,
  ),
  row(
    'track-row.show',
    'Show <track code>',
    'track-row.header',
    'Track is hidden (eye button shows the crossed-out eye).',
    'Shows the track. Uses TimelineTrackVisibilityButton; aria-pressed mirrors visible.',
    `${VISIBILITY}:4-24 and ${PANEL}:3829-3833`,
  ),
  row(
    'track-row.mute',
    'Mute <track code>',
    'track-row.header',
    'Track is not muted (aria-pressed=false).',
    'Mutes the track. aria-pressed=true afterwards; title switches to Unmute track.',
    `${PANEL}:3834-3843`,
  ),
  row(
    'track-row.unmute',
    'Unmute <track code>',
    'track-row.header',
    'Track is muted (aria-pressed=true).',
    'Unmutes the track. aria-pressed=false afterwards.',
    `${PANEL}:3834-3843`,
  ),
  row(
    'track-row.solo',
    'Solo <track code>',
    'track-row.header',
    'Track row is rendered.',
    'Toggles solo on the track. aria-pressed mirrors solo; title switches between Solo track and Unsolo track.',
    `${PANEL}:3844-3853`,
  ),

  // Track color menu (conditional, opened from the color button)
  row(
    'track-row.color-menu',
    'Track color',
    'track-row.color-menu',
    'Track color menu is open for one track (role=menu).',
    'Menu container for the color choices. Closes on outside pointer or Escape.',
    `${COLOR_MENU}:70 and ${PANEL}:3854-3875`,
  ),
  row(
    'track-row.color-default',
    'Default',
    'track-row.color-menu',
    'Track color menu is open.',
    'Clears the track label color (menuitemradio). aria-checked reflects the current color.',
    `${COLOR_MENU}:5-16 and 73-90`,
  ),
  row(
    'track-row.color-violet',
    'Violet',
    'track-row.color-menu',
    'Track color menu is open.',
    'Sets the track label color to violet (menuitemradio).',
    `${COLOR_MENU}:5-27`,
  ),
  row(
    'track-row.color-iris',
    'Iris',
    'track-row.color-menu',
    'Track color menu is open.',
    'Sets the track label color to iris (menuitemradio).',
    `${COLOR_MENU}:5-27`,
  ),
  row(
    'track-row.color-caribbean',
    'Caribbean',
    'track-row.color-menu',
    'Track color menu is open.',
    'Sets the track label color to caribbean (menuitemradio).',
    `${COLOR_MENU}:5-27`,
  ),
  row(
    'track-row.color-lavender',
    'Lavender',
    'track-row.color-menu',
    'Track color menu is open.',
    'Sets the track label color to lavender (menuitemradio).',
    `${COLOR_MENU}:5-27`,
  ),
  row(
    'track-row.color-cerulean',
    'Cerulean',
    'track-row.color-menu',
    'Track color menu is open.',
    'Sets the track label color to cerulean (menuitemradio).',
    `${COLOR_MENU}:5-27`,
  ),
  row(
    'track-row.color-forest',
    'Forest',
    'track-row.color-menu',
    'Track color menu is open.',
    'Sets the track label color to forest (menuitemradio).',
    `${COLOR_MENU}:5-27`,
  ),
  row(
    'track-row.color-rose',
    'Rose',
    'track-row.color-menu',
    'Track color menu is open.',
    'Sets the track label color to rose (menuitemradio).',
    `${COLOR_MENU}:5-27`,
  ),
  row(
    'track-row.color-mango',
    'Mango',
    'track-row.color-menu',
    'Track color menu is open.',
    'Sets the track label color to mango (menuitemradio).',
    `${COLOR_MENU}:5-27`,
  ),

  // Track header context menu (right-click on a track header; menu items, not buttons)
  row(
    'track-row.context-remove-track',
    'Remove Track',
    'track-row.header-context-menu',
    'Track is empty, the timeline has more than one track and the track is unlocked. Otherwise disabled.',
    'Removes the track (timeline.removeTrack).',
    `${COMMANDS}:749-760 and ${PANEL}:3736-3759`,
  ),
  row(
    'track-row.context-hide-track',
    'Hide Track',
    'track-row.header-context-menu',
    'Track is visible.',
    'Hides the track from the context menu (same state as track-row.hide).',
    `${COMMANDS}:749-767 and ${PANEL}:3754`,
  ),
  row(
    'track-row.context-show-track',
    'Show Track',
    'track-row.header-context-menu',
    'Track is hidden.',
    'Shows the track from the context menu (same state as track-row.show).',
    `${COMMANDS}:749-767 and ${PANEL}:3754`,
  ),

  // Track lane (insertion)
  row(
    'track-row.insert-media',
    'Insert media on <track code> track',
    'track-row.lane',
    'Track row is rendered. Enter or Space always opens the media library. A click opens it only on an empty lane; a populated lane click seeks.',
    'Opens the media library to insert media on this track.',
    `${PANEL}:3878-3899`,
  ),

  // Markers (track row index 0)
  row(
    'track-row.marker-select',
    '<marker label>. Delete to remove.',
    'track-row.marker',
    'At least one marker exists (rendered in the first track row).',
    'Selects the marker and seeks to it (aria-pressed mirrors selection). Right-click removes the marker. Delete shortcut removes it while selected.',
    `${PANEL}:4124-4152`,
  ),
  row(
    'track-row.marker-remove',
    'Remove <marker label>',
    'track-row.marker',
    'At least one marker exists.',
    'Removes this marker only (marker removal, not clip removal).',
    `${PANEL}:4153-4163`,
  ),

  // Clips (per clip in a track row)
  row(
    'track-row.clip-select',
    '<clip label>, <duration>, <start>–<end>',
    'track-row.clip',
    'At least one clip exists. Missing media adds ", media missing" to the name.',
    'Selects the clip (aria-pressed mirrors selection). Keyboard activation follows the clip role=button.',
    `${PANEL}:513-535`,
  ),
  row(
    'track-row.clip-trim-start',
    'Trim start of <clip label>',
    'track-row.clip',
    'Clip is not locked (trim handles render only when unlocked).',
    'Trims the clip start. Arrow keys nudge 0.1 s; Shift nudges 1 s.',
    `${PANEL}:737-762`,
  ),
  row(
    'track-row.clip-trim-end',
    'Trim end of <clip label>',
    'track-row.clip',
    'Clip is not locked (trim handles render only when unlocked).',
    'Trims the clip end. Arrow keys nudge 0.1 s; Shift nudges 1 s.',
    `${PANEL}:765-775`,
  ),
]);
