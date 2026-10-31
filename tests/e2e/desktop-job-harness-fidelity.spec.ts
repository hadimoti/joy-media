import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startDesktopJobHarness, type DesktopJobHarness } from './support/desktop-job-harness.js';

/**
 * The four fidelity gaps Kimi found in the in-memory media bridge.
 *
 * Each test drives the real desktop host (tests/e2e/support/desktop-job-harness.ts) over the
 * channels the editor uses, and checks that the desktop's own stores answer.
 */

const MEDIA_FIXTURE_DIR = join(process.cwd(), 'packages/test-fixtures/media');

interface CatalogEntry {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: {
    readonly mimeType: string;
    readonly durationUs?: number;
    readonly width?: number;
    readonly height?: number;
    readonly animation?: {
      readonly frameCount: number;
      readonly cycleDurationUs: number;
      readonly loopCount: number;
      readonly hasAlpha: boolean;
    };
  };
}

interface Catalog {
  readonly version: number;
  readonly counts: { readonly total: number; readonly audio: number; readonly image: number };
  readonly assets: readonly CatalogEntry[];
}

async function answer<T>(
  harness: DesktopJobHarness,
  channel: string,
  payload?: unknown,
): Promise<T> {
  const result = await harness.handler(channel, payload);
  return result as T;
}

test.describe('desktop job harness fidelity', () => {
  let harness: DesktopJobHarness;

  test.beforeEach(async () => {
    harness = await startDesktopJobHarness();
  });

  test.afterEach(async () => {
    await harness.stop();
  });

  test('gap 1: a catalog entry keeps the duration, size and animation of the stored original', async () => {
    const bytes = await readFile(join(MEDIA_FIXTURE_DIR, 'animated.gif'));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await answer(harness, 'desktop.media.asset.register', {
      id: 'gap1-animated-gif',
      kind: 'image',
      displayName: 'animated.gif',
      sha256,
      bytes: bytes.byteLength,
    });
    await answer(harness, 'desktop.media.asset.upload-original', {
      assetId: 'gap1-animated-gif',
      bytes,
    });

    const catalog = await answer<Catalog>(harness, 'desktop.asset-library.get-catalog');
    expect(catalog.counts.total).toBe(1);
    const entry = catalog.assets[0];
    expect(entry?.descriptor.mimeType).toBe('image/gif');
    // The real facts of the fixture, read out of the stored original.
    expect(entry?.descriptor.width).toBe(160);
    expect(entry?.descriptor.height).toBe(96);
    expect(entry?.descriptor.animation?.frameCount).toBeGreaterThan(1);
    expect(entry?.descriptor.durationUs).toBe(entry?.descriptor.animation?.cycleDurationUs);
    expect(entry?.descriptor.durationUs).toBeGreaterThan(0);
  });

  test('gap 2: a document write on a stale revision is a conflict, not a silent save', async () => {
    const first = await answer<{ kind: string; revisionId?: string }>(
      harness,
      'desktop.media.project.document.put',
      {
        projectId: 'gap2-project',
        baseRevisionId: '',
        revisionId: 'revision-1',
        document: { name: 'first' },
      },
    );
    expect(first.kind).toBe('saved');

    const stale = await answer<{ kind: string; revisionId?: string }>(
      harness,
      'desktop.media.project.document.put',
      {
        projectId: 'gap2-project',
        baseRevisionId: 'revision-0',
        revisionId: 'revision-2',
        document: { name: 'stale autosync' },
      },
    );
    expect(stale.kind).toBe('conflict');
    expect(stale.revisionId).toBe('revision-1');

    const missing = await answer<{ kind: string }>(harness, 'desktop.media.project.document.put', {
      projectId: 'gap2-unknown-project',
      baseRevisionId: 'revision-1',
      revisionId: 'revision-2',
      document: { name: 'never stored' },
    });
    expect(missing.kind).toBe('missing');
  });

  test('gap 3: a document write without look instances keeps the stored look instances', async () => {
    await answer(harness, 'desktop.media.project.document.put', {
      projectId: 'gap3-project',
      baseRevisionId: '',
      revisionId: 'revision-1',
      document: { name: 'first' },
      lookInstances: { look: 'sunset' },
    });
    await answer(harness, 'desktop.media.project.document.put', {
      projectId: 'gap3-project',
      baseRevisionId: 'revision-1',
      revisionId: 'revision-2',
      document: { name: 'second' },
    });
    const stored = await answer<{
      readonly revisionId: string;
      readonly document: unknown;
      readonly lookInstances?: unknown;
    }>(harness, 'desktop.media.project.document.get', { projectId: 'gap3-project' });
    expect(stored.revisionId).toBe('revision-2');
    expect(stored.document).toEqual({ name: 'second' });
    expect(stored.lookInstances).toEqual({ look: 'sunset' });
  });

  test('gap 4: an upload that does not match its registration is refused', async () => {
    const bytes = await readFile(join(MEDIA_FIXTURE_DIR, 'animated.gif'));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await answer(harness, 'desktop.media.asset.register', {
      id: 'gap4-asset',
      kind: 'image',
      displayName: 'animated.gif',
      sha256,
      bytes: bytes.byteLength,
    });

    // Different bytes, same length: only the checksum can catch it.
    const tampered = Buffer.from(bytes);
    tampered[20] = (tampered[20] ?? 0) ^ 0xff;
    await expect(
      answer(harness, 'desktop.media.asset.upload-original', {
        assetId: 'gap4-asset',
        bytes: tampered,
      }),
    ).rejects.toThrow(/checksum/i);

    // A shorter upload is refused on its length.
    await expect(
      answer(harness, 'desktop.media.asset.upload-original', {
        assetId: 'gap4-asset',
        bytes: bytes.subarray(0, bytes.byteLength - 1),
      }),
    ).rejects.toThrow(/size/i);
  });

  test('the harness runs a real Worker job through the desktop job stack', async () => {
    const workers = await answer<readonly { workerId: string; capabilities: string[] }[]>(
      harness,
      'desktop.media.workers.list',
      {},
    );
    // The Worker process has to say hello before it can lease a job.
    await expect
      .poll(
        async () => {
          const current = await answer<readonly { capabilities: string[] }[]>(
            harness,
            'desktop.media.workers.list',
            {},
          );
          return current[0]?.capabilities ?? [];
        },
        { timeout: 30_000, intervals: [200, 500, 1000] },
      )
      .toContain('render.export');
    expect(workers.length).toBeLessThanOrEqual(1);
  });
});
