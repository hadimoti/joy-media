import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareRgbFrames } from '../compare.mjs';
import { createFakePage } from './fake-page.mjs';
import {
  CANCEL_MIN_BUSY_MS,
  CANCEL_MIN_TIMELINE_SECONDS,
  CANCEL_POLL_MS,
  FRAME_COMPARE_SAMPLES,
  EXPORT_MATRIX_IDS,
  EXPORT_MATRIX_ROWS,
  assertNoStagedLibraryEntries,
  burnInRegionDimensions,
  clickNamed,
  inspectPreset,
  monitorPictureRect,
  parseProcessTreeWorkingSet,
  processTreeWorkingSet,
  runCancelRow,
  timecodeIsWithinFrame,
  timelineSecondsFromBoxes,
} from './export-matrix-steps.mjs';

const validProbe = {
  format: { duration: '6.00' },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      avg_frame_rate: '30/1',
      nb_frames: '180',
    },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
};

test('A10 has nine selectable preset rows, one four-frame compare, one memory row and the ten-minute memory row', () => {
  assert.deepEqual(
    EXPORT_MATRIX_IDS,
    Array.from({ length: 14 }, (_, index) => `D-A10-${String(index + 1).padStart(2, '0')}`),
  );
  assert.equal(EXPORT_MATRIX_ROWS.length, 14);
});

test('preset validation checks dimensions, rate, frame count, one-frame duration and audio', () => {
  assert.equal(inspectPreset(validProbe, 'youtube-1080').pass, true);
  const noAudio = { ...validProbe, streams: [validProbe.streams[0]] };
  assert.ok(inspectPreset(noAudio, 'youtube-1080').problems.includes('audio stream missing'));
  const short = { ...validProbe, format: { duration: '5.9' } };
  assert.equal(inspectPreset(short, 'youtube-1080').pass, false);
});

test('D-A10 export acceptance rejects leftover internal and .stage catalog entries', () => {
  const libraryDir = mkdtempSync(path.join(os.tmpdir(), 'joy-a10-library-'));
  const catalogPath = path.join(libraryDir, 'catalog.json');
  const ctx = { libraryDir };
  try {
    writeFileSync(catalogPath, JSON.stringify({ assets: [{ displayName: 'user.mp4' }] }));
    assert.doesNotThrow(() => assertNoStagedLibraryEntries(ctx, 'D-A10-01'));

    writeFileSync(catalogPath, JSON.stringify({ assets: [{ internal: true }] }));
    assert.throws(() => assertNoStagedLibraryEntries(ctx, 'D-A10-01'), /left 1 staged entry/u);

    writeFileSync(catalogPath, JSON.stringify({ assets: [{ displayName: 'export.mp4.stage' }] }));
    assert.throws(() => assertNoStagedLibraryEntries(ctx, 'D-A10-01'), /left 1 staged entry/u);
  } finally {
    rmSync(libraryDir, { recursive: true, force: true });
  }
});

test('RGB compare uses the stated mean absolute per-channel threshold', () => {
  const preview = { width: 2, height: 1, bytes: Buffer.from([10, 10, 10, 10, 10, 10]) };
  const near = { width: 2, height: 1, bytes: Buffer.from([11, 10, 10, 11, 10, 10]) };
  const shifted = { width: 2, height: 1, bytes: Buffer.from([14, 10, 10, 14, 10, 10]) };
  assert.equal(compareRgbFrames(preview, near, 1).status, 'pass');
  assert.equal(compareRgbFrames(preview, shifted, 1).status, 'fail');
});

test('D-A10-10 samples matching source times on both duplicated clips', () => {
  assert.deepEqual(FRAME_COMPARE_SAMPLES, [
    { seconds: 1, sourceSeconds: 1 },
    { seconds: 2, sourceSeconds: 2 },
    { seconds: 4, sourceSeconds: 1 },
    { seconds: 5, sourceSeconds: 2 },
  ]);
  assert.equal(timecodeIsWithinFrame('00:00:01:01', 30, 30), true);
  assert.equal(timecodeIsWithinFrame('00:00:01:02', 30, 30), false);
  assert.equal(timecodeIsWithinFrame('00:00:01:30', 30, 30), false);
  assert.equal(timecodeIsWithinFrame(null, 30, 30), false);
});

test('Monitor picture crop uses the centered Fit frame and excludes stage margins', () => {
  assert.deepEqual(
    monitorPictureRect(
      { left: 100, top: 40, width: 800, height: 500, zoom: 0.4 },
      { width: 1920, height: 1080 },
    ),
    { x: 116, y: 74, width: 768, height: 432 },
  );
  assert.deepEqual(burnInRegionDimensions({ width: 768, height: 432 }), {
    x: 0,
    y: 0,
    width: 192,
    height: 43,
  });
});

test('memory sampler reads launched process tree working sets', () => {
  const rows = processTreeWorkingSet(12, {
    run: (_exe, _args) => ({
      status: 0,
      stdout: '[{"ProcessId":12,"WorkingSetSize":1024},{"ProcessId":13,"WorkingSetSize":512}]',
    }),
  });
  assert.deepEqual(rows, [
    { pid: 12, workingSetBytes: 1024 },
    { pid: 13, workingSetBytes: 512 },
  ]);
});

test('memory sample parser accepts a single PowerShell object and validates its fields', () => {
  assert.deepEqual(parseProcessTreeWorkingSet('{"ProcessId":12,"WorkingSetSize":1024}'), [
    { pid: 12, workingSetBytes: 1024 },
  ]);
  assert.deepEqual(parseProcessTreeWorkingSet(''), []);
  assert.throws(
    () => parseProcessTreeWorkingSet('{bad json'),
    /invalid process memory sample JSON/u,
  );
  assert.throws(
    () => parseProcessTreeWorkingSet('{"ProcessId":12,"WorkingSetSize":"unknown"}'),
    /invalid PID or working set/u,
  );
});

test('memory sampler reports spawn and PowerShell failures with useful details', () => {
  assert.throws(
    () =>
      processTreeWorkingSet(12, {
        run: () => ({ error: new Error('spawn failed'), status: null }),
      }),
    /process memory sample failed: spawn failed/u,
  );
  assert.throws(
    () => processTreeWorkingSet(12, { run: () => ({ status: 1, stderr: 'CIM access denied' }) }),
    /process memory sample failed: CIM access denied; exit code 1/u,
  );
});

/**
 * A scripted export on the fake page with a virtual clock. `readState(poll, clicked)` gives the Export button state
 * at each poll; the Cancel button shows when `cancelVisible` is true. The clock moves only through `wait`.
 */
function scriptedCancel({ readState, cancelVisible = true, fixtureSeconds = 3 }) {
  const clock = { t: 0 };
  const record = { clicks: [], busyAt: undefined, lengthen: [] };
  let polls = 0;
  const page = createFakePage({
    answers: ({ path, method, fn }) => {
      if (method === 'evaluate' && fn === 'readExportState') {
        const state = readState(polls, record.clicks.length > 0);
        polls += 1;
        if (state.busy && record.busyAt === undefined) record.busyAt = clock.t;
        return state;
      }
      if (path.includes('Cancel export')) {
        if (method === 'isVisible') return cancelVisible;
        if (method === 'click') record.clicks.push(clock.t);
      }
      if (path.includes('Reframe') && method === 'isVisible') return false;
      return undefined;
    },
  });
  const ctx = { downloadDir: 'scratch-downloads', media: 'fixtures\\source.mp4', appPid: 1 };
  const deps = {
    ensureClip: async () => ({ clips: [{ id: 'clip-1' }] }),
    fixtureSeconds: () => fixtureSeconds,
    lengthen: async (_page, _rowId, options) => {
      record.lengthen.push(options);
      return CANCEL_MIN_TIMELINE_SECONDS;
    },
    listMp4: () => [],
    processNames: () => ['joy media.exe', 'msedgewebview2.exe'],
    now: () => clock.t,
    wait: async (ms) => {
      clock.t += ms;
    },
  };
  return { page, ctx, deps, record };
}

const exportedThenIdle = (poll, clicked) =>
  clicked ? { busy: false, toast: 'Export cancelled' } : { busy: poll >= 1, toast: '' };

test('cancel is clicked as soon as the button shows, after the short minimum, not after a fixed 4 s', async () => {
  const { page, ctx, deps, record } = scriptedCancel({ readState: exportedThenIdle });
  const message = await runCancelRow(page, ctx, 'D-A10-14', 'vp9-webm-audio.webm', deps);
  assert.equal(record.clicks.length, 1);
  const waited = record.clicks[0] - record.busyAt;
  assert.ok(waited >= CANCEL_MIN_BUSY_MS, `cancel came ${waited} ms after busy, below the minimum`);
  assert.ok(
    waited <= CANCEL_MIN_BUSY_MS + CANCEL_POLL_MS,
    `cancel came ${waited} ms after busy; it should follow the minimum at once`,
  );
  assert.match(message, /cancelled \d\.\d s after it went busy/u);
  assert.match(message, /timeline lengthened to 30\.0 s/u);
});

test('an export that finishes before the Cancel click is BLOCKED with the stated reason, not a click timeout', async () => {
  // Busy for one poll only, then the button is back to Export; no Cancel button ever shows.
  const { page, ctx, deps, record } = scriptedCancel({
    readState: (poll) => ({ busy: poll === 1, toast: '' }),
    cancelVisible: false,
  });
  await assert.rejects(
    runCancelRow(page, ctx, 'D-A10-14', 'vp9-webm-audio.webm', deps),
    (error) => {
      assert.equal(
        error.message,
        'BLOCKED D-A10-14: the export finished before it could be cancelled (fixture too short on this machine)',
      );
      return true;
    },
  );
  assert.equal(record.clicks.length, 0);
});

test('an export that ends while the Cancel click is in flight is also BLOCKED', async () => {
  // The button shows at the check, but the export ends before the click lands: the click times out and the
  // Export button is no longer busy, so the row says BLOCKED rather than the click timeout.
  let finished = false;
  const { page, ctx, deps } = scriptedCancel({
    readState: () => ({ busy: !finished, toast: '' }),
  });
  const failing = Object.create(page);
  failing.getByRole = (role, options) => {
    const locator = page.getByRole(role, options);
    if (options?.name !== 'Cancel export') return locator;
    return {
      ...locator,
      click: async () => {
        finished = true;
        throw new Error('locator.click: Timeout 5000ms exceeded.');
      },
    };
  };
  await assert.rejects(
    runCancelRow(failing, ctx, 'D-A10-14', 'vp9-webm-audio.webm', deps),
    (error) => {
      assert.equal(
        error.message,
        'BLOCKED D-A10-14: the export finished before it could be cancelled (fixture too short on this machine)',
      );
      return true;
    },
  );
});

test('the timeline is lengthened for the 3-second WebM row but not for the 10-minute row', async () => {
  const webm = scriptedCancel({ readState: exportedThenIdle, fixtureSeconds: 3 });
  await runCancelRow(webm.page, webm.ctx, 'D-A10-14', 'vp9-webm-audio.webm', webm.deps);
  assert.deepEqual(webm.record.lengthen, [
    { clipSeconds: 3, minSeconds: CANCEL_MIN_TIMELINE_SECONDS },
  ]);

  const tenMinute = scriptedCancel({ readState: exportedThenIdle, fixtureSeconds: 600 });
  const message = await runCancelRow(
    tenMinute.page,
    tenMinute.ctx,
    'D-A10-13',
    'h264-1080p-10min.mp4',
    tenMinute.deps,
  );
  assert.deepEqual(tenMinute.record.lengthen, []);
  assert.match(message, /600\.0 s source, not lengthened/u);
});

test('a failed click names the control that could not be reached', async () => {
  const locator = {
    click: async () => {
      throw new Error('locator.click: Timeout 10000ms exceeded.\nCall log:\n  waiting');
    },
  };
  await assert.rejects(clickNamed(locator, 'button "Cancel export"'), (error) => {
    assert.equal(
      error.message,
      'could not click button "Cancel export" within 10000 ms: locator.click: Timeout 10000ms exceeded.',
    );
    return true;
  });
});

test('timeline length is read from the clip boxes and does not depend on the zoom', () => {
  const at = (width) =>
    Array.from({ length: 4 }, (_, index) => ({
      id: `c${index}`,
      left: index * width,
      right: (index + 1) * width,
    }));
  assert.equal(timelineSecondsFromBoxes(at(100), 3), 12);
  assert.equal(timelineSecondsFromBoxes(at(37), 3), 12);
  assert.equal(timelineSecondsFromBoxes([], 3), 0);
});
