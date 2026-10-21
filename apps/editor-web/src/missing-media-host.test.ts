import { describe, expect, it } from 'vitest';
import type { AssetRecordV1, JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import { applyTransaction, type CommandTransaction } from '@joy-media/commands';
import { emptySpikeProject, makeVideoClip, SECOND_US, withClips } from '@joy-media/test-fixtures';
import { createMissingMediaHost, type MissingMediaSession } from './missing-media-host.js';
import type { RelinkCache } from './media-relink.js';
import type { OriginalAssetDescriptor } from './opfs-original-asset-cache.js';

const encode = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(text));

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await new Blob([bytes]).arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function recordFor(id: string, bytes: Uint8Array<ArrayBuffer>): Promise<AssetRecordV1> {
  return {
    id,
    kind: 'video',
    displayName: `${id}.mp4`,
    sha256: await sha256(bytes),
    bytes: bytes.byteLength,
    descriptor: { mimeType: 'video/mp4' },
  };
}

function memoryCache(cached: readonly string[]): RelinkCache & { readonly stored: Set<string> } {
  const stored = new Set(cached);
  return {
    stored,
    async get(assetId) {
      return stored.has(assetId) ? new Blob(['cached']) : undefined;
    },
    async put(descriptor: OriginalAssetDescriptor) {
      stored.add(descriptor.assetId);
    },
  };
}

/** A session that really applies timeline transactions, and keeps the visual asset map. */
function fakeSession(
  timeline: SpikeProject,
  assets: Record<string, AssetRecordV1>,
): MissingMediaSession & {
  readonly state: { timeline: SpikeProject; visual: JoyProjectV1; dispatches: string[] };
} {
  const state = {
    timeline,
    visual: { assets } as unknown as JoyProjectV1,
    dispatches: [] as string[],
  };
  return {
    state,
    get timelineProject() {
      return state.timeline;
    },
    get visualProject() {
      return state.visual;
    },
    dispatchCompound(label, parts) {
      state.dispatches.push(label);
      if (parts.document !== undefined) state.visual = parts.document;
      if (parts.timeline !== undefined) {
        const tx: CommandTransaction = parts.timeline;
        state.timeline = applyTransaction(state.timeline, tx).project;
      }
    },
  };
}

describe('missing media host', () => {
  it('lists only assets a clip still references and that have no cached original', async () => {
    const used = await recordFor('asset-used', encode('used'));
    const unused = await recordFor('asset-unused', encode('unused'));
    const cached = await recordFor('asset-cached', encode('cached'));
    const timeline = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-used' }),
      makeVideoClip('clip-2', SECOND_US, SECOND_US, { assetId: 'asset-cached' }),
    ]);
    const session = fakeSession(timeline, {
      'asset-used': used,
      'asset-unused': unused,
      'asset-cached': cached,
    });
    const host = createMissingMediaHost(session, async () => memoryCache(['asset-cached']));
    expect((await host.list()).map((entry) => entry.assetId)).toEqual(['asset-used']);
  });

  it('relinks an exact match: the cache gains the original and the entry leaves the list', async () => {
    const bytes = encode('exact clip');
    const record = await recordFor('asset-1', bytes);
    const timeline = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-1' }),
    ]);
    const cache = memoryCache([]);
    const session = fakeSession(timeline, { 'asset-1': record });
    const host = createMissingMediaHost(session, async () => cache);
    const [entry] = await host.list();
    expect(await host.relink(entry!, new Blob([bytes]))).toEqual({ ok: true });
    expect(cache.stored.has('asset-1')).toBe(true);
    expect(await host.list()).toEqual([]);
  });

  it('refuses a mismatched file and leaves the cache untouched', async () => {
    const record = await recordFor('asset-1', encode('exact clip'));
    const timeline = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-1' }),
    ]);
    const cache = memoryCache([]);
    const host = createMissingMediaHost(
      fakeSession(timeline, { 'asset-1': record }),
      async () => cache,
    );
    const [entry] = await host.list();
    expect(await host.relink(entry!, new Blob([encode('other clip')]))).toEqual({
      ok: false,
      reason: 'hash-mismatch',
    });
    expect(cache.stored.size).toBe(0);
  });

  it('use-different-file adds a replacement asset, repoints the clips, and keeps the original intact', async () => {
    const originalBytes = encode('original clip');
    const original = await recordFor('asset-1', originalBytes);
    const timeline = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-1' }),
      makeVideoClip('clip-2', SECOND_US, SECOND_US, { assetId: 'asset-1' }),
    ]);
    const cache = memoryCache([]);
    const session = fakeSession(timeline, { 'asset-1': original });
    const host = createMissingMediaHost(session, async () => cache);
    const [entry] = await host.list();
    const replacement = encode('a different file');
    const outcome = await host.useDifferentFile(entry!, new Blob([replacement]));
    expect(outcome).toMatchObject({ ok: true, clipCount: 2 });
    const replacementId = (outcome as { replacementId: string }).replacementId;

    const clips = session.state.timeline.compositions['root']!.tracks[0]!.clips;
    expect(clips.map((clip) => clip.kind === 'video' && clip.assetId)).toEqual([
      replacementId,
      replacementId,
    ]);
    expect(session.state.visual.assets[replacementId]).toMatchObject({
      sha256: await sha256(replacement),
      bytes: replacement.byteLength,
    });
    expect(session.state.visual.assets['asset-1']).toEqual(original);
    expect(cache.stored.has(replacementId)).toBe(true);
    expect(cache.stored.has('asset-1')).toBe(false);
    // Nothing references the original now, so it leaves the missing list.
    expect(await host.list()).toEqual([]);
  });

  it('refuses an empty file for use-different-file without any change', async () => {
    const record = await recordFor('asset-1', encode('x'));
    const timeline = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-1' }),
    ]);
    const session = fakeSession(timeline, { 'asset-1': record });
    const cache = memoryCache([]);
    const host = createMissingMediaHost(session, async () => cache);
    const [entry] = await host.list();
    expect(await host.useDifferentFile(entry!, new Blob([]))).toEqual({
      ok: false,
      reason: 'empty-file',
    });
    expect(session.state.dispatches).toEqual([]);
    expect(cache.stored.size).toBe(0);
  });

  it('batch matching pairs files with missing assets by content and reports the rest', async () => {
    const one = encode('clip one');
    const two = encode('clip two');
    const timeline = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-1' }),
      makeVideoClip('clip-2', SECOND_US, SECOND_US, { assetId: 'asset-2' }),
    ]);
    const session = fakeSession(timeline, {
      'asset-1': await recordFor('asset-1', one),
      'asset-2': await recordFor('asset-2', two),
    });
    const host = createMissingMediaHost(session, async () => memoryCache([]));
    const result = await host.matchFiles([
      { file: new Blob([two]), fileName: 'two.mp4' },
      { file: new Blob([encode('stranger')]), fileName: 'stranger.mp4' },
    ]);
    expect(result.matches.map((match) => [match.assetId, match.fileName])).toEqual([
      ['asset-2', 'two.mp4'],
    ]);
    expect(result.unmatchedFileNames).toEqual(['stranger.mp4']);
    expect(result.unresolvedAssetIds).toEqual(['asset-1']);
  });
});
