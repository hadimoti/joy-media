import { describe, expect, it } from 'vitest';
import { createEvidenceStore } from './evidence-store.js';
import {
  analyzeTimelineTextBoxes,
  createTimelineQcSampler,
  planTimelineQcSampling,
} from './qc-sampler.js';

const textBox = {
  id: 'title-main',
  kind: 'title' as const,
  startUs: 2_000_000,
  endUs: 4_000_000,
  x: 0.1,
  y: 0.1,
  width: 0.8,
  height: 0.3,
  textColor: { r: 255, g: 255, b: 255, a: 255 },
};

let fixtureId = 0;

function createFixture(
  plan: ReturnType<typeof planTimelineQcSampling>,
  store = createEvidenceStore(),
) {
  fixtureId += 1;
  const scope = {
    runId: `qc-run-${fixtureId}`,
    identity: {
      projectId: `project-${fixtureId}`,
      assetDigest: 'a'.repeat(64),
      projectRevision: 'revision-1',
      modelId: 'local-qc',
      promptPolicyDigest: 'qc-v1',
    },
  };
  const manifestId = `timeline-qc-${fixtureId}`;
  const lookup = { manifestId, scope };
  store.createManifest({
    id: manifestId,
    scope,
    mode: 'overview',
    intendedFrameIdPages: [plan.frameIds],
  });
  return {
    store,
    lookup,
    request: {
      plan,
      composition: {
        snapshot: {
          kind: 'canonical' as const,
          compositionId: 'composition-1',
          projectRevision: 'revision-1',
          rendererVersion: 'renderer-v1',
          evaluatorVersion: 'evaluator-v1',
          dependencyDigests: ['b'.repeat(64)],
          state: {},
        },
        readiness: {
          check: () =>
            ({ asset: 'ready', font: 'ready', scene: 'ready', shader: 'ready' }) as const,
        },
        evaluator: {
          version: 'evaluator-v1',
          evaluate: (_snapshot: unknown, timeUs: number) => ({
            version: 1 as const,
            compositionId: 'composition-1',
            timeUs,
            viewport: { width: 4, height: 4, dpr: 1 },
            background: { r: 0, g: 0, b: 0, a: 255 },
            nodes: [],
          }),
        },
        renderer: {
          version: 'renderer-v1',
          renderAndReadback: () => ({
            width: 4,
            height: 4,
            data: new Uint8Array(4 * 4 * 4),
          }),
        },
      },
      evidenceStore: store,
      evidenceLookup: lookup,
    },
  };
}

function canvasFactory(jpegBytes = 4) {
  return (width: number, height: number) => {
    const context = {
      createImageData: (imageWidth: number, imageHeight: number) => ({
        width: imageWidth,
        height: imageHeight,
        data: new Uint8ClampedArray(imageWidth * imageHeight * 4),
      }),
      putImageData: () => undefined,
      drawImage: () => undefined,
    };
    return {
      width,
      height,
      getContext: () => context,
      convertToBlob: async ({ type }: { type: string }) =>
        new Blob([new Uint8Array(jpegBytes)], { type }),
    };
  };
}

function darkFrame(outputTimeUs: number, width = 10, height = 10) {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 3; index < rgba.length; index += 4) rgba[index] = 255;
  return { outputTimeUs, width, height, rgba };
}

describe('timeline QC sampler', () => {
  it('plans evenly spaced samples and includes every cut exactly once', () => {
    const plan = planTimelineQcSampling({
      durationUs: 10_000_000,
      cutTimesUs: [8_000_000, 4_000_000, 4_000_000],
      strategy: { kind: 'evenly-spaced-plus-cuts', count: 3 },
    });

    expect(plan.timesUs).toEqual([0, 4_000_000, 5_000_000, 8_000_000, 9_999_999]);
    expect(plan.frameIds).toEqual(plan.timesUs.map((timeUs) => `timeline-frame-${timeUs}`));
    expect(plan.coverage).toMatchObject({
      sourceDurationUs: 10_000_000,
      sampledFrameCount: 5,
      sampledCutCount: 2,
      totalCutCount: 2,
      completeSourceCoverage: false,
    });
  });

  it('rejects a plan when adding cuts exceeds the frame cap', () => {
    expect(() =>
      planTimelineQcSampling({
        durationUs: 10,
        cutTimesUs: [2],
        strategy: { kind: 'evenly-spaced-plus-cuts', count: 2 },
        maxFrames: 2,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-plan' }));
  });

  it('adds a title midpoint and checks its 90 percent safe area and contrast', () => {
    const plan = planTimelineQcSampling({
      durationUs: 6_000_000,
      strategy: { kind: 'times', timesUs: [0, 5_999_999] },
      textBoxes: [textBox],
    });
    expect(plan.timesUs).toEqual([0, 3_000_000, 5_999_999]);

    const frame = darkFrame(3_000_000);
    const outsideBox = { ...textBox, id: 'title-outside', x: 0.9, width: 0.2 };
    const checks = analyzeTimelineTextBoxes([textBox, outsideBox], [frame]);

    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({
      id: 'title-main',
      safeArea: { inside90Percent: true },
      legibility: { sampledAtUs: 3_000_000, meetsMinimumContrast: true },
    });
    expect(checks[0]?.legibility.contrastRatio).toBeGreaterThan(4.5);
    expect(checks[1]).toMatchObject({
      id: 'title-outside',
      safeArea: { inside90Percent: false },
    });
  });

  it('blends translucent text against the sampled colored background in sRGB', () => {
    const frame = darkFrame(3_000_000);
    for (let index = 0; index < frame.rgba.length; index += 4) {
      frame.rgba[index] = 0;
      frame.rgba[index + 1] = 0;
      frame.rgba[index + 2] = 255;
      frame.rgba[index + 3] = 255;
    }
    const translucentWhite = { ...textBox, textColor: { r: 255, g: 255, b: 255, a: 128 } };

    const [check] = analyzeTimelineTextBoxes([translucentWhite], [frame]);

    expect(check?.legibility.status).toBe('measured');
    if (check?.legibility.status !== 'measured') throw new Error('expected measured contrast');
    expect(check.legibility.contrastRatio).toBeCloseTo(2.639, 3);
  });

  it('captures sequentially, downsizes to a JPEG budget, and stores time and coverage', async () => {
    const plan = planTimelineQcSampling({
      durationUs: 1_000_000,
      strategy: { kind: 'times', timesUs: [0, 500_000] },
    });
    const fixture = createFixture(plan);
    const sampler = createTimelineQcSampler({
      canvasFactory: canvasFactory(),
      maxWidth: 2,
      maxHeight: 2,
      maxFrameBytes: 32,
      maxTotalBytes: 64,
    });

    const result = await sampler.sample(fixture.request);

    expect(result).toMatchObject({ status: 'captured', frameIds: plan.frameIds });
    for (const frameId of plan.frameIds) {
      const timestampUs = Number(frameId.slice('timeline-frame-'.length));
      expect(fixture.store.readFrameArtifact({ ...fixture.lookup, frameId })).toMatchObject({
        timestampUs,
        jpeg: expect.objectContaining({ type: 'image/jpeg', size: 4 }),
        width: 2,
        height: 2,
        coverage: { completeSourceCoverage: false, sampledFrameCount: 2 },
      });
    }
  });

  it('reports an artifact that exceeds the per-frame JPEG cap', async () => {
    const plan = planTimelineQcSampling({
      durationUs: 1_000_000,
      strategy: { kind: 'times', timesUs: [0] },
    });
    const fixture = createFixture(plan);

    const result = await createTimelineQcSampler({
      canvasFactory: canvasFactory(8),
      maxFrameBytes: 4,
      maxTotalBytes: 16,
    }).sample(fixture.request);

    expect(result).toMatchObject({
      status: 'failed',
      code: 'artifact-too-large',
      sampledFrameCount: 0,
    });
  });

  it('reports when accumulated JPEGs exceed the total byte budget', async () => {
    const plan = planTimelineQcSampling({
      durationUs: 1_000_000,
      strategy: { kind: 'times', timesUs: [0, 500_000] },
    });
    const fixture = createFixture(plan);

    const result = await createTimelineQcSampler({
      canvasFactory: canvasFactory(),
      maxFrameBytes: 4,
      maxTotalBytes: 4,
    }).sample(fixture.request);

    expect(result).toMatchObject({
      status: 'failed',
      code: 'byte-budget-exceeded',
      sampledFrameCount: 1,
    });
  });

  it('maps an evidence-store quota error to the byte-budget result', async () => {
    const plan = planTimelineQcSampling({
      durationUs: 1_000_000,
      strategy: { kind: 'times', timesUs: [0] },
    });
    const fixture = createFixture(plan, createEvidenceStore({ maxFrameArtifactBytes: 2 }));

    const result = await createTimelineQcSampler({
      canvasFactory: canvasFactory(),
      maxFrameBytes: 8,
      maxTotalBytes: 16,
    }).sample(fixture.request);

    expect(result).toMatchObject({
      status: 'failed',
      code: 'byte-budget-exceeded',
      sampledFrameCount: 0,
    });
  });

  it('cancels an aborted capture request', async () => {
    const plan = planTimelineQcSampling({
      durationUs: 1_000_000,
      strategy: { kind: 'times', timesUs: [0] },
    });
    const fixture = createFixture(plan);
    const controller = new AbortController();
    controller.abort();

    const result = await createTimelineQcSampler({ canvasFactory: canvasFactory() }).sample({
      ...fixture.request,
      signal: controller.signal,
    });

    expect(result).toEqual({ status: 'cancelled', sampledFrameCount: 0 });
    expect(fixture.store.readManifest(fixture.lookup)?.status).toBe('cancelled');
  });
});
