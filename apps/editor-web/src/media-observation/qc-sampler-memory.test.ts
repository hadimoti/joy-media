import { describe, expect, it, vi } from 'vitest';

const captureControl = vi.hoisted(() => ({
  capture: undefined as (() => Promise<unknown>) | undefined,
}));

vi.mock('./composition-observer.js', () => ({
  createCompositionObserver: () => ({
    capture: () => {
      if (captureControl.capture === undefined) throw new Error('capture was not configured');
      return captureControl.capture();
    },
  }),
}));

import { createEvidenceStore } from './evidence-store.js';
import { createTimelineQcSampler, planTimelineQcSampling } from './qc-sampler.js';

function capturedFrame(outputTimeUs: number, rgba: Uint8Array) {
  return {
    identity: {
      projectId: 'project-1',
      assetDigest: 'a'.repeat(64),
      projectRevision: 'revision-1',
      modelId: 'local-qc',
      promptPolicyDigest: 'qc-v1',
    },
    snapshotKind: 'canonical' as const,
    outputTimeUs,
    width: 2,
    height: 2,
    rgba,
  };
}

function createCanvasFactory() {
  return (width: number, height: number) => ({
    width,
    height,
    getContext: () => ({
      createImageData: (imageWidth: number, imageHeight: number) => ({
        width: imageWidth,
        height: imageHeight,
        data: new Uint8ClampedArray(imageWidth * imageHeight * 4),
      }),
      putImageData: () => undefined,
      drawImage: () => undefined,
    }),
    convertToBlob: async ({ type }: { type: string }) =>
      new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type }),
  });
}

describe('timeline QC sampler readback lifetime', () => {
  it('analyzes a readback before the next capture so its RGBA buffer can be released', async () => {
    const textBox = {
      id: 'caption-memory',
      kind: 'caption' as const,
      startUs: 0,
      endUs: 2_000_000,
      x: 0.1,
      y: 0.1,
      width: 0.8,
      height: 0.3,
      textColor: { r: 255, g: 255, b: 255, a: 255 },
    };
    const plan = planTimelineQcSampling({
      durationUs: 3_000_000,
      strategy: { kind: 'times', timesUs: [1_000_000, 2_000_000] },
      textBoxes: [textBox],
    });
    const rgba = new Uint8Array(2 * 2 * 4);
    for (let index = 3; index < rgba.length; index += 4) rgba[index] = 255;
    const firstFrame = capturedFrame(1_000_000, rgba);
    const secondFrame = capturedFrame(2_000_000, new Uint8Array(2 * 2 * 4));
    for (let index = 3; index < secondFrame.rgba.length; index += 4) secondFrame.rgba[index] = 255;

    let captureCount = 0;
    captureControl.capture = async () => {
      captureCount += 1;
      if (captureCount === 2) rgba.fill(255);
      return {
        status: 'captured',
        captureScope: 'isolated-render-readback',
        encodedOutput: 'not-assessed',
        frames: [captureCount === 1 ? firstFrame : secondFrame],
      };
    };

    const store = createEvidenceStore();
    const scope = {
      runId: 'qc-memory-run',
      identity: {
        projectId: 'project-1',
        assetDigest: 'a'.repeat(64),
        projectRevision: 'revision-1',
        modelId: 'local-qc',
        promptPolicyDigest: 'qc-v1',
      },
    };
    const lookup = { manifestId: 'qc-memory-manifest', scope };
    store.createManifest({
      id: lookup.manifestId,
      scope,
      mode: 'overview',
      intendedFrameIdPages: [plan.frameIds],
    });

    const result = await createTimelineQcSampler({ canvasFactory: createCanvasFactory() }).sample({
      plan,
      composition: {
        snapshot: {
          kind: 'canonical',
          compositionId: 'composition-1',
          projectRevision: 'revision-1',
          rendererVersion: 'renderer-v1',
          evaluatorVersion: 'evaluator-v1',
          dependencyDigests: ['b'.repeat(64)],
          state: {},
        },
        readiness: {
          check: () => ({ asset: 'ready', font: 'ready', scene: 'ready', shader: 'ready' }),
        },
        evaluator: {
          version: 'evaluator-v1',
          evaluate: () => ({
            version: 1,
            compositionId: 'composition-1',
            timeUs: 0,
            viewport: { width: 2, height: 2, dpr: 1 },
            background: { r: 0, g: 0, b: 0, a: 255 },
            nodes: [],
          }),
        },
        renderer: {
          version: 'renderer-v1',
          renderAndReadback: () => ({ width: 2, height: 2, data: new Uint8Array(16) }),
        },
      },
      evidenceStore: store,
      evidenceLookup: lookup,
    });

    expect(captureCount).toBe(2);
    expect(result).toMatchObject({ status: 'captured' });
    if (result.status !== 'captured') throw new Error('expected captured result');
    expect(result.textChecks[0]?.legibility).toMatchObject({
      status: 'measured',
      sampledAtUs: 1_000_000,
      contrastRatio: 21,
    });
  });
});
