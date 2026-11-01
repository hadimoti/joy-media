import { describe, expect, it } from 'vitest';
import { agentSlotDraft, validateAgentSlot, type AgentSlot } from '@joy-media/provider-sdk';
import { writeAgentSlot, type AgentSlotStore } from '../store/agent-slots.js';
import { applySlotToBody, resolveSlotRequest } from './agent-slot-request.js';

function memoryStore(): AgentSlotStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getSetting: (key) => values.get(key),
    setSetting: (key, value) => {
      values.set(key, value);
    },
  };
}

function slotFrom(draft: Record<string, unknown>): AgentSlot {
  const result = validateAgentSlot('workhorse', draft);
  if (!result.ok) throw new Error('the test draft must be valid');
  return result.slot;
}

describe('agent slot requests', () => {
  it('takes the profile and model from the stored slot, and merges its instructions into the system message', () => {
    const store = memoryStore();
    writeAgentSlot(store, 'workhorse', {
      profileId: 'profile-1',
      model: 'model-1',
      instructions: 'Keep the answer short.',
    });

    const resolved = resolveSlotRequest(store, 'workhorse', {
      messages: [
        { role: 'system', content: 'Built-in rules.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    expect(resolved).toMatchObject({ ok: true, profileId: 'profile-1', modelId: 'model-1' });
    if (!resolved.ok) throw new Error('expected a resolved slot');
    expect(resolved.body).toMatchObject({
      messages: [
        { role: 'system', content: 'Built-in rules.\n\nKeep the answer short.' },
        { role: 'user', content: 'Hello' },
      ],
    });
  });

  it('refuses a slot that is not set, and reads a stored slot that no longer passes as not set', () => {
    const store = memoryStore();
    expect(resolveSlotRequest(store, 'creative', { messages: [] })).toMatchObject({
      ok: false,
      error: 'The Creative Brain slot is not set',
    });
    store.values.set('agent_slot.creative', JSON.stringify({ provider: 'openrouter' }));
    expect(resolveSlotRequest(store, 'creative', { messages: [] }).ok).toBe(false);
    store.values.set('agent_slot.creative', '{not json');
    expect(resolveSlotRequest(store, 'creative', { messages: [] }).ok).toBe(false);
  });

  it('adds a system message when the body has none', () => {
    const slot = slotFrom({ instructions: 'Use plain words.' });
    expect(applySlotToBody({ messages: [{ role: 'user', content: 'Hi' }] }, slot)).toEqual({
      messages: [
        { role: 'system', content: 'Use plain words.' },
        { role: 'user', content: 'Hi' },
      ],
    });
  });

  it('applies a temperature the body does not set, but keeps one it sets', () => {
    const slot = slotFrom({ settings: { temperature: 0.2 } });
    expect(applySlotToBody({ messages: [] }, slot)).toMatchObject({ temperature: 0.2 });
    expect(applySlotToBody({ messages: [], temperature: 0.9 }, slot)).toMatchObject({
      temperature: 0.9,
    });
  });

  it('never raises an output limit: the smaller of the body and the slot wins', () => {
    const slot = slotFrom({ settings: { maxOutputTokens: 900 } });
    expect(applySlotToBody({ messages: [], max_tokens: 300 }, slot)).toMatchObject({
      max_tokens: 300,
    });
    expect(applySlotToBody({ messages: [], max_tokens: 4000 }, slot)).toMatchObject({
      max_tokens: 900,
    });
    expect(applySlotToBody({ messages: [] }, slot)).toMatchObject({ max_tokens: 900 });
  });

  it('returns a body that is not an object unchanged, for the broker to refuse', () => {
    const slot = slotFrom({ instructions: 'Anything.' });
    expect(applySlotToBody('not a body', slot)).toBe('not a body');
    expect(agentSlotDraft(slot)).toEqual({ instructions: 'Anything.' });
  });
});
