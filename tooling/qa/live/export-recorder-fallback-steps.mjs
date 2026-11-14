/* global document, window */

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
