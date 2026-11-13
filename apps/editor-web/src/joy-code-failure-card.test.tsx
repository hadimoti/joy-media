// @vitest-environment jsdom
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JoyCodeFailureCard } from './joy-code-failure-card.js';
import { JOY_CODE_MESSAGES, type JoyCodeMessage } from './joy-code-messages.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RETRY: JoyCodeMessage = {
  title: 'Joy Code could not finish',
  sentence: 'Joy Code could not finish this step. No edits were applied.',
  action: { label: 'Try again', kind: 'retry' },
};
const SETTINGS: JoyCodeMessage = {
  title: 'Joy Code needs a model',
  sentence: 'No AI model is connected. Connect one in Agent Settings to edit.',
  action: { label: 'Connect a model', kind: 'open-settings' },
};
const DISMISS: JoyCodeMessage = {
  title: 'Recipes are paused',
  sentence: 'Recipes are paused while Joy Code finishes its safety checks.',
  action: { label: 'Dismiss', kind: 'dismiss' },
};

describe('Joy Code failure card', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  async function render(node: ReactNode): Promise<HTMLDivElement> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(node);
    });
    return container!;
  }

  function button(rendered: HTMLDivElement): HTMLButtonElement | null {
    return rendered.querySelector<HTMLButtonElement>('button');
  }

  it('shows the title, the one sentence and the one button of its entry', async () => {
    const rendered = await render(<JoyCodeFailureCard message={RETRY} onRetry={vi.fn()} />);

    const card = rendered.querySelector('.joy-code-failure-card');
    expect(card).not.toBeNull();
    expect(card!.classList.contains('is-retry')).toBe(true);
    expect(rendered.querySelector('.joy-code-failure-card-title')!.textContent).toBe(RETRY.title);
    expect(rendered.querySelector('.joy-code-failure-card-sentence')!.textContent).toBe(
      RETRY.sentence,
    );
    expect(rendered.querySelectorAll('button')).toHaveLength(1);
    expect(button(rendered)!.textContent).toBe('Try again');
    expect(button(rendered)!.className).toContain('button-primary');
  });

  it('a retry button re-runs the request and does nothing else', async () => {
    const onRetry = vi.fn();
    const onOpenSettings = vi.fn();
    const rendered = await render(
      <JoyCodeFailureCard message={RETRY} onRetry={onRetry} onOpenSettings={onOpenSettings} />,
    );

    await act(async () => {
      button(rendered)!.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).not.toHaveBeenCalled();
    // A retry keeps the card: the request may fail again and show it again.
    expect(rendered.querySelector('.joy-code-failure-card')).not.toBeNull();
  });

  it('an open-settings button opens Agent Settings and keeps the card', async () => {
    const onRetry = vi.fn();
    const onOpenSettings = vi.fn();
    const rendered = await render(
      <JoyCodeFailureCard message={SETTINGS} onRetry={onRetry} onOpenSettings={onOpenSettings} />,
    );

    expect(
      rendered.querySelector('.joy-code-failure-card')!.classList.contains('is-open-settings'),
    ).toBe(true);
    expect(button(rendered)!.textContent).toBe('Connect a model');
    await act(async () => {
      button(rendered)!.click();
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(rendered.querySelector('.joy-code-failure-card')).not.toBeNull();
  });

  it('a dismiss button closes the card without running anything', async () => {
    const onRetry = vi.fn();
    const onOpenSettings = vi.fn();
    const rendered = await render(
      <JoyCodeFailureCard message={DISMISS} onRetry={onRetry} onOpenSettings={onOpenSettings} />,
    );

    expect(button(rendered)!.textContent).toBe('Dismiss');
    expect(button(rendered)!.className).toContain('button-secondary');
    await act(async () => {
      button(rendered)!.click();
    });
    expect(rendered.querySelector('.joy-code-failure-card')).toBeNull();
    expect(rendered.textContent).toBe('');
    expect(onRetry).not.toHaveBeenCalled();
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('shows no button when the handler for its action is missing', async () => {
    const retry = await render(<JoyCodeFailureCard message={RETRY} />);
    expect(retry.querySelector('.joy-code-failure-card')).not.toBeNull();
    expect(retry.querySelectorAll('button')).toHaveLength(0);
    act(() => root?.unmount());
    container?.remove();

    const settings = await render(<JoyCodeFailureCard message={SETTINGS} onRetry={vi.fn()} />);
    expect(settings.querySelectorAll('button')).toHaveLength(0);
    expect(settings.textContent).toContain(SETTINGS.sentence);
  });

  it('renders every table entry with its own kind and label', async () => {
    for (const [key, message] of Object.entries(JOY_CODE_MESSAGES)) {
      const rendered = await render(
        <JoyCodeFailureCard message={message} onRetry={vi.fn()} onOpenSettings={vi.fn()} />,
      );
      expect(rendered.querySelector('.joy-code-failure-card-title'), key).not.toBeNull();
      expect(button(rendered)!.textContent, key).toBe(message.action.label);
      act(() => root?.unmount());
      container?.remove();
      root = undefined;
      container = undefined;
    }
  });
});
