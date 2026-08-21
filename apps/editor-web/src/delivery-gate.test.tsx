import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeliveryReportPanel } from './DeliveryReportPanel.js';
import {
  deliveryGate,
  reconcileDeliveryInspections,
  type DeliveryQualityStatus,
  type DeliveryRenderReport,
  type ExportProcessEntry,
} from './export-history.js';

const startedAt = '2026-08-21T00:00:00.000Z';

function entry(
  overrides: Partial<ExportProcessEntry> & Pick<ExportProcessEntry, 'id' | 'filename'>,
): ExportProcessEntry {
  return {
    status: 'completed',
    startedAt,
    ...overrides,
  };
}

function report(statuses: readonly DeliveryQualityStatus[]): DeliveryRenderReport {
  return {
    version: 1,
    promiseId: 'promise-project-1-1-reels-1080',
    checkedAt: '2026-08-21T00:01:00.000Z',
    artifact: {
      outputRef: 'render-output-1',
      sha256: 'a'.repeat(64),
      bytes: 1_048_576,
    },
    facts: {
      container: 'mp4',
      video: {
        codec: 'h264',
        width: 1080,
        height: 1920,
        frameRate: 30,
        durationUs: 1_000_000,
        frames: 30,
        sampledFrames: 12,
        blackFrames: 0,
        blankFrames: 0,
        duplicateFrames: 0,
      },
      audio: {
        codec: 'aac',
        sampleRate: 48000,
        channels: 2,
        durationUs: 1_000_000,
        rms: 0.1,
        peak: 0.5,
        clippedSamples: 0,
      },
      subtitles: { streams: 0 },
    },
    findings: statuses.map((status, index) => ({
      code: `${status}-${index}`,
      status,
      message: `${status} finding ${index}`,
    })),
  };
}

describe('delivery gate', () => {
  it('allows verified delivery when inspection reports only passing evidence', () => {
    const gate = deliveryGate(
      entry({
        id: 'delivery-1',
        filename: 'delivery.mp4',
        channel: 'verified-delivery',
        exportJobId: 'render-export-1',
        inspectJobId: 'render-inspect-1',
        reportRef: 'report-render-inspect-1',
        inspection: { state: 'completed', report: report(['pass', 'pass']) },
      }),
    );

    expect(gate).toMatchObject({
      status: 'pass',
      canDeliver: true,
      summary: { pass: 2, warn: 0, fail: 0 },
    });
  });

  it('allows verified delivery with a warning report but keeps the warning visible', () => {
    const gate = deliveryGate(
      entry({
        id: 'delivery-2',
        filename: 'warn.mp4',
        channel: 'verified-delivery',
        inspection: { state: 'completed', report: report(['pass', 'warn']) },
      }),
    );

    expect(gate).toMatchObject({
      status: 'warn',
      canDeliver: true,
      summary: { pass: 1, warn: 1, fail: 0 },
    });
  });

  it('blocks delivery when a report has failing evidence and no authorized waiver', () => {
    const gate = deliveryGate(
      entry({
        id: 'delivery-3',
        filename: 'fail.mp4',
        channel: 'verified-delivery',
        inspection: { state: 'completed', report: report(['pass', 'fail']) },
      }),
    );

    expect(gate).toMatchObject({
      status: 'blocked',
      canDeliver: false,
      reason: 'Render inspection found blocking failures.',
    });
  });

  it('allows delivery only when a failing report has a waiver actor and reason', () => {
    const blocked = deliveryGate(
      entry({
        id: 'delivery-4',
        filename: 'unauthorized-waiver.mp4',
        channel: 'verified-delivery',
        inspection: {
          state: 'completed',
          report: report(['fail']),
          waiver: { actor: 'producer@example.com', reason: ' ' },
        },
      }),
    );
    const waived = deliveryGate(
      entry({
        id: 'delivery-5',
        filename: 'waived.mp4',
        channel: 'verified-delivery',
        inspection: {
          state: 'completed',
          report: report(['fail']),
          waiver: {
            actor: 'producer@example.com',
            reason: 'Client accepted one clipped sample for the embargo cut.',
            recordedAt: '2026-08-21T00:02:00.000Z',
          },
        },
      }),
    );

    expect(blocked.canDeliver).toBe(false);
    expect(waived).toMatchObject({
      status: 'waived',
      canDeliver: true,
      waiver: {
        actor: 'producer@example.com',
        reason: 'Client accepted one clipped sample for the embargo cut.',
      },
    });
  });

  it('does not deliver canceled inspections or legacy uninspected exports', () => {
    expect(
      deliveryGate(
        entry({
          id: 'delivery-6',
          filename: 'canceled.mp4',
          channel: 'verified-delivery',
          inspectJobId: 'render-inspect-canceled',
          inspection: { state: 'canceled' },
        }),
      ),
    ).toMatchObject({
      status: 'canceled',
      canDeliver: false,
      reason: 'Render inspection was canceled before a report was recorded.',
    });

    expect(
      deliveryGate(
        entry({
          id: 'legacy-export',
          filename: 'legacy.mp4',
          status: 'completed',
          totalBytes: 99,
        }),
      ),
    ).toMatchObject({
      status: 'unverified',
      canDeliver: false,
      reason: 'No render inspection report is linked to this export.',
    });
  });

  it('renders report evidence and keeps quick browser exports separate from verified delivery', () => {
    const markup = renderToStaticMarkup(
      <DeliveryReportPanel
        entries={[
          entry({
            id: 'quick-1',
            filename: 'quick.mp4',
            channel: 'quick-browser-export',
            totalBytes: 1024,
          }),
          entry({
            id: 'delivery-7',
            filename: 'verified.mp4',
            channel: 'verified-delivery',
            exportJobId: 'render-export-7',
            inspectJobId: 'render-inspect-7',
            reportRef: 'report-render-inspect-7',
            inspection: { state: 'completed', report: report(['pass', 'warn']) },
          }),
        ]}
      />,
    );

    expect(markup).toContain('Quick browser export');
    expect(markup).toContain('Not verified');
    expect(markup).toContain('Verified delivery');
    expect(markup).toContain('report-render-inspect-7');
    expect(markup).toContain('render-export-7');
    expect(markup).toContain('1 warning');
  });

  it('reconciles completed, failed, and canceled render jobs into delivery inspection evidence', () => {
    const entries: readonly ExportProcessEntry[] = [
      entry({
        id: 'delivery-pass',
        filename: 'pass.mp4',
        channel: 'verified-delivery',
        exportJobId: 'render-pass',
        reportRef: 'report-pass',
        inspection: { state: 'queued', reportRef: 'report-pass' },
      }),
      entry({
        id: 'delivery-fail',
        filename: 'fail.mp4',
        channel: 'verified-delivery',
        exportJobId: 'render-fail',
        reportRef: 'report-fail',
        inspection: {
          state: 'queued',
          reportRef: 'report-fail',
          waiver: { actor: 'producer@example.com', reason: 'Known client exception' },
        },
      }),
      entry({
        id: 'delivery-canceled',
        filename: 'canceled.mp4',
        channel: 'verified-delivery',
        exportJobId: 'render-canceled',
        reportRef: 'report-canceled',
        inspection: { state: 'queued', reportRef: 'report-canceled' },
      }),
      entry({
        id: 'quick',
        filename: 'quick.mp4',
        channel: 'quick-browser-export',
        inspection: { state: 'not-requested' },
      }),
    ];

    const reconciled = reconcileDeliveryInspections(entries, [
      renderJob('render-pass', 'completed', report(['pass'])),
      renderJob('render-fail', 'completed', report(['fail'])),
      renderJob('render-canceled', 'canceled'),
    ]);

    expect(deliveryGate(reconciled[0]!)).toMatchObject({ status: 'pass', canDeliver: true });
    expect(deliveryGate(reconciled[1]!)).toMatchObject({
      status: 'waived',
      canDeliver: true,
      waiver: { actor: 'producer@example.com' },
    });
    expect(deliveryGate(reconciled[2]!)).toMatchObject({ status: 'canceled', canDeliver: false });
    expect(reconciled[3]).toMatchObject({
      channel: 'quick-browser-export',
      inspection: { state: 'not-requested' },
    });
  });
});

function renderJob(
  id: string,
  state: 'completed' | 'canceled' | 'failed',
  qualityReport?: DeliveryRenderReport,
) {
  return {
    id,
    projectId: 'project-1',
    type: 'render.export',
    state,
    progress: state === 'completed' ? 100 : 25,
    cancelRequested: false,
    ...(state === 'failed' ? { error: 'worker failed' } : {}),
    ...(qualityReport === undefined
      ? {}
      : {
          derivative: {
            jobId: id,
            kind: 'render.export',
            reportRef: qualityReport.artifact?.outputRef ?? `report-${id}`,
            outputRef: 'render-output',
            sha256: 'b'.repeat(64),
            bytes: 2048,
            workerRef: 'worker-1',
            resultRef: `derivative:${id}`,
            verifiedAt: Date.parse(startedAt),
            qualityReport,
          },
        }),
  } as const;
}
