import { runRealMediaLoopJourney, test } from '../../../tooling/browser-smoke/src/run.js';

test('reopens one real imported media clip with drawable video and audio', async ({ page }) => {
  await runRealMediaLoopJourney({
    page,
    baseUrl: process.env.JOY_MEDIA_BROWSER_URL ?? 'http://127.0.0.1:5173',
    fixturePath:
      process.env.JOY_MEDIA_REAL_MEDIA_FIXTURE ??
      'packages/test-fixtures/media/timecode-tone.mp4',
  });
});
