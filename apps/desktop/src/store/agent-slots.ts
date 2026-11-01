import {
  agentSlotDraft,
  AGENT_SLOT_IDS,
  emptyAgentSlot,
  validateAgentSlot,
  type AgentSlot,
  type AgentSlotId,
  type AgentSlotResult,
} from '@joy-media/provider-sdk';

/** The part of the local database that agent slots use. Slots are kept as settings, so the schema does not change. */
export interface AgentSlotStore {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
}

function slotKey(id: AgentSlotId): string {
  return `agent_slot.${id}`;
}

/** One slot as the desktop reads it. A stored slot that no longer passes the rules reads as empty, so it cannot run. */
export function readAgentSlot(store: AgentSlotStore, id: AgentSlotId): AgentSlot {
  const raw = store.getSetting(slotKey(id));
  if (raw === undefined) return emptyAgentSlot(id);
  let draft: unknown;
  try {
    draft = JSON.parse(raw) as unknown;
  } catch {
    return emptyAgentSlot(id);
  }
  const result = validateAgentSlot(id, draft);
  return result.ok ? result.slot : emptyAgentSlot(id);
}

export function readAgentSlots(store: AgentSlotStore): readonly AgentSlot[] {
  return AGENT_SLOT_IDS.map((id) => readAgentSlot(store, id));
}

/** Checks a draft and stores it when it is valid. A refused draft changes nothing. */
export function writeAgentSlot(
  store: AgentSlotStore,
  id: AgentSlotId,
  draft: unknown,
): AgentSlotResult {
  const result = validateAgentSlot(id, draft);
  if (!result.ok) return result;
  store.setSetting(slotKey(id), JSON.stringify(agentSlotDraft(result.slot)));
  return result;
}

/** Empties the profile of every slot that names the deleted profile. The rest of the slot is kept. */
export function clearAgentSlotsForProfile(
  store: AgentSlotStore,
  profileId: string,
): readonly AgentSlotId[] {
  const cleared: AgentSlotId[] = [];
  for (const id of AGENT_SLOT_IDS) {
    const slot = readAgentSlot(store, id);
    if (slot.profileId !== profileId) continue;
    store.setSetting(
      slotKey(id),
      JSON.stringify(agentSlotDraft({ ...slot, profileId: undefined })),
    );
    cleared.push(id);
  }
  return cleared;
}
