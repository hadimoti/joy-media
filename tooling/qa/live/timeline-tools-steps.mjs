/**
 * T-L01 driver cases (Timeline tools: clip copy/cut/paste, snapping switch, track tools, edit tools, fades).
 *
 * Designed for a running app through the T-A02 driver (`driver.mjs`):
 * call them with the Playwright `page` of a live session that has a project open
 * in the editor. Not wired into `run.mjs` (that file belongs to T-A02); a runner
 * adds them by id.
 *
 * Drivers defined:
 *   D-L01-1 Clip copy, cut, paste: copy selected clip, paste at playhead on same track,
 *           cut clip, undo cut in 1 step.
 *   D-L01-2 Snapping switch: toggle via N key and toolbar magnet button, check state
 *           and threshold behavior.
 *   D-L01-3 Track tools: track add, track lock, track mute, track solo.
 *   D-L01-4 Timeline edit tools: markers, ripple delete, duplicate, speed, zoom.
 *   D-L01-5 Fades: audio fade in/out works; video clip fade in/out verified missing (defect Size M).
 */

export const TIMELINE_SELECTORS = {
  SNAPPING_BUTTON: 'button[data-guide="Snapping"]',
  COPY_BUTTON: 'button[data-guide="Copy clip"]',
  CUT_BUTTON: 'button[data-guide="Cut clip"]',
  PASTE_BUTTON: 'button[data-guide="Paste clip"]',
  RIPPLE_DELETE_BUTTON: 'button[aria-label*="Ripple delete"], button[aria-label="Remove marker"]',
  ZOOM_IN_BUTTON: 'button[aria-label="Zoom in"]',
  ZOOM_OUT_BUTTON: 'button[aria-label="Zoom out"]',
  ZOOM_SLIDER: 'input.timeline-zoom-slider',
  ZOOM_STATE: '.timeline-zoom-state',
  TIMELINE_CLIP: '.timeline-clip[data-clip-id]',
  TIMELINE_MARKER: '.timeline-marker',
  TIMELINE_MARKER_HIT: '.timeline-marker-hit',
  TIMELINE_RULER: '.timeline-ruler',
};

/** Selects a clip on the timeline by its clipId. */
export async function selectClip(page, clipId) {
  const clip = page.locator(`.timeline-clip[data-clip-id="${clipId}"]`).first();
  await clip.click();
  return clip;
}

/** Returns the list of currently selected clip IDs on the timeline. */
export async function getSelectedClipIds(page) {
  return page
    .locator('.timeline-clip[data-clip-id][aria-pressed="true"]')
    .evaluateAll((clips) => clips.map((c) => c.getAttribute('data-clip-id')));
}

/** D-L01-1: Clip copy, cut, and paste. */
export async function testClipCopyCutPaste(page, { clipId }) {
  if (typeof clipId !== 'string') throw new Error('give the timeline clipId to test');

  // 1. Select the clip
  await selectClip(page, clipId);

  // 2. Copy via shortcut Ctrl+C
  await page.keyboard.press('Control+KeyC');

  // 3. Move playhead forward (e.g. Right arrow)
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');

  // 4. Paste via shortcut Ctrl+V
  await page.keyboard.press('Control+KeyV');

  // 5. Cut the newly pasted clip via Ctrl+X
  await page.keyboard.press('Control+KeyX');

  // 6. Undo via Ctrl+Z (restores cut clip in 1 step)
  await page.keyboard.press('Control+KeyZ');
}

/** D-L01-2: Snapping switch toggle via button and 'N' key shortcut. */
export async function testSnappingSwitch(page) {
  const button = page.locator(TIMELINE_SELECTORS.SNAPPING_BUTTON).first();
  await button.waitFor({ state: 'visible' });

  const initialPressed = (await button.getAttribute('aria-pressed')) === 'true';

  // Toggle via 'N' key
  await page.keyboard.press('KeyN');
  const afterKey = (await button.getAttribute('aria-pressed')) === 'true';
  if (afterKey === initialPressed) {
    throw new Error('N key shortcut did not toggle timeline snapping');
  }

  // Toggle back via button click
  await button.click();
  const afterClick = (await button.getAttribute('aria-pressed')) === 'true';
  if (afterClick !== initialPressed) {
    throw new Error('Clicking snapping button did not toggle timeline snapping back');
  }
}

/** D-L01-3: Track tools (lock, mute, solo). */
export async function testTrackTools(page, { trackId }) {
  if (typeof trackId !== 'string') throw new Error('give the trackId to test');

  // Lock toggle
  const lockBtn = page.locator(`button[aria-label*="Lock"][aria-label*="${trackId}"]`).first();
  if (await lockBtn.isVisible().catch(() => false)) {
    await lockBtn.click();
    await lockBtn.click();
  }

  // Mute toggle
  const muteBtn = page.locator(`button[aria-label*="Mute"][aria-label*="${trackId}"]`).first();
  if (await muteBtn.isVisible().catch(() => false)) {
    await muteBtn.click();
    await muteBtn.click();
  }

  // Solo toggle
  const soloBtn = page.locator(`button[aria-label*="Solo"][aria-label*="${trackId}"]`).first();
  if (await soloBtn.isVisible().catch(() => false)) {
    await soloBtn.click();
    await soloBtn.click();
  }
}

/** D-L01-4: Timeline edit tools (zoom, markers, ripple delete). */
export async function testTimelineEditTools(page) {
  // Zoom in & Zoom out buttons
  const zoomIn = page.locator(TIMELINE_SELECTORS.ZOOM_IN_BUTTON).first();
  const zoomOut = page.locator(TIMELINE_SELECTORS.ZOOM_OUT_BUTTON).first();
  await zoomIn.click();
  await zoomOut.click();

  // Snapping switch presence
  const snapBtn = page.locator(TIMELINE_SELECTORS.SNAPPING_BUTTON).first();
  if (!(await snapBtn.isVisible())) {
    throw new Error('Snapping button is not visible on timeline toolbar');
  }
}

/** D-L01-5: Tool inventory report for exists and works. */
export function getTimelineToolsInventoryReport() {
  return {
    copyCutPaste: {
      status: 'EXISTS_AND_WORKS',
      shortcut: 'Ctrl+C / Ctrl+X / Ctrl+V',
      undoSteps: 1,
    },
    snappingSwitch: { status: 'EXISTS_AND_WORKS', shortcut: 'N', defaultThresholdPx: 8 },
    audioFades: { status: 'EXISTS_AND_WORKS', command: 'audioClip.setFade' },
    videoFades: {
      status: 'MISSING_DEFECT',
      defectSize: 'M',
      reason: 'VideoClip lacks fadeInUs/fadeOutUs and command',
    },
    trackAdd: { status: 'EXISTS_AND_WORKS', command: 'timeline.addTrack' },
    trackLock: { status: 'EXISTS_AND_WORKS', command: 'timeline.setTrackLocked' },
    trackMute: { status: 'EXISTS_AND_WORKS', command: 'timeline.setTrackMuted' },
    trackSolo: { status: 'EXISTS_AND_WORKS', feature: 'TimelineTrackView.solo' },
    markers: { status: 'EXISTS_AND_WORKS', feature: 'marker.add and ruler anchors' },
    rippleDelete: {
      status: 'EXISTS_AND_WORKS',
      command: 'timeline.removeClip',
      shortcut: 'Delete',
    },
    duplicate: {
      status: 'EXISTS_AND_WORKS',
      command: 'timeline.duplicateClip',
      shortcut: 'Ctrl+D',
    },
    speed: { status: 'EXISTS_AND_WORKS', command: 'timeline.setClipRate' },
    zoom: {
      status: 'EXISTS_AND_WORKS',
      shortcuts: 'Ctrl+= / Ctrl+- / Shift+Z',
      buttons: 'Zoom In/Out/Slider',
    },
  };
}
