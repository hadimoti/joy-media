import type {
  TimelineElementKind,
  UniversalTimelineDocument,
  UniversalTimelineItem,
  UniversalTimelineSource,
} from './universal-timeline.js';

function fixtureItem(
  id: string,
  elementKind: TimelineElementKind,
  source: UniversalTimelineSource,
  trackId: string,
  withinTrackOrder: number,
): UniversalTimelineItem {
  return {
    id: `fixture-${id}`,
    compositionId: 'fixture-root',
    trackId,
    elementKind,
    startUs: 0,
    durationUs: 5_000_000,
    source,
    ...(elementKind === 'video' || elementKind === 'audio' ? { sourceInUs: 0 } : {}),
    withinTrackOrder,
  };
}

/** Deterministic, media-free fixture covering every universal element kind. */
export const mixedElementTimelineFixture: UniversalTimelineDocument = {
  schemaVersion: 1,
  items: [
    fixtureItem('video-a', 'video', { kind: 'asset', id: 'asset-video-a' }, 'fixture-bottom', 0),
    fixtureItem('video-b', 'video', { kind: 'asset', id: 'asset-video-b' }, 'fixture-top', 0),
    fixtureItem('image', 'image', { kind: 'object', id: 'object-image' }, 'fixture-top', 1),
    fixtureItem('text', 'text', { kind: 'object', id: 'object-text' }, 'fixture-top', 2),
    fixtureItem('shape', 'shape', { kind: 'object', id: 'object-shape' }, 'fixture-top', 3),
    fixtureItem('html', 'html-scene', { kind: 'object', id: 'object-html' }, 'fixture-top', 4),
    fixtureItem('audio', 'audio', { kind: 'asset', id: 'asset-audio' }, 'fixture-bottom', 1),
    fixtureItem(
      'caption',
      'caption',
      { kind: 'caption', id: 'caption-document' },
      'fixture-top',
      5,
    ),
    fixtureItem(
      'composition',
      'composition',
      { kind: 'composition', id: 'fixture-child' },
      'fixture-top',
      6,
    ),
    fixtureItem(
      'camera',
      'camera',
      { kind: 'controller', id: 'camera-controller' },
      'fixture-top',
      7,
    ),
    fixtureItem(
      'controller',
      'controller',
      { kind: 'controller', id: 'generic-controller' },
      'fixture-top',
      8,
    ),
  ],
};
