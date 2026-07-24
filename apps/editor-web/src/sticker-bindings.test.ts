import { describe, expect, it } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import {
  bindClipToObject,
  readClipObjectMap,
  resolveObjectIdForSelection,
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
});
