import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MONITOR_SNAP_ROWS,
  canvasCentreOnScreen,
  centreFromTransform,
  dragAndObserve,
  offsetFromFrameCentre,
  parseReadout,
  prepareSnapPicture,
} from './desktop-monitor-snap-steps.mjs';

test('snapping starts in a fresh project with the supplied still picture', async () => {
  const calls = [];
  const page = {};
  const steps = {
    newProject: async (_page, title) => calls.push(['project', title]),
    importPicture: async (_page, file) => calls.push(['import', file]),
    placePicture: async (_page, file) => calls.push(['place', file]),
  };
  await prepareSnapPicture(page, { media: 'fixture.jpg', runTag: 'abc' }, steps);
  assert.deepEqual(calls, [
    ['project', 'Monitor snap abc'],
    ['import', 'fixture.jpg'],
    ['place', 'fixture.jpg'],
  ]);
});

test('capture runs with the mouse held and input is released even if capture fails', async () => {
  const events = [];
  const page = {
    keyboard: {
      down: async () => events.push('ctrl down'),
      up: async () => events.push('ctrl up'),
    },
    mouse: {
      move: async () => events.push('move'),
      down: async () => events.push('mouse down'),
      up: async () => events.push('mouse up'),
    },
    evaluate: async () => ({ overlay: true, readout: null, guides: [] }),
  };
  await assert.rejects(
    dragAndObserve(
      page,
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      {
        ctrl: true,
        onHeld: async () => {
          events.push('capture');
          throw new Error('capture failed');
        },
      },
    ),
    /capture failed/u,
  );
  assert.deepEqual(events, [
    'ctrl down',
    'move',
    'mouse down',
    'move',
    'capture',
    'mouse up',
    'ctrl up',
  ]);
});

test('release failures are reported while both inputs are released', async () => {
  const events = [];
  const page = {
    keyboard: { down: async () => {}, up: async () => events.push('ctrl up') },
    mouse: {
      move: async () => {},
      down: async () => {},
      up: async () => {
        events.push('mouse up');
        throw new Error('mouse release failed');
      },
    },
    evaluate: async () => ({ overlay: true, readout: null, guides: [] }),
  };
  await assert.rejects(
    dragAndObserve(page, { x: 0, y: 0 }, { x: 1, y: 1 }, { ctrl: true }),
    /mouse release failed/u,
  );
  assert.deepEqual(events, ['mouse up', 'ctrl up']);
});

test('a failed press still attempts to release inputs', async () => {
  const events = [];
  const page = {
    keyboard: { down: async () => {}, up: async () => events.push('ctrl up') },
    mouse: {
      move: async () => {},
      down: async () => {
        throw new Error('press failed');
      },
      up: async () => events.push('mouse up'),
    },
  };
  await assert.rejects(
    dragAndObserve(page, { x: 0, y: 0 }, { x: 1, y: 1 }, { ctrl: true }),
    /press failed/u,
  );
  assert.deepEqual(events, ['mouse up', 'ctrl up']);
});

test('setup drag releases the mouse without waiting for an overlay', async () => {
  const events = [];
  const page = {
    mouse: {
      move: async () => {},
      down: async () => events.push('down'),
      up: async () => events.push('up'),
    },
    evaluate: async () => {
      throw new Error('unexpected overlay read');
    },
  };
  await dragAndObserve(page, { x: 0, y: 0 }, { x: 1, y: 1 }, { ctrl: false, observe: false });
  assert.deepEqual(events, ['down', 'up']);
});

test('the snap readout text parses to the box in frame pixels', () => {
  assert.deepEqual(parseReadout('X 540  Y 960  W 270  H 480  A 0°'), {
    x: 540,
    y: 960,
    width: 270,
    height: 480,
    angle: 0,
  });
  assert.deepEqual(parseReadout('X -12  Y 0  W 5  H 6  A -12.5°'), {
    x: -12,
    y: 0,
    width: 5,
    height: 6,
    angle: -12.5,
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

test('the target rows cover both canvas corners, both safe areas, user guides, and other element edges and centres', () => {
  assert.deepEqual(
    MONITOR_SNAP_ROWS.map((row) => row.id),
    [
      'D-M06-01',
      'D-M06-02',
      'D-M06-03',
      'D-M06-04',
      'D-M06-05',
      'D-M06-06',
      'D-M06-07',
      'D-M06-08',
    ],
  );
});
