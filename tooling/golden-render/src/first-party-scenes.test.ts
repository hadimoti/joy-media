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
afterEach(async () => {
  for (const driver of openedDrivers.splice(0)) await driver.closeAsync!();
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
        const driver = openChromiumDriver();
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
        const preview = await captureSceneSurfaceAsync(
          runtime,
          driver,
          request,
          new SceneCaptureCache(),
        );
        const finalRender = await captureSceneSurfaceAsync(
          runtime,
          driver,
          request,
          new SceneCaptureCache(),
        );
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
      200_000,
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
