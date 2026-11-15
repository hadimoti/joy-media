// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEditorContext } from '@joy-media/agent-tools';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { AgentPanel } from './AgentPanel.js';
import { DEFAULT_AGENT_POLICY } from './agent-policy-settings.js';
import { EditorSession } from './editor-session.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import type * as QcHostAdapterModule from './joy-agent/qc-host-adapter.js';
import type { EditorQcAdapterInput } from './joy-agent/qc-host-adapter.js';
import type { ByokSessionStatus } from './joy-agent/protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollIntoView = vi.fn();

/** Every QC adapter the panel builds, so a test can play the part of its report. */
const built: EditorQcAdapterInput[] = [];

vi.mock('./joy-agent/qc-host-adapter.js', async (importOriginal) => {
  const original = await importOriginal<typeof QcHostAdapterModule>();
  return {
    ...original,
    createEditorQcAdapter: (input: EditorQcAdapterInput) => {
      built.push(input);
      return original.createEditorQcAdapter(input);
    },
  };
});

/**
 * T-B07: a quality-check run shows its report as one card in the conversation, and a timecode on the card
 * moves the editor playhead. An ordinary edit never shows a card. The panel is driven through its real
 * composer; only the model client is faked, and the report arrives through the adapter's own callback.
 */

const CONNECTED: ByokSessionStatus = {
  provider: 'openai-compatible',
  modelId: 'gpt-test',
  capability: 'tool-loop',
};

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  built.length = 0;
});

function idleClient(): JoyAgentEngineClient {
  const startRun = vi.fn(() => {
    const iterator = (async function* () {
      // The run ends at once; the report is delivered by the test.
    })();
    return Object.assign(iterator, { run: { runId: 'run-qc-1', epoch: 1 } });
  });
  return {
    getStatus: () => CONNECTED,
    getMediaCapabilities: () => undefined,
    cancel: vi.fn(async () => undefined),
    startRun,
  } as unknown as JoyAgentEngineClient;
}

async function sendPrompt(prompt: string, onSeek: (timeUs: number) => void): Promise<HTMLElement> {
  const project = buildReferenceSpikeProject();
  const session = new EditorSession(memoryStorage(), project, INITIAL_EDITOR_PROJECT);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <AgentPanel
        project={project}
        selectedClipIds={[]}
        playheadUs={0}
        agentContext={buildEditorContext(project)}
        onUndo={() => undefined}
        session={session}
        settings={DEFAULT_AGENT_POLICY}
        storage={memoryStorage() as never}
        joyAgentEngineClient={idleClient()}
        creativeBriefOptedIn
        creativeBriefRunner={() => new Promise(() => undefined)}
        onSeek={onSeek}
      />,
    ),
  );
  const textarea = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message Joy Code"]',
  )!;
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  act(() => {
    setValue!.call(textarea, prompt);
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    container!
      .querySelector<HTMLButtonElement>('button.joy-code-send[aria-label="Send message"]')!
      .click();
  });
  return container;
}

function report(
  findingCount: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    reportId: 'qc-report-run-1-1',
    createdAt: '2026-11-15T10:00:00.000Z',
    target: { kind: 'timeline', range: { domain: 'composition', startUs: 0, endUs: 6_000_000 } },
    run: { layer1: true, layer2: false, modelId: null, framesSent: 0, framesSkipped: 0 },
    coverage: { completeSourceCoverage: false, sampledRanges: [], unsampledRanges: [] },
    findings: Array.from({ length: findingCount }, (_, index) => ({
      id: `f${index + 1}`,
      type: 'safe-area',
      state: 'measured',
      severity: 'minor',
      startUs: (index + 1) * 1_000_000,
      endUs: (index + 1) * 1_000_000 + 500_000,
      label: 'A title sits outside the 90 percent safe area.',
      fixable: true,
    })),
    notes: [],
    frames: [{ frameId: 'timeline-frame-0', timeUs: 0 }],
    modelComprehensionGuaranteed: false,
    ...extra,
  };
}

describe('AgentPanel: QC report card', () => {
  it('shows the report as a card and moves the playhead from a finding', async () => {
    const onSeek = vi.fn();
    const host = await sendPrompt('Run a quality check on my film', onSeek);
    // Two adapters per QC run: the tools' own (guarded by the run's revision) and the repair loop's (it follows
    // the live revision after its own approved commits). Only the repair loop may have a live revision.
    expect(built).toHaveLength(2);
    expect(built[0]!.getRevision).toBeUndefined();
    expect(built[1]!.getRevision).toBeTypeOf('function');
    expect(host.querySelector('[aria-label="QC report"]')).toBeNull();

    act(() => built[0]!.onReport?.(report(2)));

    const cards = host.querySelectorAll('[aria-label="QC report"]');
    expect(cards).toHaveLength(1);
    expect(host.querySelector('[data-qc-summary]')?.textContent).toBe(
      '2 findings (2 minor) in 1 type',
    );
    // The card replaces the summary line: it is not shown twice.
    expect(host.textContent?.match(/2 findings \(2 minor\) in 1 type/g)).toHaveLength(1);

    act(() => host.querySelector<HTMLButtonElement>('[data-qc-finding="f2"]')!.click());
    expect(onSeek).toHaveBeenCalledWith(2_000_000);
  });

  it('updates the same card when frames were sent and keeps unrelated runs separate', async () => {
    const host = await sendPrompt('Run a quality check on my film', () => undefined);

    act(() => built[0]!.onReport?.(report(3)));
    act(() =>
      built[0]!.onReport?.(
        report(3, { run: { layer1: true, layer2: true, modelId: 'gpt-test', framesSent: 4 } }),
      ),
    );
    expect(host.querySelectorAll('[aria-label="QC report"]')).toHaveLength(1);
    expect(host.querySelector('[data-qc-fact="sent"]')?.textContent).toBe('ModelSent to gpt-test');
    expect(host.querySelector('[data-qc-fact="frames"]')?.textContent).toBe('Frames4');

    // A report from a different run is not a before/after pair.
    act(() => built[0]!.onReport?.(report(1, { reportId: 'qc-report-run-2-1' })));
    const cards = host.querySelectorAll('[aria-label="QC report"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.querySelector('[data-qc-fact="before"]')).toBeNull();
    expect(cards[1]!.querySelector('[data-qc-fact="before"]')).toBeNull();
    expect(cards[1]!.querySelector('[data-qc-fact="after"]')).toBeNull();
    expect(cards[1]!.querySelector('[data-qc-fact="findings"]')?.textContent).toBe('Findings1');
  });

  it('shows before and after for a later report in the same run', async () => {
    const host = await sendPrompt('Run a quality check on my film', () => undefined);
    act(() => built[0]!.onReport?.(report(3)));
    act(() => built[0]!.onReport?.(report(1, { reportId: 'qc-report-run-1-2' })));
    const cards = host.querySelectorAll('[aria-label="QC report"]');
    expect(cards).toHaveLength(2);
    expect(cards[1]!.querySelector('[data-qc-fact="before"]')?.textContent).toBe('Before3');
    expect(cards[1]!.querySelector('[data-qc-fact="after"]')?.textContent).toBe('After1');
  });

  it('ignores a value that is not a report', async () => {
    const host = await sendPrompt('Run a quality check on my film', () => undefined);
    act(() => built[0]!.onReport?.({ version: 1 }));
    expect(host.querySelector('[aria-label="QC report"]')).toBeNull();
  });

  it('shows no card for an ordinary edit', async () => {
    const host = await sendPrompt('Trim the first clip by two seconds', () => undefined);
    expect(built).toHaveLength(0);
    expect(host.querySelector('[aria-label="QC report"]')).toBeNull();
  });
});
