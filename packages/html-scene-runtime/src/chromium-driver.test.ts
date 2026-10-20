import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { rational } from '@joy-media/project-schema';
import { createChromiumSceneDriver, findChromiumExecutable } from './chromium-driver.js';
import { captureSceneSurface } from './headless.js';
import { createSandboxedReactScene } from './runtime.js';

class FakeWorker extends EventEmitter {
  readonly posted: Record<string, unknown>[] = [];
  constructor(private readonly onPost?: (message: Record<string, unknown>) => void) {
    super();
  }
  postMessage(message: unknown): void {
    const event = message as Record<string, unknown>;
    this.posted.push(event);
    this.onPost?.(event);
  }
  terminate(): Promise<number> {
    return Promise.resolve(0);
  }
  unref(): void {}
}

const unitRequest = {
  markup: '',
  width: 1,
  height: 1,
  transparent: true,
  timeUs: 0,
  frameRate: rational(30, 1),
  locale: 'en',
  seed: 'unit',
};

describe('Chromium scene driver ownership', () => {
  it('kills the known browser PID before terminating a timed-out worker', async () => {
    const order: string[] = [];
    let fake!: FakeWorker;
    const driver = createChromiumSceneDriver({
      executablePath: process.execPath,
      timeoutMs: 1,
      workerFactory: () => {
        fake = new FakeWorker((message) => {
          if (message.type === 'capture')
            Atomics.store(new Int32Array(message.shared as SharedArrayBuffer, 0, 4), 3, 31415);
        });
        fake.terminate = async () => {
          order.push('terminate');
          return 0;
        };
        return fake;
      },
      killTree: (pid) => {
        order.push(`kill:${pid}`);
      },
    });
    await expect(driver.captureAsync!(unitRequest)).rejects.toThrow('RENDER_CAPTURE_TIMEOUT');
    expect(order[0]).toBe('kill:31415');
    expect(order.indexOf('kill:31415')).toBeLessThan(order.indexOf('terminate'));
  }, 5_000);

  it('keeps the capture error first and retains the PID when cleanup fails', async () => {
    let fake!: FakeWorker;
    const driver = createChromiumSceneDriver({
      executablePath: process.execPath,
      workerFactory: () => {
        fake = new FakeWorker((message) => {
          if (message.type !== 'capture') return;
          const buffer = message.shared as SharedArrayBuffer;
          const control = new Int32Array(buffer, 0, 4);
          const bytes = new TextEncoder().encode('original capture failure');
          new Uint8Array(buffer, 16, bytes.length).set(bytes);
          Atomics.store(control, 2, bytes.length);
          Atomics.store(control, 3, 27182);
          Atomics.store(control, 0, 2);
          fake.emit('message', { type: 'complete', requestId: message.requestId });
        });
        return fake;
      },
      killTree: () => {
        throw new Error('survivors: 27182');
      },
    });
    await expect(driver.captureAsync!(unitRequest)).rejects.toThrow(
      'Chromium scene capture failed: original capture failure; browser cleanup failed: survivors: 27182',
    );
    expect(driver.browserProcessId).toBe(27182);
  });

  it('does not post a capture for a pre-aborted request', async () => {
    let fake!: FakeWorker;
    const driver = createChromiumSceneDriver({
      executablePath: process.execPath,
      workerFactory: () => (fake = new FakeWorker()),
    });
    const controller = new AbortController();
    controller.abort();
    await expect(driver.captureAsync!(unitRequest, controller.signal)).rejects.toThrow(
      'Render cancelled before title capture.',
    );
    expect(fake.posted).toEqual([]);
  });
});

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
