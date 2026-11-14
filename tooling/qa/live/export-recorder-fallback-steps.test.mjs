import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPORT_RECORDER_FALLBACK_CASES,
  runRecorderFallbackExport,
} from './export-recorder-fallback-steps.mjs';

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
