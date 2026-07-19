/** Pure v0 -> v1 migration harness. */

import type { Clip, SpikeProject } from './model.js';
import type { JoyProjectV1, AssetRecordV1, ClipV1 } from './v1.js';
import { validateJoyProjectV1 } from './v1.js';

export interface MigrationReport {
  readonly fromVersion: 0;
  readonly toVersion: 1;
  readonly defaultsApplied: readonly string[];
}

export interface MigrationResult {
  readonly project: JoyProjectV1;
  readonly report: MigrationReport;
}

/** Converts an immutable P00 spike project into the v1 document shape without I/O. */
export function migrateV0ToV1(project: SpikeProject): MigrationResult {
  const assets: Record<string, AssetRecordV1> = {};
  const compositions = Object.fromEntries(
    Object.entries(project.compositions).map(([id, composition]) => [
      id,
      {
        id: composition.id,
        name: composition.name,
        width: composition.width,
        height: composition.height,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: composition.frameRate,
        durationUs: composition.durationUs,
        background: '#000000',
        tracks: composition.tracks.map((track) => ({
          id: track.id,
          kind: track.kind,
          name: track.id,
          order: track.order,
          enabled: track.enabled,
          locked: false,
          clips: track.clips.map((clip) => migrateClip(clip, assets)),
        })),
      },
    ]),
  );
  const migrated: JoyProjectV1 = {
    schemaVersion: 1,
    id: project.id,
    title: project.compositions[project.rootCompositionId]?.name ?? 'Migrated project',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    rootCompositionId: project.rootCompositionId,
    settings: { defaultLocale: 'en' },
    compositions,
    assets,
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: {},
    pluginData: {},
  };
  const diagnostics = validateJoyProjectV1(migrated);
  if (diagnostics.length > 0)
    throw new Error(`v0 migration produced invalid v1: ${diagnostics[0]!.message}`);
  return {
    project: migrated,
    report: {
      fromVersion: 0,
      toVersion: 1,
      defaultsApplied: [
        'pixelAspectRatio',
        'background',
        'track.name',
        'track.locked',
        'project metadata',
        'visualObjects',
        'captionDocuments',
      ],
    },
  };
}

function migrateClip(clip: Clip, assets: Record<string, AssetRecordV1>): ClipV1 {
  if (clip.kind === 'composition') return { ...clip };
  assets[clip.assetId] ??= { id: clip.assetId, kind: 'video', displayName: clip.assetId };
  return { ...clip };
}
