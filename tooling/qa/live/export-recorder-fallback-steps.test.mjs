import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPORT_RECORDER_FALLBACK_CASES,
  RECORDER_FALLBACK_EXPORT_OPTIONS,
  RECORDER_FALLBACK_ROW_ID,
  runRecorderFallbackExport,
  runRecorderFallbackExportRow,
} from './export-recorder-fallback-steps.mjs';
import { LIVE_ROWS } from './matrix.mjs';
import { COLOR_MATRIX_ROWS_BY_ID } from './color-matrix-rows.mjs';

/** A fake page whose evaluate runs the function against one shared fake window, as the browser would. */
function createRowPage({ route = 'recorder-fallback' } = {}) {
  const win = { __JOY_MEDIA_LAST_EXPORT_ROUTE__: route };
  return {
    win,
    evaluate: async (fn, arg) => {
      const previous = globalThis.window;
      globalThis.window = win;
      try {
        return arg === undefined ? fn() : fn(arg);
      } finally {
        globalThis.window = previous;
      }
    },
  };
}

const OK_PROBE_MESSAGE = 'timeline not cut; ffprobe: h264 1920x1080, 3.00 s, aac audio';

test('the D-F23-02 row is registered after D-F23-01 and runs in the live runner', () => {
  assert.equal(RECORDER_FALLBACK_ROW_ID, 'D-F23-02');
  assert.equal(COLOR_MATRIX_ROWS_BY_ID['D-F23-02'].id, 'D-F23-02');
  assert.equal(typeof COLOR_MATRIX_ROWS_BY_ID['D-F23-02'].run, 'function');
  assert.ok(LIVE_ROWS.some((row) => row.id === 'D-F23-02'));
});

test('the D-F23-02 row arms the fallback flag for its export, checks the route and clears the flag', async () => {
  const page = createRowPage({ route: 'recorder-fallback' });
  const seen = [];
  let prepared = 0;
  const result = await runRecorderFallbackExportRow(
    page,
    {},
    {
      prepareClip: async () => {
        prepared += 1;
      },
      exportAndProbe: async (_page, _ctx, rowId, options, deps) => {
        seen.push({
          rowId,
          options,
          deps,
          flagDuringExport: page.win.__JOY_MEDIA_FORCE_RECORDER_FALLBACK__,
        });
        return { message: OK_PROBE_MESSAGE };
      },
    },
  );

  assert.equal(prepared, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].rowId, 'D-F23-02');
  assert.deepEqual(seen[0].options, { skipTrim: true, seconds: 3, audio: 'any' });
  assert.deepEqual(seen[0].options, RECORDER_FALLBACK_EXPORT_OPTIONS);
  assert.deepEqual(seen[0].deps, { attempts: 400 });
  assert.equal(seen[0].flagDuringExport, true);
  assert.equal(page.win.__JOY_MEDIA_FORCE_RECORDER_FALLBACK__, false);
  assert.match(result, /route: recorder-fallback/);
  assert.match(result, /file is valid/);
});

test('the D-F23-02 row fails on a wrong route and still clears the flag', async () => {
  const page = createRowPage({ route: 'offline-mp4' });
  await assert.rejects(
    () =>
      runRecorderFallbackExportRow(
        page,
        {},
        {
          prepareClip: async () => {},
          exportAndProbe: async () => ({ message: OK_PROBE_MESSAGE }),
        },
      ),
    /Expected export route 'recorder-fallback', but got 'offline-mp4'/,
  );
  assert.equal(page.win.__JOY_MEDIA_FORCE_RECORDER_FALLBACK__, false);
});

test('the D-F23-02 row fails when the export fails and still clears the flag', async () => {
  const page = createRowPage({ route: 'recorder-fallback' });
  await assert.rejects(
    () =>
      runRecorderFallbackExportRow(
        page,
        {},
        {
          prepareClip: async () => {},
          exportAndProbe: async () => {
            throw new Error('the export failed: Export failed: canvas rendering context lost');
          },
        },
      ),
    /the export failed: Export failed: canvas rendering context lost/,
  );
  assert.equal(page.win.__JOY_MEDIA_FORCE_RECORDER_FALLBACK__, false);
});

function createFakePage(options = {}) {
  const evaluateCalls = [];
  const clicks = [];
  let evaluatedFallbackFlag = false;
  let evaluatedRoute = options.route ?? 'recorder-fallback';

  const buttonLocator = {
    click: async () => {
      clicks.push('export-button');
    },
  };

  const toastLocator = {
    innerText: async () => options.toast ?? 'Completed — export.mp4 verified',
  };

  return {
    evaluateCalls,
    clicks,
    getByRole: (role, query) => {
      if (role === 'button' && query.name === 'Export MP4') return buttonLocator;
      throw new Error(`Unexpected getByRole(${role}, ${JSON.stringify(query)})`);
    },
    locator: (selector) => {
      if (selector === '.export-toast') return toastLocator;
      throw new Error(`Unexpected locator(${selector})`);
    },
    evaluate: async (fn) => {
      evaluateCalls.push(fn);
      // Simulate evaluate execution in browser with window
      const prevWindow = globalThis.window;
      const fakeWindow = {
        __JOY_MEDIA_FORCE_RECORDER_FALLBACK__: evaluatedFallbackFlag,
        __JOY_MEDIA_LAST_EXPORT_ROUTE__: evaluatedRoute,
      };
      globalThis.window = fakeWindow;
      try {
        if (typeof fn === 'function') {
          const result = fn.call(fakeWindow);
          if (fakeWindow.__JOY_MEDIA_FORCE_RECORDER_FALLBACK__) {
            evaluatedFallbackFlag = true;
          }
          return result;
        }
        return undefined;
      } finally {
        globalThis.window = prevWindow;
      }
    },
    waitForFunction: async (_fn) => {
      // Simulate wait completion
      return true;
    },
  };
}

test('defines case D-F23-1 in EXPORT_RECORDER_FALLBACK_CASES', () => {
  assert.equal(typeof EXPORT_RECORDER_FALLBACK_CASES['D-F23-1'], 'function');
  assert.equal(EXPORT_RECORDER_FALLBACK_CASES['D-F23-1'], runRecorderFallbackExport);
});

test('runRecorderFallbackExport arms fallback, clicks export, and confirms recorder-fallback route', async () => {
  const fakePage = createFakePage({ route: 'recorder-fallback', toast: 'Export finished' });
  const result = await runRecorderFallbackExport(fakePage);

  assert.equal(fakePage.clicks.length, 1);
  assert.equal(fakePage.clicks[0], 'export-button');
  assert.match(result, /Recorder fallback export completed successfully/);
  assert.match(result, /route: recorder-fallback/);
});

test('runRecorderFallbackExport throws when the route taken is not recorder-fallback', async () => {
  const fakePage = createFakePage({ route: 'offline-mp4' });
  await assert.rejects(
    () => runRecorderFallbackExport(fakePage),
    /Expected export route 'recorder-fallback', but got 'offline-mp4'/,
  );
});

test('runRecorderFallbackExport throws when export toast indicates failure', async () => {
  const fakePage = createFakePage({
    route: 'recorder-fallback',
    toast: 'Export failed: canvas rendering context lost',
  });
  await assert.rejects(
    () => runRecorderFallbackExport(fakePage),
    /Export ended with failure: Export failed: canvas rendering context lost/,
  );
});
