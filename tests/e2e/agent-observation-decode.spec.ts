import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE_ROOT = join(process.cwd(), 'packages/test-fixtures/live-director-generated');
const MANIFEST = JSON.parse(
  readFileSync(join(process.cwd(), 'tooling/fixtures/joy-director-fixture-manifest.json'), 'utf8'),
) as {
  readonly fixtures: readonly {
    readonly name: string;
    readonly sha256: string;
    readonly video?: { readonly actualPresentationPtsUs: readonly number[] };
  }[];
};

function fixture(name: string) {
  const value = MANIFEST.fixtures.find((entry) => entry.name === name);
  if (value === undefined) throw new Error(`missing Live Director fixture ${name}`);
  return value;
}

async function serveFixture(page: Page, name: string): Promise<string> {
  const url = `/__joy-director-fixture__/${name}`;
  await page.route(`**${url}`, async (route) => {
    await route.fulfill({
      contentType: name.endsWith('.webm') ? 'video/webm' : 'video/mp4',
      body: readFileSync(join(FIXTURE_ROOT, name)),
    });
  });
  return url;
}

async function openObservationHarness(page: Page): Promise<void> {
  await page.route('**/__joy-observation-harness', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>JOY observation harness</title>',
    });
  });
  await page.goto('/__joy-observation-harness');
}

async function decodeFixture(page: Page, name: string, startUs: number, endUs: number) {
  const item = fixture(name);
  const url = await serveFixture(page, name);
  return page.evaluate(
    async ({ assetDigest, sourceUrl, startUs: requestedStartUs, endUs: requestedEndUs }) => {
      const [{ createBrowserSourceObservationDecoder }, { ObservationResourceScheduler }] =
        await Promise.all([
          import('/src/media-observation/source-decoder.ts'),
          import('/src/media-observation/resource-scheduler.ts'),
        ]);
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error('fixture response was unavailable');
      const source = new Blob([await response.arrayBuffer()], { type: 'video/mp4' });
      const scheduler = new ObservationResourceScheduler({
        maxWorkingSetBytes: 128 * 1024 * 1024,
        maxInFlight: 1,
      });
      const decoder = createBrowserSourceObservationDecoder({
        assetDigest,
        streamId: 'video-0',
        source,
        scheduler,
        epoch: 1,
      });
      const frames: Array<{
        actualTimeUs: number;
        durationUs: number;
        presentationIndex: number;
        id: string;
        width: number;
        height: number;
      }> = [];
      try {
        for await (const frame of decoder.frames(
          { startUs: requestedStartUs, endUs: requestedEndUs },
          new AbortController().signal,
        )) {
          frames.push({
            actualTimeUs: frame.actualTimeUs,
            durationUs: frame.durationUs,
            presentationIndex: frame.presentationIndex,
            id: frame.id,
            width: frame.width,
            height: frame.height,
          });
        }
        return { frames, scheduler: scheduler.snapshot() };
      } finally {
        decoder.close();
      }
    },
    { assetDigest: item.sha256, sourceUrl: url, startUs, endUs },
  );
}

async function decodeFixtureInWorker(page: Page, name: string, startUs: number, endUs: number) {
  const item = fixture(name);
  const url = await serveFixture(page, name);
  return page.evaluate(
    async ({ assetDigest, sourceUrl, startUs: requestedStartUs, endUs: requestedEndUs }) => {
      const { ObservationWorkerClient } =
        await import('/src/media-observation/observation-worker-client.ts');
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error('fixture response was unavailable');
      const client = new ObservationWorkerClient();
      const frames: Array<{
        actualTimeUs: number;
        durationUs: number;
        presentationIndex: number;
        id: string;
        width: number;
        height: number;
        thumbnail: {
          width: number;
          height: number;
          byteLength: number;
          type: string;
          magic: number[];
        };
      }> = [];
      try {
        for await (const frame of client.frames(
          {
            assetDigest,
            streamId: 'video-0',
            source: new Blob([await response.arrayBuffer()], { type: 'video/mp4' }),
            epoch: 1,
            range: { startUs: requestedStartUs, endUs: requestedEndUs },
          },
          new AbortController().signal,
        )) {
          const bytes = new Uint8Array(await frame.thumbnail.blob.arrayBuffer());
          frames.push({
            actualTimeUs: frame.actualTimeUs,
            durationUs: frame.durationUs,
            presentationIndex: frame.presentationIndex,
            id: frame.id,
            width: frame.width,
            height: frame.height,
            thumbnail: {
              width: frame.thumbnail.width,
              height: frame.thumbnail.height,
              byteLength: frame.thumbnail.byteLength,
              type: frame.thumbnail.blob.type,
              magic: [...bytes.slice(0, 2)],
            },
          });
        }
        return frames;
      } finally {
        await client.close();
      }
    },
    { assetDigest: item.sha256, sourceUrl: url, startUs, endUs },
  );
}

test.describe('JOY Live Director source observation decode', () => {
  test('uses real browser decoder PTS and presentation order for CFR and VFR fixtures', async ({
    page,
  }) => {
    await openObservationHarness(page);
    const cfr = fixture('cfr-numbered.mp4');
    const cfrResult = await decodeFixture(page, cfr.name, 0, 2_000_000);
    expect(cfrResult.frames.map((frame) => frame.actualTimeUs)).toEqual(
      cfr.video?.actualPresentationPtsUs,
    );
    expect(cfrResult.frames.map((frame) => frame.presentationIndex)).toEqual([
      ...Array(cfrResult.frames.length).keys(),
    ]);
    expect(cfrResult.frames.every((frame) => frame.id.startsWith('source-frame:v1:'))).toBe(true);
    expect(cfrResult.scheduler).toEqual({
      activeCount: 0,
      activePlaybackCount: 0,
      playbackPriorityActive: false,
      workingSetBytes: 0,
    });

    const vfr = fixture('vfr-numbered.mp4');
    const vfrResult = await decodeFixture(page, vfr.name, 0, 1_600_000);
    expect(vfrResult.frames.map((frame) => frame.actualTimeUs)).toEqual(
      vfr.video?.actualPresentationPtsUs,
    );
    expect(vfrResult.frames.map((frame) => frame.durationUs)).not.toEqual(
      Array(vfrResult.frames.length).fill(vfrResult.frames[0]?.durationUs),
    );
  });

  test('preserves nonzero presentation origin and returns the frame spanning a focused flash', async ({
    page,
  }) => {
    await openObservationHarness(page);
    const nonzero = fixture('nonzero-pts-origin.mp4');
    const nonzeroResult = await decodeFixture(page, nonzero.name, 0, 4_000_000);
    expect(nonzeroResult.frames[0]?.actualTimeUs).toBe(nonzero.video?.actualPresentationPtsUs[0]);

    const flash = fixture('single-frame-flash.mp4');
    const flashResult = await decodeFixture(page, flash.name, 500_000, 533_334);
    // The real decoder reports the next frame at 533333 µs. Its interval
    // overlaps the requested half-open event end by one µs, so both temporal
    // identities are retained instead of rounding it away.
    expect(flashResult.frames.map((frame) => frame.actualTimeUs)).toEqual([500_000, 533_333]);
  });

  test('keeps B-frame presentation order and applies decoded rotation/SAR display dimensions', async ({
    page,
  }) => {
    await openObservationHarness(page);
    const reordered = fixture('b-frame-reorder.mp4');
    const reorderedResult = await decodeFixture(page, reordered.name, 0, 2_000_000);
    expect(reorderedResult.frames.map((frame) => frame.actualTimeUs)).toEqual(
      reordered.video?.actualPresentationPtsUs,
    );
    expect(reorderedResult.frames.map((frame) => frame.presentationIndex)).toEqual([
      ...Array(reorderedResult.frames.length).keys(),
    ]);

    const portrait = fixture('portrait-rotation-sar.mp4');
    const portraitResult = await decodeFixture(page, portrait.name, 0, 1_000_000);
    const first = portraitResult.frames[0];
    expect(first).toBeDefined();
    // The encoded raster is 120×200 with a 4:3 SAR and 90° rotation. The
    // decoder's display dimensions must be non-raster presentation geometry.
    expect(first?.width).toBeGreaterThan(0);
    expect(first?.height).toBeGreaterThan(0);
    expect([first?.width, first?.height]).not.toEqual([120, 200]);
  });

  test('cancels an active scan and releases its worker-set lease', async ({ page }) => {
    await openObservationHarness(page);
    const item = fixture('cfr-numbered.mp4');
    const url = await serveFixture(page, item.name);
    const result = await page.evaluate(
      async ({ assetDigest, sourceUrl }) => {
        const [
          { createBrowserSourceObservationDecoder, SourceObservationDecodeError },
          { ObservationResourceScheduler },
        ] = await Promise.all([
          import('/src/media-observation/source-decoder.ts'),
          import('/src/media-observation/resource-scheduler.ts'),
        ]);
        const response = await fetch(sourceUrl);
        const scheduler = new ObservationResourceScheduler({
          maxWorkingSetBytes: 128 * 1024 * 1024,
          maxInFlight: 1,
        });
        const decoder = createBrowserSourceObservationDecoder({
          assetDigest,
          streamId: 'video-0',
          source: new Blob([await response.arrayBuffer()], { type: 'video/mp4' }),
          scheduler,
          epoch: 2,
        });
        const controller = new AbortController();
        const iterable = decoder.frames({ startUs: 0, endUs: 2_000_000 }, controller.signal);
        const iterator = iterable[Symbol.asyncIterator]();
        try {
          const first = await iterator.next();
          if (first.done) throw new Error('fixture unexpectedly had no first frame');
          controller.abort();
          try {
            await iterator.next();
            return { code: 'unexpected-success', scheduler: scheduler.snapshot() };
          } catch (error) {
            return {
              code: error instanceof SourceObservationDecodeError ? error.code : 'unexpected-error',
              scheduler: scheduler.snapshot(),
            };
          }
        } finally {
          decoder.close();
        }
      },
      { assetDigest: item.sha256, sourceUrl: url },
    );
    expect(result).toEqual({
      code: 'cancelled',
      scheduler: {
        activeCount: 0,
        activePlaybackCount: 0,
        playbackPriorityActive: false,
        workingSetBytes: 0,
      },
    });
  });

  test('fails with backpressure before retaining an oversized decoded frame', async ({ page }) => {
    await openObservationHarness(page);
    const item = fixture('cfr-numbered.mp4');
    const url = await serveFixture(page, item.name);
    const result = await page.evaluate(
      async ({ assetDigest, sourceUrl }) => {
        const [
          { createBrowserSourceObservationDecoder, SourceObservationDecodeError },
          { ObservationResourceScheduler },
        ] = await Promise.all([
          import('/src/media-observation/source-decoder.ts'),
          import('/src/media-observation/resource-scheduler.ts'),
        ]);
        const response = await fetch(sourceUrl);
        const scheduler = new ObservationResourceScheduler({
          maxWorkingSetBytes: 1,
          maxInFlight: 1,
        });
        const decoder = createBrowserSourceObservationDecoder({
          assetDigest,
          streamId: 'video-0',
          source: new Blob([await response.arrayBuffer()], { type: 'video/mp4' }),
          scheduler,
          epoch: 3,
        });
        try {
          for await (const _frame of decoder.frames(
            { startUs: 0, endUs: 2_000_000 },
            new AbortController().signal,
          )) {
            throw new Error('backpressure unexpectedly produced a frame');
          }
          return { code: 'unexpected-success', scheduler: scheduler.snapshot() };
        } catch (error) {
          return {
            code:
              error instanceof SourceObservationDecodeError
                ? error.code
                : (error as { code?: unknown }).code,
            scheduler: scheduler.snapshot(),
          };
        } finally {
          decoder.close();
        }
      },
      { assetDigest: item.sha256, sourceUrl: url },
    );
    expect(result).toEqual({
      code: 'backpressure',
      scheduler: {
        activeCount: 0,
        activePlaybackCount: 0,
        playbackPriorityActive: false,
        workingSetBytes: 0,
      },
    });
  });

  test('reports corrupt source bytes as a structured browser decode failure', async ({ page }) => {
    await openObservationHarness(page);
    const corrupt = fixture('corrupt-truncated.mp4');
    const url = await serveFixture(page, corrupt.name);
    const result = await page.evaluate(
      async ({ assetDigest, sourceUrl }) => {
        const [
          { createBrowserSourceObservationDecoder, SourceObservationDecodeError },
          { ObservationResourceScheduler },
        ] = await Promise.all([
          import('/src/media-observation/source-decoder.ts'),
          import('/src/media-observation/resource-scheduler.ts'),
        ]);
        const response = await fetch(sourceUrl);
        const decoder = createBrowserSourceObservationDecoder({
          assetDigest,
          streamId: 'video-0',
          source: new Blob([await response.arrayBuffer()], { type: 'video/mp4' }),
          scheduler: new ObservationResourceScheduler({
            maxWorkingSetBytes: 1_000_000,
            maxInFlight: 1,
          }),
          epoch: 1,
        });
        try {
          for await (const _frame of decoder.frames(
            { startUs: 0, endUs: 1_000_000 },
            new AbortController().signal,
          )) {
            throw new Error('corrupt source unexpectedly produced a frame');
          }
          return 'unexpected-success';
        } catch (error) {
          return error instanceof SourceObservationDecodeError ? error.code : 'unexpected-error';
        } finally {
          decoder.close();
        }
      },
      { assetDigest: corrupt.sha256, sourceUrl: url },
    );
    expect(result).toBe('decode-failed');
  });

  test('decodes and bounds actual visual artifacts in the dedicated browser worker', async ({
    page,
  }) => {
    await openObservationHarness(page);
    const cfr = fixture('cfr-numbered.mp4');
    const frames = await decodeFixtureInWorker(page, cfr.name, 0, 2_000_000);
    expect(frames.map((frame) => frame.actualTimeUs)).toEqual(cfr.video?.actualPresentationPtsUs);
    expect(frames.every((frame) => frame.id.startsWith('source-frame:v1:'))).toBe(true);
    expect(
      frames.every(
        (frame) =>
          frame.thumbnail.byteLength > 0 &&
          frame.thumbnail.width <= 512 &&
          frame.thumbnail.height <= 512 &&
          frame.thumbnail.type === 'image/jpeg' &&
          frame.thumbnail.magic[0] === 0xff &&
          frame.thumbnail.magic[1] === 0xd8,
      ),
    ).toBe(true);
  });
});
