import { describe, expect, it } from 'vitest';
import {
  formatQcRange,
  formatQcTimecode,
  qcGroupName,
  qcReportFileNames,
  qcReportJson,
  qcReportMarkdown,
  qcSentLine,
  readQcReportView,
} from './joy-code-qc-report.js';

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    reportId: 'qc-report-run-1-1',
    projectId: 'project-1',
    createdAt: '2026-11-15T10:00:00.000Z',
    target: { kind: 'timeline', range: { domain: 'composition', startUs: 0, endUs: 6_000_000 } },
    run: { layer1: true, layer2: false, modelId: null, framesSent: 0, framesSkipped: 0 },
    coverage: { completeSourceCoverage: false, sampledRanges: [], unsampledRanges: [] },
    findings: [
      {
        id: 'f2',
        type: 'text-legibility',
        state: 'measured',
        severity: 'major',
        startUs: 3_000_000,
        endUs: 4_000_000,
        label: 'A title is hard to read against the picture behind it.',
        fixable: true,
      },
      {
        id: 'f1',
        type: 'safe-area',
        state: 'measured',
        severity: 'minor',
        startUs: 1_000_000,
        endUs: 3_000_000,
        label: 'A title sits outside the 90 percent safe area.',
        fixable: true,
      },
      {
        id: 'f3',
        type: 'black',
        state: 'measured',
        severity: 'blocker',
        startUs: 500_000,
        endUs: 500_000,
        label: 'A black frame.',
        fixable: false,
      },
    ],
    notes: [],
    frames: [
      { frameId: 'timeline-frame-0', timeUs: 0 },
      { frameId: 'timeline-frame-3000000', timeUs: 3_000_000 },
    ],
    modelComprehensionGuaranteed: false,
    ...overrides,
  };
}

describe('readQcReportView', () => {
  it('groups findings by type in picture, sound, text order with the earliest first', () => {
    const view = readQcReportView(report())!;
    expect(view.groups.map((group) => group.type)).toEqual([
      'black',
      'safe-area',
      'text-legibility',
    ]);
    expect(view.groups.map((group) => group.name)).toEqual([
      'Black frames',
      'Safe area',
      'Text legibility',
    ]);
    expect(view.findingCount).toBe(3);
    expect(view.summary).toBe('3 findings (1 blocker, 1 major, 1 minor) in 3 types');
    expect(view.durationUs).toBe(6_000_000);
    expect(view.frames.map((frame) => frame.timeUs)).toEqual([0, 3_000_000]);
  });

  it('says a clean sampled report is clean only in the sampled frames', () => {
    expect(readQcReportView(report({ findings: [] }))!.summary).toBe(
      'No findings in the sampled frames',
    );
    expect(
      readQcReportView(
        report({
          findings: [],
          coverage: { completeSourceCoverage: true, sampledRanges: [], unsampledRanges: [] },
        }),
      )!.summary,
    ).toBe('No findings');
  });

  it('drops a finding it cannot verify and refuses a value that is not a report', () => {
    const view = readQcReportView(
      report({
        findings: [
          { id: 'x', type: 'black', startUs: -1, endUs: 5, label: 'Bad time' },
          { id: 'y', type: 'black', startUs: 9, endUs: 5, label: 'Backwards' },
          { id: 'z', type: 'black', startUs: 1, endUs: 5 },
          'not an object',
          { id: 'ok', type: 'silence', startUs: 1, endUs: 5, label: 'Quiet part' },
        ],
      }),
    )!;
    expect(view.findingCount).toBe(1);
    expect(view.groups[0]!.findings[0]).toMatchObject({
      id: 'ok',
      severity: 'minor',
      state: 'unconfirmed',
      fixable: false,
    });
    expect(readQcReportView(null)).toBeUndefined();
    expect(readQcReportView({ version: 2, reportId: 'a', findings: [] })).toBeUndefined();
    expect(readQcReportView({ version: 1, findings: [] })).toBeUndefined();
    expect(readQcReportView({ version: 1, reportId: 'a' })).toBeUndefined();
  });

  it('reads the model and the frames used against the budget', () => {
    const view = readQcReportView(
      report({ run: { layer1: true, layer2: true, modelId: 'vision-1', framesSent: 4 } }),
      12,
    )!;
    expect(view).toMatchObject({
      layer2: true,
      modelId: 'vision-1',
      framesSent: 4,
      frameBudget: 12,
    });
    expect(qcSentLine(view)).toBe('Sent to vision-1');
    expect(qcSentLine(readQcReportView(report())!)).toBe('Kept on this device');
  });

  it('keeps a frame id with a path or a link out of the filmstrip', () => {
    const view = readQcReportView(
      report({
        frames: [
          { frameId: 'C:\\private\\frame.png', timeUs: 1 },
          { frameId: 'https://example.test/frame', timeUs: 2 },
          { frameId: 'timeline-frame-5', timeUs: 5 },
        ],
      }),
    )!;
    expect(view.frames.map((frame) => frame.id)).toEqual(['timeline-frame-5']);
  });
});

describe('formatting and files', () => {
  it('formats timecodes and ranges', () => {
    expect(formatQcTimecode(0)).toBe('0:00.000');
    expect(formatQcTimecode(61_500_000)).toBe('1:01.500');
    expect(formatQcTimecode(3_723_004_000)).toBe('1:02:03.004');
    expect(formatQcRange({ startUs: 1_000_000, endUs: 3_000_000 })).toBe('0:01.000–0:03.000');
    expect(formatQcRange({ startUs: 500_000, endUs: 500_000 })).toBe('0:00.500');
  });

  it('names an unknown type from its own words', () => {
    expect(qcGroupName('black')).toBe('Black frames');
    expect(qcGroupName('lens-flare')).toBe('Lens flare');
    expect(qcGroupName('***')).toBe('Other');
  });

  it('makes file names safe', () => {
    expect(qcReportFileNames('qc-report-run-1-1')).toEqual({
      markdown: 'qc-report-run-1-1.md',
      json: 'qc-report-run-1-1.json',
    });
    expect(qcReportFileNames('..\\..\\evil name')).toEqual({
      markdown: '..-..-evil-name.md',
      json: '..-..-evil-name.json',
    });
  });

  it('writes Markdown with the summary, the groups and the before and after', () => {
    const view = readQcReportView(report())!;
    const markdown = qcReportMarkdown(view, { findingCount: 5 });
    expect(markdown).toContain('# QC report qc-report-run-1-1');
    expect(markdown).toContain('3 findings (1 blocker, 1 major, 1 minor) in 3 types');
    expect(markdown).toContain('- Before: 5 findings, after: 3 findings');
    expect(markdown).toContain('- Kept on this device');
    expect(markdown).toContain('- Frames: 0 of 16');
    expect(markdown).toContain('## Safe area (1)');
    expect(markdown).toContain('| 0:01.000–0:03.000 | minor | measured |');
    expect(markdown).toContain('not guaranteed to have understood');
    expect(qcReportMarkdown(readQcReportView(report({ findings: [] }))!)).toContain('No findings.');
  });

  it('writes the report as received as JSON', () => {
    const source = report();
    const json = JSON.parse(qcReportJson(readQcReportView(source)!)) as Record<string, unknown>;
    expect(json).toEqual(source);
    expect(json['modelComprehensionGuaranteed']).toBe(false);
  });
});
