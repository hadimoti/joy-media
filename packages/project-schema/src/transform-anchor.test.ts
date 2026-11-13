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

  it('accepts any finite anchor, inside or outside the box', () => {
    for (const anchor of [
      { anchorX: 0, anchorY: 0 },
      { anchorX: 1, anchorY: 1 },
      { anchorX: -0.5, anchorY: 2.25 },
      { anchorX: 0.3 },
    ])
      expect(validateJoyProjectV1(withTransform({ ...TRANSFORM, ...anchor }))).toEqual([]);
  });

  it('rejects an anchor that is not a finite number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '0.5', null]) {
      const messages = validateJoyProjectV1(
        withTransform({ ...TRANSFORM, anchorX: bad, anchorY: bad }),
      ).map((diagnostic) => diagnostic.message);
      expect(messages).toContain('transform anchorX must be finite');
      expect(messages).toContain('transform anchorY must be finite');
    }
  });

  it('the migration leaves an old project exactly as it was (no anchor is added)', () => {
    const old = withTransform({ ...TRANSFORM });
    const before = JSON.stringify(old);
    const latest = migrateToLatest(old);
    expect(JSON.stringify(old)).toBe(before);
    expect(latest.visualObjects.shape!.transform).toEqual(TRANSFORM);
    expect('anchorX' in latest.visualObjects.shape!.transform).toBe(false);
    expect('anchorY' in latest.visualObjects.shape!.transform).toBe(false);
    expect(validateJoyProjectV3(latest)).toEqual([]);
  });

  it('the migration keeps a saved anchor and the latest schema accepts it', () => {
    const anchored = withTransform({ ...TRANSFORM, anchorX: 0, anchorY: 0.75 });
    const latest = migrateToLatest(anchored);
    expect(latest.visualObjects.shape!.transform.anchorX).toBe(0);
    expect(latest.visualObjects.shape!.transform.anchorY).toBe(0.75);
    expect(validateJoyProjectV3(latest)).toEqual([]);
    const broken = {
      ...latest,
      visualObjects: {
        shape: { ...latest.visualObjects.shape!, transform: { ...TRANSFORM, anchorY: Number.NaN } },
      },
    };
    expect(validateJoyProjectV3(broken).map((diagnostic) => diagnostic.message)).toContain(
      'transform anchorY must be finite',
    );
  });
});
