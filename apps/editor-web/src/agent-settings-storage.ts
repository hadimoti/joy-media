import type { AgentSettings } from './agent-settings-types.js';
import { DEFAULT_AGENT_SETTINGS } from './agent-settings-types.js';

export const AGENT_SETTINGS_STORAGE_KEY = 'joy-media.agent-settings.v1';

export interface AgentSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadAgentSettings(storage: AgentSettingsStorage): AgentSettings {
  const raw = storage.getItem(AGENT_SETTINGS_STORAGE_KEY);
  if (raw === null) return DEFAULT_AGENT_SETTINGS;
  try {
    return normalizeAgentSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
}

export function saveAgentSettings(storage: AgentSettingsStorage, settings: AgentSettings): void {
  storage.setItem(AGENT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function normalizeAgentSettings(value: unknown): AgentSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_AGENT_SETTINGS;
  const candidate = value as Partial<AgentSettings>;
  const modes: readonly AgentSettings['executionMode'][] = [
    'suggest-only',
    'preview-and-approve',
    'auto-apply-low-risk',
    'full-auto-limited',
  ];
  const capabilities = Array.isArray(candidate.allowedCapabilities)
    ? candidate.allowedCapabilities.filter(
        (capability): capability is AgentSettings['allowedCapabilities'][number] =>
          typeof capability === 'string' &&
          DEFAULT_AGENT_SETTINGS.allowedCapabilities.includes(
            capability as AgentSettings['allowedCapabilities'][number],
          ),
      )
    : DEFAULT_AGENT_SETTINGS.allowedCapabilities;
  return {
    version: 1,
    activeHost: 'kilocode',
    executionMode: modes.includes(candidate.executionMode as AgentSettings['executionMode'])
      ? (candidate.executionMode as AgentSettings['executionMode'])
      : DEFAULT_AGENT_SETTINGS.executionMode,
    reasoningModel:
      candidate.reasoningModel === 'mistral-small-latest' ? candidate.reasoningModel : '',
    mediaProvider:
      typeof candidate.mediaProvider === 'string' && candidate.mediaProvider.trim().length > 0
        ? candidate.mediaProvider.trim()
        : DEFAULT_AGENT_SETTINGS.mediaProvider,
    allowedCapabilities:
      capabilities.length > 0
        ? [...new Set(capabilities)]
        : DEFAULT_AGENT_SETTINGS.allowedCapabilities,
    maxCostPerRunUsd:
      typeof candidate.maxCostPerRunUsd === 'number' &&
      Number.isFinite(candidate.maxCostPerRunUsd) &&
      candidate.maxCostPerRunUsd >= 0
        ? Math.min(10_000, candidate.maxCostPerRunUsd)
        : DEFAULT_AGENT_SETTINGS.maxCostPerRunUsd,
    privacyMode: candidate.privacyMode === 'local-only' ? 'local-only' : 'ask-before-remote',
    workerPreference:
      candidate.workerPreference === 'any-approved' ? 'any-approved' : 'prefer-local',
  };
}
