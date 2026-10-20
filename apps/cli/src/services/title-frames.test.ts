import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startEncode } from '../commands/render-media.js';
import {
  buildTitleSceneFrame,
  compileTitleInstance,
  sampleTitleMotion,
} from '@joy-media/motion-core';
import {
  encodeRgbaPng,
  renderTitleFrames,
  titleFrameCount,
  titleFrameLocalTimes,
  titleFrameTimes,
  withCaptureDeadline,
} from './title-frames.js';

describe('title frame timing and PNG encoding', () => {
  it('refuses a changed recorded Chromium file before invoking its probe', async () => {
    const directory = join(tmpdir(), `joy-title-chromium-drift-${process.pid}`);
    const executablePath = join(directory, 'chrome.exe');
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    writeFileSync(executablePath, 'changed chromium');
    let probes = 0;
    vi.resetModules();
    vi.doMock('@joy-media/html-scene-runtime', () => ({
      findChromiumExecutable: () => executablePath,
      probeChromium: async () => {
        probes += 1;
        return { version: 'Chromium should not run' };
      },
      loadNotoSansArabicFaces: () => [{ sha256: 'font-hash' }],
      scenePaintFontDescriptors: () => [],
      createChromiumSceneDriver: () => {
        throw new Error('Chromium must not be launched');
      },
    }));
    const { renderTitleFrames } = await import('./title-frames.js');
    const { pinChromiumExecutableSha256ForTests } = await import('./render-preparation.js');
    const recordedHash = `sha256:${createHash('sha256').update('recorded chromium').digest('hex')}`;
    pinChromiumExecutableSha256ForTests(executablePath, recordedHash);
    try {
      await expect(
        renderTitleFrames(
          [
            {
              instanceId: 'drift',
              instance: {} as any,
              startUs: 0,
              durationUs: 33_334,
              trackOrder: 0,
            },
          ],
          { width: 320, height: 568, fps: { num: 30, den: 1 } },
          { chromiumExecutablePath: executablePath },
        ),
      ).rejects.toMatchObject({ code: 'RENDER_ENVIRONMENT_DRIFT' });
      expect(probes).toBe(0);
    } finally {
      pinChromiumExecutableSha256ForTests(executablePath, undefined);
      vi.doUnmock('@joy-media/html-scene-runtime');
      vi.resetModules();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports RENDER_CANCEL_TIMEOUT at the five-second cleanup deadline', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let cleanupStarted = false;
    try {
      const capture = withCaptureDeadline(
        (signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                cleanupStarted = true;
                setTimeout(() => reject(new Error('stalled cleanup')), 6_000);
              },
              { once: true },
            );
          }),
        15_000,
        controller.signal,
      );
      await Promise.resolve();
      controller.abort();
      expect(cleanupStarted).toBe(true);
      const assertion = expect(capture).rejects.toThrow('RENDER_CANCEL_TIMEOUT');
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('encodes RGBA pixels into a valid PNG with a round-trippable filter-0 IDAT', () => {
    const rgba = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 128]);
    const png = encodeRgbaPng(2, 1, rgba);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.toString('ascii', 12, 16)).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(1);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
    let offset = 8;
    let idat: Buffer | undefined;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const kind = png.toString('ascii', offset + 4, offset + 8);
      if (kind === 'IDAT') idat = png.subarray(offset + 8, offset + 8 + length);
      offset += length + 12;
    }
    expect(idat).toBeDefined();
    expect([...inflateSync(idat!).subarray(1)]).toEqual([...rgba]);
  });

  it('creates 45 frame samples for a 1.5 second clip at 30 fps', () => {
    const times = titleFrameTimes(1_500_000, { num: 30, den: 1 });
    expect(titleFrameCount(1_500_000, { num: 30, den: 1 })).toBe(45);
    expect(times).toHaveLength(45);
    expect(times[0]).toBe(0);
    expect(times[1]).toBe(33_333);
    expect(times[44]).toBe(1_466_667);
  });

  it('samples title time from the global rational frame grid at a fractional clip start', () => {
    const startUs = 350_000;
    const localTimes = titleFrameLocalTimes(startUs, 100_000, { num: 30, den: 1 });
    const desktopGlobalFrameUs = Number((11n * 1_000_000n + 15n) / 30n);

    expect(localTimes[0]).toBe(16_667);
    expect(localTimes[0]).toBe(desktopGlobalFrameUs - startUs);
    expect(localTimes).toHaveLength(titleFrameCount(100_000, { num: 30, den: 1 }));
  });

  it('samples a slide-up title at its first, middle and last frames', () => {
    const motion = { presetId: 'joy-slide-up' as const, inUs: 300_000, outUs: 300_000 };
    const times = titleFrameTimes(1_500_000, { num: 30, den: 1 });
    const first = sampleTitleMotion(motion, 1_500_000, times[0]!);
    const middle = sampleTitleMotion(motion, 1_500_000, times[22]!);
    const last = sampleTitleMotion(motion, 1_500_000, times[44]!);
    expect(first).toEqual({ opacity: 0, translateYPx: 80 });
    expect(middle).toEqual({ opacity: 1, translateYPx: 0 });
    expect(last.opacity).toBeGreaterThan(0);
    expect(last.opacity).toBeLessThan(1);
    expect(last.translateYPx).toBe(0);
  });

  it('renders a title frame from the shared title scene frame builder', async () => {
    const result = compileTitleInstance(
      {
        instanceId: 'shared-frame-test',
        templateId: 'joy.p0.title',
        clipId: 'clip-shared-frame-test',
        objectId: 'object-shared-frame-test',
        lines: { primary: 'Shared frame', secondary: '' },
        direction: 'ltr',
        font: { family: 'Noto Sans Arabic', weight: 400 },
        fontSha256: 'sha256:9a7c99eccfc3845950358733520688959bfa77ea14e6ef3b0a5efe3a8d52d28b',
        placement: { xPx: 10, yPx: 20, maxWidthPx: 300, safeInsetPx: 8 },
        motion: { presetId: 'hold', inUs: 0, outUs: 0 },
        clipDurationUs: 33_334,
        frame: { widthPx: 320, heightPx: 568 },
      },
      (text, size) => [...text].length * size * 0.55,
    );
    if (!result.ok) throw new Error(`P0 fixture compilation failed: ${result.code}`);
    const rendered = await renderTitleFrames(
      [
        {
          instanceId: 'shared-frame-test',
          instance: result.instance,
          startUs: 0,
          durationUs: 33_334,
          trackOrder: 0,
        },
      ],
      { width: 320, height: 568, fps: { num: 30, den: 1 } },
    );
    try {
      expect(rendered.layers).toHaveLength(1);
      const png = readFileSync(rendered.layers[0]!.inputPattern.replace('%05d', '00000'));
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    } finally {
      await rendered.cleanup();
    }
  }, 60_000);

  it('records the browser version reported by the capture driver', async () => {
    vi.resetModules();
    vi.doMock('@joy-media/html-scene-runtime', () => ({
      findChromiumExecutable: () => 'fake-chromium',
      loadNotoSansArabicFaces: () => [{ sha256: 'font-hash' }],
      scenePaintFontDescriptors: () => [
        {
          family: 'Noto Sans Arabic',
          weight: 400,
          subset: 'arabic',
          sha256: 'sha256:9a7c99eccfc3845950358733520688959bfa77ea14e6ef3b0a5efe3a8d52d28b',
          length: 48820,
        },
      ],
      createChromiumSceneDriver: () => ({
        get browserVersion() {
          return 'Chromium 123.4.5';
        },
        capture: () => ({ rgba: new Uint8Array(320 * 568 * 4) }),
      }),
    }));
    const fixture = compileTitleInstance(
      {
        instanceId: 'version-from-driver',
        templateId: 'joy.p0.title',
        clipId: 'clip-version-from-driver',
        objectId: 'object-version-from-driver',
        lines: { primary: 'Version', secondary: '' },
        direction: 'ltr',
        font: { family: 'Noto Sans Arabic', weight: 400 },
        fontSha256: 'sha256:9a7c99eccfc3845950358733520688959bfa77ea14e6ef3b0a5efe3a8d52d28b',
        placement: { xPx: 10, yPx: 20, maxWidthPx: 300, safeInsetPx: 8 },
        motion: { presetId: 'hold', inUs: 0, outUs: 0 },
        clipDurationUs: 33_334,
        frame: { widthPx: 320, heightPx: 568 },
      },
      (text, size) => [...text].length * size * 0.55,
    );
    if (!fixture.ok) throw new Error(`P0 fixture compilation failed: ${fixture.code}`);
    try {
      const rendered = await renderTitleFrames(
        [
          {
            instanceId: 'version-from-driver',
            instance: fixture.instance,
            startUs: 0,
            durationUs: 33_334,
            trackOrder: 0,
          },
        ],
        { width: 320, height: 568, fps: { num: 30, den: 1 } },
      );
      expect(rendered.rendererFacts.chromiumVersion).toBe('Chromium 123.4.5');
      await rendered.cleanup();
    } finally {
      vi.doUnmock('@joy-media/html-scene-runtime');
      vi.resetModules();
    }
  });

  it('closes the browser and removes capture files when cancellation arrives between frames', async () => {
    let closed = false;
    let captures = 0;
    vi.resetModules();
    vi.doMock('@joy-media/html-scene-runtime', () => ({
      findChromiumExecutable: () => 'fake-chromium',
      loadNotoSansArabicFaces: () => [{ sha256: 'font-hash' }],
      scenePaintFontDescriptors: () => [
        {
          family: 'Noto Sans Arabic',
          weight: 400,
          subset: 'arabic',
          sha256: 'sha256:9a7c99eccfc3845950358733520688959bfa77ea14e6ef3b0a5efe3a8d52d28b',
          length: 48820,
        },
      ],
      createChromiumSceneDriver: () => ({
        get browserVersion() {
          return 'Chromium fake';
        },
        capture: () => {
          captures += 1;
          return { rgba: new Uint8Array(320 * 568 * 4) };
        },
        close: () => {
          closed = true;
        },
      }),
    }));
    const fixture = compileTitleInstance(
      {
        instanceId: 'cancel-loop',
        templateId: 'joy.p0.title',
        clipId: 'clip-cancel-loop',
        objectId: 'object-cancel-loop',
        lines: { primary: 'Cancel', secondary: '' },
        direction: 'ltr',
        font: { family: 'Noto Sans Arabic', weight: 400 },
        fontSha256: 'sha256:9a7c99eccfc3845950358733520688959bfa77ea14e6ef3b0a5efe3a8d52d28b',
        placement: { xPx: 10, yPx: 20, maxWidthPx: 300, safeInsetPx: 8 },
        motion: { presetId: 'hold', inUs: 0, outUs: 0 },
        clipDurationUs: 100_000,
        frame: { widthPx: 320, heightPx: 568 },
      },
      (text, size) => [...text].length * size * 0.55,
    );
    if (!fixture.ok) throw new Error(`P0 fixture compilation failed: ${fixture.code}`);
    let checks = 0;
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith('title-cancel-loop-'));
    try {
      await expect(
        renderTitleFrames(
          [
            {
              instanceId: 'cancel-loop',
              instance: fixture.instance,
              startUs: 0,
              durationUs: 100_000,
              trackOrder: 0,
            },
          ],
          { width: 320, height: 568, fps: { num: 30, den: 1 } },
          { isCancelled: () => ++checks >= 3 },
        ),
      ).rejects.toThrow('Render cancelled during title capture');
      expect(captures).toBe(1);
      expect(closed).toBe(true);
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith('title-cancel-loop-'))).toEqual(
        before,
      );
    } finally {
      vi.doUnmock('@joy-media/html-scene-runtime');
      vi.resetModules();
    }
  });

  it('aborts an in-flight capture, closes the driver and removes its frame sequence', async () => {
    let closed = false;
    let captureStarted = false;
    vi.resetModules();
    vi.doMock('@joy-media/html-scene-runtime', () => ({
      findChromiumExecutable: () => 'fake-chromium',
      loadNotoSansArabicFaces: () => [{ sha256: 'font-hash' }],
      scenePaintFontDescriptors: () => [
        {
          family: 'Noto Sans Arabic',
          weight: 400,
          subset: 'arabic',
          sha256: 'sha256:9a7c99eccfc3845950358733520688959bfa77ea14e6ef3b0a5efe3a8d52d28b',
          length: 48820,
        },
      ],
      createChromiumSceneDriver: () => ({
        browserVersion: 'Chromium fake',
        capture: () => ({ rgba: new Uint8Array(320 * 568 * 4) }),
        captureAsync: (_request: unknown, signal?: AbortSignal) => {
          captureStarted = true;
          return new Promise((_resolve, reject) =>
            signal?.addEventListener(
              'abort',
              () => setTimeout(() => reject(new Error('aborted')), 25),
              { once: true },
            ),
          );
        },
        closeAsync: async () => {
          closed = true;
        },
      }),
    }));
    const fixture = compileTitleInstance(
      {
        instanceId: 'cancel-inflight',
        templateId: 'joy.p0.title',
        clipId: 'clip-cancel-inflight',
        objectId: 'object-cancel-inflight',
        lines: { primary: 'Cancel', secondary: '' },
        direction: 'ltr',
        font: { family: 'Noto Sans Arabic', weight: 400 },
        fontSha256: 'sha256:9a7c99eccfc3845950358733520688959bfa77ea14e6ef3b0a5efe3a8d52d28b',
        placement: { xPx: 10, yPx: 20, maxWidthPx: 300, safeInsetPx: 8 },
        motion: { presetId: 'hold', inUs: 0, outUs: 0 },
        clipDurationUs: 100_000,
        frame: { widthPx: 320, heightPx: 568 },
      },
      (text, size) => [...text].length * size * 0.55,
    );
    if (!fixture.ok) throw new Error(`P0 fixture compilation failed: ${fixture.code}`);
    const before = readdirSync(tmpdir()).filter((name) =>
      name.startsWith('title-cancel-inflight-'),
    );
    const controller = new AbortController();
    try {
      const rendering = renderTitleFrames(
        [
          {
            instanceId: 'cancel-inflight',
            instance: fixture.instance,
            startUs: 0,
            durationUs: 100_000,
            trackOrder: 0,
          },
        ],
        { width: 320, height: 568, fps: { num: 30, den: 1 } },
        { signal: controller.signal },
      );
      await vi.waitFor(() => expect(captureStarted).toBe(true));
      controller.abort();
      await expect(rendering).rejects.toThrow('Render cancelled during title capture');
      expect(closed).toBe(true);
      expect(
        readdirSync(tmpdir()).filter((name) => name.startsWith('title-cancel-inflight-')),
      ).toEqual(before);
    } finally {
      vi.doUnmock('@joy-media/html-scene-runtime');
      vi.resetModules();
    }
  });

  it('reports RENDER_CAPTURE_TIMEOUT when one capture exceeds its deadline', async () => {
    let closed = false;
    vi.resetModules();
    vi.doMock('@joy-media/html-scene-runtime', () => ({
      findChromiumExecutable: () => 'fake-chromium',
      loadNotoSansArabicFaces: () => [{ sha256: 'font-hash' }],
      scenePaintFontDescriptors: () => [
        {
          family: 'Noto Sans Arabic',
          weight: 400,
          subset: 'arabic',
          sha256: 'sha256:9a7c99eccfc3845950358733520688959bfa77ea14e6ef3b0a5efe3a8d52d28b',
          length: 48820,
        },
      ],
      createChromiumSceneDriver: () => ({
        browserVersion: 'Chromium fake',
        capture: () => ({ rgba: new Uint8Array(320 * 568 * 4) }),
        captureAsync: (_request: unknown, signal?: AbortSignal) =>
          new Promise((_resolve, reject) =>
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          ),
        closeAsync: async () => {
          closed = true;
        },
      }),
    }));
    const fixture = compileTitleInstance(
      {
        instanceId: 'capture-timeout',
        templateId: 'joy.p0.title',
        clipId: 'clip-capture-timeout',
        objectId: 'object-capture-timeout',
        lines: { primary: 'Timeout', secondary: '' },
        direction: 'ltr',
        font: { family: 'Noto Sans Arabic', weight: 400 },
        fontSha256: 'sha256:9a7c99eccfc3845950358733520688959bfa77ea14e6ef3b0a5efe3a8d52d28b',
        placement: { xPx: 10, yPx: 20, maxWidthPx: 300, safeInsetPx: 8 },
        motion: { presetId: 'hold', inUs: 0, outUs: 0 },
        clipDurationUs: 33_334,
        frame: { widthPx: 320, heightPx: 568 },
      },
      (text, size) => [...text].length * size * 0.55,
    );
    if (!fixture.ok) throw new Error(`P0 fixture compilation failed: ${fixture.code}`);
    try {
      await expect(
        renderTitleFrames(
          [
            {
              instanceId: 'capture-timeout',
              instance: fixture.instance,
              startUs: 0,
              durationUs: 33_334,
              trackOrder: 0,
            },
          ],
          { width: 320, height: 568, fps: { num: 30, den: 1 } },
          { captureTimeoutMs: 10 },
        ),
      ).rejects.toThrow('RENDER_CAPTURE_TIMEOUT');
      expect(closed).toBe(true);
    } finally {
      vi.doUnmock('@joy-media/html-scene-runtime');
      vi.resetModules();
    }
  });

  it('kills a stalled encoder process tree within two seconds', async () => {
    const previous = process.env.JOY_MEDIA_FFMPEG;
    process.env.JOY_MEDIA_FFMPEG = process.execPath;
    const encoder = startEncode(['-e', 'setInterval(() => {}, 1000)'], 1_000_000, () => {});
    const pid = encoder.pid;
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const started = performance.now();
      await encoder.cancel();
      const result = await encoder.done;
      expect(result).toMatchObject({ ok: false, code: 'cancelled' });
      expect(performance.now() - started).toBeLessThan(2_000);
      if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (previous === undefined) delete process.env.JOY_MEDIA_FFMPEG;
      else process.env.JOY_MEDIA_FFMPEG = previous;
    }
  });

  it('reports RENDER_CANCEL_TIMEOUT at the five-second deadline when an encoder cannot be reaped', async () => {
    vi.resetModules();
    const { EventEmitter } = await import('node:events');
    const fakeSpawn = vi.fn(() => {
      const child = new EventEmitter() as InstanceType<typeof EventEmitter> & {
        stdout: InstanceType<typeof EventEmitter>;
        stderr: InstanceType<typeof EventEmitter>;
        pid?: number;
        exitCode: number | null;
        kill: () => boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.kill = () => true;
      return child;
    });
    vi.doMock('node:child_process', async () => ({
      ...((await vi.importActual('node:child_process')) as Record<string, unknown>),
      spawn: fakeSpawn,
    }));
    try {
      const { startEncode: mockedStartEncode } = await import('../commands/render-media.js');
      const previous = process.env.JOY_MEDIA_FFMPEG;
      process.env.JOY_MEDIA_FFMPEG = 'fake-ffmpeg';
      const encoder = mockedStartEncode([], 1_000_000, () => {});
      const started = performance.now();
      // cancel() resolves once the cancellation has finished; the timeout is reported as the
      // encode settlement, which is where render-cmd reads it.
      await expect(encoder.cancel()).resolves.toBeUndefined();
      expect(await encoder.done).toMatchObject({ ok: false, code: 'RENDER_CANCEL_TIMEOUT' });
      const elapsedMs = performance.now() - started;
      expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
      expect(elapsedMs).toBeLessThan(7_000);
      if (previous === undefined) delete process.env.JOY_MEDIA_FFMPEG;
      else process.env.JOY_MEDIA_FFMPEG = previous;
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('sends the builder paint to the capture request', async () => {
    const fontFace = {
      family: 'Noto Sans Arabic',
      weight: 400,
      subset: 'arabic',
      sha256: 'sha256:9a7c99eccfc3845950358733520688959bfa77ea14e6ef3b0a5efe3a8d52d28b',
      length: 48820,
    } as const;
    const fixture = compileTitleInstance(
      {
        instanceId: 'paint-forwarding',
        templateId: 'joy.p0.title',
        clipId: 'clip-paint-forwarding',
        objectId: 'object-paint-forwarding',
        lines: { primary: 'Forward this paint', secondary: '' },
        direction: 'ltr',
        font: { family: 'Noto Sans Arabic', weight: 400 },
        fontSha256: fontFace.sha256,
        placement: { xPx: 10, yPx: 20, maxWidthPx: 300, safeInsetPx: 8 },
        motion: { presetId: 'hold', inUs: 0, outUs: 0 },
        clipDurationUs: 33_334,
        frame: { widthPx: 320, heightPx: 568 },
      },
      (text, size) => [...text].length * size * 0.55,
    );
    if (!fixture.ok) throw new Error(`P0 fixture compilation failed: ${fixture.code}`);
    const requests: { paint?: unknown }[] = [];
    vi.resetModules();
    vi.doMock('@joy-media/html-scene-runtime', () => ({
      findChromiumExecutable: () => 'fake-chromium',
      loadNotoSansArabicFaces: () => [{ sha256: fontFace.sha256 }],
      scenePaintFontDescriptors: () => [fontFace],
      createChromiumSceneDriver: () => ({
        get browserVersion() {
          return 'Chromium fake';
        },
        capture: (request: { paint?: unknown }) => {
          requests.push(request);
          return { rgba: new Uint8Array(320 * 568 * 4) };
        },
      }),
    }));
    try {
      const rendered = await renderTitleFrames(
        [
          {
            instanceId: 'paint-forwarding',
            instance: fixture.instance,
            startUs: 0,
            durationUs: 33_334,
            trackOrder: 0,
          },
        ],
        { width: 320, height: 568, fps: { num: 30, den: 1 } },
      );
      await rendered.cleanup();
      const expected = buildTitleSceneFrame(fixture.instance, 'paint-forwarding', 33_334, 0, {
        widthPx: 320,
        heightPx: 568,
        fontFaces: [fontFace],
        frameRate: { num: 30, den: 1 },
        locale: 'en-US',
        seed: 'paint-forwarding',
      });
      expect(requests[0]?.paint).toEqual(expected.paint);
    } finally {
      vi.doUnmock('@joy-media/html-scene-runtime');
      vi.resetModules();
    }
  });
});
