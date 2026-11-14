import { describe, expect, it, vi } from 'vitest';
import { createEvidenceStore } from '../media-observation/evidence-store.js';
import {
  createTimelineQcSampler,
  type TimelineQcCanvasFactory,
  type TimelineQcTextBox,
} from '../media-observation/qc-sampler.js';
import type { HostRpcHandlerContext } from './host-rpc.js';
import {
  createEditorQcAdapter,
  createQcHostAdapter,
  qcTimelineSourceFromTimeline,
  runDesktopMediaQc,
  type QcFrameConsentRequest,
  type QcFrameTransport,
  type QcHostAdapterDeps,
  type QcTimelineSource,
} from './qc-host-adapter.js';
import { isQcCheckRequest, isQcHostToolName } from './qc-request-intent.js';
import type { JoyAgentQcFrameReviewRequest } from './tool-bridge.js';

const IDENTITY = {
  runId: 'run-1',
  projectId: 'project-1',
  revision: 'revision-1',
  modelId: 'vision-model',
  promptPolicyDigest: 'policy-1',
};

const WIDE_TITLE: TimelineQcTextBox = {
  id: 'title-1',
  kind: 'title',
  startUs: 1_000_000,
  endUs: 3_000_000,
  // Starts outside the 5 percent margin, so the safe-area check must fire.
  x: 0.01,
  y: 0.4,
  width: 0.5,
  height: 0.1,
  textColor: { r: 255, g: 255, b: 255, a: 255 },
};

function context(signal = new AbortController().signal): HostRpcHandlerContext {
  return {
    run: { runId: 'host-run', epoch: 1 },
    requestId: 'request-1',
    signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
  };
}

const canvasFactory: TimelineQcCanvasFactory = (width, height) => {
  const imageContext = {
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: () => undefined,
    drawImage: () => undefined,
  };
  return {
    width,
    height,
    getContext: () => imageContext,
    convertToBlob: async ({ type }) => new Blob([new Uint8Array(8)], { type }),
  };
};

/** An opaque dark 8 x 8 frame, so white titles are legible and only placement can fail. */
function darkPixels(): Uint8Array {
  const data = new Uint8Array(8 * 8 * 4);
  for (let index = 3; index < data.length; index += 4) data[index] = 255;
  return data;
}

/** A composition request that renders the dark frame at every time. */
function fakeComposition(): NonNullable<QcTimelineSource['composition']> {
  return {
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
      evaluate: (_snapshot, timeUs) => ({
        version: 1 as const,
        compositionId: 'composition-1',
        timeUs,
        viewport: { width: 8, height: 8, dpr: 1 },
        background: { r: 255, g: 255, b: 255, a: 255 },
        nodes: [],
      }),
    },
    renderer: {
      version: 'renderer-v1',
      renderAndReadback: () => ({ width: 8, height: 8, data: darkPixels() }),
    },
  };
}

interface Fixture {
  readonly adapter: ReturnType<typeof createQcHostAdapter>;
  readonly store: ReturnType<typeof createEvidenceStore>;
  readonly transport: { analyze: ReturnType<typeof vi.fn> };
  readonly requestConsent: ReturnType<typeof vi.fn>;
  readonly image: { value: boolean };
  readonly privacy: { value: boolean };
}

interface FixtureOptions {
  /** `'absent'`: the host cannot capture composed frames. */
  readonly composition?: 'absent';
  /** `'absent'`: no private image transport is connected. A transport replaces the fake one. */
  readonly transport?: 'absent' | QcFrameTransport;
  /** `'absent'`: no consent card is connected. A boolean is the user's answer to the card. */
  readonly consent?: 'absent' | boolean;
  readonly identity?: QcHostAdapterDeps['identity'];
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const store = createEvidenceStore();
  const transport = {
    analyze: vi.fn(async () => ({ ok: true as const, analysis: 'The titles look steady.' })),
  };
  const requestConsent = vi.fn(async (_request: QcFrameConsentRequest, _signal: AbortSignal) =>
    options.consent === undefined || options.consent === 'absent' ? true : options.consent,
  );
  const image = { value: true };
  const privacy = { value: true };
  const composition = options.composition === 'absent' ? undefined : fakeComposition();
  const activeTransport: QcFrameTransport | undefined =
    options.transport === 'absent' ? undefined : (options.transport ?? transport);
  const deps: QcHostAdapterDeps = {
    evidenceStore: store,
    identity: options.identity ?? (() => IDENTITY),
    timeline: () => ({
      durationUs: 6_000_000,
      cutTimesUs: [2_000_000, 4_000_000],
      textBoxes: [WIDE_TITLE],
      composition,
    }),
    sampler: createTimelineQcSampler({ canvasFactory }),
    isCachedImageSupported: () => image.value,
    isPrivacyModeAllowed: () => privacy.value,
    ...(options.consent === 'absent' ? {} : { requestConsent }),
    ...(activeTransport === undefined ? {} : { transport: activeTransport }),
    createContactSheet: async () => new Blob([new Uint8Array(4)], { type: 'image/jpeg' }),
    digest: async () => 'c'.repeat(64),
    now: () => Date.UTC(2026, 10, 14),
    evenFrameCount: 4,
  };
  return { adapter: createQcHostAdapter(deps), store, transport, requestConsent, image, privacy };
}

async function readLatest(adapter: Fixture['adapter']) {
  return (await adapter.readReport({ reportId: 'latest', includeFindings: true }, context())) as {
    readonly [key: string]: unknown;
  };
}

function frameRequest(
  reportId: string,
  frameIds: readonly string[],
  tool: JoyAgentQcFrameReviewRequest['tool'] = 'media_frames_view',
): JoyAgentQcFrameReviewRequest {
  return tool === 'media_frames_view'
    ? { tool, reportId, frameIds, reason: 'Check the title.' }
    : { tool, reportId, frameIds, columns: 2 };
}

describe('QC host adapter: timeline check and report', () => {
  it('samples the cut on request and returns a report that lists its frames and findings', async () => {
    const { adapter } = createFixture();
    const report = await readLatest(adapter);

    expect(report).toMatchObject({
      version: 1,
      projectId: 'project-1',
      target: { kind: 'timeline' },
      run: { layer1: true, layer2: false, framesSent: 0 },
      modelComprehensionGuaranteed: false,
    });
    const frames = report['frames'] as { frameId: string; timeUs: number }[];
    // Four even samples, the two cuts and the title midpoint, without duplicates.
    expect(frames.length).toBeGreaterThanOrEqual(5);
    expect(new Set(frames.map((frame) => frame.frameId)).size).toBe(frames.length);
    const findings = report['findings'] as { type: string; state: string; evidenceIds: string[] }[];
    expect(findings.map((finding) => finding.type)).toEqual(['safe-area']);
    expect(findings[0]).toMatchObject({ state: 'measured', fixable: true });
    // Every cited frame is one the report lists.
    for (const id of findings[0]!.evidenceIds)
      expect(frames.map((frame) => frame.frameId)).toContain(id);
    const coverage = report['coverage'] as { completeSourceCoverage: boolean };
    expect(coverage.completeSourceCoverage).toBe(false);
  });

  it('reuses one report for repeated latest reads and omits findings on request', async () => {
    const { adapter } = createFixture();
    const first = await readLatest(adapter);
    const again = (await adapter.readReport(
      { reportId: first['reportId'] as string, includeFindings: false },
      context(),
    )) as { readonly [key: string]: unknown };

    expect(again['reportId']).toBe(first['reportId']);
    expect(again['findings']).toBeUndefined();
    expect(again['findingCount']).toBe(1);
  });

  it('refuses plainly when the host cannot capture composed frames', async () => {
    const { adapter } = createFixture({ composition: 'absent' });
    const refused = (await readLatest(adapter)) as { ok: boolean; code: string };

    expect(refused).toMatchObject({ ok: false, code: 'JOY_AGENT_QC_REPORT_UNAVAILABLE' });
    await expect(adapter.runTimelineCheck(new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      code: 'composition-unavailable',
    });
  });

  it('refuses when the run no longer owns the project', async () => {
    const { adapter } = createFixture({ identity: () => undefined });
    await expect(adapter.runTimelineCheck(new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      code: 'authority-unavailable',
    });
  });

  it('reports an unknown report id as unavailable', async () => {
    const { adapter } = createFixture();
    const refused = await adapter.readReport(
      { reportId: 'qc-report-other', includeFindings: true },
      context(),
    );
    expect(refused).toMatchObject({ ok: false, code: 'JOY_AGENT_QC_REPORT_UNAVAILABLE' });
  });

  it('keeps a file report and lists no frames for it', async () => {
    const { adapter } = createFixture();
    const reportId = adapter.storeFileReport({
      version: 1,
      reportId: 'qc-file-1',
      target: { kind: 'file' },
      findings: [],
    });
    expect(reportId).toBe('qc-file-1');
    expect(adapter.storeFileReport({ version: 2, reportId: 'x', findings: [] })).toBeUndefined();
    expect(
      adapter.isReportFrameSelectionValid(
        frameRequest('qc-file-1', ['timeline-frame-0']),
        context(),
      ),
    ).toBe(false);
  });
});

describe('QC host adapter: gates in front of every frame', () => {
  async function checked(overrides: Parameters<typeof createFixture>[0] = {}) {
    const fixture = createFixture(overrides);
    const report = await readLatest(fixture.adapter);
    const reportId = report['reportId'] as string;
    const frames = (report['frames'] as { frameId: string }[]).map((frame) => frame.frameId);
    return { ...fixture, reportId, frames };
  }

  it('serves only frame ids the report lists', async () => {
    const { adapter, reportId, frames } = await checked();

    expect(
      adapter.isReportFrameSelectionValid(frameRequest(reportId, [frames[0]!]), context()),
    ).toBe(true);
    expect(
      adapter.isReportFrameSelectionValid(
        frameRequest(reportId, [frames[0]!, 'timeline-frame-999999']),
        context(),
      ),
    ).toBe(false);
    expect(
      adapter.isReportFrameSelectionValid(frameRequest('qc-report-nope', [frames[0]!]), context()),
    ).toBe(false);
    await expect(
      adapter.reviewFrames(frameRequest(reportId, ['timeline-frame-999999']), context()),
    ).resolves.toMatchObject({ ok: false, code: 'JOY_AGENT_QC_FRAME_NOT_LISTED', framesSent: 0 });
  });

  it('reports image support only when the probe says so and a transport exists', async () => {
    const supported = await checked();
    expect(supported.adapter.isCachedImageSupported(context())).toBe(true);
    supported.image.value = false;
    expect(supported.adapter.isCachedImageSupported(context())).toBe(false);

    const withoutTransport = await checked({ transport: 'absent' });
    expect(withoutTransport.adapter.isCachedImageSupported(context())).toBe(false);
    await expect(
      withoutTransport.adapter.reviewFrames(
        frameRequest(withoutTransport.reportId, [withoutTransport.frames[0]!]),
        context(),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'JOY_AGENT_QC_CAPABILITY_UNAVAILABLE' });
    expect(withoutTransport.transport.analyze).not.toHaveBeenCalled();
  });

  it('never sends a frame in local-only mode, even if consent was given', async () => {
    const { adapter, privacy, transport, reportId, frames } = await checked();
    const request = frameRequest(reportId, [frames[0]!]);
    await expect(adapter.hasApprovedConsent(request, context())).resolves.toBe(true);
    privacy.value = false;

    expect(adapter.isPrivacyModeAllowed(context())).toBe(false);
    await expect(adapter.reviewFrames(request, context())).resolves.toMatchObject({
      ok: false,
      code: 'JOY_AGENT_QC_PRIVACY_BLOCKED',
    });
    expect(transport.analyze).not.toHaveBeenCalled();
  });

  it('does not send without an approved consent card, and a declined card stays declined', async () => {
    const { adapter, requestConsent, transport, reportId, frames } = await checked({
      consent: false,
    });
    const request = frameRequest(reportId, frames.slice(0, 2));

    await expect(adapter.hasApprovedConsent(request, context())).resolves.toBe(false);
    expect(requestConsent).toHaveBeenCalledTimes(1);
    expect(requestConsent.mock.calls[0]![0]).toMatchObject({
      reportId,
      frameCount: 2,
      modelId: 'vision-model',
      tool: 'media_frames_view',
    });
    await expect(adapter.reviewFrames(request, context())).resolves.toMatchObject({
      ok: false,
      code: 'JOY_AGENT_QC_CONSENT_REQUIRED',
    });
    expect(transport.analyze).not.toHaveBeenCalled();
  });

  it('fails closed when no consent card is connected', async () => {
    const { adapter, transport, reportId, frames } = await checked({ consent: 'absent' });
    const request = frameRequest(reportId, [frames[0]!]);

    await expect(adapter.hasApprovedConsent(request, context())).resolves.toBe(false);
    await expect(adapter.reviewFrames(request, context())).resolves.toMatchObject({
      ok: false,
      code: 'JOY_AGENT_QC_CONSENT_REQUIRED',
    });
    expect(transport.analyze).not.toHaveBeenCalled();
  });

  it('sends exactly the approved frames once and records them as reviewed', async () => {
    const { adapter, transport, requestConsent, store, reportId, frames } = await checked();
    const chosen = frames.slice(0, 3);
    const request = frameRequest(reportId, chosen);

    await expect(adapter.hasApprovedConsent(request, context())).resolves.toBe(true);
    // The same frames are covered by the consent already given: no second card.
    await expect(adapter.hasApprovedConsent(request, context())).resolves.toBe(true);
    expect(requestConsent).toHaveBeenCalledTimes(1);

    const result = await adapter.reviewFrames(request, context());
    expect(result).toEqual({
      ok: true,
      analysis: 'The titles look steady.',
      submittedFrameIds: chosen,
      framesSent: 3,
    });
    expect(transport.analyze).toHaveBeenCalledTimes(1);
    const sent = transport.analyze.mock.calls[0]![0] as {
      frames: { frameId: string }[];
      contactSheet: Blob | undefined;
      reason: string | undefined;
    };
    expect(sent.frames.map((frame) => frame.frameId)).toEqual(chosen);
    expect(sent.contactSheet).toBeUndefined();
    expect(sent.reason).toBe('Check the title.');

    const manifestId = `timeline-${reportId}`;
    const page = store.readCoveragePage({
      manifestId,
      scope: {
        runId: IDENTITY.runId,
        identity: {
          projectId: IDENTITY.projectId,
          assetDigest: 'c'.repeat(64),
          projectRevision: IDENTITY.revision,
          modelId: IDENTITY.modelId,
          promptPolicyDigest: IDENTITY.promptPolicyDigest,
        },
      },
      pageIndex: 0,
    });
    expect(page?.reviewedFrameIds).toEqual(expect.arrayContaining(chosen));
    expect(page?.summary.modelComprehensionGuaranteed).toBe(false);
  });

  it('asks again for a frame the first consent did not cover', async () => {
    const { adapter, requestConsent, reportId, frames } = await checked();
    await adapter.hasApprovedConsent(frameRequest(reportId, [frames[0]!]), context());
    await adapter.hasApprovedConsent(frameRequest(reportId, [frames[0]!, frames[1]!]), context());
    expect(requestConsent).toHaveBeenCalledTimes(2);
  });

  it('sends one contact sheet for a contact-sheet request', async () => {
    const { adapter, transport, reportId, frames } = await checked();
    const request = frameRequest(reportId, frames.slice(0, 4), 'media_contact_sheet');

    await adapter.hasApprovedConsent(request, context());
    const result = await adapter.reviewFrames(request, context());

    expect(result).toMatchObject({ ok: true, framesSent: 4 });
    const sent = transport.analyze.mock.calls[0]![0] as { contactSheet: Blob | undefined };
    expect(sent.contactSheet).toBeInstanceOf(Blob);
  });

  it('charges every requested frame when the provider call fails', async () => {
    const failing: QcFrameTransport = { analyze: vi.fn(async () => ({ ok: false as const })) };
    const { adapter, reportId, frames } = await checked({ transport: failing });
    const request = frameRequest(reportId, frames.slice(0, 2));
    await adapter.hasApprovedConsent(request, context());

    await expect(adapter.reviewFrames(request, context())).resolves.toMatchObject({
      ok: false,
      code: 'JOY_AGENT_QC_REVIEW_FAILED',
      framesSent: 2,
    });

    const throwing: QcFrameTransport = {
      analyze: vi.fn(async () => {
        throw new Error('network');
      }),
    };
    const second = await checked({ transport: throwing });
    const secondRequest = frameRequest(second.reportId, second.frames.slice(0, 2));
    await second.adapter.hasApprovedConsent(secondRequest, context());
    await expect(second.adapter.reviewFrames(secondRequest, context())).resolves.toMatchObject({
      ok: false,
      framesSent: 2,
    });
  });

  it('serves nothing after it is disposed', async () => {
    const { adapter, reportId, frames } = await checked();
    adapter.dispose();

    expect(
      adapter.isReportFrameSelectionValid(frameRequest(reportId, [frames[0]!]), context()),
    ).toBe(false);
    await expect(
      adapter.readReport({ reportId, includeFindings: true }, context()),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe('QC timeline source', () => {
  it('derives the duration and the hard cuts from the root composition', () => {
    const source = qcTimelineSourceFromTimeline({
      rootCompositionId: 'root',
      compositions: {
        root: {
          tracks: [
            { clips: [{ startUs: 0, durationUs: 2_000_000 }] },
            {
              clips: [
                { startUs: 2_000_000, durationUs: 3_000_000 },
                { startUs: 2_000_000, durationUs: 500_000 },
              ],
            },
          ],
        },
      },
    });
    expect(source).toMatchObject({ durationUs: 5_000_000, cutTimesUs: [2_000_000] });
    expect(source?.composition).toBeUndefined();
  });

  it('returns nothing for an empty or missing composition', () => {
    expect(qcTimelineSourceFromTimeline({ rootCompositionId: 'x', compositions: {} })).toBe(
      undefined,
    );
    expect(
      qcTimelineSourceFromTimeline({
        rootCompositionId: 'root',
        compositions: { root: { tracks: [{ clips: [] }] } },
      }),
    ).toBeUndefined();
  });
});

describe('editor QC adapter', () => {
  it('builds an adapter that refuses plainly while no composition request is supplied', async () => {
    const adapter = createEditorQcAdapter({
      ...IDENTITY,
      isCurrent: () => true,
      getTimeline: () => ({
        rootCompositionId: 'root',
        compositions: { root: { tracks: [{ clips: [{ startUs: 0, durationUs: 1_000_000 }] }] } },
      }),
      isCachedImageSupported: () => true,
      isPrivacyModeAllowed: () => true,
    });

    // No transport is connected, so even a supported probe cannot enable image review.
    expect(adapter.isCachedImageSupported(context())).toBe(false);
    await expect(adapter.runTimelineCheck(new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      code: 'composition-unavailable',
    });
  });

  it('stops identifying the run once it is no longer current', async () => {
    let current = true;
    const adapter = createEditorQcAdapter({
      ...IDENTITY,
      isCurrent: () => current,
      getTimeline: () => ({ rootCompositionId: 'root', compositions: {} }),
      isCachedImageSupported: () => true,
      isPrivacyModeAllowed: () => true,
    });
    current = false;
    await expect(adapter.runTimelineCheck(new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      code: 'authority-unavailable',
    });
  });
});

describe('desktop media QC call', () => {
  it('submits a media.qc job and returns the report of the finished job', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ jobId: 'job-1' })
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ status: 'done', report: { version: 1, findings: [] } });
    const report = await runDesktopMediaQc(
      { invoke },
      {
        refId: 'joylib-export',
        signal: new AbortController().signal,
        sleep: async () => undefined,
      },
    );

    expect(report).toEqual({ version: 1, findings: [] });
    expect(invoke).toHaveBeenNthCalledWith(1, 'desktop.media.qc.run', {
      refId: 'joylib-export',
      payload: {},
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'desktop.media.job.status', { jobId: 'job-1' });
  });

  it('returns nothing for a failed job or a refused submission', async () => {
    const failed = vi
      .fn()
      .mockResolvedValueOnce({ jobId: 'job-2' })
      .mockResolvedValueOnce({ status: 'failed' });
    await expect(
      runDesktopMediaQc({ invoke: failed }, { refId: 'x', signal: new AbortController().signal }),
    ).resolves.toBeUndefined();
    const refused = vi.fn().mockResolvedValueOnce({});
    await expect(
      runDesktopMediaQc({ invoke: refused }, { refId: 'x', signal: new AbortController().signal }),
    ).resolves.toBeUndefined();
  });

  it('cancels the job when it runs out of time', async () => {
    let clock = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'desktop.media.qc.run') return { jobId: 'job-3' };
      return { status: 'running' };
    });
    await expect(
      runDesktopMediaQc(
        { invoke },
        {
          refId: 'x',
          signal: new AbortController().signal,
          timeoutMs: 1_000,
          pollMs: 400,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(invoke).toHaveBeenLastCalledWith('desktop.media.job.cancel', { jobId: 'job-3' });
  });
});

describe('QC request intent', () => {
  it('recognises a quality-check request and leaves ordinary edits alone', () => {
    for (const prompt of [
      'Run a quality check on my film',
      'Check the cut for problems',
      'Review the film frame by frame for problems',
      'QC this export',
      'are there any issues in the video?',
      'Find problems in the timeline',
      'Are there faults in this export?',
      'Spot mistakes in the film',
      'Does the cut have errors?',
      'کنترل کیفیت فیلم را انجام بده',
      'کیفیت ویدیو را بررسی کن',
      'ویدیو مشکل دارد؟',
    ])
      expect(isQcCheckRequest(prompt), prompt).toBe(true);
    for (const prompt of [
      'Trim the first clip by two seconds',
      'Add a title that says Hello',
      'Make the music quieter',
      'trim the video and fix the error in the title',
      'Check the video track volume',
      'check the frame rate',
      'review my timeline pacing and tighten the cut',
      'watch the export progress',
      'Please proofread the captions',
      'Is there a way to export the video as a gif?',
      'ویدیو را کوتاه کن',
    ])
      expect(isQcCheckRequest(prompt), prompt).toBe(false);
  });

  it('knows exactly the three QC tool names', () => {
    const names = ['qc_report_read', 'media_frames_view', 'media_contact_sheet'];
    expect(names.every(isQcHostToolName)).toBe(true);
    expect(isQcHostToolName('media_frames')).toBe(false);
    expect(isQcHostToolName('validate_proposal')).toBe(false);
  });
});
