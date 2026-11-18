import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('offline and recorder MP4 exports keep stable real pixels on repeated exports', async ({
  page,
}) => {
  await page.goto('/src/offline-mp4-export.ts');
  await page.mouse.click(10, 10);
  // The Chromium build of a Linux CI runner has no H.264 encoder; the export itself refuses there.
  // Ask the same capability check the export uses, with the same settings as the run below.
  const canEncodeH264 = await page.evaluate(async () => {
    const { detectOfflineMp4Capability } = await import('/src/offline-mp4-export.ts');
    const capability = await detectOfflineMp4Capability({
      width: 160,
      height: 90,
      frameRate: 30,
      needsAudio: false,
      bitrate: 2_000_000,
    });
    return capability.ok;
  });
  test.skip(!canEncodeH264, 'This browser cannot encode H.264, so the MP4 pixel check cannot run.');
  const rendererExportModule = `/@fs/${join(process.cwd(), 'packages/renderer-pixi/src/browser-export.ts').split(String.fromCharCode(92)).join('/')}`;
  const mediabunnyModule = `/@fs/${join(process.cwd(), 'apps/editor-web/node_modules/mediabunny/dist/modules/src/index.js').split(String.fromCharCode(92)).join('/')}`;
  const codecDataModule = `/@fs/${join(process.cwd(), 'apps/editor-web/node_modules/mediabunny/dist/modules/src/codec-data.js').split(String.fromCharCode(92)).join('/')}`;
  const result = await page.evaluate(
    async ({ rendererModuleUrl, mediabunnyModuleUrl, codecDataModuleUrl }) => {
      const { detectOfflineMp4Capability, exportOfflineMp4 } =
        await import('/src/offline-mp4-export.ts');
      const { downloadBrowserMp4 } = await import(rendererModuleUrl);
      const { BlobSource, Input, Mp4InputFormat } = await import(mediabunnyModuleUrl);
      const { deserializeAvcDecoderConfigurationRecord, parseAvcSps } = await import(
        codecDataModuleUrl
      );
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

      async function inspect(blob: Blob) {
        const url = URL.createObjectURL(blob);
        const video = document.createElement('video');
        video.muted = true;
        video.src = url;
        try {
          await new Promise<void>((resolve, reject) => {
            video.addEventListener('loadeddata', () => resolve(), { once: true });
            video.addEventListener(
              'error',
              () =>
                reject(
                  new Error(
                    `Exported MP4 did not decode (code=${video.error?.code}, message=${video.error?.message}).`,
                  ),
                ),
              { once: true },
            );
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
          const pixel = Array.from(
            decodedContext.getImageData(width / 2, height / 2, 1, 1).data,
          ).slice(0, 3);
          const input = new Input({
            source: new BlobSource(blob),
            formats: [new Mp4InputFormat()],
          });
          try {
            const track = await input.getPrimaryVideoTrack();
            const decoderConfig = await track?.getDecoderConfig();
            const description = decoderConfig?.description;
            const sps =
              description === undefined
                ? undefined
                : deserializeAvcDecoderConfigurationRecord(description).sequenceParameterSets[0];
            const spsColor = sps === undefined ? undefined : parseAvcSps(sps);
            return {
              pixel,
              colorSpace: await track?.getColorSpace(),
              decoderColorSpace: decoderConfig?.colorSpace,
              spsColor: spsColor && {
                primaries: spsColor.colourPrimaries,
                transfer: spsColor.transferCharacteristics,
                matrix: spsColor.matrixCoefficients,
                fullRange: Boolean(spsColor.fullRangeFlag),
              },
            };
          } finally {
            input.dispose();
          }
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
        offline.push(await inspect(output.blob));
      }
      const recorder = [];
      for (let index = 0; index < 2; index += 1) {
        const recorderCanvas = document.createElement('canvas');
        recorderCanvas.width = width;
        recorderCanvas.height = height;
        const recorderContext = recorderCanvas.getContext('2d', { colorSpace: 'srgb' });
        if (recorderContext === null) throw new Error('Cannot create recorder source canvas.');
        const paintRecorder = () => {
          recorderContext.fillStyle = 'rgb(200 50 50)';
          recorderContext.fillRect(0, 0, width, height);
        };
        const audioContext = new AudioContext();
        const audioDestination = audioContext.createMediaStreamDestination();
        const audioOscillator = audioContext.createOscillator();
        audioOscillator.connect(audioDestination);
        audioOscillator.start();
        const audioTrack = audioDestination.stream.getAudioTracks()[0];
        if (audioTrack === undefined)
          throw new Error('The browser has no MediaStream audio track.');
        try {
          const output = await downloadBrowserMp4({
            manifest,
            frameCount,
            canvas: recorderCanvas,
            audioTrack,
            paintFrame: paintRecorder,
            autoDownload: false,
          });
          if (output.blob === undefined) throw new Error('Recorder export returned no blob.');
          recorder.push(await inspect(output.blob));
        } finally {
          audioTrack.stop();
          await audioContext.close();
        }
      }
      return { offline, recorder };
    },
    {
      rendererModuleUrl: rendererExportModule,
      mediabunnyModuleUrl: mediabunnyModule,
      codecDataModuleUrl: codecDataModule,
    },
  );

  console.log(`D130 decoded pixels: ${JSON.stringify(result)}`);
  for (const route of [result.offline, result.recorder]) {
    expect(route).toHaveLength(2);
    for (const exportResult of route) {
      expect(Math.abs(exportResult.pixel[0]! - 200)).toBeLessThanOrEqual(16);
      expect(Math.abs(exportResult.pixel[1]! - 50)).toBeLessThanOrEqual(16);
      expect(Math.abs(exportResult.pixel[2]! - 50)).toBeLessThanOrEqual(16);
      expect(exportResult.colorSpace).toMatchObject({
        primaries: 'bt709',
        transfer: 'bt709',
        matrix: 'bt709',
        fullRange: false,
      });
      expect(exportResult.decoderColorSpace).toMatchObject({
        primaries: 'bt709',
        transfer: 'bt709',
        matrix: 'bt709',
        fullRange: false,
      });
    }
    expect(route[0]?.pixel).toEqual(route[1]?.pixel);
  }
  expect(result.offline[0]?.pixel).toEqual(result.recorder[0]?.pixel);
  for (const exportResult of result.recorder) {
    expect(exportResult.spsColor).toEqual({
      primaries: 1,
      transfer: 1,
      matrix: 1,
      fullRange: false,
    });
  }
});
