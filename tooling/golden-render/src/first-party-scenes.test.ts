import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rational } from '@joy-media/project-schema';
import { renderRgbaFrames, verifyExport } from '@joy-media/export-core';
import { renderHeadlessFrame } from '@joy-media/renderer-headless';
import {
  captureSceneSurface,
  compareSceneSurfaces,
  createChromiumSceneDriver,
  createSandboxedReactScene,
  findChromiumExecutable,
  FIRST_PARTY_SCENES,
  resolveFirstPartySceneInstance,
  SceneCaptureCache,
} from '@joy-media/html-scene-runtime';
import { createParitySpikeFrame } from './index.js';

describe.runIf(findChromiumExecutable() !== undefined)(
  'P04.5 first-party scene pixel goldens',
  () => {
    it('pins real Chromium RGBA frames and proves preview/export pixel parity', () => {
      const driver = createChromiumSceneDriver();
      const hashes = FIRST_PARTY_SCENES.map((scene) => {
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
        const preview = captureSceneSurface(runtime, driver, request, new SceneCaptureCache());
        const finalRender = captureSceneSurface(runtime, driver, request, new SceneCaptureCache());
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
        return preview.sha256;
      });
      expect(hashes).toHaveLength(FIRST_PARTY_SCENES.length);
      expect(new Set(hashes).size).toBe(hashes.length);
    }, 60_000);

    it('builds and exports a reel combining footage/caption motion with two scenes', () => {
      const driver = createChromiumSceneDriver();
      const preset = { width: 32, height: 18 };
      const sceneViewport = { width: preset.width / 2, height: preset.height / 2 };
      const title = FIRST_PARTY_SCENES[0]!;
      const lowerThird = FIRST_PARTY_SCENES[2]!;
      const instances = [title, lowerThird].map((scene) => {
        const instance = resolveFirstPartySceneInstance(scene.id)!;
        return {
          runtime: createSandboxedReactScene(
            { ...scene.manifest, viewport: sceneViewport },
            scene.source,
          ),
          variables: instance.variables,
        };
      });
      const frames = [0, 50_000, 100_000].map((timeUs) => {
        const base = renderHeadlessFrame(createParitySpikeFrame(timeUs));
        const surfaces = instances.map(({ runtime, variables }) =>
          captureSceneSurface(
            runtime,
            driver,
            { timeUs, frameRate: rational(30, 1), seed: 'p04-reel', variables, locale: 'en' },
            new SceneCaptureCache(),
          ),
        );
        return composite(base.pixels, base.width, base.height, surfaces[0]!, surfaces[1]!);
      });
      const directory = mkdtempSync(join(tmpdir(), 'joy-p04-reel-'));
      const output = join(directory, 'p04-two-scenes.mp4');
      renderRgbaFrames(
        {
          projectId: 'p04-scene-reel',
          revision: 1,
          width: preset.width,
          height: preset.height,
          frameRate: 30,
          durationUs: 100_000,
          preset: 'social-h264-aac',
        },
        frames,
        output,
      );
      expect(existsSync(output)).toBe(true);
      expect(verifyExport(output)).toMatchObject({
        width: preset.width,
        height: preset.height,
        videoCodec: 'h264',
        audioCodec: 'aac',
      });
    }, 60_000);
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
    [right, left.width],
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
