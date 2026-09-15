import { describe, expect, it } from 'vitest';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import {
  joyCodeAssetDescriptorsFromProject,
  resolveJoyCodeInsertableAsset,
} from './joy-code-asset-descriptors.js';

describe('Joy Code trusted asset descriptors', () => {
  it('derives immutable media identity from the canonical project document', () => {
    const project = {
      ...INITIAL_EDITOR_PROJECT,
      assets: {
        'voice-over': {
          id: 'voice-over',
          kind: 'audio' as const,
          displayName: 'Voice over',
          descriptor: { mimeType: 'audio/wav', durationUs: 1_000_000 },
        },
      },
    };
    const descriptors = joyCodeAssetDescriptorsFromProject(project);

    expect(descriptors).toEqual([
      {
        id: 'voice-over',
        kind: 'audio',
        descriptor: { mimeType: 'audio/wav', durationUs: 1_000_000 },
      },
    ]);
    expect(Object.isFrozen(descriptors)).toBe(true);
    expect(Object.isFrozen(descriptors[0]!)).toBe(true);
    expect(resolveJoyCodeInsertableAsset('voice-over', descriptors)).toMatchObject({
      ok: true,
      trackFamily: 'audio',
    });
  });

  it.each(['lut', 'other'] as const)(
    'rejects %s project assets instead of returning a visual fallback',
    (kind) => {
      const descriptors = joyCodeAssetDescriptorsFromProject({
        ...INITIAL_EDITOR_PROJECT,
        assets: {
          unsupported: { id: 'unsupported', kind, displayName: 'Unsupported' },
        },
      });

      expect(resolveJoyCodeInsertableAsset('unsupported', descriptors)).toMatchObject({
        ok: false,
        code: 'JOY_CODE_TIMELINE_ASSET_UNSUPPORTED',
      });
    },
  );

  it('does not turn a bare asset ID into authority', () => {
    expect(resolveJoyCodeInsertableAsset('not-in-project', [])).toMatchObject({
      ok: false,
      code: 'JOY_CODE_TIMELINE_ASSET_UNAVAILABLE',
    });
  });
});
