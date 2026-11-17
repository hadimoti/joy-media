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

function memoryCache(cached: readonly string[]): RelinkCache & {
  readonly stored: Set<string>;
  readonly removed: string[];
  remove(assetId: string): Promise<void>;
} {
  const stored = new Set(cached);
  const removed: string[] = [];
  return {
    stored,
    removed,
    async get(assetId) {
      return stored.has(assetId) ? new Blob(['cached']) : undefined;
    },
    async put(descriptor: OriginalAssetDescriptor) {
      stored.add(descriptor.assetId);
    },
    async remove(assetId) {
      removed.push(assetId);
      stored.delete(assetId);
    },
  };
}

/**
 * A session that really applies timeline transactions, keeps the visual asset map, and keeps a
 * linear history like the editor's: a dispatch adds an entry and drops every redo entry; undo and
 * redo move the cursor and swap the document and timeline between the two states of an entry.
 */
function fakeSession(
  timeline: SpikeProject,
  assets: Record<string, AssetRecordV1>,
): MissingMediaSession & {
  readonly state: { timeline: SpikeProject; visual: JoyProjectV1; dispatches: string[] };
  undo(): void;
  redo(): void;
  /** An unrelated edit: a new history entry, which discards every redo entry. */
  unrelatedEdit(): void;
  failNextDispatch(): void;
} {
  const state = {
    timeline,
    visual: { assets } as unknown as JoyProjectV1,
    dispatches: [] as string[],
  };
  const entries: {
    sequence: number;
    before: { timeline: SpikeProject; visual: JoyProjectV1 };
    after: { timeline: SpikeProject; visual: JoyProjectV1 };
  }[] = [];
  let cursor = 0; // entries[0..cursor) are applied; the rest are redoable
  let sequence = 0;
  let failing = false;
  const push = (next: { timeline: SpikeProject; visual: JoyProjectV1 }): void => {
    entries.length = cursor;
    entries.push({
      sequence: ++sequence,
      before: { timeline: state.timeline, visual: state.visual },
      after: next,
    });
    cursor = entries.length;
    state.timeline = next.timeline;
    state.visual = next.visual;
  };
  return {
    state,
    get timelineProject() {
      return state.timeline;
    },
    get visualProject() {
      return state.visual;
    },
    get historyEntries() {
      return entries.map((entry) => ({ sequence: entry.sequence }));
    },
    get historyCursorSequence() {
      return cursor === 0 ? 0 : entries[cursor - 1]!.sequence;
    },
    dispatchCompound(label, parts) {
      if (failing) {
        failing = false;
        throw new Error('persistence failed');
      }
      state.dispatches.push(label);
      push({
        visual: parts.document ?? state.visual,
        timeline:
          parts.timeline === undefined
            ? state.timeline
            : applyTransaction(state.timeline, parts.timeline as CommandTransaction).project,
      });
    },
    undo() {
      const entry = entries[--cursor]!;
      state.timeline = entry.before.timeline;
      state.visual = entry.before.visual;
    },
    redo() {
      const entry = entries[cursor++]!;
      state.timeline = entry.after.timeline;
      state.visual = entry.after.visual;
    },
    unrelatedEdit() {
      push({ timeline: state.timeline, visual: { ...state.visual } });
    },
    failNextDispatch() {
      failing = true;
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

  it('waits for the sample media copy: a sample asset is never listed as missing, even briefly (T-R01)', async () => {
    const bytes = encode('sample intro');
    const record = await recordFor('asset-intro', bytes);
    const timeline = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-intro' }),
    ]);
    const session = fakeSession(timeline, { 'asset-intro': record });
    const cache = memoryCache([]);
    let finishCopy: () => void = () => undefined;
    const copy = new Promise<void>((resolve) => {
      finishCopy = resolve;
    });
    const host = createMissingMediaHost(session, async () => cache, copy);

    const listing = host.list().then(() => 'listed');
    const early = await Promise.race([
      listing,
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 0)),
    ]);
    expect(early).toBe('waiting');

    // The copy writes the original and settles; only then does the list run.
    await cache.put(
      {
        assetId: 'asset-intro',
        sha256: record.sha256!,
        bytes: bytes.byteLength,
        mimeType: 'video/mp4',
      },
      new Blob([bytes]),
    );
    finishCopy();
    expect(await host.list()).toEqual([]);
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

  it('removes a partial replacement when the cache write fails', async () => {
    const original = await recordFor('asset-1', encode('original clip'));
    const timeline = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-1' }),
    ]);
    const cache = memoryCache([]);
    const putError = new Error('cache write failed');
    const partialIds: string[] = [];
    cache.put = async (descriptor) => {
      partialIds.push(descriptor.assetId);
      cache.stored.add(descriptor.assetId);
      throw putError;
    };
    const session = fakeSession(timeline, { 'asset-1': original });
    const host = createMissingMediaHost(session, async () => cache);
    const [entry] = await host.list();

    await expect(
      host.useDifferentFile(entry!, new Blob([encode('a different file')])),
    ).rejects.toBe(putError);

    expect(partialIds).toHaveLength(1);
    expect(cache.removed).toEqual(partialIds);
    expect(cache.stored.size).toBe(0);
  });

  it('preserves the cache write error if removing its partial replacement also fails', async () => {
    const original = await recordFor('asset-1', encode('original clip'));
    const timeline = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-1' }),
    ]);
    const cache = memoryCache([]);
    const putError = new Error('cache write failed');
    const cleanupError = new Error('cache cleanup failed');
    cache.put = async () => {
      throw putError;
    };
    cache.remove = async (assetId) => {
      cache.removed.push(assetId);
      throw cleanupError;
    };
    const session = fakeSession(timeline, { 'asset-1': original });
    const host = createMissingMediaHost(session, async () => cache);
    const [entry] = await host.list();

    await expect(
      host.useDifferentFile(entry!, new Blob([encode('a different file')])),
    ).rejects.toBe(putError);
    expect(cache.removed).toHaveLength(1);
  });

  describe('the replacement copy in the original cache follows the Undo history', () => {
    async function withReplacement() {
      const original = await recordFor('asset-1', encode('original clip'));
      const timeline = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
        makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-1' }),
      ]);
      const cache = memoryCache([]);
      const session = fakeSession(timeline, { 'asset-1': original });
      const host = createMissingMediaHost(session, async () => cache);
      const [entry] = await host.list();
      const outcome = await host.useDifferentFile(entry!, new Blob([encode('a different file')]));
      const replacementId = (outcome as { replacementId: string }).replacementId;
      return { cache, session, host, replacementId };
    }

    it('keeps the copy while the edit is applied', async () => {
      const { cache, host, replacementId } = await withReplacement();
      await host.list();
      expect(cache.stored.has(replacementId)).toBe(true);
      expect(cache.removed).toEqual([]);
    });

    it('keeps the copy after Undo, because Redo needs it, and after Redo too', async () => {
      const { cache, session, host, replacementId } = await withReplacement();
      session.undo();
      await host.list();
      expect(cache.stored.has(replacementId)).toBe(true);
      session.redo();
      await host.list();
      expect(cache.stored.has(replacementId)).toBe(true);
      expect(session.state.visual.assets[replacementId]).toBeDefined();
      expect(cache.removed).toEqual([]);
    });

    it('removes the copy once the undone edit can no longer be redone', async () => {
      const { cache, session, host, replacementId } = await withReplacement();
      session.undo();
      session.unrelatedEdit();
      await host.list();
      expect(cache.removed).toEqual([replacementId]);
      expect(cache.stored.has(replacementId)).toBe(false);
      // A second list does not remove it again.
      await host.list();
      expect(cache.removed).toEqual([replacementId]);
    });

    it('continues cleaning other orphans and retries a removal that failed', async () => {
      const originalA = await recordFor('asset-a', encode('original a'));
      const originalB = await recordFor('asset-b', encode('original b'));
      const timeline = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
        makeVideoClip('clip-a', 0, SECOND_US, { assetId: 'asset-a' }),
        makeVideoClip('clip-b', SECOND_US, SECOND_US, { assetId: 'asset-b' }),
      ]);
      const cache = memoryCache([]);
      const session = fakeSession(timeline, { 'asset-a': originalA, 'asset-b': originalB });
      const host = createMissingMediaHost(session, async () => cache);
      const [entryA, entryB] = await host.list();
      const outcomeA = await host.useDifferentFile(entryA!, new Blob([encode('replacement a')]));
      const outcomeB = await host.useDifferentFile(entryB!, new Blob([encode('replacement b')]));
      const replacementA = (outcomeA as { replacementId: string }).replacementId;
      const replacementB = (outcomeB as { replacementId: string }).replacementId;
      session.undo();
      session.undo();
      session.unrelatedEdit();

      const remove = cache.remove.bind(cache);
      const firstError = new Error('disk refused first removal');
      const attempts: string[] = [];
      cache.remove = async (assetId) => {
        attempts.push(assetId);
        if (attempts.length === 1) throw firstError;
        await remove(assetId);
      };

      await expect(host.list()).rejects.toBe(firstError);
      expect(attempts).toEqual([replacementA, replacementB]);
      expect(cache.stored.has(replacementA)).toBe(true);
      expect(cache.stored.has(replacementB)).toBe(false);

      cache.remove = remove;
      await host.list();
      expect(cache.stored.has(replacementA)).toBe(false);
      expect(cache.removed).toEqual([replacementB, replacementA]);
    });

    it('keeps the copy after later edits when the edit is still in the Undo history', async () => {
      const { cache, session, host, replacementId } = await withReplacement();
      session.unrelatedEdit();
      await host.list();
      expect(cache.stored.has(replacementId)).toBe(true);
    });

    it('does not remove a copy before its edit is on the history (the write comes first)', async () => {
      const original = await recordFor('asset-1', encode('original clip'));
      const timeline = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
        makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-1' }),
      ]);
      const cache = memoryCache([]);
      const session = fakeSession(timeline, { 'asset-1': original });
      const host = createMissingMediaHost(session, async () => cache);
      const [entry] = await host.list();
      // A list that runs while the file is being written must not take it away.
      const realPut = cache.put.bind(cache);
      let listedDuringWrite: Promise<unknown> | undefined;
      cache.put = async (descriptor, file) => {
        await realPut(descriptor, file);
        listedDuringWrite = host.list();
        await listedDuringWrite;
      };
      await host.useDifferentFile(entry!, new Blob([encode('a different file')]));
      expect(cache.removed).toEqual([]);
    });

    it('removes the copy again when the edit could not be applied', async () => {
      const original = await recordFor('asset-1', encode('original clip'));
      const timeline = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
        makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-1' }),
      ]);
      const cache = memoryCache([]);
      const session = fakeSession(timeline, { 'asset-1': original });
      const host = createMissingMediaHost(session, async () => cache);
      const [entry] = await host.list();
      session.failNextDispatch();
      await expect(
        host.useDifferentFile(entry!, new Blob([encode('a different file')])),
      ).rejects.toThrow('persistence failed');
      expect(cache.stored.size).toBe(0);
      expect(session.state.visual.assets['asset-1']).toEqual(original);
    });
  });

  it('lists nothing when the original cache cannot be read (OPFS unavailable), not every asset', async () => {
    const record = await recordFor('asset-1', encode('clip'));
    const timeline = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-1' }),
    ]);
    const unreadable: RelinkCache = {
      isAvailable: () => false,
      async get() {
        return undefined;
      },
      async put() {},
    };
    const host = createMissingMediaHost(
      fakeSession(timeline, { 'asset-1': record }),
      async () => unreadable,
    );
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
