import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateJoyProjectV1 } from '@joy-media/project-schema';
import { effectRegistry, registerBuiltins } from '@joy-media/visual-effects';
import { buildTimelineElementsShowcase } from './timeline-elements-showcase.js';
import { effectsByObjectIdAt } from './adjustment-render.js';
import { libraryHomeOf } from './library-homes.js';
import { importProjectPackage, parseProjectPackage } from './project-package.js';
import { readProjectBundle } from './project-lifecycle.js';

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

/**
 * A real file in the shape the previous release saved (a JOY project package,
 * schemaVersion 1), with a moved item (halftone), an Effect that never moved
 * (brightness-contrast) and a Filter that stayed (gaussian-blur). It is loaded
 * through the same path a user's opened file takes: parse, import, read the bundle.
 */
const OLD_RELEASE_PACKAGE = fileURLToPath(
  new URL('./fixtures/old-release-moved-items-package.json', import.meta.url),
);

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe('an old-release project file with moved items (T-V06 fixture)', () => {
  it('loads through the project loader and resolves each effect node exactly as saved', async () => {
    registerBuiltins();
    const storage = memoryStorage();
    const pkg = parseProjectPackage(JSON.parse(readFileSync(OLD_RELEASE_PACKAGE, 'utf8')));
    const imported = await importProjectPackage(storage, pkg, {
      createId: () => 'old-release-project',
      now: () => '2026-11-13T00:00:00.000Z',
    });
    const bundle = readProjectBundle(storage, imported.entry);

    const resolved = effectsByObjectIdAt(bundle.visual, bundle.timeline, 1_000_000)['image-object'];
    expect(resolved).toEqual([
      { id: 'old-halftone', effectId: 'halftone', enabled: true, params: HALFTONE_PARAMS },
      {
        id: 'old-brightness',
        effectId: 'brightness-contrast',
        enabled: true,
        params: { brightness: 0.1, contrast: -0.2 },
      },
      { id: 'old-blur', effectId: 'gaussian-blur', enabled: true, params: { amount: 4 } },
    ]);
  });

  it('keeps each registry category, so the render routing is unchanged', () => {
    registerBuiltins();
    expect(effectRegistry.getEffect('halftone')?.category).toBe('artistic');
    expect(effectRegistry.getEffect('brightness-contrast')?.category).toBe('color');
    expect(effectRegistry.getEffect('gaussian-blur')?.category).toBe('blur');
  });

  it('shows the moved item in Effects and the kept Filter in Filters', () => {
    expect(libraryHomeOf('halftone')).toBe('effects');
    expect(libraryHomeOf('brightness-contrast')).toBe('effects');
    expect(libraryHomeOf('gaussian-blur')).toBe('filters');
  });
});
