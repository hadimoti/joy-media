import { describe, expect, it } from 'vitest';
import { FEATURE_HUBS, featureActivationRoute } from './feature-architecture.js';

describe('feature architecture', () => {
  it('keeps the two compact hubs exhaustive and free of Stickers', () => {
    expect(FEATURE_HUBS.create.tools.map((tool) => tool.id)).toEqual([
      'media',
      'text',
      'captions',
      'audio',
      'templates',
    ]);
    expect(FEATURE_HUBS.enhance.tools.map((tool) => tool.id)).toEqual([
      'motion',
      'transitions',
      'effects',
      'filters',
      'color',
      'adjust',
    ]);
    const semantics = new Set(
      Object.values(FEATURE_HUBS).flatMap((hub) => hub.tools.flatMap((tool) => tool.timelineKinds)),
    );
    expect(semantics).toEqual(
      new Set([
        'video',
        'overlay',
        'scene3d',
        'text',
        'caption',
        'audio',
        'motion',
        'transition',
        'effect',
        'filter',
        'adjust',
      ]),
    );
    expect([...semantics]).not.toContain('sticker');
    expect(FEATURE_HUBS.enhance.tools.find((tool) => tool.id === 'transitions')).toMatchObject({
      timelineBehavior: 'junction',
    });
  });

  it('routes specialist features through compact dock hubs', () => {
    expect(featureActivationRoute('captions')).toEqual({
      hub: 'create',
      dockPanelId: 'media',
      toolId: 'captions',
    });
    expect(featureActivationRoute('color')).toEqual({
      hub: 'enhance',
      dockPanelId: 'effects',
      toolId: 'color',
    });
    expect(featureActivationRoute('jobs')).toBeUndefined();
  });
});
