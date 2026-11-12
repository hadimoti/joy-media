import { describe, expect, it } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import {
  bindClipToObject,
  readClipMediaKindMap,
  readClipObjectIdsMap,
  readClipObjectMap,
  resolveObjectIdForSelection,
  writeClipMediaKind,
} from './sticker-bindings.js';

function emptyProject(): JoyProjectV1 {
  return {
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
        width: 1920,
        height: 1080,
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
    visualObjects: {
      'sticker-1': {
        id: 'sticker-1',
        kind: 'image',
        assetId: 'img-a',
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
    pluginData: {},
  };
}

describe('sticker-bindings', () => {
  it('keeps seed intro mapping when pluginData is empty', () => {
    const map = readClipObjectMap(emptyProject());
    expect(map.intro).toBe('intro-title');
  });

  it('binds a new sticker clip over seed defaults', () => {
    const next = bindClipToObject(emptyProject(), 'clip-sticker-1', 'sticker-1');
    expect(resolveObjectIdForSelection(next, ['clip-sticker-1'])).toBe('sticker-1');
    expect(readClipObjectMap(next)['clip-sticker-1']).toBe('sticker-1');
  });

  it('persists the source kind for image clips that use the video schema', () => {
    const next = writeClipMediaKind(emptyProject(), 'clip-image-1', 'image');
    expect(readClipMediaKindMap(next)['clip-image-1']).toBe('image');
  });
});

describe('one clip, several objects', () => {
  it('seed clips keep every seed object; the first-object map is unchanged', () => {
    const ids = readClipObjectIdsMap(emptyProject());
    expect(ids.intro).toEqual(['intro-title', 'scene-title']);
    expect(ids.product).toEqual(['product-image', 'scene-lower-third']);
    expect(ids.outro).toEqual(['outro-shape']);
    const first = readClipObjectMap(emptyProject());
    expect(first.intro).toBe('intro-title');
    expect(first.product).toBe('product-image');
  });

  it('a user-bound clip draws its one object; rebinding a seed clip replaces its list', () => {
    let project = bindClipToObject(emptyProject(), 'clip-sticker-1', 'sticker-1');
    project = bindClipToObject(project, 'intro', 'sticker-1');
    const ids = readClipObjectIdsMap(project);
    expect(ids['clip-sticker-1']).toEqual(['sticker-1']);
    expect(ids.intro).toEqual(['sticker-1']);
    expect(ids.product).toEqual(['product-image', 'scene-lower-third']);
  });
});
