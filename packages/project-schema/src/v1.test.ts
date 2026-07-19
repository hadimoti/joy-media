import { describe, expect, it } from 'vitest';
import { migrateV0ToV1 } from './migration.js';
import type { SpikeProject } from './model.js';
import { rational } from './time.js';
import { validateJoyProjectV1 } from './v1.js';

function v0Fixture(): SpikeProject {
  return {
    schemaVersion: 0,
    id: 'v0-fixture',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'V0 Root',
        width: 1920,
        height: 1080,
        frameRate: rational(30, 1),
        durationUs: 1_000_000,
        tracks: [
          {
            id: 'video-1',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-1',
                startUs: 0,
                durationUs: 1_000_000,
                assetId: 'asset-1',
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
    },
  };
}

describe('v1 project schema and migration harness', () => {
  it('migrates the v0 fixture into a valid v1 document with explicit defaults', () => {
    const result = migrateV0ToV1(v0Fixture());
    expect(result.project.schemaVersion).toBe(1);
    expect(result.project.assets['asset-1']).toEqual({
      id: 'asset-1',
      kind: 'video',
      displayName: 'asset-1',
    });
    expect(result.project.compositions.root!.tracks[0]).toMatchObject({
      name: 'video-1',
      locked: false,
    });
    expect(validateJoyProjectV1(result.project)).toEqual([]);
    expect(result.report.defaultsApplied).toContain('pixelAspectRatio');
  });

  it('reports invalid untrusted v1 documents without throwing', () => {
    const diagnostics = validateJoyProjectV1({
      schemaVersion: 1,
      id: '',
      title: '',
      rootCompositionId: 'nope',
      compositions: {},
      assets: {},
      variables: {},
      markers: [],
      visualObjects: {},
      pluginData: {},
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('PROJECT_SCHEMA_V1_ROOT');
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('PROJECT_SCHEMA_V1_ID');
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'PROJECT_SCHEMA_V1_CAPTION_DOCUMENTS',
    );
  });

  it('accepts a valid caption document and caption clip on a caption track', () => {
    const project = {
      ...migrateV0ToV1(v0Fixture()).project,
      captionDocuments: {
        'doc-fa': {
          id: 'doc-fa',
          language: 'fa-IR',
          direction: 'rtl',
          speakers: [{ id: 's1', name: 'راوی' }],
          words: {
            w1: {
              id: 'w1',
              text: 'سلام',
              startUs: 0,
              endUs: 500_000,
              confidence: 0.9,
              speakerId: 's1',
            },
          },
          segments: [{ id: 'seg-1', startUs: 0, endUs: 500_000, wordIds: ['w1'], speakerId: 's1' }],
        },
      },
    };
    const withCaptionTrack = {
      ...project,
      compositions: {
        root: {
          ...project.compositions.root!,
          tracks: [
            ...project.compositions.root!.tracks,
            {
              id: 'captions',
              kind: 'caption' as const,
              name: 'Captions',
              order: 1,
              enabled: true,
              locked: false,
              clips: [
                {
                  kind: 'caption' as const,
                  id: 'caption-clip',
                  startUs: 0,
                  durationUs: 500_000,
                  captionDocumentId: 'doc-fa',
                },
              ],
            },
          ],
        },
      },
    };
    expect(validateJoyProjectV1(withCaptionTrack)).toEqual([]);
  });

  it('reports caption structure violations with coded diagnostics', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const diagnostics = validateJoyProjectV1({
      ...base,
      captionDocuments: {
        broken: {
          id: 'broken',
          language: 'en',
          direction: 'sideways',
          speakers: [],
          words: {
            w1: { id: 'w1', text: 'hi', startUs: 500_000, endUs: 500_000 },
            w2: { id: 'other-id', text: 'oops', startUs: 0, endUs: 100_000 },
          },
          segments: [
            { id: 'seg', startUs: 0, endUs: 100_000, wordIds: ['missing'], speakerId: 'ghost' },
          ],
        },
      },
      compositions: {
        root: {
          ...base.compositions.root!,
          tracks: [
            {
              ...base.compositions.root!.tracks[0]!,
              clips: [
                ...base.compositions.root!.tracks[0]!.clips,
                {
                  kind: 'caption',
                  id: 'misplaced',
                  startUs: 0,
                  durationUs: 100_000,
                  captionDocumentId: 'nope',
                },
              ],
            },
          ],
        },
      },
    });
    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('PROJECT_SCHEMA_V1_CAPTION_DOCUMENT'); // bad direction
    expect(codes).toContain('PROJECT_SCHEMA_V1_CAPTION_WORD'); // empty range + key mismatch
    expect(codes).toContain('PROJECT_SCHEMA_V1_CAPTION_SEGMENT'); // unknown word + speaker
    // Caption clip on a video track referencing a missing document.
    expect(codes.filter((code) => code === 'PROJECT_SCHEMA_V1_CAPTION_CLIP')).toHaveLength(2);
  });
});
