import { describe, expect, it } from 'vitest';
import {
  VerifiedDeliverySnapshotCache,
  createVerifiedDeliverySnapshot,
} from './verified-delivery-snapshot.js';
import { captionBurnInDigestV2 } from '../../../packages/render-planner/src/v2.js';

describe('verified delivery snapshot cache', () => {
  it('carries planner-normalized static overlay, caption intent, and asset bindings', async () => {
    const timeline = {
      schemaVersion: 0 as const,
      id: 'timeline',
      rootCompositionId: 'root',
      compositions: {
        root: {
          id: 'root',
          name: 'Root',
          width: 64,
          height: 36,
          frameRate: { num: 24, den: 1 },
          durationUs: 1_000_000,
          tracks: [
            {
              id: 'video',
              kind: 'video' as const,
              order: 0,
              enabled: true,
              clips: [
                {
                  id: 'clip',
                  kind: 'video' as const,
                  assetId: 'video',
                  startUs: 0,
                  durationUs: 1_000_000,
                  sourceInUs: 0,
                },
              ],
            },
          ],
        },
      },
    };
    const visual = {
      schemaVersion: 1 as const,
      id: 'visual',
      title: 'Visual',
      createdAt: '2026-08-26',
      updatedAt: '2026-08-26',
      rootCompositionId: 'root',
      settings: { defaultLocale: 'en' },
      compositions: {
        root: {
          id: 'root',
          name: 'Root',
          width: 64,
          height: 36,
          pixelAspectRatio: { num: 1, den: 1 },
          frameRate: { num: 24, den: 1 },
          durationUs: 1_000_000,
          background: '#000',
          tracks: [
            {
              id: 'captions',
              kind: 'caption' as const,
              name: 'Captions',
              order: 1,
              enabled: true,
              locked: false,
              clips: [
                {
                  id: 'caption',
                  kind: 'caption' as const,
                  startUs: 0,
                  durationUs: 1_000_000,
                  captionDocumentId: 'doc',
                },
              ],
            },
          ],
        },
      },
      assets: {
        video: { id: 'video', kind: 'video' as const, displayName: 'Video' },
        overlay: { id: 'overlay', kind: 'image' as const, displayName: 'Overlay' },
      },
      variables: {},
      markers: [],
      visualObjects: {
        overlay: {
          id: 'overlay',
          kind: 'image' as const,
          assetId: 'overlay',
          transform: {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotationDeg: 0,
            opacity: 1,
            crop: { left: 0, top: 0, right: 0, bottom: 0 },
          },
        },
      },
      captionDocuments: {
        doc: {
          id: 'doc',
          language: 'en',
          direction: 'ltr' as const,
          speakers: [],
          words: { word: { id: 'word', text: 'JOY', startUs: 0, endUs: 500_000 } },
          segments: [{ id: 'cue', startUs: 0, endUs: 500_000, wordIds: ['word'] }],
          styleRef: 'joy-clean',
        },
      },
      pluginData: { 'joy.captions.burnIn': true },
    };
    const bytes = { sha256: 'a'.repeat(64), bytes: 1, mimeType: 'video/mp4' };
    const image = { sha256: 'b'.repeat(64), bytes: 2, mimeType: 'image/png' };
    const snapshot = await createVerifiedDeliverySnapshot({
      timelineProject: timeline,
      visualProject: visual,
      projectRef: 'project',
      assets: { video: { id: 'video', ...bytes }, overlay: { id: 'overlay', ...image } },
    });
    expect(snapshot.plan.layers.map((layer) => layer.kind)).toEqual(['video', 'image']);
    expect(snapshot.plan.captionBurnIn?.payloadSha256).toBe(
      captionBurnInDigestV2(snapshot.plan.captionBurnIn!),
    );
    expect(Object.keys(snapshot.assets).sort()).toEqual(['overlay', 'video']);
    expect(snapshot.snapshot.planSha256).toBe(snapshot.plan.planSha256);
  });
  it('reuses within a durable revision and invalidates after an edit revision', () => {
    const cache = new VerifiedDeliverySnapshotCache();
    const first = { version: 2 as const } as never;
    const edited = { version: 2 as const } as never;
    expect(cache.getOrCreate('project:revision-a', () => first)).toBe(first);
    expect(cache.getOrCreate('project:revision-a', () => edited)).toBe(first);
    expect(cache.getOrCreate('project:revision-b', () => edited)).toBe(edited);
  });
});
