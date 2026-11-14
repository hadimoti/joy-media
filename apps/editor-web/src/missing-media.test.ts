import { describe, expect, it, vi } from 'vitest';
import type { AssetRecordV1 } from '@joy-media/project-schema';
import { emptySpikeProject, makeVideoClip, SECOND_US, withClips } from '@joy-media/test-fixtures';
import {
  createMissingClipLookup,
  deriveMissingMedia,
  isClipMissing,
  matchReplacementFiles,
  missingAssetIdSet,
} from './missing-media.js';
import type { RelinkCache } from './media-relink.js';
import type { OriginalAssetDescriptor } from './opfs-original-asset-cache.js';
import { flattenRootTimelineVideoClips } from './timeline-nested-playback.js';
import type * as NestedPlayback from './timeline-nested-playback.js';

// The flatten is wrapped, not replaced, so the test can count how often a playhead tick reflattens.
vi.mock('./timeline-nested-playback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof NestedPlayback>();
  return { ...actual, flattenRootTimelineVideoClips: vi.fn(actual.flattenRootTimelineVideoClips) };
});

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await new Blob([bytes]).arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function recordOf(
  id: string,
  bytes: Uint8Array<ArrayBuffer>,
  kind: AssetRecordV1['kind'] = 'video',
): Promise<AssetRecordV1> {
  return sha256(bytes).then((hash) => ({
    id,
    kind,
    displayName: `${id}.mp4`,
    sha256: hash,
    bytes: bytes.byteLength,
    descriptor: { mimeType: 'video/mp4' },
  }));
}

function cacheWith(
  cachedIds: readonly string[],
): RelinkCache & { writes: OriginalAssetDescriptor[] } {
  const stored = new Set(cachedIds);
  const writes: OriginalAssetDescriptor[] = [];
  return {
    writes,
    async get(assetId) {
      return stored.has(assetId) ? new Blob(['cached']) : undefined;
    },
    async put(descriptor) {
      writes.push(descriptor);
      stored.add(descriptor.assetId);
    },
  };
}

const encode = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(text));

describe('deriveMissingMedia', () => {
  it('lists project assets with no cached original, and skips assets that have one', async () => {
    const assets = {
      'asset-a': await recordOf('asset-a', encode('a')),
      'asset-b': await recordOf('asset-b', encode('b')),
    };
    const missing = await deriveMissingMedia(assets, cacheWith(['asset-a']));
    expect(missing.map((entry) => entry.assetId)).toEqual(['asset-b']);
  });

  it('does not consult the control-plane catalog: a project asset is listed from its record alone', async () => {
    const assets = { 'imported-1': await recordOf('imported-1', encode('x')) };
    expect(await deriveMissingMedia(assets, cacheWith([]))).toHaveLength(1);
  });

  it('ignores LUT assets, which are not media originals', async () => {
    const assets = { 'lut-1': await recordOf('lut-1', encode('l'), 'lut') };
    expect(await deriveMissingMedia(assets, cacheWith([]))).toEqual([]);
  });

  it('never flags a virtual asset (text, caption, motion, effect, filter, adjustment, overlay, HTML scene)', async () => {
    // A virtual asset is recorded as kind `other` with no file behind it, so with an empty cache it
    // must still not be missing media (T-R01).
    const virtual = {
      'showcase-text-asset': { id: 'showcase-text-asset', kind: 'other', displayName: 'Text' },
      'showcase-caption-asset': { id: 'showcase-caption-asset', kind: 'other', displayName: 'CC' },
      'joy-adjustment-layer': { id: 'joy-adjustment-layer', kind: 'other', displayName: 'Adjust' },
      'html-scene:joy.firstparty.holo-badge': {
        id: 'html-scene:joy.firstparty.holo-badge',
        kind: 'other',
        displayName: 'Holo badge',
      },
    } as const;
    expect(await deriveMissingMedia(virtual, cacheWith([]))).toEqual([]);
  });

  it('still flags a real file that is not cached, next to the virtual ones', async () => {
    const assets = {
      'asset-intro': await recordOf('asset-intro', encode('intro'), 'video'),
      'showcase-text-asset': { id: 'showcase-text-asset', kind: 'other', displayName: 'Text' },
    } as const;
    const missing = await deriveMissingMedia(assets, cacheWith([]));
    expect(missing.map((entry) => entry.assetId)).toEqual(['asset-intro']);
  });
});

describe('matchReplacementFiles', () => {
  it('matches each file to the missing asset with the same hash and size', async () => {
    const one = await recordOf('asset-1', encode('first clip'));
    const two = await recordOf('asset-2', encode('second'));
    const result = await matchReplacementFiles(
      [
        { assetId: 'asset-1', record: one },
        { assetId: 'asset-2', record: two },
      ],
      [
        { file: new Blob([encode('second')]), fileName: 'b.mp4' },
        { file: new Blob([encode('first clip')]), fileName: 'a.mp4' },
      ],
    );
    expect(result.matches.map((match) => [match.assetId, match.fileName])).toEqual([
      ['asset-2', 'b.mp4'],
      ['asset-1', 'a.mp4'],
    ]);
    expect(result.unmatchedFileNames).toEqual([]);
    expect(result.unresolvedAssetIds).toEqual([]);
  });

  it('reports files that match nothing and assets that no file satisfies', async () => {
    const one = await recordOf('asset-1', encode('first clip'));
    const result = await matchReplacementFiles(
      [{ assetId: 'asset-1', record: one }],
      [{ file: new Blob([encode('wrong contents')]), fileName: 'wrong.mp4' }],
    );
    expect(result.matches).toEqual([]);
    expect(result.unmatchedFileNames).toEqual(['wrong.mp4']);
    expect(result.unresolvedAssetIds).toEqual(['asset-1']);
  });

  it('assigns a file to at most one asset, even when two assets share a hash', async () => {
    const shared = encode('same bytes');
    const first = await recordOf('asset-1', shared);
    const second = await recordOf('asset-2', shared);
    const result = await matchReplacementFiles(
      [
        { assetId: 'asset-1', record: first },
        { assetId: 'asset-2', record: second },
      ],
      [{ file: new Blob([shared]), fileName: 'only.mp4' }],
    );
    expect(result.matches.map((match) => match.assetId)).toEqual(['asset-1']);
    expect(result.unresolvedAssetIds).toEqual(['asset-2']);
  });
});

describe('missing clips on the timeline (T-R03)', () => {
  const entryFor = (assetId: string, displayName: string) => ({
    assetId,
    record: {
      id: assetId,
      kind: 'video' as const,
      displayName,
      sha256: 'a'.repeat(64),
      bytes: 4,
      descriptor: { mimeType: 'video/mp4' },
    },
  });

  it('marks exactly the clip whose file is missing, using the document and the cache list', async () => {
    const project = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-present', 0, SECOND_US, { assetId: 'asset-present' }),
      makeVideoClip('clip-missing', SECOND_US, SECOND_US, { assetId: 'asset-missing' }),
    ]);
    const assets = {
      'asset-present': await recordOf('asset-present', encode('present')),
      'asset-missing': await recordOf('asset-missing', encode('missing')),
    };
    const missingIds = missingAssetIdSet(
      await deriveMissingMedia(assets, cacheWith(['asset-present'])),
    );
    const marked = Object.values(project.compositions)
      .flatMap((composition) => composition.tracks.flatMap((track) => track.clips))
      .filter((clip) => isClipMissing(clip, missingIds))
      .map((clip) => clip.id);
    expect(marked).toEqual(['clip-missing']);
  });

  it('finds the missing video clip the monitor cannot draw at the playhead, and nothing otherwise', () => {
    const project = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-present', 0, SECOND_US, { assetId: 'asset-present' }),
      makeVideoClip('clip-missing', SECOND_US, SECOND_US, { assetId: 'asset-missing' }),
    ]);
    const lookup = createMissingClipLookup(
      project,
      missingAssetIdSet([entryFor('asset-missing', 'take-2.mov')]),
    );

    expect(lookup(SECOND_US + 10)).toBe('asset-missing');
    expect(lookup(10)).toBeUndefined();
    expect(lookup(2 * SECOND_US)).toBeUndefined();
    expect(createMissingClipLookup(project, new Set())(SECOND_US + 10)).toBeUndefined();
  });

  it('flattens the root timeline once per project, so a playhead tick only scans the missing clips', () => {
    const project = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-present', 0, SECOND_US, { assetId: 'asset-present' }),
      makeVideoClip('clip-missing', SECOND_US, SECOND_US, { assetId: 'asset-missing' }),
    ]);
    const missingIds = missingAssetIdSet([entryFor('asset-missing', 'take-2.mov')]);
    vi.mocked(flattenRootTimelineVideoClips).mockClear();

    const lookup = createMissingClipLookup(project, missingIds);
    const found = [0, 10, SECOND_US, SECOND_US + 10, SECOND_US + 999, 2 * SECOND_US].map((timeUs) =>
      lookup(timeUs),
    );

    expect(found).toEqual([
      undefined,
      undefined,
      'asset-missing',
      'asset-missing',
      'asset-missing',
      undefined,
    ]);
    expect(flattenRootTimelineVideoClips).toHaveBeenCalledTimes(1);
  });
});
