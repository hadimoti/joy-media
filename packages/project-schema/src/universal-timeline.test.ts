import { describe, expect, it } from 'vitest';
import type { JoyProjectV1, SpikeProject } from './index.js';
import {
  UNIVERSAL_TIMELINE_SCHEMA_VERSION,
  mixedElementTimelineFixture,
  normalizeUniversalTimeline,
  validateUniversalTimelineDocument,
} from './index.js';

const spikeProject: SpikeProject = {
  schemaVersion: 0,
  id: 'legacy',
  rootCompositionId: 'root',
  compositions: {
    root: {
      id: 'root',
      name: 'Root',
      width: 1920,
      height: 1080,
      frameRate: { num: 30, den: 1 },
      durationUs: 10_000_000,
      tracks: [
        {
          id: 'V1',
          kind: 'video',
          order: 7,
          enabled: true,
          clips: [
            {
              id: 'clip-a',
              kind: 'video',
              assetId: 'asset-a',
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

const v1Project: JoyProjectV1 = {
  schemaVersion: 1,
  id: 'v1',
  title: 'V1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  rootCompositionId: 'root',
  settings: { defaultLocale: 'en' },
  compositions: {
    root: {
      id: 'root',
      name: 'Root',
      width: 1080,
      height: 1920,
      pixelAspectRatio: { num: 1, den: 1 },
      frameRate: { num: 30, den: 1 },
      durationUs: 10_000_000,
      background: '#000',
      tracks: [
        {
          id: 'layer-1',
          kind: 'video',
          name: 'Main Video',
          order: 2,
          enabled: true,
          locked: false,
          clips: [
            {
              id: 'video-1',
              kind: 'video',
              assetId: 'audio-asset',
              startUs: 0,
              durationUs: 2_000_000,
              sourceInUs: 0,
            },
          ],
        },
      ],
    },
  },
  assets: {
    'audio-asset': { id: 'audio-asset', kind: 'audio', displayName: 'Voice' },
  },
  variables: {},
  markers: [],
  visualObjects: {
    title: {
      id: 'title',
      kind: 'text',
      text: 'Hello',
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
  captionDocuments: {},
  pluginData: { 'joy.clipObjects': { 'video-1': 'title' } },
};

describe('universal Timeline projection', () => {
  it('projects schema-0 clips without rewriting the legacy project', () => {
    const result = normalizeUniversalTimeline(spikeProject);
    expect(result.usedLegacyFallback).toBe(true);
    expect(result.needsCopyOnWriteMigration).toBe(false);
    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'clip-a',
        elementKind: 'video',
        trackOrder: 7,
        source: { kind: 'asset', id: 'asset-a' },
      }),
    ]);
    expect(spikeProject.compositions.root!.tracks[0]?.name).toBeUndefined();
  });

  it('derives audio capability and bound visual elements from v1 legacy data', () => {
    const result = normalizeUniversalTimeline(v1Project);
    expect(result.needsCopyOnWriteMigration).toBe(true);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'video-1', elementKind: 'audio' }),
        expect.objectContaining({
          id: 'video-1:object:title',
          elementKind: 'text',
          source: { kind: 'object', id: 'title' },
        }),
      ]),
    );
  });

  it('uses a valid persisted document as the copy-on-write projection', () => {
    const project: JoyProjectV1 = {
      ...v1Project,
      universalTimeline: {
        schemaVersion: UNIVERSAL_TIMELINE_SCHEMA_VERSION,
        items: [
          {
            id: 'explicit',
            compositionId: 'root',
            trackId: 'layer-1',
            elementKind: 'text',
            startUs: 1_000_000,
            durationUs: 500_000,
            source: { kind: 'object', id: 'title' },
            withinTrackOrder: 0,
          },
        ],
      },
    };
    const result = normalizeUniversalTimeline(project);
    expect(result.usedLegacyFallback).toBe(false);
    expect(result.needsCopyOnWriteMigration).toBe(false);
    expect(result.items[0]).toEqual(expect.objectContaining({ id: 'explicit', trackOrder: 2 }));
  });

  it('rejects duplicate ids, duplicate per-track order, and invalid ranges', () => {
    const diagnostics = validateUniversalTimelineDocument({
      schemaVersion: 1,
      items: [
        {
          id: 'duplicate',
          compositionId: 'root',
          trackId: 'track-1',
          elementKind: 'image',
          startUs: 0,
          durationUs: 0,
          source: { kind: 'asset', id: 'asset' },
          withinTrackOrder: 0,
        },
        {
          id: 'duplicate',
          compositionId: 'root',
          trackId: 'track-1',
          elementKind: 'not-a-kind',
          startUs: -1,
          durationUs: 1,
          source: { kind: 'asset', id: 'asset' },
          withinTrackOrder: 0,
        },
      ],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        'UNIVERSAL_TIMELINE_DUPLICATE_ITEM',
        'UNIVERSAL_TIMELINE_DUPLICATE_ORDER',
        'UNIVERSAL_TIMELINE_RANGE',
        'UNIVERSAL_TIMELINE_ELEMENT_KIND',
      ]),
    );
  });

  it('keeps a deterministic mixed-element fixture valid and complete', () => {
    expect(validateUniversalTimelineDocument(mixedElementTimelineFixture)).toEqual([]);
    expect(new Set(mixedElementTimelineFixture.items.map((item) => item.elementKind))).toEqual(
      new Set([
        'video',
        'audio',
        'image',
        'text',
        'shape',
        'caption',
        'html-scene',
        'composition',
        'camera',
        'controller',
      ]),
    );
  });
});
