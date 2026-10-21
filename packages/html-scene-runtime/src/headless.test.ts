import { describe, expect, it } from 'vitest';
import { rational } from '@joy-media/project-schema';
import { createSandboxedReactScene } from './runtime.js';
import {
  captureSceneRegion,
  captureSceneSurface,
  captureSceneSurfaceAsync,
  compareSceneSurfaces,
  SceneCaptureCache,
} from './headless.js';
import { createSceneDiagnosticPlaceholder } from './placeholder.js';

const scene = createSandboxedReactScene(
  {
    formatVersion: 1,
    id: 'capture-test',
    version: '1.0.0',
    runtime: 'joy-html-scene-1',
    viewport: { width: 2, height: 2 },
    transparent: true,
    durationUs: 1_000_000,
    permissions: { network: [], storage: 'none' },
    determinism: { seededRandom: true, wallClock: false },
  },
  'globalThis.__joyScene = function () { return React.createElement("div", null, "JOY"); };',
);

describe('deterministic headless scene capture', () => {
  it('captures alpha-capable RGBA output once for an identical frame request', () => {
    let captures = 0;
    const driver = {
      capture: () => {
        captures++;
        return { rgba: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) };
      },
    };
    const cache = new SceneCaptureCache();
    const request = {
      timeUs: 0,
      frameRate: rational(30, 1),
      seed: 'fixed',
      variables: { title: 'JOY' },
      locale: 'en',
    };
    const first = captureSceneSurface(scene, driver, request, cache);
    const second = captureSceneSurface(scene, driver, request, cache);
    expect(captures).toBe(1);
    expect(first.hasAlpha).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    second.rgba[0] = 99;
    expect(first.rgba[0]).toBe(1); // cached values are defensive copies
  });

  it('keeps frames with different paint payloads apart in the cache', async () => {
    let captures = 0;
    const driver = {
      capture: () => {
        captures++;
        return { rgba: new Uint8Array(16).fill(captures) };
      },
      captureAsync: () => {
        captures++;
        return Promise.resolve({ rgba: new Uint8Array(16).fill(captures) });
      },
    };
    const cache = new SceneCaptureCache();
    const request = (background: string) => ({
      timeUs: 0,
      frameRate: rational(30, 1),
      seed: 'fixed',
      variables: {},
      locale: 'en',
      paint: { width: 2, height: 2, background, rects: [], lines: [], fonts: [] },
    });
    const red = captureSceneSurface(scene, driver, request('#ff0000'), cache);
    const blue = captureSceneSurface(scene, driver, request('#0000ff'), cache);
    expect(captures).toBe(2);
    expect(blue.rgba[0]).toBe(2);
    expect(captureSceneSurface(scene, driver, request('#ff0000'), cache).sha256).toBe(red.sha256);
    expect(captures).toBe(2);
    const green = await captureSceneSurfaceAsync(scene, driver, request('#00ff00'), cache);
    expect(captures).toBe(3);
    expect(green.rgba[0]).toBe(3);
    const greenAgain = await captureSceneSurfaceAsync(scene, driver, request('#00ff00'), cache);
    expect(captures).toBe(3);
    expect(greenAgain.sha256).toBe(green.sha256);
  });

  it('caches cropped regions and rejects out-of-bounds requests', () => {
    const driver = {
      capture: () => ({ rgba: new Uint8Array(Array.from({ length: 16 }, (_, i) => i)) }),
    };
    const cache = new SceneCaptureCache();
    const surface = captureSceneSurface(
      scene,
      driver,
      { timeUs: 0, frameRate: rational(30, 1), seed: 'fixed', variables: {}, locale: 'en' },
      cache,
    );
    const region = captureSceneRegion(surface, { x: 1, y: 0, width: 1, height: 2 }, cache);
    expect([...region.rgba]).toEqual([4, 5, 6, 7, 12, 13, 14, 15]);
    expect(captureSceneRegion(surface, { x: 1, y: 0, width: 1, height: 2 }, cache).sha256).toBe(
      region.sha256,
    );
    expect(() => captureSceneRegion(surface, { x: 2, y: 0, width: 1, height: 1 }, cache)).toThrow(
      'inside the captured surface',
    );
  });

  it('compares browser surfaces with an explicit pixel tolerance', () => {
    const base = {
      key: 'frame',
      timeUs: 0,
      width: 2,
      height: 1,
      hasAlpha: true,
      rgba: new Uint8Array([0, 1, 2, 3, 10, 11, 12, 13]),
      sha256: 'a',
    };
    const near = { ...base, rgba: new Uint8Array([0, 2, 2, 3, 10, 11, 15, 13]), sha256: 'b' };
    expect(compareSceneSurfaces(base, near)).toMatchObject({ matches: false, differingPixels: 2 });
    expect(
      compareSceneSurfaces(base, near, { maxChannelDelta: 3, maxDifferingPixels: 0 }),
    ).toMatchObject({
      matches: true,
      maxChannelDelta: 3,
    });
  });
});

describe('scene diagnostic placeholders', () => {
  it('keeps the project renderable when a scene cannot compile or load', () => {
    expect(
      createSceneDiagnosticPlaceholder([
        { code: 'SCENE_MISSING', message: 'Scene package is unavailable.', path: 'scene' },
      ]),
    ).toEqual({
      kind: 'scene-placeholder',
      title: 'Scene unavailable',
      message: 'Scene package is unavailable.',
      diagnostics: [
        { code: 'SCENE_MISSING', message: 'Scene package is unavailable.', path: 'scene' },
      ],
    });
  });
});
