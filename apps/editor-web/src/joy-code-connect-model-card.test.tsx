// @vitest-environment jsdom
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JOY_CODE_CONNECT_MODEL_ACTION,
  JOY_CODE_CONNECT_MODEL_MESSAGE,
  JoyCodeConnectModelCard,
  JoyCodeReadinessSlot,
} from './joy-code-connect-model-card.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('Joy Code connect card', () => {
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

  it('shows one calm sentence and one gold action when no model is connected', async () => {
    const onConnect = vi.fn();
    const rendered = await render(
      <JoyCodeReadinessSlot
        showConnectCard={true}
        readinessText="Connect a model with JOY edit tools in Agent Settings to run natural-language JOY edits."
        ariaLabel="Edit readiness"
        onOpenSettings={onConnect}
      />,
    );

    const card = rendered.querySelector('.joy-code-connect-card');
    expect(card).not.toBeNull();
    expect(card!.getAttribute('aria-label')).toBe('Edit readiness');
    expect(rendered.textContent).toContain(JOY_CODE_CONNECT_MODEL_MESSAGE);
    // The technical notice is gone: the card is the whole message.
    expect(rendered.textContent).not.toContain('JOY edit tools');

    const buttons = rendered.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe(JOY_CODE_CONNECT_MODEL_ACTION);
    expect(buttons[0]!.className).toContain('button-primary');

    await act(async () => {
      (buttons[0] as HTMLButtonElement).click();
    });
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('keeps the specific notice when a model is connected but not usable', async () => {
    const onOpenSettings = vi.fn();
    const rendered = await render(
      <JoyCodeReadinessSlot
        showConnectCard={false}
        readinessText="The model capability is untested. Test a model in Agent Settings."
        ariaLabel="Recipes readiness"
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(rendered.querySelector('.joy-code-connect-card')).toBeNull();
    expect(rendered.textContent).toContain('The model capability is untested.');
    expect(rendered.textContent).not.toContain(JOY_CODE_CONNECT_MODEL_MESSAGE);

    const button = rendered.querySelector<HTMLButtonElement>('.joy-code-configure-agent-btn');
    expect(button?.textContent).toBe('Open JOY Agent Settings');
    await act(async () => {
      button!.click();
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('drops the action when there is no Settings to open', async () => {
    const rendered = await render(<JoyCodeConnectModelCard ariaLabel="Looks readiness" />);

    expect(rendered.textContent).toBe(JOY_CODE_CONNECT_MODEL_MESSAGE);
    expect(rendered.querySelectorAll('button')).toHaveLength(0);
  });
});
