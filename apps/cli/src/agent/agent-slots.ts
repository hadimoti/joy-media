import {
  emptyAgentSlot,
  validateAgentSlot,
  type AgentSlot,
  type AgentSlotId,
  type AgentSlotResult,
} from '@joy-media/provider-sdk';
import { loadCliConfig, saveCliConfig, type SavedAgentSlot } from '../utils/config.js';

/** One slot as the CLI reads it. A saved slot that no longer passes the rules reads as empty, so it cannot run. */
export function loadAgentSlot(id: AgentSlotId): AgentSlot {
  const result = validateAgentSlot(id, loadCliConfig().agentSlots?.[id]);
  return result.ok ? result.slot : emptyAgentSlot(id);
}

export function loadAgentSlots(): Readonly<Record<AgentSlotId, AgentSlot>> {
  return Object.freeze({
    workhorse: loadAgentSlot('workhorse'),
    creative: loadAgentSlot('creative'),
  });
}

/** Checks a draft and saves it when it is valid. A refused draft changes nothing. */
export function saveAgentSlot(id: AgentSlotId, draft: unknown): AgentSlotResult {
  const result = validateAgentSlot(id, draft);
  if (!result.ok) return result;
  const config = loadCliConfig();
  saveCliConfig({ ...config, agentSlots: { ...config.agentSlots, [id]: toSaved(result.slot) } });
  return result;
}

export function clearAgentSlot(id: AgentSlotId): void {
  const config = loadCliConfig();
  const agentSlots = { ...config.agentSlots };
  delete agentSlots[id];
  saveCliConfig({ ...config, agentSlots });
}

function toSaved(slot: AgentSlot): SavedAgentSlot {
  const settings = { ...slot.settings };
  return {
    ...(slot.profileId === undefined ? {} : { profileId: slot.profileId }),
    ...(slot.model === undefined ? {} : { model: slot.model }),
    ...(slot.instructions === '' ? {} : { instructions: slot.instructions }),
    ...(Object.keys(settings).length === 0 ? {} : { settings }),
  };
}
