import { describe, expect, it } from 'vitest';
import { migrateToLatest, migrateV0ToV1 } from './migration.js';
import type { SpikeProject } from './model.js';
import { rational } from './time.js';
import { validateJoyProjectV3 } from './v3.js';
import {
  DEFAULT_TRANSFORM_ANCHOR,
  transformAnchor,
  validateJoyProjectV1,
  type JoyProjectV1,
  type VisualObjectTransformV1,
} from './v1.js';

/** The anchor point in the transform (T-M05b, ADR-0046 section 5.8). */

function v0Fixture(): SpikeProject {
  return {
    schemaVersion: 0,
    id: 'anchor-fixture',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 1080,
        height: 1920,
        frameRate: rational(30, 1),
        durationUs: 1_000_000,
        tracks: [],
      },
    },
  };
}

const TRANSFORM: VisualObjectTransformV1 = {
  x: 10,
  y: 20,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 30,
  opacity: 1,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

function withTransform(transform: Record<string, unknown>): JoyProjectV1 {
  const base = migrateV0ToV1(v0Fixture()).project;
  return {
    ...base,
    visualObjects: { shape: { id: 'shape', kind: 'shape', transform } },
  } as unknown as JoyProjectV1;
}

describe('the anchor point in the transform', () => {
  it('is absent by default and means the centre', () => {
    expect(DEFAULT_TRANSFORM_ANCHOR).toBe(0.5);
    expect(transformAnchor(TRANSFORM)).toEqual({ x: 0.5, y: 0.5 });
    expect(transformAnchor({ anchorX: 0, anchorY: 1 })).toEqual({ x: 0, y: 1 });
    expect(transformAnchor({ anchorX: 0.25 })).toEqual({ x: 0.25, y: 0.5 });
  });

  it('a transform without an anchor stays valid (old projects)', () => {
    expect(validateJoyProjectV1(withTransform({ ...TRANSFORM }))).toEqual([]);
  });

  it('accepts finite anchors from one box-size outside through two box-sizes across', () => {
    for (const anchor of [
      { anchorX: -1, anchorY: 2 },
      { anchorX: 0, anchorY: 0 },
      { anchorX: 1, anchorY: 1 },
      { anchorX: 0.3 },
    ])
      expect(validateJoyProjectV1(withTransform({ ...TRANSFORM, ...anchor }))).toEqual([]);
  });

  it('rejects anchors outside [-1, 2] and names the visual object', () => {
    for (const [key, value] of [
      ['anchorX', -1.01],
      ['anchorY', 2.01],
    ] as const) {
      const diagnostics = validateJoyProjectV1(withTransform({ ...TRANSFORM, [key]: value }));
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          path: 'visualObjects.shape',
          message: `visual object "shape" transform ${key} must be within [-1, 2]`,
        }),
      );
    }
  });

  it('rejects an anchor that is not a finite number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '0.5', null]) {
      const messages = validateJoyProjectV1(
        withTransform({ ...TRANSFORM, anchorX: bad, anchorY: bad }),
      ).map((diagnostic) => diagnostic.message);
      expect(messages).toContain('visual object "shape" transform anchorX must be finite');
      expect(messages).toContain('visual object "shape" transform anchorY must be finite');
    }
  });

  it('loading old project JSON leaves its transform and centred drawing unchanged', () => {
    const old = JSON.parse(JSON.stringify(withTransform({ ...TRANSFORM }))) as JoyProjectV1;
    expect(validateJoyProjectV1(old)).toEqual([]);
    const before = JSON.stringify(old);
    const latest = migrateToLatest(old);
    expect(JSON.stringify(old)).toBe(before);
    expect(latest.visualObjects.shape!.transform).toEqual(TRANSFORM);
    expect('anchorX' in latest.visualObjects.shape!.transform).toBe(false);
    expect('anchorY' in latest.visualObjects.shape!.transform).toBe(false);
    expect(validateJoyProjectV3(latest)).toEqual([]);
    expect(transformAnchor(latest.visualObjects.shape!.transform)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('a saved anchor survives a JSON round trip and latest-schema migration', () => {
    const anchored = withTransform({ ...TRANSFORM, anchorX: -1, anchorY: 2 });
    const saved = JSON.parse(JSON.stringify(anchored)) as JoyProjectV1;
    expect(validateJoyProjectV1(saved)).toEqual([]);
    const latest = migrateToLatest(saved);
    const restored = JSON.parse(JSON.stringify(latest)) as JoyProjectV1;
    expect(restored.visualObjects.shape!.transform).toEqual({
      ...TRANSFORM,
      anchorX: -1,
      anchorY: 2,
    });
    expect(validateJoyProjectV3(restored)).toEqual([]);
  });

  it('the latest schema also rejects an anchor that is not finite', () => {
    const latest = migrateToLatest(withTransform({ ...TRANSFORM, anchorX: 0, anchorY: 0.75 }));
    const broken = {
      ...latest,
      visualObjects: {
        shape: { ...latest.visualObjects.shape!, transform: { ...TRANSFORM, anchorY: Number.NaN } },
      },
    };
    expect(validateJoyProjectV3(broken).map((diagnostic) => diagnostic.message)).toContain(
      'visual object "shape" transform anchorY must be finite',
    );
  });
});
