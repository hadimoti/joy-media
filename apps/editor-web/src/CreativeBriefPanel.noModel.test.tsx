// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreativeBriefPanel } from './CreativeBriefPanel.js';
import { JoyAgentTaskError } from './joy-agent/entry-points.js';
import { CONNECT_MODEL_FIRST_TITLE } from './joy-code-run-gate.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

/** Mounts once; later calls re-render the same root, as a connect or disconnect does. */
function renderInto(element: ReactElement) {
  if (container === undefined || root === undefined) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root?.render(element));
}

function render(props: { noModelConnected: boolean; onConnectModel?: () => void }) {
  renderInto(
    <CreativeBriefPanel
      revisionId="rev-1"
      optedIn
      runBrief={vi.fn(() => new Promise<never>(() => undefined))}
      embedded
      {...props}
    />,
  );
}

function connectControl(): HTMLElement | null {
  return (
    container?.querySelector<HTMLElement>(
      `[role="button"][aria-label="${CONNECT_MODEL_FIRST_TITLE}"]`,
    ) ?? null
  );
}

function improveButton(): HTMLButtonElement {
  const button = container?.querySelector<HTMLButtonElement>(
    'button[aria-label="Improve project"]',
  );
  if (button === null || button === undefined) throw new Error('No Improve project button');
  return button;
}

describe('Creative Brief without a connected model', () => {
  it('disables Improve project with the connect hover text', () => {
    render({ noModelConnected: true, onConnectModel: () => undefined });
    expect(improveButton().disabled).toBe(true);
    expect(improveButton().title).toBe(CONNECT_MODEL_FIRST_TITLE);
  });

  it('offers the connect step as a keyboard-reachable control', () => {
    const onConnectModel = vi.fn();
    render({ noModelConnected: true, onConnectModel });
    const connect = container?.querySelector<HTMLElement>(
      `[role="button"][aria-label="${CONNECT_MODEL_FIRST_TITLE}"]`,
    );
    expect(connect?.tabIndex).toBe(0);
    connect?.focus();
    expect(document.activeElement).toBe(connect);
    act(() => {
      connect?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    expect(onConnectModel).toHaveBeenCalledTimes(1);
  });

  it('opens the connect step on a click on the card text, once', () => {
    const onConnectModel = vi.fn();
    render({ noModelConnected: true, onConnectModel });
    act(() => container?.querySelector<HTMLElement>('.creative-brief-panel-input')?.click());
    expect(onConnectModel).toHaveBeenCalledTimes(1);
    act(() => connectControl()?.click());
    expect(onConnectModel).toHaveBeenCalledTimes(2);
  });

  it('keeps the request box read-only until a model is connected', () => {
    render({ noModelConnected: true, onConnectModel: () => undefined });
    const textarea = container?.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea?.disabled).toBe(true);
  });
});

describe('Creative Brief with a connected model', () => {
  it('stops a collecting brief and keeps its draft ready to resubmit', async () => {
    let cancel: (() => void) | undefined;
    const runBrief = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          cancel = () => reject(new JoyAgentTaskError('cancelled', 'Creative Brief cancelled'));
        }),
    );
    const onStop = vi.fn(() => cancel?.());
    renderInto(
      <CreativeBriefPanel revisionId="rev-1" optedIn runBrief={runBrief} onStop={onStop} />,
    );
    const draft = container?.querySelector<HTMLTextAreaElement>('textarea');
    if (draft == null) throw new Error('No Creative Brief draft');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        draft,
        'Refine the typography',
      );
      draft.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => improveButton().click());
    const stop = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop Creative Brief"]',
    );
    expect(stop?.disabled).toBe(false);
    await act(async () => stop?.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(draft.value).toBe('Refine the typography');
    expect(improveButton().disabled).toBe(false);
    expect(container?.querySelector('[aria-label="Error occurred"]')).toBeNull();
  });

  it('enables Improve project and shows no connect hover text', () => {
    render({ noModelConnected: false });
    expect(improveButton().disabled).toBe(false);
    expect(improveButton().title).toBe('');
  });

  it('shows no connect step and keeps Improve project enabled', () => {
    render({ noModelConnected: false, onConnectModel: () => undefined });
    expect(container?.querySelector(`[aria-label="${CONNECT_MODEL_FIRST_TITLE}"]`)).toBeNull();
    expect(improveButton().disabled).toBe(false);
  });
});

describe('Creative Brief through a connect and a disconnect, without a reload', () => {
  it('enables Improve project after connecting and disables it after disconnecting', () => {
    const props = { revisionId: 'rev-1' as const, optedIn: true, embedded: true };
    const runBrief = vi.fn(() => new Promise<never>(() => undefined));
    const onConnectModel = vi.fn();
    renderInto(<CreativeBriefPanel {...props} noModelConnected onConnectModel={onConnectModel} />);
    expect(improveButton().disabled).toBe(true);
    expect(connectControl()).not.toBeNull();

    renderInto(<CreativeBriefPanel {...props} runBrief={runBrief} noModelConnected={false} />);
    expect(improveButton().disabled).toBe(false);
    expect(improveButton().title).toBe('');
    expect(connectControl()).toBeNull();

    renderInto(
      <CreativeBriefPanel
        {...props}
        runBrief={runBrief}
        noModelConnected
        onConnectModel={onConnectModel}
      />,
    );
    expect(improveButton().disabled).toBe(true);
    expect(improveButton().title).toBe(CONNECT_MODEL_FIRST_TITLE);
    expect(connectControl()).not.toBeNull();
  });
});
