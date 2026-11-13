import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { renderHeadlessFrame } from '@joy-media/renderer-headless';
import { buildRenderFrameIRFromProject } from '@joy-media/visual-object-renderer';
import { calculateMediaFitTransform } from './media-fit-transform.js';
import { buildMediaPlacementDocument } from './place-timeline-element.js';

const legacyProject = JSON.parse(
  readFileSync(
    new URL('../../../tests/desktop/fixtures/demo-project.json', import.meta.url),
    'utf8',
  ),
) as JoyProjectV1;

describe('legacy media placement rendering', () => {
  it('keeps an old saved project frame unchanged when new media is placed', () => {
    const composition = legacyProject.compositions[legacyProject.rootCompositionId];
    if (composition === undefined) throw new Error('legacy fixture has no root composition');
    const before = renderHeadlessFrame(
      buildRenderFrameIRFromProject(
        legacyProject,
        composition.id,
        0,
        composition.width,
        composition.height,
      ),
    );

    const withNewMedia = buildMediaPlacementDocument({
      baseProject: legacyProject,
      asset: {
        id: 'asset-new-fit-test',
        kind: 'image',
        displayName: 'New media',
        descriptor: { mimeType: 'image/png', width: 960, height: 540 },
      },
      clipId: 'clip-new-fit-test',
      planned: {
        compositionId: composition.id,
        trackId: composition.tracks[0]!.id,
        clip: {
          id: 'clip-new-fit-test',
          kind: 'video',
          assetId: 'asset-new-fit-test',
          startUs: composition.durationUs,
          durationUs: 1_000_000,
          sourceInUs: 0,
        },
      },
    });
    const after = renderHeadlessFrame(
      buildRenderFrameIRFromProject(
        withNewMedia,
        composition.id,
        0,
        composition.width,
        composition.height,
      ),
    );

    expect(withNewMedia.visualObjects['video-controller']).toEqual(
      legacyProject.visualObjects['video-controller'],
    );
    expect(withNewMedia.visualObjects['image-object']).toEqual(
      legacyProject.visualObjects['image-object'],
    );
    const expectedFit = calculateMediaFitTransform({
      sourceWidth: 960,
      sourceHeight: 540,
      frameWidth: composition.width,
      frameHeight: composition.height,
      mode: 'fit',
    });
    expect(expectedFit).toBeDefined();
    expect(
      withNewMedia.visualObjects['media-controller-clip-new-fit-test']?.transform,
    ).toMatchObject(expectedFit!);
    expect(Array.from(after.pixels)).toEqual(Array.from(before.pixels));
  });
});
