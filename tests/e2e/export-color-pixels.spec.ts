import { expect, test } from '@playwright/test';

test('offline and recorder MP4 exports keep stable real pixels on repeated exports', async ({
  page,
}) => {
  await page.goto('/');
  const rendererExportModule = `/@fs${new URL('../../packages/renderer-pixi/src/browser-export.ts', import.meta.url).pathname}`;
  const result = await page.evaluate(async (rendererModuleUrl) => {
    const { detectOfflineMp4Capability, exportOfflineMp4 } =
      await import('/src/offline-mp4-export.ts');
    const { downloadBrowserMp4 } = await import(rendererModuleUrl);
    const width = 160;
    const height = 90;
    const frameRate = 30;
    const frameCount = 30;
    const manifest = { width, height, frameRate, durationUs: 1_000_000 };
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (context === null) throw new Error('The browser has no sRGB canvas context.');
    const paint = () => {
      context.fillStyle = 'rgb(200 50 50)';
      context.fillRect(0, 0, width, height);
    };
    const capability = await detectOfflineMp4Capability({
      width,
      height,
      frameRate,
      needsAudio: false,
      bitrate: 2_000_000,
    });
    if (!capability.ok) throw new Error(`Offline MP4 export unavailable: ${capability.reason}`);

    async function readCenterPixel(blob: Blob) {
      const url = URL.createObjectURL(blob);
      const video = document.createElement('video');
      video.muted = true;
      video.src = url;
      try {
        await new Promise<void>((resolve, reject) => {
          video.addEventListener('loadeddata', () => resolve(), { once: true });
          video.addEventListener('error', () => reject(new Error('Exported MP4 did not decode.')), {
            once: true,
          });
        });
        video.currentTime = 0.25;
        await new Promise<void>((resolve, reject) => {
          video.addEventListener('seeked', () => resolve(), { once: true });
          video.addEventListener('error', () => reject(new Error('Exported MP4 seek failed.')), {
            once: true,
          });
        });
        const decoded = document.createElement('canvas');
        decoded.width = width;
        decoded.height = height;
        const decodedContext = decoded.getContext('2d', { colorSpace: 'srgb' });
        if (decodedContext === null) throw new Error('Cannot read decoded MP4 pixels.');
        decodedContext.drawImage(video, 0, 0, width, height);
        return Array.from(decodedContext.getImageData(width / 2, height / 2, 1, 1).data).slice(
          0,
          3,
        );
      } finally {
        video.pause();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
      }
    }

    const offline = [];
    for (let index = 0; index < 2; index += 1) {
      const output = await exportOfflineMp4(
        {
          manifest,
          frameCount,
          canvas,
          paintFrame: paint,
          capability,
        },
        { cancelGraceMs: 0 },
      );
      if (output.blob === undefined) throw new Error('Offline MP4 export returned no blob.');
      offline.push(await readCenterPixel(output.blob));
    }

    const recorder = [];
    for (let index = 0; index < 2; index += 1) {
      const output = await downloadBrowserMp4({
        manifest,
        frameCount,
        canvas,
        paintFrame: paint,
        autoDownload: false,
      });
      if (output.blob === undefined) throw new Error('Recorder export returned no blob.');
      recorder.push(await readCenterPixel(output.blob));
    }
    return { offline, recorder };
  }, rendererExportModule);

  for (const route of [result.offline, result.recorder]) {
    expect(route).toHaveLength(2);
    for (const pixel of route) {
      expect(Math.abs(pixel[0]! - 200)).toBeLessThanOrEqual(16);
      expect(Math.abs(pixel[1]! - 50)).toBeLessThanOrEqual(16);
      expect(Math.abs(pixel[2]! - 50)).toBeLessThanOrEqual(16);
    }
    expect(route[0]).toEqual(route[1]);
  }
});
