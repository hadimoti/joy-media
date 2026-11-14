import assert from 'node:assert/strict';
import test from 'node:test';
import { getTimelineToolsInventoryReport, TIMELINE_SELECTORS } from './timeline-tools-steps.mjs';

test('TIMELINE_SELECTORS has expected toolbar and canvas selectors', () => {
  assert.ok(TIMELINE_SELECTORS.SNAPPING_BUTTON);
  assert.ok(TIMELINE_SELECTORS.COPY_BUTTON);
  assert.ok(TIMELINE_SELECTORS.CUT_BUTTON);
  assert.ok(TIMELINE_SELECTORS.PASTE_BUTTON);
  assert.ok(TIMELINE_SELECTORS.ZOOM_IN_BUTTON);
  assert.ok(TIMELINE_SELECTORS.ZOOM_OUT_BUTTON);
  assert.ok(TIMELINE_SELECTORS.TIMELINE_CLIP);
});

test('getTimelineToolsInventoryReport lists all required tools and captures video fade defect', () => {
  const report = getTimelineToolsInventoryReport();

  assert.equal(report.copyCutPaste.status, 'EXISTS_AND_WORKS');
  assert.equal(report.copyCutPaste.undoSteps, 1);

  assert.equal(report.snappingSwitch.status, 'EXISTS_AND_WORKS');
  assert.equal(report.snappingSwitch.shortcut, 'N');
  assert.equal(report.snappingSwitch.defaultThresholdPx, 8);

  assert.equal(report.audioFades.status, 'EXISTS_AND_WORKS');
  assert.equal(report.audioFades.command, 'audioClip.setFade');

  // Video fades defect
  assert.equal(report.videoFades.status, 'MISSING_DEFECT');
  assert.equal(report.videoFades.defectSize, 'M');

  // Other tools
  assert.equal(report.trackAdd.status, 'EXISTS_AND_WORKS');
  assert.equal(report.trackLock.status, 'EXISTS_AND_WORKS');
  assert.equal(report.trackMute.status, 'EXISTS_AND_WORKS');
  assert.equal(report.trackSolo.status, 'EXISTS_AND_WORKS');
  assert.equal(report.markers.status, 'EXISTS_AND_WORKS');
  assert.equal(report.rippleDelete.status, 'EXISTS_AND_WORKS');
  assert.equal(report.duplicate.status, 'EXISTS_AND_WORKS');
  assert.equal(report.speed.status, 'EXISTS_AND_WORKS');
  assert.equal(report.zoom.status, 'EXISTS_AND_WORKS');
});
