// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listDesktopAgentSlots, saveDesktopAgentSlot } from './desktop-client.js';

afterEach(() => {
  delete window.joyDesktop;
});

describe('agent slots through the desktop bridge', () => {
  it('lists the slots, and treats a bridge that returns nothing as no slots', async () => {
    const slots = [{ id: 'workhorse', label: 'Workhorse', ready: false }];
    window.joyDesktop = {
      channels: ['desktop.agent-slots.list'],
      invoke: vi.fn().mockResolvedValue(slots),
    };
    await expect(listDesktopAgentSlots()).resolves.toEqual(slots);
    expect(window.joyDesktop.invoke).toHaveBeenCalledWith('desktop.agent-slots.list');

    window.joyDesktop = { channels: [], invoke: vi.fn().mockResolvedValue(undefined) };
    await expect(listDesktopAgentSlots()).resolves.toEqual([]);
  });

  it('saves one slot with its draft, and returns the slot the desktop saved', async () => {
    const saved = { id: 'creative', label: 'Creative Brain', ready: true };
    const invoke = vi.fn().mockResolvedValue(saved);
    window.joyDesktop = { channels: ['desktop.agent-slots.save'], invoke };
    await expect(
      saveDesktopAgentSlot('creative', { profileId: 'profile-1', model: 'm' }),
    ).resolves.toEqual(saved);
    expect(invoke).toHaveBeenCalledWith('desktop.agent-slots.save', {
      id: 'creative',
      draft: { profileId: 'profile-1', model: 'm' },
    });
  });
});
