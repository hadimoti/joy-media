export const KILO_GATEWAY_BASE_URL = 'https://api.kilo.ai/api/gateway';

/** Accepted on load and migrated to KILO_GATEWAY_BASE_URL. */
export const LEGACY_KILO_BASE_URLS = [
  'https://api.kilo.ai/v1',
  'https://api.kilo.ai/api/gateway/v1',
] as const;

export { OPENROUTER_BASE_URL } from './provider-defaults.js';
export { DEFAULT_JOY_HOSTED_BASE_URL as JOY_HOSTED_BASE_URL } from './provider-config.js';

export interface ProviderModelPreset {
  id: string;
  label: string;
  vision: boolean;
  role?: 'creative' | 'workhorse' | 'fast';
}

export const KILO_MODEL_PRESETS: readonly ProviderModelPreset[] = [
  {
    id: 'byteplus-coding/dola-seed-2.0-pro',
    label: 'Dola Seed 2.0 Pro (vision)',
    vision: true,
    role: 'creative',
  },
  { id: 'byteplus-coding/dola-seed-2.0-lite', label: 'Dola Seed 2.0 Lite (vision)', vision: true },
  {
    id: 'byteplus-coding/deepseek-v4-flash',
    label: 'DeepSeek V4 Flash (text)',
    vision: false,
    role: 'fast',
  },
];

export const DEFAULT_KILO_MODEL = 'kilo/kilo-auto/free';
export const DEFAULT_OPENROUTER_MODEL = 'openrouter/free';
export const DEFAULT_LM_STUDIO_MODEL = 'local-model';
export const RETIRED_MODEL_IDS = [
  'minimax/minimax-m3',
  'kilo-auto/efficient',
  'kilo-auto/free',
] as const;

export function canonicalKiloBaseUrl(url: string): string {
  const normalized = url.trim().replace(/\/+$/, '');
  if ((LEGACY_KILO_BASE_URLS as readonly string[]).includes(normalized)) {
    return KILO_GATEWAY_BASE_URL;
  }
  return normalized;
}

export function isRetiredModelId(id: string): boolean {
  return (RETIRED_MODEL_IDS as readonly string[]).includes(id);
}

export function defaultModelFor(provider: string): string | undefined {
  if (provider === 'kilo') return DEFAULT_KILO_MODEL;
  if (provider === 'openrouter') return DEFAULT_OPENROUTER_MODEL;
  if (provider === 'joy-hosted') return DEFAULT_OPENROUTER_MODEL;
  if (provider === 'lm-studio') return DEFAULT_LM_STUDIO_MODEL;
  return undefined;
}
