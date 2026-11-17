/* global document, window */
import { exportAndProbe } from './export-probe.mjs';
import { ensureTimelineClip, selectClipById } from './ui-steps.mjs';

/**
 * T-F23 / C-079: Exercises the recorder fallback export route through the live driver.
 *
 * It arms `window.__JOY_MEDIA_FORCE_RECORDER_FALLBACK__ = true` so the app bypasses
 * the offline WebCodecs MP4 encoder and runs the deterministic real-time MediaRecorder
 * fallback path in App.tsx.
 *
 * Verifies that:
 * 1. The export route chosen was 'recorder-fallback' (via window.__JOY_MEDIA_LAST_EXPORT_ROUTE__).
 * 2. The export runs to completion without failure toast.
 */

const EXPORT_BUTTON = { name: 'Export MP4', exact: true };

export async function runRecorderFallbackExport(page) {
  // 1. Arm the forced recorder fallback flag in the browser page
  await page.evaluate(() => {
    window.__JOY_MEDIA_FORCE_RECORDER_FALLBACK__ = true;
  });

  // 2. Click the Export MP4 button
  await page.getByRole('button', EXPORT_BUTTON).click();

  // 3. Wait for the export to finish (export button is no longer aria-busy)
  await page.waitForFunction(
    () => document.querySelector('.header-export-btn')?.getAttribute('aria-busy') !== 'true',
    undefined,
    { timeout: 600_000 },
  );

  // 4. Verify that the recorder fallback route was indeed executed
  const route = await page.evaluate(() => window.__JOY_MEDIA_LAST_EXPORT_ROUTE__);
  if (route !== 'recorder-fallback') {
    throw new Error(`Expected export route 'recorder-fallback', but got '${route ?? 'undefined'}'`);
  }

  // 5. Read toast to confirm completion
  const toast = await page
    .locator('.export-toast')
    .innerText()
    .catch(() => '');
  const firstLine = toast.split('\n')[0] ?? '';
  if (/Export failed/u.test(toast)) throw new Error(`Export ended with failure: ${firstLine}`);

  return `Recorder fallback export completed successfully (route: ${route}, toast: ${firstLine || 'verified'})`;
}

export const EXPORT_RECORDER_FALLBACK_CASES = {
  'D-F23-1': runRecorderFallbackExport,
};

/** The live row (registered in color-matrix-rows.mjs) that runs the recorder fallback export through the probe. */
export const RECORDER_FALLBACK_ROW_ID = 'D-F23-02';
/** The same export options as D-F23-01: a 3 s export of the fixture clip, audio allowed either way. */
export const RECORDER_FALLBACK_EXPORT_OPTIONS = Object.freeze({
  skipTrim: true,
  seconds: 3,
  audio: 'any',
});
/** The fallback records in real time, so the poll allows about 400 s instead of the probe's default 180. */
const RECORDER_FALLBACK_ATTEMPTS = 400;

/** Arms or clears the flag the app reads when an export starts. */
export async function setRecorderFallbackFlag(page, armed) {
  await page.evaluate((value) => {
    window.__JOY_MEDIA_FORCE_RECORDER_FALLBACK__ = value;
  }, armed);
}

async function prepareFixtureClip(page, ctx) {
  const base = await ensureTimelineClip(page, ctx, RECORDER_FALLBACK_ROW_ID, { fresh: true });
  await selectClipById(page, base.clips[0].id);
}

/**
 * D-F23-02: a fresh project with the fixture clip, the flag armed, one export through the same probe as D-F23-01,
 * then the route the app reports must be 'recorder-fallback'. The flag is cleared in `finally`, so a failed
 * export cannot leave the fallback on for the rows that follow. `deps` lets a unit test replace the clip
 * setup and the export; the row itself uses the real helpers.
 */
export async function runRecorderFallbackExportRow(page, ctx, deps = {}) {
  const prepare = deps.prepareClip ?? prepareFixtureClip;
  const probeExport = deps.exportAndProbe ?? exportAndProbe;
  await prepare(page, ctx);
  await setRecorderFallbackFlag(page, true);
  try {
    const exported = await probeExport(
      page,
      ctx,
      RECORDER_FALLBACK_ROW_ID,
      RECORDER_FALLBACK_EXPORT_OPTIONS,
      { attempts: RECORDER_FALLBACK_ATTEMPTS },
    );
    const route = await page.evaluate(() => window.__JOY_MEDIA_LAST_EXPORT_ROUTE__);
    if (route !== 'recorder-fallback') {
      throw new Error(
        `Expected export route 'recorder-fallback', but got '${route ?? 'undefined'}'`,
      );
    }
    return `recorder fallback export finished and the file is valid (route: ${route}; ${exported.message})`;
  } finally {
    await setRecorderFallbackFlag(page, false);
  }
}
