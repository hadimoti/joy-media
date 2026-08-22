import { describe, expect, it } from 'vitest';
import { createBlankScene } from '@joy-media/motion-core';
import { applySceneCommand } from './sceneCommands.js';
import { createRectangleLayer, createTextLayer } from './layerFactory.js';

describe('Motion Studio scene editor command state', () => {
  it('builds a single inverse for a transform interaction that undo can replay', () => {
    const layer = createRectangleLayer(10, 20, 100, 80);
    const document = { ...createBlankScene('History'), layers: [layer] };

    const moved = applySceneCommand(document, {
      type: 'scene.setLayerTransform',
      payload: { layerId: layer.id, transform: { x: 50, y: 75 } },
    });
    const undone = applySceneCommand(moved.document, moved.inverse);

    expect(moved.document.layers[0]!.transform).toMatchObject({ x: 50, y: 75 });
    expect(undone.document.layers[0]!.transform).toEqual(layer.transform);
  });

  it('groups and ungroups layers without losing child identities', () => {
    const text = createTextLayer('A', 0, 0, 100, 50);
    const rect = createRectangleLayer(100, 0, 100, 50);
    const group = {
      ...createRectangleLayer(0, 0, 200, 50),
      id: 'group',
      type: 'group' as const,
      children: [text.id, rect.id],
    };
    const document = { ...createBlankScene('Group'), layers: [text, rect] };
    const withGroup = applySceneCommand(document, {
      type: 'scene.addLayer',
      payload: { layer: group },
    }).document;
    const parented = [text.id, rect.id].reduce(
      (current, layerId) =>
        applySceneCommand(current, {
          type: 'scene.setLayerProperty',
          payload: { layerId, property: 'parentId', value: group.id },
        }).document,
      withGroup,
    );

    expect(parented.layers.find((layer) => layer.id === text.id)?.parentId).toBe(group.id);
    expect(parented.layers.find((layer) => layer.id === rect.id)?.parentId).toBe(group.id);
  });
});
