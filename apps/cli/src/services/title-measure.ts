import { setTitleTextMeasurer } from './prepared-title.js';

let initialized = false;
export async function ensureTitleTextMeasurer(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const runtime = await import('@joy-media/html-scene-runtime');
    const driver = runtime.createChromiumSceneDriver();
    setTitleTextMeasurer(runtime.createChromiumTextMeasure(driver));
    process.once('exit', () => driver.close?.());
  } catch {
    // prepared-title reports SETUP_REQUIRED when no measurer has been registered.
  }
}
