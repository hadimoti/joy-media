import { describe, expect, it } from 'vitest';
import type { VisualObjectTransformV1 } from '@joy-media/project-schema';
import { focalLengthPx, projectThroughCamera } from './projection.js';

const layer: VisualObjectTransformV1 = {
  x: 100,
  y: 50,
  scaleX: 2,
  scaleY: 2,
  rotationDeg: 10,
  opacity: 0.8,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

const compHeight = 1080;
const fieldOfViewDeg = 54;
const focal = focalLengthPx(fieldOfViewDeg, compHeight);

describe('focalLengthPx', () => {
  it('derives a positive focal length from a sane FOV', () => {
    expect(focal).toBeGreaterThan(0);
    expect(Number.isFinite(focal)).toBe(true);
  });

  it('a wider FOV yields a shorter focal length', () => {
    expect(focalLengthPx(90, compHeight)).toBeLessThan(focalLengthPx(30, compHeight));
  });
});

describe('projectThroughCamera', () => {
  it('projects at scale 1 when the layer sits exactly at the focal distance', () => {
    const camera = { x: 0, y: 0, z: 0, rollDeg: 0, fieldOfViewDeg };
    const projected = projectThroughCamera(layer, focal, camera, compHeight);
    expect(projected.x).toBeCloseTo(layer.x, 6);
    expect(projected.y).toBeCloseTo(layer.y, 6);
    expect(projected.scaleX).toBeCloseTo(layer.scaleX, 6);
    expect(projected.scaleY).toBeCloseTo(layer.scaleY, 6);
    expect(projected.rotationDeg).toBeCloseTo(layer.rotationDeg, 6);
    expect(projected.opacity).toBe(layer.opacity); // passthrough, untouched by projection
  });

  it('dollying the camera toward the layer increases projected scale', () => {
    const far = { x: 0, y: 0, z: 0, rollDeg: 0, fieldOfViewDeg };
    const near = { x: 0, y: 0, z: focal / 2, rollDeg: 0, fieldOfViewDeg };
    const scaleFar = projectThroughCamera(layer, focal, far, compHeight).scaleX;
    const scaleNear = projectThroughCamera(layer, focal, near, compHeight).scaleX;
    expect(scaleNear).toBeCloseTo(scaleFar * 2, 6);
  });

  it('produces parallax: a nearer layer shifts more than a farther one under the same pan', () => {
    const camera = { x: 200, y: 0, z: 0, rollDeg: 0, fieldOfViewDeg };
    const nearLayer = { ...layer, x: 0, y: 0 };
    const farLayer = { ...layer, x: 0, y: 0 };
    const nearProjected = projectThroughCamera(nearLayer, focal, camera, compHeight);
    const farProjected = projectThroughCamera(farLayer, focal * 4, camera, compHeight);
    // Both layers are at the same world x, but the nearer one (smaller depth)
    // is foreshortened less by the pan offset than the farther one's shrunk scale suggests —
    // assert the classic parallax inequality: |near shift| > |far shift| for the same camera pan.
    expect(Math.abs(nearProjected.x)).toBeGreaterThan(Math.abs(farProjected.x));
  });

  it('applies camera roll as a rotation of the projected point and adds to layer rotation', () => {
    const camera = { x: 0, y: 0, z: 0, rollDeg: 90, fieldOfViewDeg };
    const onAxis: VisualObjectTransformV1 = { ...layer, x: 100, y: 0 };
    const projected = projectThroughCamera(onAxis, focal, camera, compHeight);
    expect(projected.x).toBeCloseTo(0, 4);
    expect(projected.y).toBeCloseTo(100, 4);
    expect(projected.rotationDeg).toBeCloseTo(layer.rotationDeg + 90, 6);
  });

  it('clamps degenerate (behind-camera or coincident) depth without producing NaN/Infinity', () => {
    const camera = { x: 0, y: 0, z: 0, rollDeg: 0, fieldOfViewDeg };
    const coincident = projectThroughCamera(layer, 0, camera, compHeight);
    const behind = projectThroughCamera(layer, -100, camera, compHeight);
    for (const projected of [coincident, behind]) {
      expect(Number.isFinite(projected.x)).toBe(true);
      expect(Number.isFinite(projected.y)).toBe(true);
      expect(Number.isFinite(projected.scaleX)).toBe(true);
      expect(projected.scaleX).toBeGreaterThan(0);
    }
  });
});
