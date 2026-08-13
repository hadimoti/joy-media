import {
  canonicalBindingKey,
  createIdentityColorGrade,
  migrateV0ToV1,
  type AnimationValueV2,
  type JoyProjectV1,
  type PropertyAnimationV2,
  type PropertyBindingV2,
  type SpikeProject,
} from '@joy-media/project-schema';

const DURATION_US = 2_000_000;

function baseV0Project(id: string): SpikeProject {
  return {
    schemaVersion: 0,
    id,
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'WP34 fixture root',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        durationUs: DURATION_US,
        tracks: [
          {
            id: 'video-track',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-video',
                startUs: 0,
                durationUs: 1_000_000,
                assetId: 'video-asset',
                sourceInUs: 0,
              },
              {
                kind: 'video',
                id: 'clip-video-b',
                startUs: 1_000_000,
                durationUs: 1_000_000,
                assetId: 'video-asset',
                sourceInUs: 1_000_000,
              },
            ],
          },
        ],
      },
    },
  };
}

const legacyCurve = {
  keyframes: [
    { timeUs: 0, value: 0, interpolation: 'linear' as const },
    {
      timeUs: 1_000_000,
      value: 240,
      interpolation: 'bezier' as const,
      bezier: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 },
    },
  ],
};

/**
 * Legacy-only document with pre-WP34 transform/effect curves and ColorGradeV1.
 * It intentionally has no propertyAnimations field: V2 behavior must remain
 * lazy and never be introduced by validation/normalization of an old project.
 */
export function createLegacyAnimationFixture(): JoyProjectV1 {
  const base = migrateV0ToV1(baseV0Project('wp34-legacy-animation-fixture')).project;
  return {
    ...base,
    colorGrade: { lift: -0.05, gamma: 1.12, gain: 1.04, saturation: 0.92, lutId: 'contrast' },
    visualObjects: {
      'legacy-title': {
        id: 'legacy-title',
        kind: 'text',
        text: 'Legacy animated title',
        transform: {
          x: 0,
          y: 120,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
        animations: {
          x: legacyCurve,
          opacity: { keyframes: [{ timeUs: 0, value: 1, interpolation: 'hold' }] },
        },
        effects: [
          {
            id: 'legacy-blur',
            effectId: 'blur',
            enabled: true,
            params: { radius: 8 },
            animations: {
              radius: { keyframes: [{ timeUs: 0, value: 8, interpolation: 'linear' }] },
            },
          },
        ],
      },
    },
  };
}

function scalarAnimation(
  binding: PropertyBindingV2,
  start: number,
  end: number,
): PropertyAnimationV2 {
  const value: AnimationValueV2 = {
    kind: 'scalar',
    curve: {
      keyframes: [
        { timeUs: 0, value: start, interpolation: 'linear' },
        { timeUs: 1_000_000, value: end, interpolation: 'linear' },
      ],
    },
  };
  return { binding, value };
}

function animationMap(
  animations: readonly PropertyAnimationV2[],
): Readonly<Record<string, PropertyAnimationV2>> {
  return Object.fromEntries(
    animations.map((animation) => [canonicalBindingKey(animation.binding), animation]),
  );
}

/**
 * Compact project with every WP34 ownership boundary represented. The
 * `motion-scene-layer` binding is intentionally a boundary fixture: V1 has no
 * motion-scene document entity yet, but the stable owner/time-domain address
 * is durable and schema-valid ahead of that later adapter.
 */
export function createAnimationOwnershipFixture(): JoyProjectV1 {
  const base = migrateV0ToV1(baseV0Project('wp34-animation-ownership-fixture')).project;
  const outputGrade = {
    ...createIdentityColorGrade(),
    adjust: { ...createIdentityColorGrade().adjust!, exposure: 0.25 },
  };
  const clipGrade = {
    ...createIdentityColorGrade(),
    adjust: { ...createIdentityColorGrade().adjust!, saturation: 0.85 },
  };
  const bindings: readonly PropertyAnimationV2[] = [
    scalarAnimation(
      {
        ownerKind: 'color-output',
        ownerId: 'output-grade',
        propertyId: 'adjust.exposure',
        timeDomain: 'output',
      },
      0,
      0.25,
    ),
    scalarAnimation(
      {
        ownerKind: 'color-clip',
        ownerId: 'clip-video',
        propertyId: 'adjust.saturation',
        timeDomain: 'clip-local',
      },
      1,
      0.85,
    ),
    scalarAnimation(
      {
        ownerKind: 'audio-clip',
        ownerId: 'clip-video',
        propertyId: 'gain',
        timeDomain: 'audio-timeline',
      },
      0,
      -3,
    ),
    scalarAnimation(
      {
        ownerKind: 'audio-bus',
        ownerId: 'mix-bus',
        propertyId: 'gain',
        timeDomain: 'audio-timeline',
      },
      0,
      -1,
    ),
    scalarAnimation(
      {
        ownerKind: 'caption-clip',
        ownerId: 'caption-clip',
        propertyId: 'style.opacity',
        timeDomain: 'caption-clip-local',
      },
      1,
      0.75,
    ),
    scalarAnimation(
      {
        ownerKind: 'visual-object',
        ownerId: 'camera-main',
        propertyId: 'camera.fieldOfViewDeg',
        timeDomain: 'composition',
      },
      50,
      55,
    ),
    scalarAnimation(
      {
        ownerKind: 'transition',
        ownerId: 'transition-main',
        propertyId: 'params.strength',
        timeDomain: 'transition-local',
      },
      0,
      1,
    ),
    scalarAnimation(
      {
        ownerKind: 'visual-object',
        ownerId: 'scene-main',
        propertyId: 'scene.exposed.opacity',
        timeDomain: 'composition',
      },
      0,
      1,
    ),
    scalarAnimation(
      {
        ownerKind: 'motion-scene-layer',
        ownerId: 'scene-main::layer-title',
        propertyId: 'opacity',
        timeDomain: 'scene-local',
      },
      0,
      1,
    ),
  ];
  return {
    ...base,
    colorGrade: outputGrade,
    clipColorGrades: { 'clip-video': clipGrade },
    audio: {
      clips: { 'clip-video': { gain: 0, pan: 0, mute: false, solo: false } },
      buses: [
        { id: 'mix-bus', name: 'Mix', gain: 0, pan: 0, mute: false, solo: false, inputs: [] },
      ],
      effects: [],
    },
    captionDocuments: {
      'caption-doc': {
        id: 'caption-doc',
        language: 'en',
        direction: 'ltr',
        speakers: [],
        words: { word: { id: 'word', text: 'JOY', startUs: 0, endUs: 1_000_000 } },
        segments: [{ id: 'segment', startUs: 0, endUs: 1_000_000, wordIds: ['word'] }],
      },
    },
    compositions: {
      root: {
        ...base.compositions.root!,
        activeCameraId: 'camera-main',
        tracks: [
          ...base.compositions.root!.tracks,
          {
            id: 'caption-track',
            kind: 'caption',
            name: 'Captions',
            order: 1,
            enabled: true,
            locked: false,
            clips: [
              {
                kind: 'caption',
                id: 'caption-clip',
                startUs: 0,
                durationUs: 1_000_000,
                captionDocumentId: 'caption-doc',
              },
            ],
          },
        ],
      },
    },
    visualObjects: {
      'camera-main': {
        id: 'camera-main',
        kind: 'camera',
        transform: {
          x: 0,
          y: 0,
          positionZ: 100,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
        camera: { fieldOfViewDeg: 50 },
      },
      'scene-main': {
        id: 'scene-main',
        kind: 'html-scene',
        scenePackageId: 'joy.scene.fixture',
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
    transitions: [
      {
        id: 'transition-main',
        trackId: 'video-track',
        leftClipId: 'clip-video',
        rightClipId: 'clip-video-b',
        type: 'dissolve',
        durationUs: 250_000,
        params: { strength: 0.5 },
      },
    ],
    propertyAnimations: animationMap(bindings),
  };
}
