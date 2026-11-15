// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readQcReportView, type QcReportView } from './joy-code-qc-report.js';
import { JoyCodeQcReportCard } from './joy-code-qc-report-card.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const FINDINGS = [
  {
    id: 'f1',
    type: 'safe-area',
    state: 'measured',
    severity: 'minor',
    startUs: 1_000_000,
    endUs: 3_000_000,
    label: 'A title sits outside the 90 percent safe area.',
    measured: { insideSafeArea: false },
    fixable: true,
  },
  {
    id: 'f2',
    type: 'black',
    state: 'measured',
    severity: 'major',
    startUs: 4_500_000,
    endUs: 5_000_000,
    label: 'A black run.',
    measured: { blackDurationSec: 2.5 },
    fixable: false,
  },
];

function view(overrides: Record<string, unknown> = {}): QcReportView {
  const parsed = readQcReportView({
    version: 1,
    reportId: 'qc-report-run-1-1',
    createdAt: '2026-11-15T10:00:00.000Z',
    target: { kind: 'timeline', range: { domain: 'composition', startUs: 0, endUs: 6_000_000 } },
    run: {
      layer1: true,
      layer2: true,
      modelId: 'vision-1',
      framesSent: 4,
      framesSkipped: 0,
      frameBudget: 16,
    },
    coverage: { completeSourceCoverage: false, sampledRanges: [], unsampledRanges: [] },
    findings: FINDINGS,
    notes: [
      {
        id: 'note-1',
        frameId: 'timeline-frame-0',
        timeUs: 1_500_000,
        text: 'Check the title edge.',
      },
    ],
    frames: [
      { frameId: 'timeline-frame-0', timeUs: 0 },
      { frameId: 'timeline-frame-2000000', timeUs: 2_000_000 },
    ],
    modelComprehensionGuaranteed: false,
    ...overrides,
  });
  if (parsed === undefined) throw new Error('The fixture report did not parse');
  return parsed;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('JoyCodeQcReportCard', () => {
  it('shows the summary, the findings grouped by type, the model, the frames and the filmstrip', () => {
    const host = mount(<JoyCodeQcReportCard view={view()} onSeek={() => undefined} />);

    expect(host.querySelector('[data-qc-summary]')?.textContent).toBe(
      '2 findings (1 major, 1 minor) in 2 types',
    );
    const groups = [...host.querySelectorAll('[data-qc-group]')];
    expect(groups.map((group) => group.getAttribute('data-qc-group'))).toEqual([
      'black',
      'safe-area',
    ]);
    expect(groups[1]!.textContent).toContain('0:01.000–0:03.000');
    expect(host.querySelector('[data-qc-fact="sent"]')?.textContent).toBe('ModelSent to vision-1');
    expect(host.querySelector('[data-qc-fact="frames"]')?.textContent).toBe('Frames4 / 16');
    expect(host.querySelector('[data-qc-measured]')?.textContent).toBe('Black duration: 2.5 s');
    expect(host.querySelector('[data-qc-notes]')?.textContent).toContain('Check the title edge.');
    expect(host.innerHTML.indexOf('data-qc-notes')).toBeGreaterThan(
      host.innerHTML.indexOf('data-qc-group="safe-area"'),
    );
    expect(host.querySelector('[data-qc-fact="findings"]')?.textContent).toBe('Findings2');
    expect(host.querySelector('[data-agent-evidence-filmstrip]')).not.toBeNull();
    expect(host.querySelectorAll('.agent-evidence-filmstrip__marker')).toHaveLength(2);
  });

  it('shows the state before and after when an earlier check exists', () => {
    const host = mount(
      <JoyCodeQcReportCard view={view()} before={{ findingCount: 6 }} onSeek={() => undefined} />,
    );
    expect(host.querySelector('[data-qc-fact="before"]')?.textContent).toBe('Before6');
    expect(host.querySelector('[data-qc-fact="after"]')?.textContent).toBe('After2');
    expect(host.querySelector('[data-qc-fact="findings"]')).toBeNull();
  });

  it('shows a clean report with no groups and says it kept the frames on the device', () => {
    const host = mount(
      <JoyCodeQcReportCard
        view={view({
          findings: [],
          frames: [],
          run: { layer1: true, layer2: false, modelId: null, framesSent: 0, framesSkipped: 0 },
        })}
        onSeek={() => undefined}
      />,
    );
    expect(host.querySelector('[data-qc-summary]')?.textContent).toBe(
      'No findings in the sampled frames',
    );
    expect(host.querySelectorAll('[data-qc-group]')).toHaveLength(0);
    expect(host.querySelector('[data-qc-fact="sent"]')?.textContent).toBe(
      'ModelKept on this device',
    );
    expect(host.querySelector('[data-agent-evidence-filmstrip]')).toBeNull();
    // Saving still works for a clean report.
    expect(host.querySelector('.joy-code-qc-card__save')).not.toBeNull();
  });

  it('moves the playhead to the start of a finding when its timecode is clicked', () => {
    const onSeek = vi.fn();
    const host = mount(<JoyCodeQcReportCard view={view()} onSeek={onSeek} />);

    const button = host.querySelector<HTMLButtonElement>('[data-qc-finding="f1"]');
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(1_000_000);

    act(() => host.querySelector<HTMLButtonElement>('[data-qc-finding="f2"]')!.click());
    expect(onSeek).toHaveBeenLastCalledWith(4_500_000);
  });

  it('does not move the playhead from the filmstrip: its cursor is for review only', () => {
    const onSeek = vi.fn();
    const host = mount(<JoyCodeQcReportCard view={view()} onSeek={onSeek} />);
    act(() => host.querySelector<HTMLButtonElement>('.agent-evidence-filmstrip__marker')!.click());
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('reaches every control by keyboard: native buttons, none removed from the tab order', () => {
    const host = mount(<JoyCodeQcReportCard view={view()} onSeek={() => undefined} />);
    const controls = [...host.querySelectorAll<HTMLElement>('button, input')];
    expect(controls.length).toBeGreaterThanOrEqual(5);
    for (const control of controls) {
      expect(control.tabIndex, control.outerHTML).toBeGreaterThanOrEqual(0);
      expect((control as HTMLButtonElement).disabled).toBe(false);
    }
    const first = host.querySelector<HTMLButtonElement>('[data-qc-finding]')!;
    first.focus();
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute('aria-label')).toContain('Go to');
    const save = host.querySelector<HTMLButtonElement>('.joy-code-qc-card__save')!;
    expect(save.textContent).toContain('Save report');
  });

  it('keeps timecodes as buttons that do nothing without a seek handler', () => {
    const host = mount(<JoyCodeQcReportCard view={view()} />);
    expect(host.querySelector<HTMLButtonElement>('[data-qc-finding="f1"]')!.disabled).toBe(true);
  });

  it('saves a Markdown file and a JSON file through the one file writer', () => {
    const saveFile = vi.fn();
    const host = mount(
      <JoyCodeQcReportCard
        view={view()}
        before={{ findingCount: 6 }}
        onSeek={() => undefined}
        saveFile={saveFile}
      />,
    );
    act(() => host.querySelector<HTMLButtonElement>('.joy-code-qc-card__save')!.click());

    expect(saveFile).toHaveBeenCalledTimes(2);
    const [markdownName, markdown] = saveFile.mock.calls[0] as [string, string];
    const [jsonName, json] = saveFile.mock.calls[1] as [string, string];
    expect(markdownName).toBe('qc-report-run-1-1.md');
    expect(markdown).toContain('- Before: 6 findings, after: 2 findings');
    expect(markdown).toContain('Black duration: 2.5 s');
    expect(markdown).toContain('Check the title edge.');
    expect(jsonName).toBe('qc-report-run-1-1.json');
    expect(JSON.parse(json)).toMatchObject({
      version: 1,
      reportId: 'qc-report-run-1-1',
      before: { findingCount: 6 },
      notes: [{ timeUs: 1_500_000, text: 'Check the title edge.' }],
    });
  });
});
