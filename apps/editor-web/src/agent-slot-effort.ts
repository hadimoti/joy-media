import type { AgentSlotSettings } from '@joy-media/provider-sdk';

/**
 * The effort level of an agent slot: one choice in place of the two raw numbers (temperature, max output tokens) that
 * a slot stores. Each level is a pair of those numbers; "auto" stores none, so the provider's own defaults apply. A
 * slot saved earlier with other numbers shows as "custom" and keeps them until another level is chosen.
 */
export type AgentSlotEffort = 'auto' | 'low' | 'medium' | 'high' | 'custom';

export const AGENT_SLOT_EFFORT_PRESETS: Readonly<
  Record<Exclude<AgentSlotEffort, 'auto' | 'custom'>, Required<AgentSlotSettings>>
> = Object.freeze({
  low: { temperature: 0.3, maxOutputTokens: 1024 },
  medium: { temperature: 0.7, maxOutputTokens: 4096 },
  high: { temperature: 1, maxOutputTokens: 8192 },
});

export function effortFromSettings(settings: AgentSlotSettings): AgentSlotEffort {
  if (settings.temperature === undefined && settings.maxOutputTokens === undefined) return 'auto';
  for (const level of ['low', 'medium', 'high'] as const) {
    const preset = AGENT_SLOT_EFFORT_PRESETS[level];
    if (
      preset.temperature === settings.temperature &&
      preset.maxOutputTokens === settings.maxOutputTokens
    ) {
      return level;
    }
  }
  return 'custom';
}

/** The numbers a level stores. `custom` keeps the numbers the slot already had. */
export function settingsForEffort(
  effort: AgentSlotEffort,
  current: AgentSlotSettings,
): AgentSlotSettings {
  if (effort === 'auto') return {};
  if (effort === 'custom') return current;
  return { ...AGENT_SLOT_EFFORT_PRESETS[effort] };
}
