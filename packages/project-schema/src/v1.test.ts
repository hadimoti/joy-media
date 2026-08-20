import { describe, expect, it } from 'vitest';
import { migrateV0ToV1 } from './migration.js';
import type { SpikeProject } from './model.js';
import { canonicalBindingKey } from './property-animation.js';
import { rational } from './time.js';
import { validateJoyProjectV1 } from './v1.js';

function v0Fixture(): SpikeProject {
  return {
    schemaVersion: 0,
    id: 'v0-fixture',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'V0 Root',
        width: 1920,
        height: 1080,
        frameRate: rational(30, 1),
        durationUs: 1_000_000,
        tracks: [
          {
            id: 'video-1',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-1',
                startUs: 0,
                durationUs: 1_000_000,
                assetId: 'asset-1',
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
    },
  };
}

describe('v1 project schema and migration harness', () => {
  it('migrates the v0 fixture into a valid v1 document with explicit defaults', () => {
    const result = migrateV0ToV1(v0Fixture());
    expect(result.project.schemaVersion).toBe(1);
    expect(result.project.assets['asset-1']).toEqual({
      id: 'asset-1',
      kind: 'video',
      displayName: 'asset-1',
    });
    expect(result.project.compositions.root!.tracks[0]).toMatchObject({
      name: 'video-1',
      locked: false,
    });
    expect(validateJoyProjectV1(result.project)).toEqual([]);
    expect(result.report.defaultsApplied).toContain('pixelAspectRatio');
  });

  it('reports invalid untrusted v1 documents without throwing', () => {
    const diagnostics = validateJoyProjectV1({
      schemaVersion: 1,
      id: '',
      title: '',
      rootCompositionId: 'nope',
      compositions: {},
      assets: {},
      variables: {},
      markers: [],
      visualObjects: {},
      pluginData: {},
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('PROJECT_SCHEMA_V1_ROOT');
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('PROJECT_SCHEMA_V1_ID');
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'PROJECT_SCHEMA_V1_CAPTION_DOCUMENTS',
    );
  });

  it('accepts a valid caption document and caption clip on a caption track', () => {
    const project = {
      ...migrateV0ToV1(v0Fixture()).project,
      captionDocuments: {
        'doc-fa': {
          id: 'doc-fa',
          language: 'fa-IR',
          direction: 'rtl',
          speakers: [{ id: 's1', name: 'راوی' }],
          words: {
            w1: {
              id: 'w1',
              text: 'سلام',
              startUs: 0,
              endUs: 500_000,
              confidence: 0.9,
              speakerId: 's1',
            },
          },
          segments: [{ id: 'seg-1', startUs: 0, endUs: 500_000, wordIds: ['w1'], speakerId: 's1' }],
        },
      },
    };
    const withCaptionTrack = {
      ...project,
      compositions: {
        root: {
          ...project.compositions.root!,
          tracks: [
            ...project.compositions.root!.tracks,
            {
              id: 'captions',
              kind: 'caption' as const,
              name: 'Captions',
              order: 1,
              enabled: true,
              locked: false,
              clips: [
                {
                  kind: 'caption' as const,
                  id: 'caption-clip',
                  startUs: 0,
                  durationUs: 500_000,
                  captionDocumentId: 'doc-fa',
                },
              ],
            },
          ],
        },
      },
    };
    expect(validateJoyProjectV1(withCaptionTrack)).toEqual([]);
  });

  it('validates structured text, caption clip styles, and adjacent transitions', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const transform = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    const project = {
      ...base,
      visualObjects: {
        title: {
          id: 'title',
          kind: 'text' as const,
          transform,
          text: 'سلام',
          textDocument: { version: 1 as const, blocks: [{ id: 'b1', runs: [{ text: 'سلام' }] }] },
          textStyle: {
            fontFamily: 'YekanBakh',
            fontSizePx: 64,
            fontWeight: 700,
            italic: false,
            lineHeight: 1.2,
            tracking: 0,
            direction: 'rtl' as const,
            align: 'center' as const,
            fill: { kind: 'solid' as const, color: '#ffffff' },
            blendMode: 'normal' as const,
            opacity: 1,
          },
        },
      },
      compositions: {
        root: {
          ...base.compositions.root!,
          tracks: [
            {
              ...base.compositions.root!.tracks[0]!,
              clips: [
                base.compositions.root!.tracks[0]!.clips[0]!,
                {
                  kind: 'video' as const,
                  id: 'clip-2',
                  startUs: 1_000_000,
                  durationUs: 1_000_000,
                  assetId: 'asset-1',
                  sourceInUs: 1_000_000,
                },
              ],
            },
          ],
          transitions: [
            {
              id: 't1',
              trackId: 'video-1',
              leftClipId: 'clip-1',
              rightClipId: 'clip-2',
              type: 'dissolve',
              durationUs: 100_000,
            },
          ],
        },
      },
    };
    expect(validateJoyProjectV1(project)).toEqual([]);
  });

  it('rejects malformed text, caption style, and transition references', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const transform = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    const diagnostics = validateJoyProjectV1({
      ...base,
      visualObjects: {
        bad: {
          id: 'bad',
          kind: 'text',
          transform,
          textDocument: { version: 2, blocks: [] },
          textStyle: { fontFamily: 'Unknown', fontSizePx: -1 },
        },
      },
      compositions: {
        root: {
          ...base.compositions.root!,
          tracks: [
            {
              ...base.compositions.root!.tracks[0]!,
              clips: [
                ...base.compositions.root!.tracks[0]!.clips,
                {
                  kind: 'video',
                  id: 'clip-2',
                  startUs: 1_000_000,
                  durationUs: 1_000_000,
                  assetId: 'asset-1',
                  sourceInUs: 1_000_000,
                  style: { version: 2 },
                },
              ],
            },
          ],
          transitions: [
            {
              id: 't1',
              trackId: 'video-1',
              leftClipId: 'clip-1',
              rightClipId: 'missing',
              type: 'dissolve',
              durationUs: 100_000,
            },
            {
              id: 't1',
              trackId: 'video-1',
              leftClipId: 'clip-1',
              rightClipId: 'clip-2',
              type: 'dissolve',
              durationUs: 0,
            },
          ],
        },
      },
    });
    const codes = diagnostics.map((item) => item.code);
    expect(codes).toContain('PROJECT_SCHEMA_V1_TEXT');
    expect(codes).toContain('PROJECT_SCHEMA_V1_CAPTION_STYLE');
    expect(codes).toContain('PROJECT_SCHEMA_V1_TRANSITION');
  });

  it('reports caption structure violations with coded diagnostics', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const diagnostics = validateJoyProjectV1({
      ...base,
      captionDocuments: {
        broken: {
          id: 'broken',
          language: 'en',
          direction: 'sideways',
          speakers: [],
          words: {
            w1: { id: 'w1', text: 'hi', startUs: 500_000, endUs: 500_000 },
            w2: { id: 'other-id', text: 'oops', startUs: 0, endUs: 100_000 },
          },
          segments: [
            { id: 'seg', startUs: 0, endUs: 100_000, wordIds: ['missing'], speakerId: 'ghost' },
          ],
        },
      },
      compositions: {
        root: {
          ...base.compositions.root!,
          tracks: [
            {
              ...base.compositions.root!.tracks[0]!,
              clips: [
                ...base.compositions.root!.tracks[0]!.clips,
                {
                  kind: 'caption',
                  id: 'misplaced',
                  startUs: 0,
                  durationUs: 100_000,
                  captionDocumentId: 'nope',
                },
              ],
            },
          ],
        },
      },
    });
    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('PROJECT_SCHEMA_V1_CAPTION_DOCUMENT'); // bad direction
    expect(codes).toContain('PROJECT_SCHEMA_V1_CAPTION_WORD'); // empty range + key mismatch
    expect(codes).toContain('PROJECT_SCHEMA_V1_CAPTION_SEGMENT'); // unknown word + speaker
    // Caption clip on a video track referencing a missing document.
    expect(codes.filter((code) => code === 'PROJECT_SCHEMA_V1_CAPTION_CLIP')).toHaveLength(2);
  });

  it('accepts a visual object with a valid animation curve', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const project = {
      ...base,
      visualObjects: {
        'obj-1': {
          id: 'obj-1',
          kind: 'text',
          transform: {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotationDeg: 0,
            opacity: 1,
            crop: { left: 0, top: 0, right: 0, bottom: 0 },
          },
          animations: {
            x: {
              keyframes: [
                { timeUs: 0, value: 0, interpolation: 'linear' },
                {
                  timeUs: 1_000_000,
                  value: 100,
                  interpolation: 'bezier',
                  bezier: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 },
                },
              ],
            },
          },
        },
      },
    };
    expect(validateJoyProjectV1(project)).toEqual([]);
  });

  it('reports animation violations with coded diagnostics', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const diagnostics = validateJoyProjectV1({
      ...base,
      visualObjects: {
        'obj-1': {
          id: 'obj-1',
          kind: 'text',
          transform: {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotationDeg: 0,
            opacity: 1,
            crop: { left: 0, top: 0, right: 0, bottom: 0 },
          },
          animations: {
            // non-animatable channel
            zoom: { keyframes: [{ timeUs: 0, value: 1, interpolation: 'hold' }] },
            // out-of-order times + a bezier keyframe missing its handles
            y: {
              keyframes: [
                { timeUs: 1_000_000, value: 0, interpolation: 'bezier' },
                { timeUs: 0, value: 1, interpolation: 'linear' },
              ],
            },
            // empty curve
            opacity: { keyframes: [] },
          },
        },
      },
    });
    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes.filter((code) => code === 'PROJECT_SCHEMA_V1_ANIMATION').length).toBeGreaterThan(
      0,
    );
    const messages = diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toContain('"zoom" is not an animatable property');
    expect(messages).toContain('bezier interpolation requires finite handles');
    expect(messages).toContain('keyframe times must strictly increase');
    expect(messages).toContain('curve must hold at least one keyframe');
  });

  it('accepts a null controller with a valid child parent link and motion blur', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const transform = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    const project = {
      ...base,
      visualObjects: {
        controller: { id: 'controller', kind: 'null', transform },
        child: {
          id: 'child',
          kind: 'text',
          transform,
          parentId: 'controller',
          motionBlur: { enabled: true, shutterAngleDeg: 180, samples: 8 },
        },
      },
    };
    expect(validateJoyProjectV1(project)).toEqual([]);
  });

  it('reports parenting and motion-blur violations with coded diagnostics', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const transform = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    const diagnostics = validateJoyProjectV1({
      ...base,
      visualObjects: {
        // parent that does not exist
        orphan: { id: 'orphan', kind: 'text', transform, parentId: 'ghost' },
        // mutual cycle
        a: { id: 'a', kind: 'null', transform, parentId: 'b' },
        b: { id: 'b', kind: 'null', transform, parentId: 'a' },
        // out-of-range shutter angle
        blurry: {
          id: 'blurry',
          kind: 'shape',
          transform,
          motionBlur: { enabled: true, shutterAngleDeg: 720, samples: 0 },
        },
      },
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);
    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    expect(messages).toContain('parent "ghost" does not exist');
    expect(codes).toContain('PROJECT_SCHEMA_V1_OBJECT_PARENT');
    expect(messages).toContain('parenting graph contains a cycle');
    expect(messages).toContain('motionBlur config is invalid');
  });

  it('accepts a camera object with depth and an activeCameraId (ADR-0015)', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const transform = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      positionZ: -400,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    const project = {
      ...base,
      compositions: {
        root: { ...base.compositions.root!, activeCameraId: 'cam-1' },
      },
      visualObjects: {
        'cam-1': {
          id: 'cam-1',
          kind: 'camera',
          transform: { ...transform, positionZ: 0 },
          camera: { fieldOfViewDeg: 54 },
        },
        layer: { id: 'layer', kind: 'text', transform },
      },
    };
    expect(validateJoyProjectV1(project)).toEqual([]);
  });

  it('reports camera violations with coded diagnostics', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const transform = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    const diagnostics = validateJoyProjectV1({
      ...base,
      compositions: {
        root: { ...base.compositions.root!, activeCameraId: 'ghost-camera' },
      },
      visualObjects: {
        // missing camera params
        'cam-broken': { id: 'cam-broken', kind: 'camera', transform },
        // out-of-range field of view
        'cam-wide': {
          id: 'cam-wide',
          kind: 'camera',
          transform,
          camera: { fieldOfViewDeg: 200 },
        },
        // camera params on a non-camera object
        stray: { id: 'stray', kind: 'text', transform, camera: { fieldOfViewDeg: 50 } },
        // non-finite depth
        deep: { id: 'deep', kind: 'text', transform: { ...transform, positionZ: NaN } },
      },
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);
    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    expect(messages).toContain('camera "ghost-camera" does not exist');
    expect(codes).toContain('PROJECT_SCHEMA_V1_CAMERA');
    expect(
      messages.filter((message) => message === 'camera objects require fieldOfViewDeg in (0, 170]'),
    ).toHaveLength(2);
    expect(messages).toContain('only camera objects may carry camera params');
    expect(messages).toContain('transform positionZ must be finite');
  });

  it('reports an activeCameraId pointing at a non-camera object', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const transform = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    const diagnostics = validateJoyProjectV1({
      ...base,
      compositions: {
        root: { ...base.compositions.root!, activeCameraId: 'not-a-camera' },
      },
      visualObjects: {
        'not-a-camera': { id: 'not-a-camera', kind: 'text', transform },
      },
    });
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      '"not-a-camera" is not a camera object',
    );
  });

  it('accepts a visual object with a valid expressions map (ADR-0015)', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const project = {
      ...base,
      visualObjects: {
        'obj-1': {
          id: 'obj-1',
          kind: 'text',
          transform: {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotationDeg: 0,
            opacity: 1,
            crop: { left: 0, top: 0, right: 0, bottom: 0 },
          },
          expressions: { x: 'sin(time) * 10', opacity: 'clamp(time, 0, 1)' },
        },
      },
    };
    expect(validateJoyProjectV1(project)).toEqual([]);
  });

  it('reports expression shape violations with coded diagnostics', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const transform = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    const diagnostics = validateJoyProjectV1({
      ...base,
      visualObjects: {
        'obj-1': {
          id: 'obj-1',
          kind: 'text',
          transform,
          expressions: { zoom: 'sin(time)', x: '' },
        },
        'obj-2': { id: 'obj-2', kind: 'text', transform, expressions: 'not an object' },
      },
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);
    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    expect(messages).toContain('"zoom" is not an animatable property');
    expect(messages).toContain('expression for "x" must be a non-empty string');
    expect(messages).toContain('expressions must be an object');
    expect(codes.filter((code) => code === 'PROJECT_SCHEMA_V1_EXPRESSION').length).toBeGreaterThan(
      0,
    );
  });

  it('legacy v1 documents without propertyAnimations remain valid (WP34-05)', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    expect(base.propertyAnimations).toBeUndefined();
    expect(validateJoyProjectV1(base)).toEqual([]);
  });

  it('accepts a representative valid scalar property animation (WP34-05)', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const binding = {
      ownerKind: 'visual-object' as const,
      ownerId: 'obj-1',
      propertyId: 'x',
      timeDomain: 'composition' as const,
    };
    const project = {
      ...base,
      propertyAnimations: {
        [canonicalBindingKey(binding)]: {
          binding,
          value: {
            kind: 'scalar',
            curve: {
              keyframes: [
                { timeUs: 0, value: 0, interpolation: 'linear' },
                { timeUs: 1_000_000, value: 480, interpolation: 'linear' },
              ],
            },
          },
        },
      },
    };
    expect(validateJoyProjectV1(project)).toEqual([]);
  });

  it('accepts a valid curve-snapshot property animation (WP34-05)', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const binding = {
      ownerKind: 'motion-scene-layer' as const,
      ownerId: 'layer-1',
      propertyId: 'master',
      timeDomain: 'scene-local' as const,
    };
    const project = {
      ...base,
      propertyAnimations: {
        [canonicalBindingKey(binding)]: {
          binding,
          value: {
            kind: 'curve-snapshot',
            samples: [
              {
                timeUs: 0,
                channels: { master: [0, 0.1, 0.25] },
                interpolation: 'linear',
              },
              {
                timeUs: 1_000_000,
                channels: { master: [0.8, 0.9, 1] },
                interpolation: 'linear',
              },
            ],
          },
        },
      },
    };
    expect(validateJoyProjectV1(project)).toEqual([]);
  });

  it('rejects a property animation with an unsupported time domain (WP34-05)', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const diagnostics = validateJoyProjectV1({
      ...base,
      propertyAnimations: {
        'anim-bad': {
          binding: {
            ownerKind: 'visual-object',
            ownerId: 'obj-1',
            propertyId: 'x',
            timeDomain: 'not-a-real-domain',
          },
          value: {
            kind: 'scalar',
            curve: { keyframes: [{ timeUs: 0, value: 0, interpolation: 'linear' }] },
          },
        },
      },
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'PROJECT_SCHEMA_V1_PROPERTY_ANIMATION_BINDING',
    );
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      'binding requires a valid ownerKind, non-empty ownerId/propertyId, and a known timeDomain',
    );
  });

  it('rejects a top-level propertyAnimations that is an array (WP34-05)', () => {
    const base = migrateV0ToV1(v0Fixture()).project;
    const diagnostics = validateJoyProjectV1({
      ...base,
      propertyAnimations: [],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'PROJECT_SCHEMA_V1_PROPERTY_ANIMATION_VALUE',
    );
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      'propertyAnimations must be an object',
    );
  });
});
