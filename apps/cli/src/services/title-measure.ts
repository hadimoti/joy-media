import { getTitleTextMeasurer, setTitleTextMeasurer } from './prepared-title.js';

// Registration follows the current measurer, not a one-time flag, so a measurer that was cleared
// (for example by a test reset or an earlier failed start) is registered again on the next call.
export async function ensureTitleTextMeasurer(): Promise<void> {
  if (getTitleTextMeasurer()) return;
  try {
    const runtime = await import('@joy-media/html-scene-runtime');
    const driver = runtime.createChromiumSceneDriver();
    setTitleTextMeasurer(runtime.createChromiumTextMeasure(driver));
    process.once('exit', () => driver.close?.());
  } catch {
    // prepared-title reports SETUP_REQUIRED when no measurer has been registered.
  }
}
