import { expect, test, type Page } from '@playwright/test';

async function openQcHarness(page: Page): Promise<void> {
  await page.route('**/__joy-timeline-qc-harness', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>JOY timeline QC harness</title>',
    });
  });
  await page.goto('/__joy-timeline-qc-harness');
}

test.describe('JOY timeline QC sampling', () => {
  test('samples 12 frames across a three-clip fixture and generates a contact sheet', async ({
    page,
  }) => {
    await openQcHarness(page);
    const result = await page.evaluate(async () => {
      const [
        { createEvidenceStore },
        { createTimelineQcSampler, planTimelineQcSampling },
        { createTimelineContactSheet },
      ] = await Promise.all([
        import('/src/media-observation/evidence-store.ts'),
        import('/src/media-observation/qc-sampler.ts'),
        import('/src/media-observation/contact-sheet.ts'),
      ]);

      const durationUs = 6_000_000;
      const clips = [
        { id: 'clip-1', startUs: 0, endUs: 1_500_000, color: { r: 230, g: 40, b: 40, a: 255 } },
        {
          id: 'clip-2',
          startUs: 1_500_000,
          endUs: 4_500_000,
          color: { r: 40, g: 190, b: 80, a: 255 },
        },
        {
          id: 'clip-3',
          startUs: 4_500_000,
          endUs: durationUs,
          color: { r: 40, g: 80, b: 230, a: 255 },
        },
      ];
      const plan = planTimelineQcSampling({
        durationUs,
        cutTimesUs: [1_500_000, 4_500_000],
        strategy: { kind: 'evenly-spaced-plus-cuts', count: 10 },
      });
      const scope = {
        runId: 'browser-qc-run',
        identity: {
          projectId: 'browser-qc-project',
          assetDigest: 'a'.repeat(64),
          projectRevision: 'browser-fixture-v1',
          modelId: 'local-qc',
          promptPolicyDigest: 'timeline-qc-v1',
        },
      };
      const manifestId = 'browser-timeline-qc';
      const evidenceStore = createEvidenceStore();
      evidenceStore.createManifest({
        id: manifestId,
        scope,
        mode: 'overview',
        intendedFrameIdPages: [plan.frameIds],
      });
      const sampler = createTimelineQcSampler({ maxWidth: 160, maxHeight: 90 });
      const sampled = await sampler.sample({
        plan,
        composition: {
          snapshot: {
            kind: 'canonical',
            compositionId: 'three-clip-fixture',
            projectRevision: 'browser-fixture-v1',
            rendererVersion: 'fixture-renderer-v1',
            evaluatorVersion: 'fixture-evaluator-v1',
            dependencyDigests: ['b'.repeat(64)],
            state: { clips },
          },
          readiness: {
            check: () => ({ asset: 'ready', font: 'ready', scene: 'ready', shader: 'ready' }),
          },
          evaluator: {
            version: 'fixture-evaluator-v1',
            evaluate: (snapshot, timeUs) => {
              const state = snapshot.state as { clips: typeof clips };
              const clip = state.clips.find(
                (candidate) => timeUs >= candidate.startUs && timeUs < candidate.endUs,
              );
              if (clip === undefined) throw new Error('fixture time is outside its clips');
              return {
                version: 1 as const,
                compositionId: 'three-clip-fixture',
                timeUs,
                viewport: { width: 320, height: 180, dpr: 1 },
                background: clip.color,
                nodes: [],
              };
            },
          },
          renderer: {
            version: 'fixture-renderer-v1',
            renderAndReadback: (frame) => {
              const { width, height } = frame.viewport;
              const data = new Uint8Array(width * height * 4);
              for (let offset = 0; offset < data.length; offset += 4) {
                data[offset] = frame.background.r;
                data[offset + 1] = frame.background.g;
                data[offset + 2] = frame.background.b;
                data[offset + 3] = 255;
              }
              return { width, height, data };
            },
          },
        },
        evidenceStore,
        evidenceLookup: { manifestId, scope },
      });
      if (sampled.status !== 'captured')
        throw new Error(`timeline sampling did not complete: ${sampled.status}`);
      const frames = plan.frameIds.map((frameId) => {
        const artifact = evidenceStore.readFrameArtifact({ manifestId, scope, frameId });
        if (artifact === undefined) throw new Error('a sampled JPEG artifact was not stored');
        return artifact;
      });
      const sheet = await createTimelineContactSheet({ frames });
      const bitmap = await createImageBitmap(sheet);
      const sheetDimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return {
        sampledFrameCount: sampled.frameIds.length,
        sampledCutCount: sampled.coverage.sampledCutCount,
        artifactCount: frames.length,
        jpegArtifacts: frames.every((frame) => frame.jpeg.type === 'image/jpeg'),
        sheet: { type: sheet.type, size: sheet.size, ...sheetDimensions },
      };
    });

    expect(result).toMatchObject({
      sampledFrameCount: 12,
      sampledCutCount: 2,
      artifactCount: 12,
      jpegArtifacts: true,
      sheet: { type: 'image/jpeg' },
    });
    expect(result.sheet.size).toBeGreaterThan(0);
    expect(result.sheet.width).toBeGreaterThan(0);
    expect(result.sheet.height).toBeGreaterThan(0);
  });
});
