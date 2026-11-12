import type { AssetRecordV1, JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import type { CommandTransaction } from '@joy-media/commands';
import {
  deriveMissingMedia,
  matchReplacementFiles,
  type BatchMatchResult,
  type MissingMediaEntry,
} from './missing-media.js';
import { relinkMissingMedia, type RelinkCache, type ReplacementVerdict } from './media-relink.js';
import { buildReplacementAsset, repointClipsTransaction } from './media-replacement.js';

/** The editor session surface that missing-media operations need. */
export interface MissingMediaSession {
  readonly visualProject: JoyProjectV1;
  readonly timelineProject: SpikeProject;
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
   * new asset record together.
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
): MissingMediaHost {
  const list = async (): Promise<readonly MissingMediaEntry[]> => {
    const referenced = referencedAssetIds(session.timelineProject);
    const assets = Object.fromEntries(
      Object.entries(session.visualProject.assets).filter(([assetId]) => referenced.has(assetId)),
    ) as Readonly<Record<string, AssetRecordV1>>;
    return deriveMissingMedia(assets, await cache());
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
      await store.put(
        {
          assetId: replacementId,
          sha256: record.sha256!,
          bytes: record.bytes!,
          mimeType: record.descriptor?.mimeType ?? file.type,
        },
        file,
      );
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
      session.dispatchCompound(timeline.label, {
        document,
        ...(timeline.commands.length === 0 ? {} : { timeline }),
      });
      return { ok: true, replacementId, clipCount: timeline.commands.length };
    },

    async matchFiles(files) {
      return matchReplacementFiles(await list(), files);
    },
  };
}
