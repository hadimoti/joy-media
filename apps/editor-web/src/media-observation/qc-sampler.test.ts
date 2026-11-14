import { describe, expect, it } from 'vitest';
import { createEvidenceStore } from './evidence-store.js';

const loadQcSampler = async () => import('./qc-sampler.js').catch(() => undefined);

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

describe('timeline QC sampler', () => {
  it('plans evenly spaced samples and includes every cut exactly once', async () => {
    const qc = await loadQcSampler();
    expect(qc).toBeDefined();
    if (qc === undefined) return;

    const plan = qc.planTimelineQcSampling({
      durationUs: 10_000_000,
      cutTimesUs: [8_000_000, 4_000_000, 4_000_000],
      strategy: { kind: 'evenly-spaced-plus-cuts', count: 3 },
    });

    expect(plan.timesUs).toEqual([0, 4_000_000, 5_000_000, 8_000_000, 9_999_999]);
    expect(plan.frameIds).toEqual(plan.timesUs.map((timeUs: number) => `timeline-frame-${timeUs}`));
    expect(plan.coverage).toMatchObject({
      sourceDurationUs: 10_000_000,
      sampledFrameCount: 5,
      sampledCutCount: 2,
      totalCutCount: 2,
      completeSourceCoverage: false,
    });
  });

  it('adds a title midpoint to explicit sample times and checks its 90 percent safe area and contrast', async () => {
    const qc = await loadQcSampler();
    expect(qc).toBeDefined();
    if (qc === undefined) return;

    const plan = qc.planTimelineQcSampling({
      durationUs: 6_000_000,
      strategy: { kind: 'times', timesUs: [0, 5_999_999] },
      textBoxes: [textBox],
    });
    expect(plan.timesUs).toEqual([0, 3_000_000, 5_999_999]);

    const darkFrame = {
      outputTimeUs: 3_000_000,
      width: 10,
      height: 10,
      rgba: new Uint8Array(10 * 10 * 4),
    };
    darkFrame.rgba.forEach((_value, index) => {
      if (index % 4 === 3) darkFrame.rgba[index] = 255;
    });
    const outsideBox = { ...textBox, id: 'title-outside', x: 0.9, width: 0.2 };
    const checks = qc.analyzeTimelineTextBoxes([textBox, outsideBox], [darkFrame]);

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

  it('captures sequentially, downsizes to a JPEG budget, and stores time and coverage', async () => {
    const qc = await loadQcSampler();
    expect(qc).toBeDefined();
    if (qc === undefined) return;

    const plan = qc.planTimelineQcSampling({
      durationUs: 1_000_000,
      strategy: { kind: 'times', timesUs: [0, 500_000] },
    });
    const evidenceStore = createEvidenceStore();
    const scope = {
      runId: 'qc-run-1',
      identity: {
        projectId: 'project-1',
        assetDigest: 'a'.repeat(64),
        projectRevision: 'revision-1',
        modelId: 'local-qc',
        promptPolicyDigest: 'qc-v1',
      },
    };
    const manifestId = 'timeline-qc-1';
    const lookup = { manifestId, scope };
    evidenceStore.createManifest({
      id: manifestId,
      scope,
      mode: 'overview',
      intendedFrameIdPages: [plan.frameIds],
    });
    const drawCalls: unknown[][] = [];
    const canvasFactory = (width: number, height: number) => {
      const context = {
        createImageData: (imageWidth: number, imageHeight: number) => ({
          width: imageWidth,
          height: imageHeight,
          data: new Uint8ClampedArray(imageWidth * imageHeight * 4),
        }),
        putImageData: (imageData: unknown) => drawCalls.push(['putImageData', imageData]),
        drawImage: (...args: unknown[]) => drawCalls.push(['drawImage', ...args]),
      };
      return {
        width,
        height,
        getContext: () => context,
        convertToBlob: async ({ type }: { type: string }) =>
          new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type }),
      };
    };
    const request = {
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
      evidenceStore,
      evidenceLookup: lookup,
    };
    const sampler = qc.createTimelineQcSampler({
      canvasFactory,
      maxWidth: 2,
      maxHeight: 2,
      maxFrameBytes: 32,
      maxTotalBytes: 64,
    });

    const result = await sampler.sample(request);

    expect(result).toMatchObject({ status: 'captured', frameIds: plan.frameIds });
    expect(drawCalls.some(([kind]) => kind === 'drawImage')).toBe(true);
    for (const frameId of plan.frameIds) {
      const timestampUs = Number(frameId.slice('timeline-frame-'.length));
      expect(evidenceStore.readFrameArtifact({ ...lookup, frameId })).toMatchObject({
        timestampUs,
        jpeg: expect.objectContaining({ type: 'image/jpeg', size: 4 }),
        width: 2,
        height: 2,
        coverage: { completeSourceCoverage: false, sampledFrameCount: 2 },
      });
    }
  });
});
