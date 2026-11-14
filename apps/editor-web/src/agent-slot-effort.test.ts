import { describe, expect, it } from 'vitest';
import { effortFromSettings, settingsForEffort } from './agent-slot-effort.js';

describe('agent slot effort level', () => {
  it('reads no numbers as auto and a preset pair as its level', () => {
    expect(effortFromSettings({})).toBe('auto');
    expect(effortFromSettings({ temperature: 0.7, maxOutputTokens: 4096 })).toBe('medium');
    expect(effortFromSettings({ temperature: 0.3, maxOutputTokens: 1024 })).toBe('low');
    expect(effortFromSettings({ temperature: 1, maxOutputTokens: 8192 })).toBe('high');
  });

  it('shows other numbers as custom and keeps them', () => {
    const odd = { temperature: 0.4 };
    expect(effortFromSettings(odd)).toBe('custom');
    expect(settingsForEffort('custom', odd)).toEqual(odd);
  });

  it('stores the pair of a level, and nothing for auto', () => {
    expect(settingsForEffort('high', { temperature: 0.4 })).toEqual({
      temperature: 1,
      maxOutputTokens: 8192,
    });
    expect(settingsForEffort('auto', { temperature: 0.4 })).toEqual({});
  });
});
