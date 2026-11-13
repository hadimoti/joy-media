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
});
