/**
 * End-to-end test: VisualObjectV1 → evaluator → RenderFrameIR → golden render.
 *
 * This proves the bridge that was documented as Partial in P10's gate review.
 * It creates a real scene (two objects with expressions + camera dolly) and
 * renders it through both the pixi preview path and the headless export path,
 * then compares the pixel digests for parity.
 */

import { describe, it, expect } from 'vitest';
import type { VisualObjectV1 } from '@joy-media/project-schema';
import { evaluateCameraExpressionTransform } from '@joy-media/evaluator';
import type { EvaluatedExpressionTransform } from '@joy-media/evaluator';
import type { RenderFrameIR } from '@joy-media/render-ir';
import { validateRenderFrameIR } from '@joy-media/render-ir';
import { renderPixiPreview } from '@joy-media/renderer-pixi';
import { renderHeadlessFrame } from '@joy-media/renderer-headless';
import { digestRgba } from '@joy-media/golden-render';
import { buildRenderFrameIR } from './index.js';
import type { ResolvedObject } from './index.js';

/** Build a minimal real scene matching the P10 gate review fixture. */
function makeScene(): {
  objects: Record<string, VisualObjectV1>;
  cameraId: string;
  layer1Id: string;
  layer2Id: string;
} {
  const camera: VisualObjectV1 = {
    id: 'camera-1',
    kind: 'camera',
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      positionZ: 0,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    },
    // positionZ expression: dolly from -500 to -300 over 1 second
    expressions: { positionZ: '-500 + time * 200' },
    camera: { fieldOfViewDeg: 45 },
  };

  const layer1: VisualObjectV1 = {
    id: 'layer-near',
    kind: 'image',
    transform: {
      x: 0,
      y: 0,
      scaleX: 0.5,
      scaleY: 0.5,
      rotationDeg: 0,
      opacity: 1,
      positionZ: 200,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    },
  };

  const layer2: VisualObjectV1 = {
    id: 'layer-far',
    kind: 'text',
    text: 'DEEP',
    transform: {
      x: 200,
      y: 100,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      positionZ: -100,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    },
    // opacity expression on the far layer (independent from camera)
    expressions: { opacity: 'clamp(time * 0.5, 0, 1)' },
  };

  return {
    objects: { [camera.id]: camera, [layer1.id]: layer1, [layer2.id]: layer2 },
    cameraId: camera.id,
    layer1Id: layer1.id,
    layer2Id: layer2.id,
  };
}

describe('e2e: VisualObject → evaluator → RenderFrameIR → render', () => {
  it('resolves a full scene with camera+expressions and produces a valid RenderFrameIR', () => {
    const scene = makeScene();

    // Resolve each visible object at time 500ms through the full evaluator
    const timeUs = 500_000;
    const resolved: ResolvedObject[] = [];

    for (const objId of [scene.layer1Id, scene.layer2Id]) {
      const result: EvaluatedExpressionTransform = evaluateCameraExpressionTransform(
        objId,
        scene.cameraId,
        scene.objects,
        timeUs,
        1080, // comp height
      );
      const obj = scene.objects[objId]!;
      const diags =
        result.diagnostics.length > 0
          ? result.diagnostics.map((d) => ({ channel: d.property, message: d.message }))
          : [];

      resolved.push({
        object: obj,
        transform: result.transform,
        ...(diags.length > 0 ? { expressionDiagnostics: diags } : {}),
      });
    }

    // Build the frame
    const frame: RenderFrameIR = buildRenderFrameIR('scene-1', timeUs, 1920, 1080, resolved);

    // Must validate
    expect(() => validateRenderFrameIR(frame)).not.toThrow();

    // Must have exactly 2 visual nodes (camera is excluded)
    expect(frame.nodes).toHaveLength(2);

    // Both render paths must produce identical pixels
    const preview = renderPixiPreview(frame);
    const headless = renderHeadlessFrame(frame);

    expect(preview.width).toBe(headless.width);
    expect(preview.height).toBe(headless.height);
    expect(preview.pixels.length).toBe(headless.pixels.length);

    const previewDigest = digestRgba(preview.pixels);
    const headlessDigest = digestRgba(headless.pixels);
    const identical = previewDigest === headlessDigest;

    expect(identical).toBe(true);
  });

  it('camera-only scene produces empty nodes array (no controllers rendered)', () => {
    const scene = makeScene();
    const timeUs = 0;

    const resolved: ResolvedObject[] = [];
    for (const objId of [scene.cameraId]) {
      const result = evaluateCameraExpressionTransform(
        objId,
        scene.cameraId,
        scene.objects,
        timeUs,
        1080,
      );
      resolved.push({
        object: scene.objects[objId]!,
        transform: result.transform,
      });
    }

    const frame = buildRenderFrameIR('c', timeUs, 100, 100, resolved);
    expect(frame.nodes).toHaveLength(0);
    expect(() => validateRenderFrameIR(frame)).not.toThrow();
  });
});
