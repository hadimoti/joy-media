import type { AssetRecordV1 } from '@joy-media/project-schema';
import { describe, expect, it } from 'vitest';
import { withoutLibraryServedEntries } from './library-media-available.js';
import type { MissingMediaEntry } from './missing-media.js';

const LIB_ID = `joylib-${'a'.repeat(64)}`;
const entry = (assetId: string, kind: string): MissingMediaEntry => ({
  assetId,
  record: { kind } as unknown as AssetRecordV1,
});

describe('withoutLibraryServedEntries', () => {
  it('drops a library asset the library folder can still serve', async () => {
    const urls: string[] = [];
    const result = await withoutLibraryServedEntries(
      [entry(LIB_ID, 'image'), entry('other', 'video')],
      {
        isDesktop: () => true,
        fetchFile: async (url) => {
          urls.push(url);
          return { ok: true };
        },
      },
    );
    expect(result.map((item) => item.assetId)).toEqual(['other']);
    expect(urls).toEqual([`joy-asset://library/images/${LIB_ID}`]);
  });

  it('keeps a library asset whose file is gone or unreachable', async () => {
    const gone = await withoutLibraryServedEntries([entry(LIB_ID, 'video')], {
      isDesktop: () => true,
      fetchFile: async () => ({ ok: false }),
    });
    const broken = await withoutLibraryServedEntries([entry(LIB_ID, 'video')], {
      isDesktop: () => true,
      fetchFile: async () => {
        throw new Error('offline');
      },
    });
    expect(gone).toHaveLength(1);
    expect(broken).toHaveLength(1);
  });

  it('changes nothing in a plain browser', async () => {
    const entries = [entry(LIB_ID, 'image')];
    expect(await withoutLibraryServedEntries(entries, { isDesktop: () => false })).toBe(entries);
  });
});
