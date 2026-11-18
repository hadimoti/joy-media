import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MONITOR_SNAP_ROWS,
  canvasCentreOnScreen,
  centreFromTransform,
  offsetFromFrameCentre,
  parseReadout,
} from './desktop-monitor-snap-steps.mjs';

test('the snap readout text parses to the box in frame pixels', () => {
  assert.deepEqual(parseReadout('X 540  Y 960  W 270  H 480  A 0°'), {
    x: 540,
    y: 960,
    width: 270,
    height: 480,
  });
  assert.deepEqual(parseReadout('X -12  Y 0  W 5  H 6  A -0°'), {
    x: -12,
    y: 0,
    width: 5,
    height: 6,
  });
  assert.equal(parseReadout('no readout'), null);
  assert.equal(parseReadout(null), null);
});

test('the frame centre on screen follows the Monitor pan and zoom', () => {
  const geometry = { left: 100, top: 50, zoom: 0.25, panX: 300, panY: 200 };
  // A 1080 x 1920 frame at 0.25: the centre is 135 px right and 240 px down from the frame origin.
  assert.deepEqual(canvasCentreOnScreen(geometry, { width: 1080, height: 1920 }), {
    x: 100 + 300 + 135,
    y: 50 + 200 + 240,
  });
});

test('the element centre is the transform origin plus half the readout box, and its offset from the frame centre', () => {
  const centre = centreFromTransform({ x: 405, y: 720 }, { width: 270, height: 480 });
  assert.deepEqual(centre, { x: 540, y: 960 });
  assert.deepEqual(offsetFromFrameCentre(centre, { width: 1080, height: 1920 }), { x: 0, y: 0 });
});

test('the row refuses without --media before it touches the page', async () => {
  const row = MONITOR_SNAP_ROWS.find((item) => item.id === 'D-M06-01');
  assert.ok(row, 'D-M06-01 is registered');
  await assert.rejects(row.run(null, { media: undefined }), /^Error: BLOCKED-on-fixture D-M06-01/u);
});
