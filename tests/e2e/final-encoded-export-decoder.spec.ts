import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE_ROOT = join(process.cwd(), 'packages/test-fixtures/live-director-generated');
const MANIFEST = JSON.parse(
  readFileSync(join(process.cwd(), 'tooling/fixtures/joy-director-fixture-manifest.json'), 'utf8'),
) as {
  readonly fixtures: readonly {
    readonly name: string;
    readonly video?: { readonly actualPresentationPtsUs: readonly number[] };
  }[];
};

test('decodes final encoded fixture bytes with WebCodecs, not the live Monitor/canvas', async ({
  page,
}) => {
  const fixture = MANIFEST.fixtures.find((entry) => entry.name === 'cfr-numbered.mp4');
  if (fixture?.video === undefined) throw new Error('missing CFR encoded export fixture');
  const fixtureUrl = '/__joy-final-encoded-export-fixture__/cfr-numbered.mp4';
  await page.route(`**${fixtureUrl}`, async (route) => {
    await route.fulfill({
      contentType: 'video/mp4',
      body: readFileSync(join(FIXTURE_ROOT, fixture.name)),
    });
  });
  await page.goto('/');

  const result = await page.evaluate(
    async ({ sourceUrl }) => {
      const { createBrowserFinalEncodedExportDecoder } =
        await import('/src/media-observation/final-encoded-export-decoder.ts');
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error('fixture response was unavailable');
      const decoder = createBrowserFinalEncodedExportDecoder();
      const decoded = await decoder.decode({
        artifact: {
          artifactId: 'browser-final-export-fixture-1',
          encoded: new Blob([await response.arrayBuffer()], { type: 'video/mp4' }),
        },
        requestedPixelPtsUs: [1_000_000],
        requestedAudioWindows: [],
        limits: {
          maxArtifactBytes: 1_000_000,
          maxPresentationPts: 64,
          maxDecodedFrames: 1,
          maxFramePixels: 1_000_000,
          maxDecodedPixelBytes: 4_000_000,
          maxAudioSampleValues: 1_000,
        },
        signal: new AbortController().signal,
      });
      if (decoded.status !== 'decoded') return decoded;
      const video = decoded.decoded.videoStreams[0];
      if (video === undefined) throw new Error('decoded export had no video stream');
      return {
        status: decoded.status,
        container: decoded.decoded.container,
        durationUs: decoded.decoded.durationUs,
        codec: video.codec,
        presentationPtsUs: video.presentationPtsUs,
        frames: video.frames.map((frame) => ({
          ptsUs: frame.ptsUs,
          width: frame.width,
          height: frame.height,
          byteLength: frame.rgba.byteLength,
        })),
      };
    },
    { sourceUrl: fixtureUrl },
  );

  expect(result).toEqual({
    status: 'decoded',
    container: 'mp4',
    durationUs: 2_000_000,
    codec: 'avc',
    presentationPtsUs: fixture.video.actualPresentationPtsUs,
    frames: [
      {
        ptsUs: 1_000_000,
        width: 160,
        height: 90,
        byteLength: 160 * 90 * 4,
      },
    ],
  });
});

test('reads only the requested final-export audio window through WebCodecs', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(async () => {
    const { createBrowserFinalEncodedExportDecoder } =
      await import('/src/media-observation/final-encoded-export-decoder.ts');
    const response = await fetch('/media/reference/asset-intro.mp4');
    if (!response.ok) throw new Error('reference export fixture was unavailable');
    const decoded = await createBrowserFinalEncodedExportDecoder().decode({
      artifact: {
        artifactId: 'browser-final-export-audio-fixture-1',
        encoded: new Blob([await response.arrayBuffer()], { type: 'video/mp4' }),
      },
      requestedPixelPtsUs: [],
      requestedAudioWindows: [{ startUs: 0, endUs: 250_000 }],
      limits: {
        maxArtifactBytes: 2_000_000,
        maxPresentationPts: 2_000,
        maxDecodedFrames: 64,
        maxFramePixels: 1_000_000,
        maxDecodedPixelBytes: 4_000_000,
        maxAudioSampleValues: 200_000,
      },
      signal: new AbortController().signal,
    });
    if (decoded.status !== 'decoded') return decoded;
    const audio = decoded.decoded.audioStreams[0];
    if (audio === undefined) throw new Error('decoded export had no audio stream');
    return {
      status: decoded.status,
      codec: audio.codec,
      sampleRate: audio.sampleRate,
      channelCount: audio.channelCount,
      windows: audio.windows.map((window) => ({
        startUs: window.startUs,
        channelLengths: window.channels.map((channel) => channel.length),
      })),
    };
  });

  expect(result).toMatchObject({
    status: 'decoded',
    codec: 'aac',
    sampleRate: 48_000,
    channelCount: 1,
  });
  if (result.status !== 'decoded') throw new Error(`audio decode did not complete: ${result.code}`);
  expect(result.windows).toHaveLength(1);
  expect(result.windows[0]?.startUs).toBe(0);
  expect(result.windows[0]?.channelLengths[0]).toBeGreaterThan(0);
  // Encoded AAC packet PTS values are represented in integer microseconds.
  // The requested quarter-second range is 12,000 samples at 48 kHz; allow one
  // sample of boundary coverage so that a rounded packet timestamp cannot make
  // the decoder discard audio that overlaps the requested interval.
  expect(result.windows[0]?.channelLengths[0]).toBeLessThanOrEqual(12_001);
});

test('cannot certify a final MP4 after its encoded media payload is zeroed', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(async () => {
    const [{ createFinalEncodedExportVerifier }, { createBrowserFinalEncodedExportDecoder }] =
      await Promise.all([
        import('/src/media-observation/render-verification.ts'),
        import('/src/media-observation/final-encoded-export-decoder.ts'),
      ]);
    const response = await fetch('/media/reference/asset-intro.mp4');
    if (!response.ok) throw new Error('reference export fixture was unavailable');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const decoder = createBrowserFinalEncodedExportDecoder();
    const limits = {
      maxArtifactBytes: 2_000_000,
      maxPresentationPts: 2_000,
      maxDecodedFrames: 64,
      maxFramePixels: 1_000_000,
      maxDecodedPixelBytes: 4_000_000,
      maxAudioSampleValues: 200_000,
    };
    const clean = await decoder.decode({
      artifact: {
        artifactId: 'clean-final-export-fixture',
        encoded: new Blob([bytes], { type: 'video/mp4' }),
      },
      requestedPixelPtsUs: [0],
      requestedAudioWindows: [{ startUs: 0, endUs: 100_000 }],
      limits,
      signal: new AbortController().signal,
    });
    if (clean.status !== 'decoded') throw new Error(`clean fixture did not decode: ${clean.code}`);
    const video = clean.decoded.videoStreams[0];
    const audio = clean.decoded.audioStreams[0];
    if (video === undefined || audio === undefined)
      throw new Error('clean fixture did not contain final audio/video streams');

    // MP4 boxes are length/type pairs. Alter only `mdat` payload bytes, keeping
    // headers/metadata intact; a metadata-only verifier could accept this.
    const corrupt = Uint8Array.from(bytes);
    const text = new TextDecoder();
    let offset = 0;
    let zeroed = false;
    while (offset + 8 <= corrupt.byteLength) {
      const view = new DataView(corrupt.buffer, corrupt.byteOffset + offset);
      const declaredSize = view.getUint32(0, false);
      const type = text.decode(corrupt.slice(offset + 4, offset + 8));
      const headerBytes = declaredSize === 1 ? 16 : 8;
      const size =
        declaredSize === 0
          ? corrupt.byteLength - offset
          : declaredSize === 1
            ? Number(view.getBigUint64(8, false))
            : declaredSize;
      if (!Number.isSafeInteger(size) || size < headerBytes || offset + size > corrupt.byteLength)
        throw new Error('fixture MP4 box layout was invalid');
      if (type === 'mdat') {
        corrupt.fill(0, offset + headerBytes, offset + size);
        zeroed = true;
        break;
      }
      offset += size;
    }
    if (!zeroed) throw new Error('fixture MP4 contained no media-data box');

    return createFinalEncodedExportVerifier({ decoder }).verify({
      artifact: {
        artifactId: 'zeroed-final-export-fixture',
        encoded: new Blob([corrupt], { type: 'video/mp4' }),
      },
      expected: {
        container: clean.decoded.container,
        width: video.width,
        height: video.height,
        durationUs: clean.decoded.durationUs,
        expectedVideoPtsUs: video.presentationPtsUs,
        videoCodec: video.codec,
        audioCodec: audio.codec,
        videoStreamCount: clean.decoded.videoStreams.length,
        audioStreamCount: clean.decoded.audioStreams.length,
        visualPredicates: [],
        audioSyncPredicates: [],
      },
    });
  });

  expect(result.status).not.toBe('verified');
});

test('enforces aggregate browser RGBA and PCM allocation budgets before later decode copies', async ({
  page,
}) => {
  const fixture = MANIFEST.fixtures.find((entry) => entry.name === 'cfr-numbered.mp4');
  if (fixture?.video === undefined) throw new Error('missing CFR encoded export fixture');
  const fixtureUrl = '/__joy-final-encoded-export-budget-fixture__/cfr-numbered.mp4';
  await page.route(`**${fixtureUrl}`, async (route) => {
    await route.fulfill({
      contentType: 'video/mp4',
      body: readFileSync(join(FIXTURE_ROOT, fixture.name)),
    });
  });
  await page.goto('/');

  const result = await page.evaluate(
    async ({ sourceUrl }) => {
      const { createBrowserFinalEncodedExportDecoder } =
        await import('/src/media-observation/final-encoded-export-decoder.ts');
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error('fixture response was unavailable');
      const videoAggregate = await createBrowserFinalEncodedExportDecoder().decode({
        artifact: {
          artifactId: 'aggregate-rgba-fixture',
          encoded: new Blob([await response.arrayBuffer()], { type: 'video/mp4' }),
        },
        requestedPixelPtsUs: [0, 1_000_000],
        requestedAudioWindows: [],
        limits: {
          maxArtifactBytes: 1_000_000,
          maxPresentationPts: 64,
          maxDecodedFrames: 2,
          maxFramePixels: 1_000_000,
          // Each 160×90 RGBA frame is 57,600 bytes; two must not allocate
          // under a 60,000-byte aggregate cap.
          maxDecodedPixelBytes: 60_000,
          maxAudioSampleValues: 1_000,
        },
        signal: new AbortController().signal,
      });

      const audioResponse = await fetch('/media/reference/asset-intro.mp4');
      if (!audioResponse.ok) throw new Error('reference export fixture was unavailable');
      const audioAggregate = await createBrowserFinalEncodedExportDecoder().decode({
        artifact: {
          artifactId: 'aggregate-pcm-fixture',
          encoded: new Blob([await audioResponse.arrayBuffer()], { type: 'video/mp4' }),
        },
        requestedPixelPtsUs: [],
        requestedAudioWindows: [{ startUs: 0, endUs: 100_000 }],
        limits: {
          maxArtifactBytes: 2_000_000,
          maxPresentationPts: 2_000,
          maxDecodedFrames: 64,
          maxFramePixels: 1_000_000,
          maxDecodedPixelBytes: 4_000_000,
          // The 100ms PCM chunk fits individually, but its retained compacted
          // copy would exceed this aggregate ceiling.
          maxAudioSampleValues: 6_000,
        },
        signal: new AbortController().signal,
      });
      return { videoAggregate, audioAggregate };
    },
    { sourceUrl: fixtureUrl },
  );

  expect(result.videoAggregate).toEqual({ status: 'blocked', code: 'decoder-policy' });
  expect(result.audioAggregate).toEqual({ status: 'blocked', code: 'decoder-policy' });
});
