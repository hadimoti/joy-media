// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreativeBriefPanel } from './CreativeBriefPanel.js';
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

function render(props: { noModelConnected: boolean; onConnectModel?: () => void }) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <CreativeBriefPanel
        revisionId="rev-1"
        optedIn
        runBrief={vi.fn(() => new Promise<never>(() => undefined))}
        embedded
        {...props}
      />,
    ),
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

  it('opens the connect step when the card is clicked', () => {
    const onConnectModel = vi.fn();
    render({ noModelConnected: true, onConnectModel });
    const card = container?.querySelector<HTMLElement>('[aria-label="Brief request input"]');
    act(() => card?.click());
    expect(onConnectModel).toHaveBeenCalledTimes(1);
  });

  it('keeps the request box read-only until a model is connected', () => {
    render({ noModelConnected: true, onConnectModel: () => undefined });
    const textarea = container?.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea?.disabled).toBe(true);
  });
});

describe('Creative Brief with a connected model', () => {
  it('enables Improve project and shows no connect hover text', () => {
    render({ noModelConnected: false });
    expect(improveButton().disabled).toBe(false);
    expect(improveButton().title).toBe('');
  });

  it('does not open the connect step on a click on the card', () => {
    const onConnectModel = vi.fn();
    render({ noModelConnected: false, onConnectModel });
    const card = container?.querySelector<HTMLElement>('[aria-label="Brief request input"]');
    act(() => card?.click());
    expect(onConnectModel).not.toHaveBeenCalled();
  });
});
