import { describe, expect, it } from 'vitest';
import {
  applyPreparedOperations,
  canonicalJson,
  changedEntities,
  preparedPlanId,
} from './prepared-edit.js';
import type { CliProjectDocument } from '../utils/project-loader.js';

function fixture(): CliProjectDocument {
  return {
    schemaVersion: 3,
    id: 'project-1',
    title: 'Fixture',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 1920,
        height: 1080,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 10_000_000,
        background: '#000',
        tracks: [
          {
            id: 'v1',
            kind: 'video',
            family: 'visual',
            name: 'Video',
            order: 0,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'c1',
                kind: 'video',
                assetId: 'asset-a',
                sourceInUs: 0,
                startUs: 0,
                durationUs: 5_000_000,
              },
            ],
          },
          {
            id: 'v2',
            kind: 'video',
            family: 'visual',
            name: 'Video 2',
            order: 1,
            enabled: true,
            locked: false,
            clips: [],
          },
        ],
      },
    },
    assets: { 'asset-a': { id: 'asset-a', kind: 'video', displayName: 'a.mp4' } },
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as CliProjectDocument;
}

describe('prepared edit pure helpers', () => {
  it('canonical JSON sorts object keys recursively and retains array order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [2, 1] })).toBe(
      '{"a":{"x":3,"y":2},"list":[2,1],"z":1}',
    );
  });

  it('canonical JSON orders integer-like keys as strings at every depth', () => {
    expect(canonicalJson({ '2': 'b', '10': 'a', nested: { '3': 1, '20': 2 } })).toBe(
      '{"10":"a","2":"b","nested":{"20":2,"3":1}}',
    );
  });

  it('plan identity changes when any immutable field changes', () => {
    const plan = { schemaVersion: 1, baseRevision: 2, resultHash: 'sha256:a', planId: 'ignored' };
    expect(preparedPlanId(plan)).not.toBe(preparedPlanId({ ...plan, resultHash: 'sha256:b' }));
  });

  it('diff lists exactly the moved and trimmed clip entities', () => {
    const before = fixture();
    const after = applyPreparedOperations(before, [
      { id: 'op-1', op: 'trimClip', clipId: 'c1', durationUs: 4_000_000 },
      { id: 'op-2', op: 'moveClip', clipId: 'c1', trackId: 'v2', startUs: 1_000_000 },
    ]);
    expect(changedEntities(before, after)).toEqual([
      { kind: 'clip', id: 'c1', change: 'modified' },
    ]);
  });
});
