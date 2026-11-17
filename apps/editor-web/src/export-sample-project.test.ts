import { describe, expect, it } from 'vitest';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import { buildReferenceSpikeProject, REFERENCE_PROJECT } from '@joy-media/test-fixtures';

import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { preflightExportClipSources, type ExportClipSourcePreflight } from './export-preload.js';
import type { ProjectCatalogEntry } from './project-catalog.js';
import { seedsForCatalogEntry } from './project-factory.js';
import { ProjectMediaResolver } from './project-media-resolver.js';
import { SAMPLE_MEDIA } from './sample-media-cache.js';
import { flattenRootTimelineVideoClips } from './timeline-nested-playback.js';

const NOW = '1970-01-01T00:00:00.000Z';

/** The catalog entry the "Local editor project" card opens. */
const SAMPLE_ENTRY: ProjectCatalogEntry = {
  id: INITIAL_EDITOR_PROJECT.id,
  title: INITIAL_EDITOR_PROJECT.title,
  createdAt: NOW,
  updatedAt: NOW,
  timelineProjectId: REFERENCE_PROJECT.id,
  visualProjectId: INITIAL_EDITOR_PROJECT.id,
};

/**
 * The preflight input the export builds for each video clip (App.tsx, exportClipPreflight). A clip with no
 * mask source plays its own asset, which is the case for the sample.
 */
function preflightInputFor(
  timeline: SpikeProject,
  visual: JoyProjectV1,
): readonly ExportClipSourcePreflight[] {
  return flattenRootTimelineVideoClips(timeline).map((clip) => ({
    clipId: clip.id,
    visualAssetId: clip.assetId,
    visualAssetLabel: visual.assets[clip.assetId]?.displayName ?? clip.assetId,
    audioAssetId: clip.assetId,
    audioAssetLabel: visual.assets[clip.assetId]?.displayName ?? clip.assetId,
  }));
}

/** The app's media resolver for a profile with no owner storage and an empty original cache. */
function resolverFor(visual: JoyProjectV1): ProjectMediaResolver {
  return new ProjectMediaResolver({
    projectId: visual.id,
    controlPlaneReady: false,
    project: visual,
    client: { assets: async () => [] },
    originalCache: { get: async () => undefined },
  });
}

describe('the Local editor sample through the export preflight', () => {
  it('preflights every clip of the sample document to a file the app ships', async () => {
    const seeds = seedsForCatalogEntry(SAMPLE_ENTRY);
    const input = preflightInputFor(seeds.timeline, seeds.visual);
    const resolver = resolverFor(seeds.visual);

    const prepared = await preflightExportClipSources(input, (assetId) =>
      resolver.resolve(assetId),
    );

    expect([...prepared.keys()]).toEqual(input.map((clip) => clip.clipId));
    const shipped = new Set(SAMPLE_MEDIA.map((media) => media.assetId));
    for (const clip of input) expect(shipped.has(clip.visualAssetId)).toBe(true);
    for (const source of prepared.values()) {
      expect(source.visualSource.url).toMatch(
        /^\/media\/reference\/asset-(intro|product|outro)\.mp4$/u,
      );
      expect(source.audioSource).toBe(source.visualSource);
    }
  });

  it('refuses the reference timeline the sample used to carry, in plain words that name both clips', async () => {
    const seeds = seedsForCatalogEntry(SAMPLE_ENTRY);
    const input = preflightInputFor(buildReferenceSpikeProject(), seeds.visual);
    const resolver = resolverFor(seeds.visual);

    await expect(
      preflightExportClipSources(input, (assetId) => resolver.resolve(assetId)),
    ).rejects.toThrow(
      'Missing media in this export: b-roll-a, b-roll-b. Relink or replace the clips.',
    );
  });
});
