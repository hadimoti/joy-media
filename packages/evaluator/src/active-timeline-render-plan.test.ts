import { describe, expect, it } from 'vitest';
import { rational } from '@joy-media/project-schema';
import { buildActiveTimelineRenderPlan } from './active-timeline-render-plan.js';

describe('buildActiveTimelineRenderPlan', () => {
  it('keeps audio-family clips out of the visual compositor', () => {
    const project = {
      schemaVersion: 0 as const,
      id: 'project',
      rootCompositionId: 'root',
      compositions: {
        root: {
          id: 'root',
          name: 'Root',
          width: 1920,
          height: 1080,
          frameRate: { num: 30, den: 1 },
          durationUs: 1_000_000,
          tracks: [
            {
              id: 'A1',
              kind: 'video' as const,
              family: 'audio' as const,
              order: 10,
              enabled: true,
              clips: [
                {
                  id: 'audio',
                  kind: 'video' as const,
                  assetId: 'voice.wav',
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
    expect(
      buildActiveTimelineRenderPlan(project, 0, { elementKindByClipId: { audio: 'audio' } }).items,
    ).toEqual([]);
  });
  it('includes every active layer and composites the top track last', () => {
    const project = {
      schemaVersion: 0 as const,
      id: 'p',
      rootCompositionId: 'root',
      compositions: {
        root: {
          id: 'root',
          name: 'Root',
          width: 100,
          height: 100,
          frameRate: rational(30, 1),
          durationUs: 10_000_000,
          tracks: [
            {
              id: 'top',
              kind: 'video' as const,
              order: 1,
              enabled: true,
              clips: [
                {
                  id: 'blue',
                  kind: 'video' as const,
                  assetId: 'asset-blue',
                  startUs: 0,
                  durationUs: 5_000_000,
                  sourceInUs: 0,
                },
              ],
            },
            {
              id: 'bottom',
              kind: 'video' as const,
              order: 0,
              enabled: true,
              clips: [
                {
                  id: 'red',
                  kind: 'video' as const,
                  assetId: 'asset-red',
                  startUs: 0,
                  durationUs: 5_000_000,
                  sourceInUs: 0,
                },
              ],
            },
          ],
        },
      },
    };
    const plan = buildActiveTimelineRenderPlan(project, 1_000_000);
    expect(plan.items.map((item) => item.id)).toEqual(['red', 'blue']);
    expect(plan.items.map((item) => item.zIndex)).toEqual([1, 2]);
  });

  it('keeps disabled tracks out and accepts explicit element/binding metadata', () => {
    const project = {
      schemaVersion: 0 as const,
      id: 'p',
      rootCompositionId: 'root',
      compositions: {
        root: {
          id: 'root',
          name: 'Root',
          width: 10,
          height: 10,
          frameRate: rational(30, 1),
          durationUs: 1_000_000,
          tracks: [
            {
              id: 'layer',
              kind: 'video' as const,
              order: 0,
              enabled: false,
              clips: [
                {
                  id: 'clip',
                  kind: 'video' as const,
                  assetId: 'asset',
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
    expect(buildActiveTimelineRenderPlan(project, 0).items).toEqual([]);
  });

  it('does not leak child-composition items into the root plan', () => {
    const project = {
      schemaVersion: 1 as const,
      id: 'nested',
      title: 'Nested',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      rootCompositionId: 'root',
      settings: { defaultLocale: 'en' },
      compositions: {
        root: {
          id: 'root',
          name: 'Root',
          width: 100,
          height: 100,
          pixelAspectRatio: { num: 1, den: 1 },
          frameRate: rational(30, 1),
          durationUs: 5_000_000,
          background: '#000',
          tracks: [
            {
              id: 'root-track',
              kind: 'video' as const,
              name: 'Root',
              order: 0,
              enabled: true,
              locked: false,
              clips: [],
            },
          ],
        },
        child: {
          id: 'child',
          name: 'Child',
          width: 100,
          height: 100,
          pixelAspectRatio: { num: 1, den: 1 },
          frameRate: rational(30, 1),
          durationUs: 5_000_000,
          background: '#000',
          tracks: [
            {
              id: 'child-track',
              kind: 'video' as const,
              name: 'Child',
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
      universalTimeline: {
        schemaVersion: 1 as const,
        items: [
          {
            id: 'child-only',
            compositionId: 'child',
            trackId: 'child-track',
            elementKind: 'text' as const,
            startUs: 0,
            durationUs: 5_000_000,
            source: { kind: 'object' as const, id: 'missing' },
            withinTrackOrder: 0,
          },
        ],
      },
    };
    expect(buildActiveTimelineRenderPlan(project, 1_000_000).items).toEqual([]);
  });
});
