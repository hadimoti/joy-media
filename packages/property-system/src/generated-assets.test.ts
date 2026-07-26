import { describe, expect, it } from 'vitest';
import { migrateV0ToV1, validateJoyProjectV1 } from '@joy-media/project-schema';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import { VisualObjectProjectHistory } from './index.js';

describe('generated asset project transactions', () => {
  it('persists complete provenance and removes the project reference on undo', () => {
    const history = new VisualObjectProjectHistory(migrateV0ToV1(emptySpikeProject()).project);
    const generationProvenance = {
      providerId: 'local-comfy',
      modelId: 'background-removal',
      modelVersion: 'v1',
      prompt: 'Remove the background',
      seed: 42,
      inputAssetHashes: ['a'.repeat(64)],
      parameters: { matte: 'transparent' },
      generatedAssetId: 'generated-image-1',
      cost: { amount: '0.00', currency: 'USD' },
      createdAt: '2026-07-26T12:00:00.000Z',
    } as const;

    history.apply({
      label: 'Register generated image',
      commands: [
        {
          type: 'asset.registerGenerated',
          payload: {
            asset: {
              id: 'generated-image-1',
              kind: 'image',
              displayName: 'Background removed',
              generationProvenance,
            },
          },
        },
      ],
    });

    expect(history.present.assets['generated-image-1']?.generationProvenance).toEqual(
      generationProvenance,
    );
    expect(validateJoyProjectV1(history.present)).toEqual([]);

    history.undo();
    expect(history.present.assets['generated-image-1']).toBeUndefined();
    history.redo();
    expect(history.present.assets['generated-image-1']?.generationProvenance).toEqual(
      generationProvenance,
    );
  });
});
