import { describe, expect, it } from 'vitest';
import {
  AGENT_SLOT_IDS,
  AGENT_SLOT_LIMITS,
  agentSlotDraft,
  emptyAgentSlot,
  isAgentSlotConfigured,
  parseAgentSlotId,
  validateAgentSlot,
} from './agent-slots.js';

describe('agent slots', () => {
  it('has two independent slots with the default labels and nothing bound', () => {
    expect(AGENT_SLOT_IDS).toEqual(['workhorse', 'creative']);
    expect(emptyAgentSlot('workhorse')).toMatchObject({
      id: 'workhorse',
      label: 'Workhorse',
      profileId: undefined,
      model: undefined,
      instructions: '',
    });
    expect(emptyAgentSlot('creative')).toMatchObject({ label: 'Creative Brain' });
    expect(isAgentSlotConfigured(emptyAgentSlot('creative'))).toBe(false);
  });

  it('accepts a complete slot, trims its text and keeps its settings', () => {
    const result = validateAgentSlot('creative', {
      profileId: '  profile-1 ',
      model: ' model-x ',
      instructions: '  Write short sentences.  ',
      settings: { temperature: 0.4, maxOutputTokens: 2000 },
    });
    expect(result).toMatchObject({
      ok: true,
      slot: {
        id: 'creative',
        profileId: 'profile-1',
        model: 'model-x',
        instructions: 'Write short sentences.',
        settings: { temperature: 0.4, maxOutputTokens: 2000 },
      },
    });
    if (!result.ok) throw new Error('expected a valid slot');
    expect(isAgentSlotConfigured(result.slot)).toBe(true);
  });

  it('treats blank text as not set', () => {
    const result = validateAgentSlot('workhorse', {
      profileId: '   ',
      model: '',
      instructions: ' ',
    });
    expect(result).toMatchObject({
      ok: true,
      slot: { profileId: undefined, model: undefined, instructions: '' },
    });
  });

  it('refuses an unknown slot and a field the slot does not have', () => {
    expect(validateAgentSlot('kilo', {})).toEqual({ ok: false, issue: 'UNKNOWN_SLOT' });
    expect(validateAgentSlot('workhorse', { provider: 'openrouter' })).toEqual({
      ok: false,
      issue: 'UNKNOWN_FIELD',
      field: 'provider',
    });
    expect(validateAgentSlot('workhorse', { settings: { topP: 0.9 } })).toEqual({
      ok: false,
      issue: 'INVALID_VALUE',
      field: 'settings',
    });
  });

  it('refuses a value out of its bounds rather than cutting it down', () => {
    const tooLong = 'x'.repeat(AGENT_SLOT_LIMITS.instructionsLength + 1);
    expect(validateAgentSlot('workhorse', { instructions: tooLong })).toMatchObject({
      ok: false,
      field: 'instructions',
    });
    expect(
      validateAgentSlot('workhorse', { model: 'm'.repeat(AGENT_SLOT_LIMITS.modelIdLength + 1) }),
    ).toMatchObject({ ok: false, field: 'model' });
    expect(validateAgentSlot('workhorse', { profileId: 42 })).toMatchObject({
      ok: false,
      field: 'profileId',
    });
    expect(validateAgentSlot('workhorse', { settings: { temperature: 2.5 } })).toMatchObject({
      ok: false,
      field: 'settings',
    });
    expect(validateAgentSlot('workhorse', { settings: { temperature: Number.NaN } })).toMatchObject(
      {
        ok: false,
      },
    );
    expect(validateAgentSlot('workhorse', { settings: { maxOutputTokens: 10.5 } })).toMatchObject({
      ok: false,
    });
    expect(validateAgentSlot('workhorse', { settings: { maxOutputTokens: 0 } })).toMatchObject({
      ok: false,
    });
  });

  it('refuses a draft that is not an object', () => {
    expect(validateAgentSlot('workhorse', 'openrouter')).toEqual({
      ok: false,
      issue: 'INVALID_VALUE',
    });
    expect(validateAgentSlot('workhorse', ['profile-1'])).toEqual({
      ok: false,
      issue: 'INVALID_VALUE',
    });
  });

  it('parses only the two slot ids', () => {
    expect(parseAgentSlotId('workhorse')).toBe('workhorse');
    expect(parseAgentSlotId('openrouter')).toBeUndefined();
    expect(parseAgentSlotId(undefined)).toBeUndefined();
  });
});

describe('agent slot drafts', () => {
  it('round-trips a slot through its draft, and saves an empty slot as an empty draft', () => {
    const result = validateAgentSlot('workhorse', {
      profileId: 'profile-1',
      model: 'model-1',
      instructions: 'Be exact.',
      settings: { maxOutputTokens: 900 },
    });
    if (!result.ok) throw new Error('expected a valid slot');
    expect(validateAgentSlot('workhorse', agentSlotDraft(result.slot))).toEqual(result);
    expect(agentSlotDraft(emptyAgentSlot('creative'))).toEqual({});
  });
});
