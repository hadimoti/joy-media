/**
 * The two general-purpose agent slots (D17, PLAN-v4 §6d-1). Each slot stands alone: it names one saved provider profile,
 * so its provider and its authentication come from that profile, and it also holds a model, instructions and optional
 * settings. No slot is tied to a task or a provider, and none has a built-in binding: an empty slot cannot run.
 *
 * This module is pure. The desktop stores slots in its database and the CLI in its config file; both use these rules.
 */

export const AGENT_SLOT_IDS = ['workhorse', 'creative'] as const;
export type AgentSlotId = (typeof AGENT_SLOT_IDS)[number];

/** The default label of each slot. A label names the slot only; it carries no provider. */
export const AGENT_SLOT_LABELS: Readonly<Record<AgentSlotId, string>> = Object.freeze({
  workhorse: 'Workhorse',
  creative: 'Creative Brain',
});

/** Bounds on what a slot may hold. A value outside them is refused, never cut down to fit. */
export const AGENT_SLOT_LIMITS = Object.freeze({
  profileIdLength: 128,
  modelIdLength: 256,
  instructionsLength: 4000,
  temperatureMin: 0,
  temperatureMax: 2,
  maxOutputTokensMin: 1,
  maxOutputTokensMax: 32_000,
});

export interface AgentSlotSettings {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

/** What the owner sets for one slot. An absent or empty text field means "not set". */
export interface AgentSlotDraft {
  readonly profileId?: string | undefined;
  readonly model?: string | undefined;
  readonly instructions?: string | undefined;
  readonly settings?: AgentSlotSettings | undefined;
}

export interface AgentSlot {
  readonly id: AgentSlotId;
  readonly label: string;
  readonly profileId: string | undefined;
  readonly model: string | undefined;
  readonly instructions: string;
  readonly settings: AgentSlotSettings;
}

export type AgentSlotIssue = 'UNKNOWN_SLOT' | 'UNKNOWN_FIELD' | 'INVALID_VALUE';

export type AgentSlotResult =
  | { readonly ok: true; readonly slot: AgentSlot }
  | { readonly ok: false; readonly issue: AgentSlotIssue; readonly field?: string };

const SLOT_FIELDS: readonly string[] = ['profileId', 'model', 'instructions', 'settings'];
const SETTING_FIELDS: readonly string[] = ['temperature', 'maxOutputTokens'];

export function parseAgentSlotId(value: unknown): AgentSlotId | undefined {
  return (AGENT_SLOT_IDS as readonly unknown[]).includes(value)
    ? (value as AgentSlotId)
    : undefined;
}

/** A slot with nothing bound. It cannot run until the owner sets a profile and a model. */
export function emptyAgentSlot(id: AgentSlotId): AgentSlot {
  return Object.freeze({
    id,
    label: AGENT_SLOT_LABELS[id],
    profileId: undefined,
    model: undefined,
    instructions: '',
    settings: Object.freeze({}),
  });
}

/** A slot can run only when it names a profile and a model. */
export function isAgentSlotConfigured(slot: Pick<AgentSlot, 'profileId' | 'model'>): boolean {
  return slot.profileId !== undefined && slot.model !== undefined;
}

/**
 * Checks a draft for one slot. An unknown field, an unknown slot, or a value out of range is refused, so nothing is
 * stored that a later run would have to guess about. Text is trimmed, and blank text means "not set".
 */
export function validateAgentSlot(id: unknown, draft: unknown): AgentSlotResult {
  const slotId = parseAgentSlotId(id);
  if (slotId === undefined) return { ok: false, issue: 'UNKNOWN_SLOT' };
  if (draft === undefined || draft === null) return { ok: true, slot: emptyAgentSlot(slotId) };
  if (typeof draft !== 'object' || Array.isArray(draft)) {
    return { ok: false, issue: 'INVALID_VALUE' };
  }
  const record = draft as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!SLOT_FIELDS.includes(key)) return { ok: false, issue: 'UNKNOWN_FIELD', field: key };
  }

  const profileId = optionalText(record.profileId, AGENT_SLOT_LIMITS.profileIdLength);
  if (profileId === null) return { ok: false, issue: 'INVALID_VALUE', field: 'profileId' };
  const model = optionalText(record.model, AGENT_SLOT_LIMITS.modelIdLength);
  if (model === null) return { ok: false, issue: 'INVALID_VALUE', field: 'model' };
  const instructions = optionalText(record.instructions, AGENT_SLOT_LIMITS.instructionsLength);
  if (instructions === null) return { ok: false, issue: 'INVALID_VALUE', field: 'instructions' };
  const settings = optionalSettings(record.settings);
  if (settings === null) return { ok: false, issue: 'INVALID_VALUE', field: 'settings' };

  return {
    ok: true,
    slot: Object.freeze({
      id: slotId,
      label: AGENT_SLOT_LABELS[slotId],
      profileId,
      model,
      instructions: instructions ?? '',
      settings,
    }),
  };
}

/** Undefined when absent or blank, the trimmed text when valid, and null when the value is refused. */
function optionalText(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** The settings object, frozen, or null when a setting is refused. Absent settings are an empty object. */
function optionalSettings(value: unknown): AgentSlotSettings | null {
  if (value === undefined || value === null) return Object.freeze({});
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !SETTING_FIELDS.includes(key))) return null;

  const settings: { temperature?: number; maxOutputTokens?: number } = {};
  if (record.temperature !== undefined) {
    const temperature = record.temperature;
    if (
      typeof temperature !== 'number' ||
      !Number.isFinite(temperature) ||
      temperature < AGENT_SLOT_LIMITS.temperatureMin ||
      temperature > AGENT_SLOT_LIMITS.temperatureMax
    ) {
      return null;
    }
    settings.temperature = temperature;
  }
  if (record.maxOutputTokens !== undefined) {
    const maxOutputTokens = record.maxOutputTokens;
    if (
      typeof maxOutputTokens !== 'number' ||
      !Number.isInteger(maxOutputTokens) ||
      maxOutputTokens < AGENT_SLOT_LIMITS.maxOutputTokensMin ||
      maxOutputTokens > AGENT_SLOT_LIMITS.maxOutputTokensMax
    ) {
      return null;
    }
    settings.maxOutputTokens = maxOutputTokens;
  }
  return Object.freeze(settings);
}

/** The draft a slot is saved from: only the fields it holds, so an empty slot saves as an empty draft. */
export function agentSlotDraft(slot: AgentSlot): AgentSlotDraft {
  const settings = { ...slot.settings };
  return {
    ...(slot.profileId === undefined ? {} : { profileId: slot.profileId }),
    ...(slot.model === undefined ? {} : { model: slot.model }),
    ...(slot.instructions === '' ? {} : { instructions: slot.instructions }),
    ...(Object.keys(settings).length === 0 ? {} : { settings }),
  };
}
