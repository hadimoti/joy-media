import type {
  JoyProjectV1,
  SpikeProject,
  VideoClip,
  VisualObjectV1,
} from '@joy-media/project-schema';
import { CLIP_OBJECTS_PLUGIN_KEY } from './sticker-bindings.js';
import {
  EFFECT_LAYER_TARGET_PLUGIN_KEY,
  TIMELINE_ELEMENT_KIND_PLUGIN_KEY,
  type TimelineElementKind,
} from './timeline-element-kind.js';

export const TIMELINE_ELEMENTS_SHOWCASE = Object.freeze({
  id: 'timeline-elements-showcase-v3',
  title: 'Timeline Elements Showcase',
  durationUs: 30_000_000,
});

const ZERO_TRANSFORM: VisualObjectV1['transform'] = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  opacity: 1,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

function clip(id: string, assetId: string, startUs: number, durationUs: number): VideoClip {
  return { id, kind: 'video', assetId, startUs, durationUs, sourceInUs: 0 };
}

function controller(id: string, assetId: string): VisualObjectV1 {
  return { id, kind: 'null', assetId, transform: ZERO_TRANSFORM };
}

/**
 * A deterministic, editable project whose two timeline lenses expose the same
 * Video baseline plus every authored element kind, including CC and 3D. Controller
 * layers are intentionally real project objects, not decorative demo rows.
 */
export function buildTimelineElementsShowcase(
  title: string = TIMELINE_ELEMENTS_SHOWCASE.title,
  now: string = '2026-08-14T00:00:00.000Z',
): { readonly timeline: SpikeProject; readonly visual: JoyProjectV1 } {
  const clips = {
    intro: clip('showcase-intro', 'asset-intro', 0, 6_000_000),
    product: clip('showcase-product', 'asset-product', 6_000_000, 12_000_000),
    outro: clip('showcase-outro', 'asset-outro', 18_000_000, 12_000_000),
    brollA: clip('showcase-b-roll-a', 'asset-product', 0, 15_000_000),
    brollB: clip('showcase-b-roll-b', 'asset-intro', 15_000_000, 15_000_000),
    overlay: clip('showcase-overlay', 'showcase-overlay-asset', 4_000_000, 18_000_000),
    scene3d: clip(
      'showcase-scene3d',
      'html-scene:joy.firstparty.holo-badge',
      2_000_000,
      10_000_000,
    ),
    text: clip('showcase-text', 'showcase-text-asset', 1_000_000, 8_000_000),
    caption: clip('showcase-caption', 'showcase-caption-asset', 0, 30_000_000),
    motion: clip('showcase-motion', 'showcase-motion-asset', 8_000_000, 14_000_000),
    effect: clip('showcase-effect', 'showcase-effect-asset', 6_000_000, 6_000_000),
    filter: clip('showcase-filter', 'showcase-filter-asset', 12_000_000, 6_000_000),
    adjust: clip('showcase-adjust', 'joy-adjustment-layer', 6_000_000, 12_000_000),
    audio: clip('showcase-audio', 'showcase-audio-asset', 0, 30_000_000),
  } as const;

  const timeline: SpikeProject = {
    schemaVersion: 0,
    id: TIMELINE_ELEMENTS_SHOWCASE.id,
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Timeline elements',
        width: 1080,
        height: 1920,
        frameRate: { num: 30, den: 1 },
        durationUs: TIMELINE_ELEMENTS_SHOWCASE.durationUs,
        tracks: [
          {
            id: 'Video 1',
            kind: 'video',
            family: 'visual',
            order: 0,
            enabled: true,
            clips: [clips.intro, clips.product, clips.outro],
          },
          {
            id: 'Video 2',
            kind: 'video',
            family: 'visual',
            order: 1,
            enabled: true,
            clips: [clips.brollA, clips.brollB],
          },
          {
            id: 'Overlay',
            kind: 'video',
            family: 'visual',
            order: 2,
            enabled: true,
            clips: [clips.overlay],
          },
          {
            id: '3D Scene',
            kind: 'video',
            family: 'visual',
            order: 3,
            enabled: true,
            clips: [clips.scene3d],
          },
          {
            id: 'Text',
            kind: 'video',
            family: 'visual',
            order: 4,
            enabled: true,
            clips: [clips.text],
          },
          {
            id: 'Captions',
            kind: 'video',
            family: 'visual',
            order: 5,
            enabled: true,
            clips: [clips.caption],
          },
          {
            id: 'Motion',
            kind: 'video',
            family: 'visual',
            order: 6,
            enabled: true,
            clips: [clips.motion],
          },
          {
            id: 'Effects',
            kind: 'video',
            family: 'visual',
            order: 7,
            enabled: true,
            clips: [clips.effect],
          },
          {
            id: 'Filters',
            kind: 'video',
            family: 'visual',
            order: 8,
            enabled: true,
            clips: [clips.filter],
          },
          {
            id: 'Adjust',
            kind: 'video',
            family: 'visual',
            order: 9,
            enabled: true,
            clips: [clips.adjust],
          },
          {
            id: 'Audio',
            kind: 'video',
            family: 'audio',
            order: 10,
            enabled: true,
            clips: [clips.audio],
          },
        ],
      },
    },
  };

  const visualObjects: Record<string, VisualObjectV1> = {
    'showcase-intro-controller': controller('showcase-intro-controller', 'asset-intro'),
    'showcase-product-controller': controller('showcase-product-controller', 'asset-product'),
    'showcase-outro-controller': controller('showcase-outro-controller', 'asset-outro'),
    'showcase-b-roll-a-controller': controller('showcase-b-roll-a-controller', 'asset-product'),
    'showcase-b-roll-b-controller': controller('showcase-b-roll-b-controller', 'asset-intro'),
    'showcase-overlay-object': {
      id: 'showcase-overlay-object',
      kind: 'shape',
      shape: 'rectangle',
      transform: { ...ZERO_TRANSFORM, x: 690, y: 310, scaleX: 2.4, scaleY: 1.15, opacity: 0.7 },
    },
    'showcase-scene3d-object': {
      id: 'showcase-scene3d-object',
      kind: 'html-scene',
      scenePackageId: 'joy.firstparty.holo-badge',
      transform: { ...ZERO_TRANSFORM, x: 130, y: 390, scaleX: 0.92, scaleY: 0.92 },
    },
    'showcase-text-object': {
      id: 'showcase-text-object',
      kind: 'text',
      text: 'Six clear timeline elements',
      transform: { ...ZERO_TRANSFORM, x: 115, y: 210, scaleX: 1.2, scaleY: 1.2 },
    },
    'showcase-caption-controller': controller(
      'showcase-caption-controller',
      'showcase-caption-asset',
    ),
    'showcase-motion-object': {
      id: 'showcase-motion-object',
      kind: 'shape',
      shape: 'rectangle',
      transform: { ...ZERO_TRANSFORM, x: 320, y: 930, scaleX: 1.6, scaleY: 0.32 },
      animations: {
        x: {
          keyframes: [
            { timeUs: 0, value: 320, interpolation: 'linear' },
            { timeUs: 14_000_000, value: 760, interpolation: 'linear' },
          ],
        },
        opacity: {
          keyframes: [
            { timeUs: 0, value: 0, interpolation: 'linear' },
            { timeUs: 800_000, value: 1, interpolation: 'linear' },
            { timeUs: 13_200_000, value: 1, interpolation: 'linear' },
            { timeUs: 14_000_000, value: 0, interpolation: 'linear' },
          ],
        },
      },
    },
    'showcase-effect-controller': {
      ...controller('showcase-effect-controller', 'showcase-effect-asset'),
      effects: [
        {
          id: 'showcase-glow',
          effectId: 'glow',
          enabled: true,
          params: { strength: 0.35, radius: 8 },
        },
      ],
    },
    'showcase-filter-controller': {
      ...controller('showcase-filter-controller', 'showcase-filter-asset'),
      effects: [
        {
          id: 'showcase-filter-gaussian',
          effectId: 'gaussian-blur',
          enabled: true,
          params: { amount: 3.5 },
        },
        {
          id: 'showcase-filter-noise',
          effectId: 'noise',
          enabled: true,
          params: { amount: 0.12 },
        },
      ],
    },
    'showcase-adjust-controller': {
      ...controller('showcase-adjust-controller', 'joy-adjustment-layer'),
      effects: [
        {
          id: 'showcase-adjust-contrast',
          effectId: 'brightness-contrast',
          enabled: true,
          params: { brightness: 0.04, contrast: 0.16 },
        },
        {
          id: 'showcase-adjust-vibrance',
          effectId: 'vibrance',
          enabled: true,
          params: { amount: 0.12 },
        },
      ],
    },
    'showcase-audio-controller': controller('showcase-audio-controller', 'showcase-audio-asset'),
  };

  const clipObjects = {
    [clips.intro.id]: 'showcase-intro-controller',
    [clips.product.id]: 'showcase-product-controller',
    [clips.outro.id]: 'showcase-outro-controller',
    [clips.brollA.id]: 'showcase-b-roll-a-controller',
    [clips.brollB.id]: 'showcase-b-roll-b-controller',
    [clips.overlay.id]: 'showcase-overlay-object',
    [clips.scene3d.id]: 'showcase-scene3d-object',
    [clips.text.id]: 'showcase-text-object',
    [clips.caption.id]: 'showcase-caption-controller',
    [clips.motion.id]: 'showcase-motion-object',
    [clips.effect.id]: 'showcase-effect-controller',
    [clips.filter.id]: 'showcase-filter-controller',
    [clips.adjust.id]: 'showcase-adjust-controller',
    [clips.audio.id]: 'showcase-audio-controller',
  };
  const elementKinds: Record<string, TimelineElementKind> = {
    [clips.intro.id]: 'video',
    [clips.product.id]: 'video',
    [clips.outro.id]: 'video',
    [clips.brollA.id]: 'video',
    [clips.brollB.id]: 'video',
    [clips.overlay.id]: 'overlay',
    [clips.scene3d.id]: 'scene3d',
    [clips.text.id]: 'text',
    [clips.caption.id]: 'caption',
    [clips.motion.id]: 'motion',
    [clips.effect.id]: 'effect',
    [clips.filter.id]: 'filter',
    [clips.adjust.id]: 'adjust',
    [clips.audio.id]: 'audio',
  };

  const visual: JoyProjectV1 = {
    schemaVersion: 1,
    id: TIMELINE_ELEMENTS_SHOWCASE.id,
    title,
    createdAt: now,
    updatedAt: now,
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Timeline elements',
        width: 1080,
        height: 1920,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: TIMELINE_ELEMENTS_SHOWCASE.durationUs,
        background: '#080808',
        tracks: [
          {
            id: 'showcase-caption-track',
            kind: 'caption',
            name: 'Captions',
            order: 0,
            enabled: true,
            locked: false,
            clips: [
              {
                id: clips.caption.id,
                kind: 'caption',
                startUs: clips.caption.startUs,
                durationUs: clips.caption.durationUs,
                captionDocumentId: 'showcase-captions-en',
              },
            ],
          },
        ],
      },
    },
    assets: {
      'asset-intro': {
        id: 'asset-intro',
        kind: 'video',
        displayName: 'Intro',
        descriptor: { mimeType: 'video/mp4', durationUs: 30_000_000, width: 1080, height: 1920 },
      },
      'asset-product': {
        id: 'asset-product',
        kind: 'video',
        displayName: 'Product',
        descriptor: { mimeType: 'video/mp4', durationUs: 30_000_000, width: 1080, height: 1920 },
      },
      'asset-outro': {
        id: 'asset-outro',
        kind: 'video',
        displayName: 'Outro',
        descriptor: { mimeType: 'video/mp4', durationUs: 30_000_000, width: 1080, height: 1920 },
      },
      'showcase-overlay-asset': {
        id: 'showcase-overlay-asset',
        kind: 'other',
        displayName: 'Overlay',
      },
      'html-scene:joy.firstparty.holo-badge': {
        id: 'html-scene:joy.firstparty.holo-badge',
        kind: 'other',
        displayName: 'Joy Code 3D Holo Badge',
      },
      'showcase-text-asset': { id: 'showcase-text-asset', kind: 'other', displayName: 'Text' },
      'showcase-caption-asset': {
        id: 'showcase-caption-asset',
        kind: 'other',
        displayName: 'CC Captions',
      },
      'showcase-motion-asset': {
        id: 'showcase-motion-asset',
        kind: 'other',
        displayName: 'Motion Graphic',
      },
      'showcase-effect-asset': {
        id: 'showcase-effect-asset',
        kind: 'other',
        displayName: 'Effects',
      },
      'showcase-filter-asset': {
        id: 'showcase-filter-asset',
        kind: 'other',
        displayName: 'Filters',
      },
      'joy-adjustment-layer': { id: 'joy-adjustment-layer', kind: 'other', displayName: 'Adjust' },
      'showcase-audio-asset': {
        id: 'showcase-audio-asset',
        kind: 'audio',
        displayName: 'Audio',
        descriptor: { mimeType: 'audio/wav', durationUs: 30_000_000 },
      },
    },
    variables: {},
    markers: [],
    visualObjects,
    captionDocuments: {
      'showcase-captions-en': {
        id: 'showcase-captions-en',
        language: 'en-US',
        direction: 'ltr',
        speakers: [],
        words: {
          'showcase-word-1': {
            id: 'showcase-word-1',
            text: 'Every',
            startUs: 1_000_000,
            endUs: 1_600_000,
          },
          'showcase-word-2': {
            id: 'showcase-word-2',
            text: 'feature',
            startUs: 1_600_000,
            endUs: 2_300_000,
          },
          'showcase-word-3': {
            id: 'showcase-word-3',
            text: 'matches',
            startUs: 8_000_000,
            endUs: 8_700_000,
          },
          'showcase-word-4': {
            id: 'showcase-word-4',
            text: 'timeline',
            startUs: 8_700_000,
            endUs: 9_500_000,
          },
        },
        segments: [
          {
            id: 'showcase-segment-1',
            startUs: 1_000_000,
            endUs: 2_300_000,
            wordIds: ['showcase-word-1', 'showcase-word-2'],
          },
          {
            id: 'showcase-segment-2',
            startUs: 8_000_000,
            endUs: 9_500_000,
            wordIds: ['showcase-word-3', 'showcase-word-4'],
          },
        ],
        styleRef: 'joy-clean',
      },
    },
    transitions: [
      {
        id: 'showcase-transition',
        trackId: 'Video 1',
        leftClipId: clips.intro.id,
        rightClipId: clips.product.id,
        type: 'dissolve',
        durationUs: 500_000,
      },
    ],
    pluginData: {
      [CLIP_OBJECTS_PLUGIN_KEY]: clipObjects,
      [TIMELINE_ELEMENT_KIND_PLUGIN_KEY]: elementKinds,
      [EFFECT_LAYER_TARGET_PLUGIN_KEY]: {
        'showcase-effect-controller': clips.product.id,
        'showcase-filter-controller': clips.product.id,
        'showcase-adjust-controller': clips.product.id,
      },
    },
    audio: {
      clips: {
        [clips.intro.id]: { gain: 1, pan: 0, mute: false, solo: false },
        [clips.product.id]: { gain: 1, pan: 0, mute: false, solo: false },
        [clips.outro.id]: { gain: 1, pan: 0, mute: false, solo: false },
        [clips.brollA.id]: { gain: 0, pan: 0, mute: true, solo: false },
        [clips.brollB.id]: { gain: 0, pan: 0, mute: true, solo: false },
        [clips.overlay.id]: { gain: 0, pan: 0, mute: true, solo: false },
        [clips.audio.id]: { gain: 0.85, pan: 0, mute: false, solo: false },
      },
      buses: [
        { id: 'master', name: 'Master', gain: 1, pan: 0, mute: false, solo: false, inputs: [] },
      ],
      effects: [],
    },
  };

  return { timeline, visual };
}
