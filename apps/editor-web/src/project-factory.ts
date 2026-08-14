import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import {
  buildReferenceSpikeProject,
  emptySpikeProject,
  REFERENCE_PROJECT,
} from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT, DEFAULT_COMPOSITION_SIZE } from './editor-project.js';
import type { ProjectCatalogEntry } from './project-catalog.js';
import {
  buildTimelineElementsShowcase,
  TIMELINE_ELEMENTS_SHOWCASE,
} from './timeline-elements-showcase.js';

/** Blank creative documents for a brand-new library project (same id on both slices). */
export function createBlankProjectDocuments(
  projectId: string,
  title: string,
  now: string = new Date().toISOString(),
): { readonly timeline: SpikeProject; readonly visual: JoyProjectV1 } {
  const base = emptySpikeProject({
    trackCount: 2,
    durationUs: 60_000_000,
    frameRate: { num: 30, den: 1 },
  });
  const timeline: SpikeProject = { ...base, id: projectId };
  const visual: JoyProjectV1 = {
    schemaVersion: 1,
    id: projectId,
    title,
    createdAt: now,
    updatedAt: now,
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Root composition',
        width: DEFAULT_COMPOSITION_SIZE.width,
        height: DEFAULT_COMPOSITION_SIZE.height,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 60_000_000,
        background: '#000000',
        tracks: [
          {
            id: 'caption-track',
            kind: 'caption',
            name: 'Captions',
            order: 0,
            enabled: true,
            locked: false,
            clips: [],
          },
        ],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: {},
    pluginData: {},
  };
  return { timeline, visual };
}

/**
 * Seeds passed to EditorSession for recover-or-initialize. Existing store data
 * wins; seeds only materialize on first open.
 */
export function seedsForCatalogEntry(entry: ProjectCatalogEntry): {
  readonly timeline: SpikeProject;
  readonly visual: JoyProjectV1;
} {
  if (
    entry.id === TIMELINE_ELEMENTS_SHOWCASE.id ||
    entry.timelineProjectId === TIMELINE_ELEMENTS_SHOWCASE.id ||
    entry.visualProjectId === TIMELINE_ELEMENTS_SHOWCASE.id
  ) {
    return buildTimelineElementsShowcase(entry.title, entry.createdAt);
  }
  if (
    entry.timelineProjectId === REFERENCE_PROJECT.id ||
    entry.visualProjectId === INITIAL_EDITOR_PROJECT.id
  ) {
    return {
      timeline: { ...buildReferenceSpikeProject(), id: entry.timelineProjectId },
      visual: {
        ...INITIAL_EDITOR_PROJECT,
        id: entry.visualProjectId,
        title: entry.title,
      },
    };
  }
  return createBlankProjectDocuments(entry.id, entry.title, entry.createdAt);
}
