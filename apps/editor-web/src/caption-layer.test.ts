import { describe, expect, it } from 'vitest';
import { applyTransaction } from '@joy-media/commands';
import { buildCaptionLayerInsertion } from './caption-layer.js';
import { resolveObjectIdForSelection } from './sticker-bindings.js';
import { readTimelineElementKindMap } from './timeline-element-kind.js';
import { buildTimelineElementsShowcase } from './timeline-elements-showcase.js';

describe('buildCaptionLayerInsertion', () => {
  it('creates the CC visual document and Classic timeline lane atomically', () => {
    const { timeline, visual } = buildTimelineElementsShowcase();
    const insertion = buildCaptionLayerInsertion({ timeline, project: visual, token: 'test' });
    const nextTimeline = applyTransaction(timeline, insertion.timeline).project;
    const track = nextTimeline.compositions.root!.tracks.find(
      (candidate) => candidate.id === 'Captions-test',
    );
    expect(track?.clips[0]).toEqual(
      expect.objectContaining({ id: 'caption-test', assetId: 'joy-caption-layer' }),
    );
    expect(readTimelineElementKindMap(insertion.project)['caption-test']).toBe('caption');
    expect(resolveObjectIdForSelection(insertion.project, ['caption-test'])).toBe(
      'caption-controller-test',
    );
    expect(insertion.project.captionDocuments['captions-test']).toMatchObject({
      language: 'en-US',
      segments: [],
    });
    expect(
      insertion.project.compositions
        .root!.tracks.flatMap((candidate) => candidate.clips)
        .find((clip) => clip.id === 'caption-test'),
    ).toMatchObject({ kind: 'caption', captionDocumentId: 'captions-test' });
  });
});
