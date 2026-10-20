import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rational } from '@joy-media/project-schema';
import {
  createChromiumSceneDriver,
  findChromiumExecutable,
  killChromiumTree,
} from './chromium-driver.js';
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
  it.skipIf(process.platform !== 'win32')(
    'skips the process scan when no owned process remains and the profile is removed immediately',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'chromium-cleanup-test-'));
      const profile = join(root, 'profile');
      mkdirSync(profile);
      const calls: string[] = [];
      try {
        killChromiumTree(
          undefined,
          profile,
          ((command: string) => {
            calls.push(command);
            return { status: 0, error: undefined, stderr: '', stdout: '' };
          }) as never,
          (directory) => rmSync(directory, { recursive: true, force: true }),
        );
        expect(calls).not.toContain('powershell.exe');
        expect(existsSync(profile)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'still refuses when an owned Chromium process survives and the process scan times out',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'chromium-cleanup-test-'));
      const profile = join(root, 'profile');
      mkdirSync(profile);
      const calls: string[] = [];
      try {
        expect(() =>
          killChromiumTree(
            process.pid,
            profile,
            ((command: string) => {
              calls.push(command);
              if (command === 'powershell.exe') {
                const error = Object.assign(new Error('scan timed out'), { code: 'ETIMEDOUT' });
                return { status: null, error, stderr: '', stdout: '' };
              }
              return { status: 0, error: undefined, stderr: '', stdout: '' };
            }) as never,
            () => {},
          ),
        ).toThrow('cannot verify Chromium processes');
        expect(calls).toContain('powershell.exe');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'scans the process list when first profile removal fails with EBUSY',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'chromium-cleanup-test-'));
      const profile = join(root, 'profile');
      mkdirSync(profile);
      const calls: string[] = [];
      let scans = 0;
      try {
        killChromiumTree(
          2_147_483_000,
          profile,
          ((command: string) => {
            calls.push(command);
            if (command === 'powershell.exe') scans += 1;
            return { status: 0, error: undefined, stderr: '', stdout: '' };
          }) as never,
          () => {
            const error = Object.assign(new Error('profile busy'), { code: 'EBUSY' });
            throw error;
          },
        );
        expect(scans).toBeGreaterThan(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'scans after taskkill to verify all profile processes stopped',
    () => {
      const calls: string[][] = [];
      killChromiumTree(
        27182,
        'C:\\profile',
        ((command: string, args: string[]) => {
          calls.push([command, ...args]);
          return {
            status: 0,
            error: undefined,
            stderr: '',
            stdout: command === 'powershell.exe' ? '' : '',
          };
        }) as never,
        () => {
          const error = Object.assign(new Error('profile busy'), { code: 'EBUSY' });
          throw error;
        },
      );
      expect(calls).toContainEqual(['taskkill', '/T', '/F', '/PID', '27182']);
      expect(calls.some(([command]) => command === 'powershell.exe')).toBe(true);
    },
  );

  it.skipIf(process.platform !== 'win32')('kills every survivor returned by a profile scan', () => {
    const killed: string[] = [];
    let scans = 0;
    killChromiumTree(
      27182,
      'C:\\profile',
      ((command: string, args: string[]) => {
        if (command === 'taskkill') killed.push(args[args.indexOf('/PID') + 1]!);
        if (command === 'powershell.exe') scans += 1;
        return {
          status: 0,
          error: undefined,
          stderr: '',
          stdout: command === 'powershell.exe' && scans === 1 ? '27182\n31415\n' : '',
        };
      }) as never,
      () => {
        const error = Object.assign(new Error('profile busy'), { code: 'EBUSY' });
        throw error;
      },
    );
    expect(killed).toEqual(['27182', '27182', '31415']);
  });

  it('retries profile removal after the browser tree exits', async () => {
    let fake!: FakeWorker;
    let profileDirectory = '';
    let removalAttempts = 0;
    const driver = createChromiumSceneDriver({
      executablePath: process.execPath,
      workerFactory: (_source, options) => {
        profileDirectory = String(
          (options.workerData as { readonly profileDirectory: string }).profileDirectory,
        );
        fake = new FakeWorker((message) => {
          if (message.type !== 'close') return;
          Atomics.store(new Int32Array(message.shared as SharedArrayBuffer, 0, 4), 0, 1);
          fake.emit('message', { type: 'complete', requestId: message.requestId });
        });
        return fake;
      },
      killTree: () => {},
      removeProfile: (directory) => {
        removalAttempts += 1;
        if (removalAttempts <= 2) {
          const error = new Error('profile busy') as NodeJS.ErrnoException;
          error.code = 'EBUSY';
          throw error;
        }
        rmSync(directory, { recursive: true, force: true });
      },
    });
    try {
      await driver.closeAsync!();
      expect(removalAttempts).toBeGreaterThanOrEqual(3);
      expect(existsSync(profileDirectory)).toBe(false);
    } finally {
      rmSync(profileDirectory, { recursive: true, force: true });
    }
  });

  it('terminates a timed-out worker before killing its newly published browser PID', async () => {
    const order: string[] = [];
    let fake!: FakeWorker;
    let control: Int32Array | undefined;
    const driver = createChromiumSceneDriver({
      executablePath: process.execPath,
      timeoutMs: 1,
      workerFactory: () => {
        fake = new FakeWorker((message) => {
          if (message.type === 'capture')
            control = new Int32Array(message.shared as SharedArrayBuffer, 0, 4);
        });
        fake.terminate = async () => {
          order.push('terminate');
          if (control) Atomics.store(control, 3, 31415);
          return 0;
        };
        return fake;
      },
      killTree: (pid) => {
        order.push(`kill:${pid}`);
      },
    });
    await expect(driver.captureAsync!(unitRequest)).rejects.toThrow('RENDER_CAPTURE_TIMEOUT');
    expect(order.indexOf('terminate')).toBeLessThan(order.indexOf('kill:31415'));
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

  it('kills a browser PID published after the timeout snapshot', async () => {
    let fake!: FakeWorker;
    const killed: number[] = [];
    const driver = createChromiumSceneDriver({
      executablePath: process.execPath,
      timeoutMs: 20,
      workerFactory: () => {
        fake = new FakeWorker((message) => {
          if (message.type !== 'capture') return;
          setTimeout(() => {
            Atomics.store(new Int32Array(message.shared as SharedArrayBuffer, 0, 4), 3, 38123);
          }, 25);
        });
        fake.terminate = () => new Promise((resolve) => setTimeout(() => resolve(0), 20));
        return fake;
      },
      killTree: (pid) => {
        if (pid !== undefined) killed.push(pid);
      },
    });
    await expect(driver.captureAsync!(unitRequest)).rejects.toThrow('RENDER_CAPTURE_TIMEOUT');
    expect(killed).toContain(38123);
  });

  it('kills the session PID on worker error before lastBrowserPid is populated', async () => {
    let fake!: FakeWorker;
    const killed: number[] = [];
    const driver = createChromiumSceneDriver({
      executablePath: process.execPath,
      timeoutMs: 100,
      workerFactory: () => {
        fake = new FakeWorker((message) => {
          if (message.type !== 'capture') return;
          const control = new Int32Array(message.shared as SharedArrayBuffer, 0, 4);
          Atomics.store(control, 3, 39123);
          Atomics.store(control, 2, 0);
          Atomics.store(control, 0, 2);
          fake.emit('message', { type: 'complete', requestId: message.requestId });
          fake.emit('error', new Error('worker startup failure'));
        });
        return fake;
      },
      killTree: (pid) => {
        if (pid !== undefined) killed.push(pid);
      },
    });
    await expect(driver.captureAsync!(unitRequest)).rejects.toThrow();
    expect(killed).toContain(39123);
  });

  it('retries failed browser cleanup when close is called later', async () => {
    let fake!: FakeWorker;
    const attempts: Array<number | undefined> = [];
    const driver = createChromiumSceneDriver({
      executablePath: process.execPath,
      workerFactory: () => {
        fake = new FakeWorker((message) => {
          if (message.type !== 'capture') return;
          const buffer = message.shared as SharedArrayBuffer;
          const control = new Int32Array(buffer, 0, 4);
          const bytes = new TextEncoder().encode('capture failed');
          new Uint8Array(buffer, 16, bytes.length).set(bytes);
          Atomics.store(control, 2, bytes.length);
          Atomics.store(control, 3, 40123);
          Atomics.store(control, 0, 2);
          fake.emit('message', { type: 'complete', requestId: message.requestId });
        });
        return fake;
      },
      killTree: (pid) => {
        attempts.push(pid);
        if (attempts.length === 1) throw new Error('temporary kill failure');
      },
    });
    await expect(driver.captureAsync!(unitRequest)).rejects.toThrow('temporary kill failure');
    await driver.closeAsync!();
    expect(attempts).toEqual([40123, 40123]);
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
