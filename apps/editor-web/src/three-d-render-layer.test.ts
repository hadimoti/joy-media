import { applyTransaction } from '@joy-media/commands';
import { describe, expect, it } from 'vitest';
import { resolveObjectIdForSelection } from './sticker-bindings.js';
import { readTimelineElementKindMap } from './timeline-element-kind.js';
import { buildTimelineElementsShowcase } from './timeline-elements-showcase.js';
import { buildThreeDRenderLayerInsertion, THREE_D_PLUGIN_KEY } from './three-d-render-layer.js';

describe('buildThreeDRenderLayerInsertion', () => {
  it('creates one image-backed 3D track with durable timeline semantics', () => {
    const seed = buildTimelineElementsShowcase();
    const insertion = buildThreeDRenderLayerInsertion({
      timeline: seed.timeline,
      project: seed.visual,
      playheadUs: 29_000_000,
      token: 'test',
      asset: {
        assetId: 'render-3d-test',
        displayName: 'Product Orbit · 3D Render',
        bytes: 2048,
        mimeType: 'image/png',
        sha256: 'a'.repeat(64),
        scene: {
          version: 1,
          sceneId: 'scene-orbit',
          sourceRefs: ['product.glb', 'product.bin'],
          camera: { position: [1, 2, 6], target: [0, 0, 0] },
          model: { position: [0, 0, 0], rotation: [0, 0.5, 0], scale: [1, 1, 1] },
          light: { intensity: 1.2, color: '#ffffff' },
          material: { colors: ['#ff0000'] },
        },
      },
    });
    const timeline = applyTransaction(seed.timeline, insertion.timeline).project;
    const clip = timeline.compositions.root?.tracks.find((track) => track.id === '3D-test')
      ?.clips[0];

    expect(clip).toMatchObject({
      id: 'clip-scene3d-test',
      assetId: 'render-3d-test',
      startUs: 29_000_000,
      durationUs: 1_000_000,
    });
    expect(readTimelineElementKindMap(insertion.project)[clip!.id]).toBe('scene3d');
    expect(resolveObjectIdForSelection(insertion.project, [clip!.id])).toBe('scene3d-test');
    expect(insertion.project.visualObjects['scene3d-test']).toMatchObject({
      kind: 'image',
      assetId: 'render-3d-test',
    });
    expect(insertion.project.assets['render-3d-test']).toMatchObject({
      kind: 'image',
      bytes: 2048,
      sha256: 'a'.repeat(64),
      descriptor: { mimeType: 'image/png' },
    });
    expect(insertion.project.pluginData[THREE_D_PLUGIN_KEY]).toMatchObject({
      'scene-orbit': { version: 1, sourceRefs: ['product.glb', 'product.bin'] },
    });
  });
});
