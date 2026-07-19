import { describe, expect, it } from 'vitest';
import { rational } from '@joy-media/project-schema';
import { createChromiumSceneDriver, findChromiumExecutable } from './chromium-driver.js';
import { captureSceneSurface } from './headless.js';
import { createSandboxedReactScene } from './runtime.js';

const chromiumAvailable = findChromiumExecutable() !== undefined;

describe.runIf(chromiumAvailable)('Chromium scene capture driver', () => {
  it('captures deterministic, alpha-aware RGBA pixels from the real browser', () => {
    const driver = createChromiumSceneDriver();
    const request = {
      markup: '<div style="width:100%;height:100%;background:rgb(3,4,5)"></div>',
      width: 6,
      height: 4,
      transparent: true,
      timeUs: 0,
      frameRate: rational(30, 1),
      locale: 'en',
      seed: 'fixed',
    };
    const first = driver.capture(request);
    const second = driver.capture(request);
    expect(first.rgba).toHaveLength(6 * 4 * 4);
    expect([...first.rgba.subarray(0, 4)]).toEqual([3, 4, 5, 255]);
    expect(first.rgba).toEqual(second.rgba);
  }, 30_000);

  it('applies scene variable edits in the headless browser render', () => {
    const scene = createSandboxedReactScene(
      {
        formatVersion: 1,
        id: 'browser-variable-scene',
        version: '1.0.0',
        runtime: 'joy-html-scene-1',
        viewport: { width: 4, height: 4 },
        transparent: true,
        durationUs: 1_000_000,
        permissions: { network: [], storage: 'none' },
        determinism: { seededRandom: true, wallClock: false },
      },
      `globalThis.__joyScene = (ctx) => React.createElement('div', {
        style: { width: '100%', height: '100%', background: ctx.variables.color }
      });`,
    );
    const driver = createChromiumSceneDriver();
    const request = {
      timeUs: 0,
      frameRate: rational(30, 1),
      seed: 'fixed',
      locale: 'en',
    };
    const amber = captureSceneSurface(scene, driver, {
      ...request,
      variables: { color: '#e9b949' },
    });
    const violet = captureSceneSurface(scene, driver, {
      ...request,
      variables: { color: '#5138ee' },
    });
    expect(amber.sha256).not.toBe(violet.sha256);
    expect([...amber.rgba.subarray(0, 3)]).toEqual([233, 185, 73]);
    expect([...violet.rgba.subarray(0, 3)]).toEqual([81, 56, 238]);
  }, 30_000);
});
