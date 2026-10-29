import { isAgentSlotConfigured, type AgentSlot, type AgentSlotId } from '@joy-media/provider-sdk';
import { readAgentSlot, type AgentSlotStore } from '../store/agent-slots.js';

export type SlotRequestResult =
  | {
      readonly ok: true;
      readonly profileId: string;
      readonly modelId: string;
      readonly body: unknown;
    }
  | { readonly ok: false; readonly error: string };

/**
 * A request that names a slot takes its profile, its model and its instructions from the slot, so the renderer chooses
 * only the slot. The broker still checks the endpoint against that profile before anything is sent.
 */
export function resolveSlotRequest(
  store: AgentSlotStore,
  slotId: AgentSlotId,
  body: unknown,
): SlotRequestResult {
  const slot = readAgentSlot(store, slotId);
  if (!isAgentSlotConfigured(slot) || slot.profileId === undefined || slot.model === undefined) {
    return { ok: false, error: `The ${slot.label} slot is not set` };
  }
  return {
    ok: true,
    profileId: slot.profileId,
    modelId: slot.model,
    body: applySlotToBody(body, slot),
  };
}

/**
 * The slot's instructions join the system message. Its settings can only lower a limit: a temperature the body does not
 * set comes from the slot, and an output limit is the smaller of the body's and the slot's.
 */
export function applySlotToBody(body: unknown, slot: AgentSlot): unknown {
  if (!isRecord(body)) return body;
  const next: Record<string, unknown> = { ...body };
  if (Array.isArray(body.messages) && slot.instructions !== '') {
    next.messages = withInstructions(body.messages, slot.instructions);
  }
  if (slot.settings.temperature !== undefined && body.temperature === undefined) {
    next.temperature = slot.settings.temperature;
  }
  if (slot.settings.maxOutputTokens !== undefined) {
    const requested =
      typeof body.max_tokens === 'number' ? body.max_tokens : Number.POSITIVE_INFINITY;
    next.max_tokens = Math.min(requested, slot.settings.maxOutputTokens);
  }
  return next;
}

function withInstructions(messages: readonly unknown[], instructions: string): unknown[] {
  const system = messages.findIndex(
    (message) =>
      isRecord(message) && message.role === 'system' && typeof message.content === 'string',
  );
  if (system === -1) return [{ role: 'system', content: instructions }, ...messages];
  return messages.map((message, index) => {
    if (index !== system || !isRecord(message)) return message;
    return { ...message, content: `${String(message.content)}\n\n${instructions}` };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
