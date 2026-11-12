// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSlotsSection, type AgentSlotsSectionProps } from './AgentSlotsSection.js';
import { AppDialogHost } from './AppDialogs.js';
import { getAppDialogQueue, settleAppDialog } from './app-dialogs.js';
import type { DesktopAgentSlot, DesktopProviderProfile } from './desktop-client.js';

/** Clicks the button with this text in the open confirm dialog. */
async function answerDialog(panel: Element, text: string): Promise<void> {
  const button = Array.from(
    panel.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
  ).find((candidate) => candidate.textContent === text);
  if (button === undefined) throw new Error(`Expected dialog button "${text}"`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const profile: DesktopProviderProfile = {
  id: 'profile-1',
  name: 'Local LM',
  provider: 'custom',
  baseUrl: 'http://127.0.0.1:1234/v1',
  modelId: 'llama3',
  createdAt: '2026-10-29T00:00:00.000Z',
  updatedAt: '2026-10-29T00:00:00.000Z',
};

const chatGptProfile: DesktopProviderProfile = {
  id: 'chatgpt-profile-1',
  provider: 'chatgpt',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  modelId: 'gpt-6-luna',
  cachedModels: ['gpt-6.1-sol', 'gpt-6-luna'],
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
};

function buttonNamed(panel: Element, text: string): HTMLButtonElement | undefined {
  return Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent === text,
  );
}

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
    for (const entry of getAppDialogQueue()) settleAppDialog(entry.id, null);
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
      root?.render(
        createElement(
          Fragment,
          null,
          createElement(AgentSlotsSection, props),
          createElement(AppDialogHost),
        ),
      );
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

  it('shows two empty slots on first setup and binds Workhorse to a local profile without a key', async () => {
    const emptySlots = [slot({}), slot({ id: 'creative', label: 'Creative Brain' })];
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === 'desktop.agent-slots.list') return emptySlots;
      if (channel === 'desktop.agent-slots.save') {
        const saved = payload as { id: string; draft: { profileId?: string; model?: string } };
        return slot({
          id: saved.id as 'workhorse',
          label: 'Workhorse',
          profileId: saved.draft.profileId ?? null,
          profileName: 'Local LM',
          profileProvider: 'custom',
          model: saved.draft.model ?? null,
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
    expect(panel.querySelector('[aria-label="Workhorse profile"]')).toHaveProperty('value', '');
    expect(panel.querySelector('[aria-label="Creative Brain profile"]')).toHaveProperty(
      'value',
      '',
    );
    expect(
      Array.from(
        (panel.querySelector('[aria-label="Workhorse profile"]') as HTMLSelectElement).options,
      ).map((option) => option.value),
    ).toEqual(['', 'profile-1']);

    await act(async () => {
      typeInto(panel.querySelector('[aria-label="Workhorse profile"]'), 'profile-1');
      typeInto(panel.querySelector('[aria-label="Workhorse model"]'), 'llama3');
    });
    const save = Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Save Workhorse',
    );
    await act(async () => {
      save?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const saveCall = invoke.mock.calls.find(([channel]) => channel === 'desktop.agent-slots.save');
    expect(saveCall?.[1]).toMatchObject({
      id: 'workhorse',
      draft: { profileId: 'profile-1', model: 'llama3' },
    });
    expect(JSON.stringify(invoke.mock.calls).toLowerCase()).not.toContain('openrouter');
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('sk-or-');
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

  it('names a ChatGPT connection by its name, never by its id, and offers log out and log in again', async () => {
    window.joyDesktop = {
      channels: ['desktop.agent-slots.list'],
      invoke: vi.fn(async () => [slot({}), slot({ id: 'creative', label: 'Creative Brain' })]),
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const panel = await render({ profiles: [chatGptProfile], onUseSlot: vi.fn() });

    expect(panel.textContent).toContain('ChatGPT is connected.');
    expect(panel.textContent).not.toContain('chatgpt-profile-1');
    const options = Array.from(
      (panel.querySelector('[aria-label="Workhorse profile"]') as HTMLSelectElement).options,
    );
    expect(options.find((option) => option.value === 'chatgpt-profile-1')?.textContent).toBe(
      'ChatGPT',
    );
    expect(buttonNamed(panel, 'Log in again')).toBeDefined();
    expect(buttonNamed(panel, 'Log out')).toBeDefined();
    expect(buttonNamed(panel, 'Connect ChatGPT')).toBeUndefined();
  });

  it('connects ChatGPT from the slots when no connection is saved', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'desktop.agent-slots.list') return [slot({})];
      if (channel === 'desktop.provider-profile.sign-in') return chatGptProfile;
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.agent-slots.list', 'desktop.provider-profile.sign-in'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const onProfilesChanged = vi.fn();
    const panel = await render({ profiles: [profile], onUseSlot: vi.fn(), onProfilesChanged });

    expect(panel.textContent).toContain('ChatGPT is not connected.');
    await act(async () => {
      buttonNamed(panel, 'Connect ChatGPT')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.sign-in', {
      provider: 'chatgpt',
    });
    expect(onProfilesChanged).toHaveBeenCalled();
    expect(panel.textContent).toContain('ChatGPT is connected.');
  });

  it('logs out of ChatGPT only after the owner confirms, then reads the profiles again', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'desktop.agent-slots.list') return [slot({})];
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.agent-slots.list', 'desktop.provider-profile.sign-out'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const onProfilesChanged = vi.fn();
    const panel = await render({
      profiles: [chatGptProfile],
      onUseSlot: vi.fn(),
      onProfilesChanged,
    });

    await act(async () => {
      buttonNamed(panel, 'Log out')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(invoke).not.toHaveBeenCalledWith('desktop.provider-profile.sign-out', expect.anything());
    expect(panel.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Log out of ChatGPT?',
    );
    await answerDialog(panel, 'Log out');

    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.sign-out', {
      id: 'chatgpt-profile-1',
    });
    expect(onProfilesChanged).toHaveBeenCalled();
    expect(panel.textContent).toContain('Logged out of ChatGPT.');
  });

  it('does not log out when the owner declines the confirmation', async () => {
    const invoke = vi.fn(async (channel: string) =>
      channel === 'desktop.agent-slots.list' ? [slot({})] : undefined,
    );
    window.joyDesktop = {
      channels: ['desktop.agent-slots.list', 'desktop.provider-profile.sign-out'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const panel = await render({ profiles: [chatGptProfile], onUseSlot: vi.fn() });

    await act(async () => {
      buttonNamed(panel, 'Log out')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await answerDialog(panel, 'Cancel');

    expect(panel.querySelector('[role="alertdialog"]')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('desktop.provider-profile.sign-out', expect.anything());
  });

  it('offers the models the profile lists, and saves the one picked', async () => {
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === 'desktop.agent-slots.list') {
        return [slot({ profileId: 'chatgpt-profile-1', model: 'gpt-6.1-sol', ready: true })];
      }
      if (channel === 'desktop.agent-slots.save') {
        const saved = payload as { draft: { model?: string; profileId?: string } };
        return slot({
          profileId: saved.draft.profileId ?? null,
          model: saved.draft.model ?? null,
          ready: true,
        });
      }
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.agent-slots.list', 'desktop.agent-slots.save'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const panel = await render({ profiles: [chatGptProfile], onUseSlot: vi.fn() });

    const picker = panel.querySelector('[aria-label="Workhorse model"]') as HTMLSelectElement;
    expect(picker.tagName).toBe('SELECT');
    expect(Array.from(picker.options).map((option) => option.value)).toEqual([
      '',
      'gpt-6.1-sol',
      'gpt-6-luna',
    ]);

    await act(async () => {
      typeInto(picker, 'gpt-6-luna');
    });
    await act(async () => {
      buttonNamed(panel, 'Save Workhorse')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const saveCall = invoke.mock.calls.find(([channel]) => channel === 'desktop.agent-slots.save');
    expect(saveCall?.[1]).toMatchObject({
      id: 'workhorse',
      draft: { profileId: 'chatgpt-profile-1', model: 'gpt-6-luna' },
    });
  });

  it('reads the models a profile offers when the owner asks, and keeps typing available', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'desktop.agent-slots.list') {
        return [slot({ profileId: 'chatgpt-profile-1', ready: false })];
      }
      if (channel === 'desktop.provider.models') return [{ id: 'gpt-6-luna', name: 'gpt-6-luna' }];
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.agent-slots.list', 'desktop.provider.models'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const withoutList: DesktopProviderProfile = { ...chatGptProfile, cachedModels: undefined };
    const onProfilesChanged = vi.fn();
    const panel = await render({ profiles: [withoutList], onUseSlot: vi.fn(), onProfilesChanged });

    expect(panel.querySelector('[aria-label="Workhorse model"]')?.tagName).toBe('INPUT');
    await act(async () => {
      buttonNamed(panel, 'Refresh models')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(invoke).toHaveBeenCalledWith('desktop.provider.models', { id: 'chatgpt-profile-1' });
    // The desktop keeps the list on the profile, so the profiles are read again.
    expect(onProfilesChanged).toHaveBeenCalled();
    expect(panel.querySelector('[aria-label="Workhorse model"]')?.tagName).toBe('SELECT');
    expect(buttonNamed(panel, 'Type a model ID')).toBeDefined();
  });
});
