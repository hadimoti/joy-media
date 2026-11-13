import { describe, expect, it } from 'vitest';
import { REFERENCE_PROJECT } from '@joy-media/test-fixtures';
import { DEFAULT_COMPOSITION_SIZE, INITIAL_EDITOR_PROJECT } from './editor-project.js';
import type { ProjectCatalogEntry } from './project-catalog.js';
import { createBlankProjectDocuments, seedsForCatalogEntry } from './project-factory.js';
import { TIMELINE_ELEMENTS_SHOWCASE } from './timeline-elements-showcase.js';

const NOW = '2026-11-13T09:00:00.000Z';

function rootOf(doc: { readonly compositions: Record<string, unknown> }, id: string) {
  return doc.compositions[id] as { width: number; height: number };
}

describe('createBlankProjectDocuments: the canvas the person chose', () => {
  it('gives a new project the 16:9 1920×1080 default when no format is passed', () => {
    const { timeline, visual } = createBlankProjectDocuments('p1', 'Default', NOW);

    expect(rootOf(visual, 'root')).toMatchObject({ width: 1920, height: 1080 });
    expect(rootOf(timeline, 'root')).toMatchObject({ width: 1920, height: 1080 });
    expect(visual.exportPreset).toBe('youtube-1080');
  });

  it.each([
    ['youtube-16-9', { width: 1920, height: 1080 }, 'youtube-1080'],
    ['reels-9-16', { width: 1080, height: 1920 }, 'reels-1080'],
    ['square-1-1', { width: 1080, height: 1080 }, 'square-1080'],
    ['feed-4-5', { width: 1080, height: 1350 }, 'instagram-feed-4x5'],
  ] as const)(
    'gives %s the canvas and preset it was chosen with, on both documents',
    (_id, canvas, presetId) => {
      const { timeline, visual } = createBlankProjectDocuments(
        'p2',
        'Chosen',
        NOW,
        canvas,
        presetId,
      );

      expect(rootOf(visual, 'root')).toMatchObject(canvas);
      expect(rootOf(timeline, 'root')).toMatchObject(canvas);
      expect(visual.exportPreset).toBe(presetId);
    },
  );

  it('uses a custom canvas as given, with the custom preset', () => {
    const { timeline, visual } = createBlankProjectDocuments(
      'p3',
      'Custom',
      NOW,
      { width: 1600, height: 900 },
      'custom',
    );

    expect(rootOf(visual, 'root')).toMatchObject({ width: 1600, height: 900 });
    expect(rootOf(timeline, 'root')).toMatchObject({ width: 1600, height: 900 });
    expect(visual.exportPreset).toBe('custom');
  });

  it('derives the preset from the canvas when none is passed', () => {
    const { visual } = createBlankProjectDocuments('p4', 'Derived', NOW, {
      width: 1080,
      height: 1350,
    });

    expect(visual.exportPreset).toBe('instagram-feed-4x5');
  });

  it('keeps the default size constant at 1920×1080', () => {
    expect(DEFAULT_COMPOSITION_SIZE).toEqual({ width: 1920, height: 1080 });
  });
});

describe('seedsForCatalogEntry: the sample projects keep their own sizes', () => {
  const entry = (overrides: Partial<ProjectCatalogEntry>): ProjectCatalogEntry => ({
    id: 'entry',
    title: 'Entry',
    createdAt: NOW,
    updatedAt: NOW,
    timelineProjectId: 'entry',
    visualProjectId: 'entry',
    ...overrides,
  });

  it('seeds the Local editor project sample at 1080×1920', () => {
    const seeds = seedsForCatalogEntry(
      entry({ id: INITIAL_EDITOR_PROJECT.id, visualProjectId: INITIAL_EDITOR_PROJECT.id }),
    );

    expect(rootOf(seeds.visual, 'root')).toMatchObject({ width: 1080, height: 1920 });
  });

  it('seeds the timeline elements sample at 1080×1920', () => {
    const seeds = seedsForCatalogEntry(
      entry({
        id: TIMELINE_ELEMENTS_SHOWCASE.id,
        timelineProjectId: TIMELINE_ELEMENTS_SHOWCASE.id,
      }),
    );

    expect(rootOf(seeds.timeline, 'root')).toMatchObject({ width: 1080, height: 1920 });
  });

  it('keeps the reference project on its own timeline id', () => {
    const seeds = seedsForCatalogEntry(
      entry({
        timelineProjectId: REFERENCE_PROJECT.id,
        visualProjectId: INITIAL_EDITOR_PROJECT.id,
      }),
    );

    expect(seeds.timeline.id).toBe(REFERENCE_PROJECT.id);
  });
});
