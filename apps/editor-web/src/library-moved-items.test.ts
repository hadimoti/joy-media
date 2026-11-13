import { describe, expect, it } from 'vitest';
import { validateJoyProjectV1 } from '@joy-media/project-schema';
import { effectRegistry, registerBuiltins } from '@joy-media/visual-effects';
import { buildTimelineElementsShowcase } from './timeline-elements-showcase.js';
import { effectsByObjectIdAt } from './adjustment-render.js';
import { libraryHomeOf } from './library-homes.js';

const HALFTONE_PARAMS = {
  cellSize: 10,
  angle: 22.5,
  dotScale: 1,
  shape: 0,
  colorMode: 0,
  invert: 0,
} as const;

/** A project that uses one of the five items that moved to Effects. */
function projectWithMovedItem() {
  const { timeline, visual } = buildTimelineElementsShowcase();
  const object = visual.visualObjects['showcase-overlay-object']!;
  const project = {
    ...visual,
    visualObjects: {
      ...visual.visualObjects,
      'showcase-overlay-object': {
        ...object,
        effects: [
          {
            id: 'showcase-halftone',
            effectId: 'halftone',
            enabled: true,
            params: HALFTONE_PARAMS,
          },
        ],
      },
    },
  };
  return { timeline, project, visual };
}

describe('a project that uses a moved item (T-V06)', () => {
  it('opens without a new complaint', () => {
    const { project, visual } = projectWithMovedItem();
    expect(validateJoyProjectV1(project)).toEqual(validateJoyProjectV1(visual));
  });

  it('renders the same effect, because the registry id did not change', () => {
    registerBuiltins();
    const { timeline, project } = projectWithMovedItem();
    const routed = effectsByObjectIdAt(project, timeline, 4_000_000);
    expect(routed['showcase-overlay-object']?.map((effect) => effect.effectId)).toEqual([
      'halftone',
    ]);
    expect(routed['showcase-overlay-object']?.[0]?.params).toEqual(HALFTONE_PARAMS);
    expect(effectRegistry.getEffect('halftone')?.label).toBe('Halftone Press');
  });

  it('shows the item in its new panel, not in both', () => {
    expect(libraryHomeOf('halftone')).toBe('effects');
  });

  it('opens a saved old project with a moved item and a kept item, rendering both unchanged', () => {
    registerBuiltins();
    const { timeline, visual } = buildTimelineElementsShowcase();
    const object = visual.visualObjects['showcase-overlay-object']!;
    // What an old build saved: a drawn style that moved to Effects, and a filter that stayed.
    const savedEffects = [
      { id: 'showcase-halftone', effectId: 'halftone', enabled: true, params: HALFTONE_PARAMS },
      { id: 'showcase-blur', effectId: 'gaussian-blur', enabled: true, params: { amount: 4 } },
    ];
    const savedFile = JSON.stringify({
      ...visual,
      visualObjects: {
        ...visual.visualObjects,
        'showcase-overlay-object': { ...object, effects: savedEffects },
      },
    });

    // Opened from the file, as a user would open it.
    const opened = JSON.parse(savedFile) as typeof visual;
    expect(validateJoyProjectV1(opened)).toEqual(validateJoyProjectV1(visual));

    // Before: the saved records. After: the instances the render routes.
    const routed = effectsByObjectIdAt(opened, timeline, 4_000_000)['showcase-overlay-object'];
    expect(routed).toEqual(savedEffects);
    for (const effect of savedEffects) {
      expect(effectRegistry.getEffect(effect.effectId)?.id).toBe(effect.effectId);
    }
    expect(libraryHomeOf('halftone')).toBe('effects');
    expect(libraryHomeOf('gaussian-blur')).toBe('filters');
  });
});
