// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSlotsSection, type AgentSlotsSectionProps } from './AgentSlotsSection.js';
import type { DesktopAgentSlot, DesktopProviderProfile } from './desktop-client.js';

const profile: DesktopProviderProfile = {
  id: 'profile-1',
  name: 'Local LM',
  provider: 'custom',
  baseUrl: 'http://127.0.0.1:1234/v1',
  modelId: 'llama3',
  createdAt: '2026-10-29T00:00:00.000Z',
  updatedAt: '2026-10-29T00:00:00.000Z',
};

function slot(overrides: Partial<DesktopAgentSlot>): DesktopAgentSlot {
  return {
    id: 'workhorse',
    label: 'Workhorse',
    profileId: null,
    profileName: null,
    profileProvider: null,
    model: null,
    instructions: '',
    settings: {},
    ready: false,
    ...overrides,
  };
}

/** Sets a field the way a person does, so React's change handler runs. */
function typeInto(element: Element | null, value: string): void {
  const field = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const prototype = Object.getPrototypeOf(field) as object;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('AgentSlotsSection', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    delete window.joyDesktop;
    vi.restoreAllMocks();
  });

  async function render(props: AgentSlotsSectionProps): Promise<HTMLDivElement> {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(AgentSlotsSection, props));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return container;
  }

  it('says the slots are set up in the desktop app, outside it', async () => {
    const panel = await render({ profiles: [profile], onUseSlot: vi.fn() });
    expect(panel.textContent).toContain('Agent slots are set up in the desktop app.');
    expect(panel.querySelector('.agent-slot-card')).toBeNull();
  });

  it('lists both slots, and saves what the owner typed for one of them', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'desktop.agent-slots.list') {
        return [slot({}), slot({ id: 'creative', label: 'Creative Brain' })];
      }
      if (channel === 'desktop.agent-slots.save') {
        return slot({
          profileId: 'profile-1',
          profileName: 'Local LM',
          profileProvider: 'custom',
          model: 'llama3',
          instructions: 'Be brief.',
          settings: { temperature: 0.4 },
          ready: true,
        });
      }
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.agent-slots.list', 'desktop.agent-slots.save'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const panel = await render({ profiles: [profile], onUseSlot: vi.fn() });
    expect(panel.querySelectorAll('.agent-slot-card')).toHaveLength(2);

    await act(async () => {
      typeInto(panel.querySelector('[aria-label="Workhorse profile"]'), 'profile-1');
      typeInto(panel.querySelector('[aria-label="Workhorse model"]'), 'llama3');
      typeInto(panel.querySelector('[aria-label="Workhorse instructions"]'), 'Be brief.');
      typeInto(panel.querySelector('[aria-label="Workhorse temperature"]'), '0.4');
    });
    const save = Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Save Workhorse',
    );
    await act(async () => {
      save?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(invoke).toHaveBeenCalledWith('desktop.agent-slots.save', {
      id: 'workhorse',
      draft: {
        profileId: 'profile-1',
        model: 'llama3',
        instructions: 'Be brief.',
        settings: { temperature: 0.4, maxOutputTokens: undefined },
      },
    });
    expect(panel.textContent).toContain('Workhorse saved.');
  });

  it('runs the agent in a slot only once the slot is ready, and then with its profile', async () => {
    const onUseSlot = vi.fn(async () => undefined);
    window.joyDesktop = {
      channels: ['desktop.agent-slots.list'],
      invoke: vi.fn(async () => [
        slot({ profileId: 'profile-1', model: 'llama3', ready: true }),
        slot({ id: 'creative', label: 'Creative Brain' }),
      ]),
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const panel = await render({ profiles: [profile], onUseSlot });

    const useButtons = Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).filter(
      (button) => button.textContent === 'Use for agent',
    );
    expect(useButtons.map((button) => button.disabled)).toEqual([false, true]);
    await act(async () => {
      useButtons[0]?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onUseSlot).toHaveBeenCalledWith(expect.objectContaining({ id: 'workhorse' }), profile);
  });
});
