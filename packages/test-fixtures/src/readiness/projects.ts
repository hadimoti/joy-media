/**
 * Pure-data project builders for JOY Media readiness tests.
 * No filesystem I/O, no generated media.
 */

import {
  migrateV0ToV1,
  migrateV1ToV2,
  migrateV2ToV3,
  type JoyProjectV1,
  type JoyProjectV2,
  type JoyProjectV3,
  type SpikeProject,
} from '@joy-media/project-schema';
import { createAnimationOwnershipFixture } from '../wp34-animation-fixtures.js';

// ---------------------------------------------------------------------------
// Basic AV delivery
// ---------------------------------------------------------------------------

export function buildBasicAvDeliveryProject(): JoyProjectV1 {
  const v0: SpikeProject = {
    schemaVersion: 0,
    id: 'basic-av-delivery',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Basic AV Delivery',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        durationUs: 10_000_000,
        tracks: [
          {
            id: 'video-track',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-video',
                startUs: 0,
                durationUs: 10_000_000,
                assetId: 'asset-video',
                sourceInUs: 0,
              },
            ],
          },
          {
            id: 'audio-track',
            kind: 'video',
            order: 1,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-audio',
                startUs: 0,
                durationUs: 10_000_000,
                assetId: 'asset-audio',
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
    },
  };
  const migrated = migrateV0ToV1(v0).project;
  // Fix second track kind to 'audio' (v0 only supports 'video')
  const rootComp = migrated.compositions[migrated.rootCompositionId]!;
  const tracks = rootComp.tracks.map((track) =>
    track.id === 'audio-track' ? { ...track, kind: 'audio' as const } : track,
  );
  return {
    ...migrated,
    id: 'basic-av-delivery',
    title: 'Basic AV Delivery',
    compositions: {
      ...migrated.compositions,
      [migrated.rootCompositionId]: { ...rootComp, tracks },
    },
    assets: {
      ...migrated.assets,
      'asset-video': { id: 'asset-video', kind: 'video', displayName: 'Video asset' },
      'asset-audio': { id: 'asset-audio', kind: 'audio', displayName: 'Audio asset' },
    },
  };
}

// ---------------------------------------------------------------------------
// Gaps and parallel tracks
// ---------------------------------------------------------------------------

export function buildGapsParallelTracksProject(): JoyProjectV1 {
  const v0: SpikeProject = {
    schemaVersion: 0,
    id: 'gaps-parallel-tracks',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Gaps and Parallel Tracks',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        durationUs: 10_000_000,
        tracks: [
          {
            id: 'video-track-0',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-a',
                startUs: 0,
                durationUs: 3_000_000,
                assetId: 'asset-video',
                sourceInUs: 0,
              },
              {
                kind: 'video',
                id: 'clip-b',
                startUs: 5_000_000,
                durationUs: 3_000_000,
                assetId: 'asset-video',
                sourceInUs: 0,
              },
            ],
          },
          {
            id: 'video-track-1',
            kind: 'video',
            order: 1,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-c',
                startUs: 1_000_000,
                durationUs: 3_000_000,
                assetId: 'asset-video',
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
    },
  };
  const migrated = migrateV0ToV1(v0).project;
  return {
    ...migrated,
    id: 'gaps-parallel-tracks',
    title: 'Gaps and Parallel Tracks',
    assets: {
      ...migrated.assets,
      'asset-video': { id: 'asset-video', kind: 'video', displayName: 'Video asset' },
    },
  };
}

// ---------------------------------------------------------------------------
// Kitchen sink (all supported editor domains)
// ---------------------------------------------------------------------------

export function buildKitchenSinkSupportedProject(): JoyProjectV1 {
  return createAnimationOwnershipFixture();
}

// ---------------------------------------------------------------------------
// Persian / RTL caption project
// ---------------------------------------------------------------------------

export function buildPersianRtlProject(): JoyProjectV1 {
  const v0: SpikeProject = {
    schemaVersion: 0,
    id: 'persian-rtl-project',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Persian RTL Project',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        durationUs: 5_000_000,
        tracks: [
          {
            id: 'video-track',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-video',
                startUs: 0,
                durationUs: 5_000_000,
                assetId: 'asset-video',
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
    },
  };
  const migrated = migrateV0ToV1(v0).project;
  return {
    ...migrated,
    id: 'persian-rtl-project',
    title: 'Persian RTL Project',
    assets: {
      ...migrated.assets,
      'asset-video': { id: 'asset-video', kind: 'video', displayName: 'Video asset' },
    },
    captionDocuments: {
      'caption-doc': {
        id: 'caption-doc',
        language: 'fa',
        direction: 'rtl',
        speakers: [],
        words: {
          'word-1': { id: 'word-1', text: 'سلام', startUs: 0, endUs: 1_000_000 },
          'word-2': { id: 'word-2', text: 'دنیا', startUs: 1_000_000, endUs: 2_000_000 },
        },
        segments: [{ id: 'seg-1', startUs: 0, endUs: 2_000_000, wordIds: ['word-1', 'word-2'] }],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Historical schema versions (v0–v3)
// ---------------------------------------------------------------------------

export function buildHistoricalSchemaProjects(): {
  v0: SpikeProject;
  v1: JoyProjectV1;
  v2: JoyProjectV2;
  v3: JoyProjectV3;
} {
  const v0: SpikeProject = {
    schemaVersion: 0,
    id: 'historical-schemas',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Historical Schema Versions',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        durationUs: 5_000_000,
        tracks: [
          {
            id: 'video-track',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-video',
                startUs: 0,
                durationUs: 5_000_000,
                assetId: 'asset-video',
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
    },
  };

  const v1Result = migrateV0ToV1(v0);
  const v1: JoyProjectV1 = {
    ...v1Result.project,
    id: 'historical-schemas',
    title: 'Historical Schema Versions',
  };

  const v2Result = migrateV1ToV2(v1);
  const v2: JoyProjectV2 = {
    ...v2Result.project,
    id: 'historical-schemas',
    title: 'Historical Schema Versions',
  };

  const v3Result = migrateV2ToV3(v2);
  const v3: JoyProjectV3 = {
    ...v3Result.project,
    id: 'historical-schemas',
    title: 'Historical Schema Versions',
  };

  return { v0, v1, v2, v3 };
}

// ---------------------------------------------------------------------------
// Missing and relinked assets
// ---------------------------------------------------------------------------

export function buildMissingRelinkedAssetsProject(): {
  missingProject: JoyProjectV1;
  relinkedProject: JoyProjectV1;
  assetId: string;
  missingPath: string;
  relinkedPath: string;
  missingSources: Readonly<Record<string, string>>;
  relinkedSources: Readonly<Record<string, string>>;
} {
  const assetId = 'asset-video';
  const missingPath = 'originals/missing-source.mp4';
  const relinkedPath = 'relinked/source.mp4';
  const sha256 = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

  const baseV0: SpikeProject = {
    schemaVersion: 0,
    id: 'missing-relinked-assets',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Missing and Relinked Assets',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        durationUs: 5_000_000,
        tracks: [
          {
            id: 'video-track',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-video',
                startUs: 0,
                durationUs: 5_000_000,
                assetId,
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
    },
  };

  const migrated = migrateV0ToV1(baseV0).project;

  const missingProject: JoyProjectV1 = {
    ...migrated,
    id: 'missing-relinked-assets',
    title: 'Missing and Relinked Assets',
    assets: {
      [assetId]: {
        id: assetId,
        kind: 'video',
        displayName: 'Video asset',
        sha256,
        bytes: 1024,
        descriptor: { mimeType: 'video/mp4', durationUs: 5_000_000, width: 1920, height: 1080 },
      },
    },
  };

  const relinkedProject: JoyProjectV1 = {
    ...migrated,
    id: 'missing-relinked-assets',
    title: 'Missing and Relinked Assets',
    assets: {
      [assetId]: {
        id: assetId,
        kind: 'video',
        displayName: 'Video asset',
        sha256,
        bytes: 1024,
        descriptor: { mimeType: 'video/mp4', durationUs: 5_000_000, width: 1920, height: 1080 },
      },
    },
  };

  // The project schema intentionally keeps machine-local file paths outside
  // the portable project document. Model the CLI's separate source registry
  // so a relink changes the source location without changing project identity.
  return {
    missingProject,
    relinkedProject,
    assetId,
    missingPath,
    relinkedPath,
    missingSources: { [assetId]: missingPath },
    relinkedSources: { [assetId]: relinkedPath },
  };
}

// ---------------------------------------------------------------------------
// 10 000-clip scale profile
// ---------------------------------------------------------------------------

export function buildTenThousandClipProject(): SpikeProject {
  const tracks = [];
  for (let trackIndex = 0; trackIndex < 100; trackIndex++) {
    const clips = [];
    for (let clipIndex = 0; clipIndex < 100; clipIndex++) {
      clips.push({
        kind: 'video' as const,
        id: `clip-t${trackIndex}-c${clipIndex}`,
        startUs: clipIndex * 100_000,
        durationUs: 100_000,
        assetId: 'asset-placeholder',
        sourceInUs: 0,
      });
    }
    tracks.push({
      id: `track-${trackIndex}`,
      kind: 'video' as const,
      order: trackIndex,
      enabled: true,
      clips,
    });
  }

  return {
    schemaVersion: 0 as const,
    id: 'ten-thousand-clip-project',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Ten Thousand Clip Project',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        durationUs: 10_000_000,
        tracks,
      },
    },
  };
}
