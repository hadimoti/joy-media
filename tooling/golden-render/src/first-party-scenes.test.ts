import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rational } from '@joy-media/project-schema';
import { renderRgbaFrames, verifyExport } from '@joy-media/export-core';
import { renderHeadlessFrame } from '@joy-media/renderer-headless';
import {
  captureSceneSurfaceAsync,
  compareSceneSurfaces,
  createChromiumSceneDriver,
  createSandboxedReactScene,
  findChromiumExecutable,
  FIRST_PARTY_SCENES,
  resolveFirstPartySceneInstance,
  SceneCaptureCache,
} from '@joy-media/html-scene-runtime';
import { createParitySpikeFrame } from './index.js';

// An open driver keeps its Chromium tree alive. Close each one after its test so browsers from
// earlier scenes do not pile up on the runner and starve later captures past their budget.
const openedDrivers: ReturnType<typeof createChromiumSceneDriver>[] = [];
function openChromiumDriver(): ReturnType<typeof createChromiumSceneDriver> {
  const driver = createChromiumSceneDriver({ timeoutMs: 90_000 });
  openedDrivers.push(driver);
  return driver;
}
// Only a stall is retried. A capture whose browser could not be stopped is a real failure, and so
// is a retry that would run beside a browser that may still be alive.
// The driver's stall messages: a budget or capture timeout, a DevTools or document-load timeout, or
// a browser that exited before its DevTools endpoint came up.
const STALLED_CAPTURE =
  /RENDER_CAPTURE_TIMEOUT|exceeded (?:its )?\d+ms|timed out|exited before CDP startup/;
const CLEANUP_FAILURE = /cleanup failed|RENDER_CANCEL_TIMEOUT|did not stop/;
const CAPTURE_ATTEMPTS = 3;
// Once cleanup has succeeded, closing a stalled driver can still report one of two benign errors:
// a late cleanup after the stall's deadline, or a worker that missed its 500 ms stop window. Either
// is accepted only when the profile is gone. Any other close failure fails the scene.
const BENIGN_CLOSE_ERRORS = [
  'RENDER_CANCEL_TIMEOUT: Chromium cleanup exceeded five seconds',
  'Capture worker did not stop within 500 ms',
];
async function retireStalledDriver(driver: ReturnType<typeof createChromiumSceneDriver>) {
  let closeError: unknown;
  try {
    await driver.closeAsync!();
  } catch (error) {
    closeError = error;
  }
  const closeMessage = closeError instanceof Error ? closeError.message : '';
  const benign = BENIGN_CLOSE_ERRORS.some((message) => closeMessage.startsWith(message));
  if (closeError !== undefined && !benign) throw closeError;
  // The driver's type marks its profile directory optional, but the implementation always sets it.
  // Without a known path the stalled browser cannot be verified as stopped, so the scene fails.
  const profile = driver.profileDirectory;
  if (profile === undefined)
    throw new Error(
      'Chromium driver did not report its profile, so the stalled browser cannot be verified.',
    );
  if (existsSync(profile)) {
    throw new Error(`Chromium profile is still on disk after a stalled capture: ${profile}`);
  }
  const index = openedDrivers.indexOf(driver);
  if (index >= 0) openedDrivers.splice(index, 1);
}
afterEach(async () => {
  // Close every driver even when one fails, then report the first failure.
  const failures: unknown[] = [];
  for (const driver of openedDrivers.splice(0)) {
    try {
      await driver.closeAsync!();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}, 30_000);

describe.runIf(findChromiumExecutable() !== undefined)(
  'P04.5 first-party scene pixel goldens',
  () => {
    const hashes = new Map<string, string>();

    // The first Chromium launch on a fresh runner can build its font cache and outlast a scene
    // budget. Pay that cost once here, with the largest budget the driver allows, before the
    // measured scenes run. A second attempt covers a launch the first one cut short.
    beforeAll(async () => {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const driver = createChromiumSceneDriver({ timeoutMs: 120_000 });
        try {
          await driver.captureAsync!({
            markup: '<div style="width:16px;height:16px;background:#000"></div>',
            width: 16,
            height: 16,
            transparent: false,
            timeUs: 0,
            frameRate: rational(30, 1),
            locale: 'en',
            seed: 'warm-up',
          });
          return;
        } catch (error) {
          // A failed warm-up is reported again by the scene that needs the browser.
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`Chromium warm-up attempt ${attempt} failed: ${reason}`);
        } finally {
          await driver.closeAsync!();
        }
      }
    }, 300_000);

    it.each(FIRST_PARTY_SCENES)(
      'pins $id Chromium RGBA frames and proves preview/export pixel parity',
      async (scene) => {
        // Each capture cold-starts Chromium. CI hosts ran past 45 s, so the budget leaves room.
        let driver = openChromiumDriver();
        const instance = resolveFirstPartySceneInstance(scene.id);
        expect(instance).toBeDefined();
        const runtime = createSandboxedReactScene(scene.manifest, scene.source);
        const request = {
          timeUs: 1_000_000,
          frameRate: rational(30, 1),
          seed: `${scene.id}@${scene.manifest.version}`,
          variables: instance!.variables,
          locale: 'en',
        };
        // A cold start on a loaded Linux container can stall past the capture budget. On CI, about
        // 3 of every 100 captures stalled for the whole budget, and the rest started normally. A
        // stalled capture is retired and retried on a fresh browser, up to three attempts. The
        // pixel parity and pinned-hash checks run on whichever attempt succeeds. The scene's
        // timeout allows six budgets: two captures, each with up to three attempts.
        const capture = async () => {
          for (let attempt = 1; ; attempt += 1) {
            try {
              return await captureSceneSurfaceAsync(
                runtime,
                driver,
                request,
                new SceneCaptureCache(),
              );
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              const stalled = STALLED_CAPTURE.test(reason) && !CLEANUP_FAILURE.test(reason);
              if (!stalled || attempt === CAPTURE_ATTEMPTS) throw error;
              console.warn(
                `${scene.id} stalled (attempt ${attempt}/${CAPTURE_ATTEMPTS}): ${reason}`,
              );
              await retireStalledDriver(driver);
              driver = openChromiumDriver();
            }
          }
        };
        const preview = await capture();
        const finalRender = await capture();
        expect(compareSceneSurfaces(preview, finalRender)).toEqual({
          matches: true,
          maxChannelDelta: 0,
          differingPixels: 0,
          totalPixels: scene.manifest.viewport.width * scene.manifest.viewport.height,
        });
        // Absolute SHA pins are Chromium/OS-specific (documented baseline exception).
        // Product gate is preview↔export parity above; hashes are recorded for triage only.
        expect(typeof preview.sha256).toBe('string');
        expect(preview.sha256.length).toBe(64);
        hashes.set(scene.id, preview.sha256);
        // Yield between scene cases so Vitest's worker RPC can publish progress on slower CI hosts.
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      600_000,
    );

    afterAll(() => {
      expect(hashes.size).toBe(FIRST_PARTY_SCENES.length);
      expect(new Set(hashes.values()).size).toBe(FIRST_PARTY_SCENES.length);
    });

    it('builds and exports a reel combining footage/caption motion with two scenes', async () => {
      const driver = openChromiumDriver();
      const title = FIRST_PARTY_SCENES[0]!;
      const lowerThird = FIRST_PARTY_SCENES[2]!;
      const instances = [title, lowerThird].map((scene) => {
        const instance = resolveFirstPartySceneInstance(scene.id)!;
        return {
          runtime: createSandboxedReactScene(
            { ...scene.manifest, viewport: { width: 16, height: 9 } },
            scene.source,
          ),
          variables: instance.variables,
        };
      });
      const frames: Uint8Array[] = [];
      for (const timeUs of [0, 50_000, 100_000]) {
        const base = renderHeadlessFrame(createParitySpikeFrame(timeUs));
        const surfaces = [];
        for (const { runtime, variables } of instances) {
          surfaces.push(
            await captureSceneSurfaceAsync(
              runtime,
              driver,
              { timeUs, frameRate: rational(30, 1), seed: 'p04-reel', variables, locale: 'en' },
              new SceneCaptureCache(),
            ),
          );
        }
        frames.push(composite(base.pixels, base.width, base.height, surfaces[0]!, surfaces[1]!));
      }
      const directory = mkdtempSync(join(tmpdir(), 'joy-p04-reel-'));
      const output = join(directory, 'p04-two-scenes.mp4');
      renderRgbaFrames(
        {
          projectId: 'p04-scene-reel',
          revision: 1,
          width: 32,
          height: 18,
          frameRate: 30,
          durationUs: 100_000,
          preset: 'social-h264-aac',
        },
        frames,
        output,
      );
      expect(existsSync(output)).toBe(true);
      expect(verifyExport(output)).toMatchObject({
        width: 32,
        height: 18,
        videoCodec: 'h264',
        audioCodec: 'aac',
      });
    }, 300_000);
  },
);

function composite(
  base: Uint8Array,
  width: number,
  height: number,
  left: { readonly width: number; readonly height: number; readonly rgba: Uint8Array },
  right: { readonly width: number; readonly height: number; readonly rgba: Uint8Array },
): Uint8Array {
  const output = new Uint8Array(base);
  for (const [surface, originX] of [
    [left, 0],
    [right, 16],
  ] as const) {
    for (let y = 0; y < surface.height && y < height; y++) {
      for (let x = 0; x < surface.width && originX + x < width; x++) {
        const source = (y * surface.width + x) * 4;
        const target = (y * width + originX + x) * 4;
        const alpha = surface.rgba[source + 3]! / 255;
        for (let channel = 0; channel < 3; channel++) {
          output[target + channel] = Math.round(
            surface.rgba[source + channel]! * alpha + output[target + channel]! * (1 - alpha),
          );
        }
        output[target + 3] = Math.round(alpha * 255 + output[target + 3]! * (1 - alpha));
      }
    }
  }
  return output;
}
