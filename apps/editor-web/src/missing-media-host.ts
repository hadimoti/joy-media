import type { AssetRecordV1, JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import type { CommandTransaction } from '@joy-media/commands';
import {
  deriveMissingMedia,
  matchReplacementFiles,
  type BatchMatchResult,
  type MissingMediaEntry,
} from './missing-media.js';
import { relinkMissingMedia, type RelinkCache, type ReplacementVerdict } from './media-relink.js';
import { assetMediaMimeType } from './asset-mime-type.js';
import { buildReplacementAsset, repointClipsTransaction } from './media-replacement.js';

/** The editor session surface that missing-media operations need. */
export interface MissingMediaSession {
  readonly visualProject: JoyProjectV1;
  readonly timelineProject: SpikeProject;
  /** The undo and redo history, so the host can tell whether an edit can still be undone or redone. */
  readonly historyEntries: readonly { readonly sequence: number }[];
  /** Sequence of the newest applied history entry (0 when there is none). */
  readonly historyCursorSequence: number;
  dispatchCompound(
    label: string,
    parts: { readonly document?: JoyProjectV1; readonly timeline?: CommandTransaction },
  ): void;
}

export type UseDifferentFileOutcome =
  | { readonly ok: true; readonly replacementId: string; readonly clipCount: number }
  | { readonly ok: false; readonly reason: 'empty-file' };

export interface MissingMediaHost {
  /** Missing assets that a timeline clip still references. */
  list(): Promise<readonly MissingMediaEntry[]>;
  /** Exact-match relink: the file must match the recorded hash and length. */
  relink(entry: MissingMediaEntry, file: Blob): Promise<ReplacementVerdict>;
  /**
   * Explicit override: stores the file as a new asset with its own metadata and
   * repoints every clip that used the missing asset. The original record and
   * any cached original are left unchanged. Undo removes the repoint and the
   * new asset record together. The new file's copy in the original cache stays while Undo or Redo
   * can still reach the edit, and is removed by the next `list()` once the edit has left the history.
   */
  useDifferentFile(entry: MissingMediaEntry, file: Blob): Promise<UseDifferentFileOutcome>;
  /** Matches chosen files to the current missing list by content. Writes nothing. */
  matchFiles(
    files: readonly { readonly file: Blob; readonly fileName: string }[],
  ): Promise<BatchMatchResult>;
}

/** Asset ids that at least one video clip, in any composition or track, references. */
export function referencedAssetIds(project: SpikeProject): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const composition of Object.values(project.compositions))
    for (const track of composition.tracks)
      for (const clip of track.clips) if (clip.kind === 'video') ids.add(clip.assetId);
  return ids;
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `replacement-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function createMissingMediaHost(
  session: MissingMediaSession,
  cache: () => Promise<RelinkCache>,
  /** Settles when the session's sample media copy has finished (T-R01); the list waits for it. */
  sampleMediaCopy?: Promise<unknown>,
): MissingMediaHost {
  /**
   * The replacement files this session wrote into the original cache, with the history entry of the
   * edit that uses each. A file is added only once its edit is on the history, so a list that runs
   * while the file is still being written cannot take it away.
   */
  const replacementEntries = new Map<string, number>();

  /**
   * Removes the cached copy of a replacement whose edit has left the history. An edit leaves the
   * history only when a new edit discards the redo entries after an Undo; while it is applied, or
   * undone and still redoable, its copy stays, so Redo finds its file.
   */
  const removeDiscardedReplacements = async (store: RelinkCache): Promise<void> => {
    if (replacementEntries.size === 0) return;
    const onHistory = new Set(session.historyEntries.map((entry) => entry.sequence));
    let firstRemovalError: unknown;
    let hadRemovalError = false;
    for (const [replacementId, sequence] of [...replacementEntries]) {
      if (onHistory.has(sequence) || session.visualProject.assets[replacementId] !== undefined)
        continue;
      if (store.remove === undefined) continue;
      try {
        await store.remove(replacementId);
        replacementEntries.delete(replacementId);
      } catch (error) {
        if (!hadRemovalError) firstRemovalError = error;
        hadRemovalError = true;
      }
    }
    if (hadRemovalError) throw firstRemovalError;
  };

  const list = async (): Promise<readonly MissingMediaEntry[]> => {
    await sampleMediaCopy;
    const referenced = referencedAssetIds(session.timelineProject);
    const assets = Object.fromEntries(
      Object.entries(session.visualProject.assets).filter(([assetId]) => referenced.has(assetId)),
    ) as Readonly<Record<string, AssetRecordV1>>;
    const store = await cache();
    await removeDiscardedReplacements(store);
    return deriveMissingMedia(assets, store);
  };
  return {
    list,

    async relink(entry, file) {
      return relinkMissingMedia(await cache(), entry.record, file);
    },

    async useDifferentFile(entry, file) {
      if (file.size === 0) return { ok: false, reason: 'empty-file' };
      const replacementId = randomId();
      const record = await buildReplacementAsset(entry.record, replacementId, file);
      const store = await cache();
      try {
        await store.put(
          {
            assetId: replacementId,
            sha256: record.sha256!,
            bytes: record.bytes!,
            mimeType: assetMediaMimeType(entry.record.kind, [
              file.type,
              entry.record.descriptor?.mimeType,
            ]),
          },
          file,
        );
      } catch (error) {
        try {
          await store.remove?.(replacementId);
        } catch {
          // Preserve the cache write error; a cleanup failure must not replace its cause.
        }
        throw error;
      }
      const timeline = repointClipsTransaction(
        session.timelineProject,
        entry.assetId,
        replacementId,
        `Use different file for ${entry.record.displayName}`,
      );
      const document: JoyProjectV1 = {
        ...session.visualProject,
        assets: { ...session.visualProject.assets, [replacementId]: record },
      };
      try {
        session.dispatchCompound(timeline.label, {
          document,
          ...(timeline.commands.length === 0 ? {} : { timeline }),
        });
      } catch (error) {
        // The edit was not applied, so nothing will ever refer to the file just written.
        try {
          await store.remove?.(replacementId);
        } catch {
          // Preserve the dispatch error; a cleanup failure must not replace its cause.
        }
        throw error;
      }
      replacementEntries.set(replacementId, session.historyCursorSequence);
      return { ok: true, replacementId, clipCount: timeline.commands.length };
    },

    async matchFiles(files) {
      return matchReplacementFiles(await list(), files);
    },
  };
}
