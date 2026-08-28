import type { AgentExecutionMode, ToolCapability } from '@joy-media/agent-tools';

/** These are IDs, never provider credentials or arbitrary user-entered model names. */
export const CONFIGURABLE_REASONING_MODELS = ['mistral-small-latest'] as const;
export type ConfigurableReasoningModel = (typeof CONFIGURABLE_REASONING_MODELS)[number] | '';

export interface AgentSettings {
  readonly version: 1;
  readonly activeHost: 'kilocode';
  readonly executionMode: AgentExecutionMode;
  readonly reasoningModel: ConfigurableReasoningModel;
  readonly mediaProvider: string;
  readonly allowedCapabilities: readonly ToolCapability[];
  readonly maxCostPerRunUsd: number;
  readonly privacyMode: 'ask-before-remote' | 'local-only';
  readonly workerPreference: 'prefer-local' | 'any-approved';
}

export const ALL_AGENT_TOOL_CAPABILITIES: readonly ToolCapability[] = [
  'timeline.read',
  'timeline.write',
  'assets.read',
  'assets.import',
  'filesystem.read',
  'filesystem.write',
  'provider.generate',
  'provider.spend',
  'render.preview',
  'export.write',
  'project.overwrite',
  'plugin.invoke',
];

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  version: 1,
  activeHost: 'kilocode',
  executionMode: 'preview-and-approve',
  reasoningModel: '',
  mediaProvider: 'Approved provider',
  allowedCapabilities: ALL_AGENT_TOOL_CAPABILITIES,
  maxCostPerRunUsd: 10,
  privacyMode: 'ask-before-remote',
  workerPreference: 'prefer-local',
};
