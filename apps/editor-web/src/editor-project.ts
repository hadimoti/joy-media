import type { JoyProjectV1 } from '@joy-media/project-schema';

/** The project document stays outside React's ephemeral editor state. */
export const INITIAL_EDITOR_PROJECT: JoyProjectV1 = {
  schemaVersion: 1,
  id: 'local-editor-project',
  title: 'Local editor project',
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
  rootCompositionId: 'root',
  settings: { defaultLocale: 'en' },
  compositions: {
    root: {
      id: 'root',
      name: 'Root composition',
      width: 1920,
      height: 1080,
      pixelAspectRatio: { num: 1, den: 1 },
      frameRate: { num: 30, den: 1 },
      durationUs: 30_000_000,
      background: '#000000',
      tracks: [],
    },
  },
  assets: {
    'product-still': { id: 'product-still', kind: 'image', displayName: 'Product still' },
  },
  variables: {},
  markers: [],
  visualObjects: {
    'intro-title': {
      id: 'intro-title',
      kind: 'text',
      text: 'JOY',
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
    'product-image': {
      id: 'product-image',
      kind: 'image',
      assetId: 'product-still',
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
    'outro-shape': {
      id: 'outro-shape',
      kind: 'shape',
      shape: 'rectangle',
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

export const TIMELINE_OBJECT_IDS: Readonly<Record<string, readonly string[]>> = {
  intro: ['intro-title'],
  product: ['product-image'],
  outro: ['outro-shape'],
};
