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
      tracks: [
        {
          id: 'caption-track',
          kind: 'caption',
          name: 'Captions',
          order: 0,
          enabled: true,
          locked: false,
          clips: [
            {
              id: 'caption-clip-1',
              kind: 'caption',
              startUs: 1_000_000,
              durationUs: 4_000_000,
              captionDocumentId: 'captions-fa',
            },
          ],
        },
      ],
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
        // A shallow depth offset (ADR-0015): only visible once a composition
        // has an activeCameraId — the default (no camera) render is unaffected.
        positionZ: -200,
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
      // A visible reference-project motion cue: scrubbing now changes actual
      // Monitor pixels, not merely the timeline selection state.
      animations: {
        x: {
          keyframes: [
            { timeUs: 0, value: 0, interpolation: 'linear' },
            { timeUs: 30_000_000, value: 300, interpolation: 'linear' },
          ],
        },
      },
    },
    'product-image': {
      id: 'product-image',
      kind: 'image',
      assetId: 'product-still',
      transform: {
        // Offset from intro-title (kept at 0,0 — asserted by editor-session.test.ts)
        // so the three seeded reference objects don't stack on identical
        // placeholder-sized boxes and occlude one another in the Monitor preview.
        x: 400,
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
        x: 800,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotationDeg: 0,
        opacity: 1,
        // Deep background layer for a parallax demo (ADR-0015): a camera dolly
        // or pan shifts this far less than intro-title's shallow depth.
        positionZ: 1500,
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
    },
  },
  captionDocuments: {
    'captions-fa': {
      id: 'captions-fa',
      language: 'fa-IR',
      direction: 'auto',
      speakers: [{ id: 'narrator', name: 'راوی' }],
      words: {
        w1: { id: 'w1', text: 'سلام', startUs: 0, endUs: 800_000, confidence: 0.95 },
        w2: { id: 'w2', text: 'به', startUs: 800_000, endUs: 1_200_000, confidence: 0.62 },
        w3: { id: 'w3', text: 'جوی', startUs: 1_200_000, endUs: 2_000_000, confidence: 0.88 },
        w4: { id: 'w4', text: 'JOY', startUs: 2_000_000, endUs: 2_800_000 },
        w5: { id: 'w5', text: 'Media', startUs: 2_800_000, endUs: 3_600_000 },
      },
      segments: [
        {
          id: 'seg-1',
          startUs: 0,
          endUs: 2_000_000,
          wordIds: ['w1', 'w2', 'w3'],
          speakerId: 'narrator',
        },
        { id: 'seg-2', startUs: 2_000_000, endUs: 3_600_000, wordIds: ['w4', 'w5'] },
      ],
    },
  },
  pluginData: {},
};

export const TIMELINE_OBJECT_IDS: Readonly<Record<string, readonly string[]>> = {
  intro: ['intro-title'],
  product: ['product-image'],
  outro: ['outro-shape'],
};
