import { describe, expect, it } from 'vitest';
import { layoutTemplatedCaptionNodes, rtlStressCues } from '@joy-media/captions-core';
import type { JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import { bindClipToObject } from '../sticker-bindings.js';
import {
  captionNodeId,
  clipIdToObjectId,
  clipIdToObjectIds,
  isCaptionNodeId,
  objectIdToClipId,
  objectIdToClipIds,
  parseCaptionNodeId,
  renderNodeIdToClipId,
} from './monitor-ids.js';

const transform = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  opacity: 1,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

function project(): JoyProjectV1 {
  const objects: Record<string, VisualObjectV1> = {
    'title-1': { id: 'title-1', kind: 'text', text: 'Hi', transform },
    'sticker-1': { id: 'sticker-1', kind: 'image', assetId: 'img', transform },
  };
  const base: JoyProjectV1 = {
    schemaVersion: 1,
    id: 'p',
    title: 't',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
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
        durationUs: 1_000_000,
        background: '#000',
        tracks: [],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: objects,
    captionDocuments: {},
    pluginData: {},
  };
  const withTitle = bindClipToObject(base, 'clip-title', 'title-1');
  const withSticker = bindClipToObject(withTitle, 'clip-sticker-a', 'sticker-1');
  return bindClipToObject(withSticker, 'clip-sticker-b', 'sticker-1');
}

const timeline = new Set(['clip-title', 'clip-sticker-a', 'clip-sticker-b', 'clip-video', 'cc-1']);

describe('clip id and object id', () => {
  it('clip id to object id, and nothing for a clip without a visual object', () => {
    const p = project();
    expect(clipIdToObjectId(p, 'clip-title')).toBe('title-1');
    expect(clipIdToObjectId(p, 'clip-sticker-b')).toBe('sticker-1');
    expect(clipIdToObjectId(p, 'clip-video')).toBeUndefined();
  });

  it('object id back to its clip ids, in binding order', () => {
    const p = project();
    expect(objectIdToClipIds(p, 'sticker-1', timeline)).toEqual([
      'clip-sticker-a',
      'clip-sticker-b',
    ]);
    expect(objectIdToClipId(p, 'sticker-1', timeline)).toBe('clip-sticker-a');
    expect(objectIdToClipId(p, 'title-1', timeline)).toBe('clip-title');
    expect(objectIdToClipId(p, 'missing', timeline)).toBeUndefined();
  });

  it('the two directions agree for every bound clip', () => {
    const p = project();
    for (const clipId of ['clip-title', 'clip-sticker-a', 'clip-sticker-b']) {
      const objectId = clipIdToObjectId(p, clipId)!;
      expect(objectIdToClipIds(p, objectId, timeline)).toContain(clipId);
    }
  });

  it('the timeline filter drops seed bindings for clips the project does not have', () => {
    const p = project();
    const all = Object.values(p.visualObjects).flatMap((object) => objectIdToClipIds(p, object.id));
    const onTimeline = Object.values(p.visualObjects).flatMap((object) =>
      objectIdToClipIds(p, object.id, timeline),
    );
    expect(onTimeline.every((clipId) => timeline.has(clipId))).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(onTimeline.length);
  });
});

describe('caption ids', () => {
  it('builds and reads the caption ids captions-core makes', () => {
    expect(captionNodeId('cc-1', 'seg-4')).toBe('caption:cc-1:seg-4');
    expect(captionNodeId('cc-1', 'seg-4', 2)).toBe('caption:cc-1:seg-4:line2');
    expect(parseCaptionNodeId('caption:cc-1:seg-4')).toEqual({
      clipId: 'cc-1',
      segmentId: 'seg-4',
    });
    expect(parseCaptionNodeId('caption:cc-1:seg-4:line0')).toEqual({
      clipId: 'cc-1',
      segmentId: 'seg-4',
      line: 0,
    });
  });

  it('keeps a segment id with a colon whole, and refuses ids that are not captions', () => {
    expect(parseCaptionNodeId('caption:cc-1:seg:a:line3')).toEqual({
      clipId: 'cc-1',
      segmentId: 'seg:a',
      line: 3,
    });
    for (const id of ['title-1', 'caption:', 'caption:cc-1', 'caption::seg', 'caption:cc-1:']) {
      expect(parseCaptionNodeId(id)).toBeUndefined();
    }
    expect(isCaptionNodeId('caption:cc-1:s')).toBe(true);
    expect(isCaptionNodeId('clip-video')).toBe(false);
  });

  it('round-trips every caption node the caption layout really draws', () => {
    const cues = rtlStressCues();
    const nodes = layoutTemplatedCaptionNodes(cues, { viewportWidth: 320, viewportHeight: 180 });
    expect(nodes.length).toBeGreaterThan(0);
    const clipIds = new Set(cues.map((cue) => cue.clipId));
    for (const node of nodes) {
      const parts = parseCaptionNodeId(node.id);
      expect(parts).toBeDefined();
      expect(clipIds.has(parts!.clipId)).toBe(true);
      expect(captionNodeId(parts!.clipId, parts!.segmentId, parts!.line)).toBe(node.id);
    }
  });
});

describe('drawn node id to the clip to select', () => {
  it('maps captions, video clips and visual objects to their timeline clip', () => {
    const p = project();
    expect(renderNodeIdToClipId(p, 'caption:cc-1:seg-1:line0', timeline)).toBe('cc-1');
    expect(renderNodeIdToClipId(p, 'clip-video', timeline)).toBe('clip-video');
    expect(renderNodeIdToClipId(p, 'title-1', timeline)).toBe('clip-title');
    expect(renderNodeIdToClipId(p, 'sticker-1', timeline)).toBe('clip-sticker-a');
  });

  it('returns nothing for a node that is on no timeline clip', () => {
    const p = project();
    expect(renderNodeIdToClipId(p, 'caption:gone:seg-1', timeline)).toBeUndefined();
    expect(renderNodeIdToClipId(p, 'unknown-node', timeline)).toBeUndefined();
  });
});

/** The seed project's objects: `intro` and `product` each draw two, `outro` one. */
function seedProject(): JoyProjectV1 {
  const base = project();
  const seedObjects: Record<string, VisualObjectV1> = {
    'intro-title': { id: 'intro-title', kind: 'text', text: 'Intro', transform },
    'scene-title': { id: 'scene-title', kind: 'text', text: 'Scene', transform },
    'product-image': { id: 'product-image', kind: 'image', assetId: 'img', transform },
    'scene-lower-third': { id: 'scene-lower-third', kind: 'text', text: 'Lower', transform },
    'outro-shape': { id: 'outro-shape', kind: 'text', text: 'Outro', transform },
  };
  return { ...base, visualObjects: { ...base.visualObjects, ...seedObjects } };
}

const seedTimeline = new Set(['intro', 'product', 'outro', 'clip-title', 'cc-1']);

describe('one clip with several objects (seed bindings)', () => {
  it('the intro and product clips keep both of their objects', () => {
    const p = seedProject();
    expect(clipIdToObjectIds(p, 'intro')).toEqual(['intro-title', 'scene-title']);
    expect(clipIdToObjectIds(p, 'product')).toEqual(['product-image', 'scene-lower-third']);
  });

  it('every object of intro and product maps back to exactly that one clip', () => {
    const p = seedProject();
    for (const [objectId, clipId] of [
      ['intro-title', 'intro'],
      ['scene-title', 'intro'],
      ['product-image', 'product'],
      ['scene-lower-third', 'product'],
    ] as const) {
      expect(objectIdToClipIds(p, objectId, seedTimeline)).toEqual([clipId]);
      expect(objectIdToClipId(p, objectId, seedTimeline)).toBe(clipId);
      expect(renderNodeIdToClipId(p, objectId, seedTimeline)).toBe(clipId);
    }
  });

  it('a clip with one object (seed and user-bound)', () => {
    const p = seedProject();
    expect(clipIdToObjectIds(p, 'outro')).toEqual(['outro-shape']);
    expect(renderNodeIdToClipId(p, 'outro-shape', seedTimeline)).toBe('outro');
    expect(clipIdToObjectIds(p, 'clip-title')).toEqual(['title-1']);
    expect(renderNodeIdToClipId(p, 'title-1', seedTimeline)).toBe('clip-title');
  });

  it('the first-object converter is unchanged', () => {
    const p = seedProject();
    expect(clipIdToObjectId(p, 'intro')).toBe('intro-title');
    expect(clipIdToObjectId(p, 'product')).toBe('product-image');
  });

  it('a caption id maps to its caption clip, not through the object bindings', () => {
    const p = seedProject();
    expect(renderNodeIdToClipId(p, captionNodeId('cc-1', 'seg-1', 0), seedTimeline)).toBe('cc-1');
    expect(clipIdToObjectIds(p, 'cc-1')).toEqual([]);
  });

  it('a missing id maps to nothing', () => {
    const p = seedProject();
    expect(clipIdToObjectIds(p, 'missing-clip')).toEqual([]);
    expect(objectIdToClipIds(p, 'missing-object', seedTimeline)).toEqual([]);
    expect(renderNodeIdToClipId(p, 'missing-object', seedTimeline)).toBeUndefined();
    // A seed object the project does not have is not returned for its clip.
    expect(clipIdToObjectIds(project(), 'intro')).toEqual([]);
    // A seed clip that is not on the timeline is not returned for its object.
    expect(renderNodeIdToClipId(p, 'scene-title', new Set(['outro']))).toBeUndefined();
  });

  it('rebinding a seed clip to another object replaces all of its seed objects', () => {
    const p = bindClipToObject(seedProject(), 'intro', 'title-1');
    expect(clipIdToObjectIds(p, 'intro')).toEqual(['title-1']);
    expect(renderNodeIdToClipId(p, 'scene-title', seedTimeline)).toBeUndefined();
    expect(objectIdToClipIds(p, 'title-1', seedTimeline)).toEqual(['intro', 'clip-title']);
  });
});
