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
  });
});
