import { JOY_CODE_SECRET_REFERENCE } from './joy-code-secret-resolver.js';
export { JOY_CODE_CONSENT_VERSION } from './joy-code-consent.js';
import { JOY_CODE_CONSENT_VERSION } from './joy-code-consent.js';

export { JOY_CODE_SECRET_REFERENCE } from './joy-code-secret-resolver.js';
export const JOY_CODE_MODEL_ID = 'nvidia/nemotron-3.5-lightning:free' as const;
export const JOY_CODE_FREE_MODEL_IDS = [JOY_CODE_MODEL_ID] as const;
export type JoyCodeRuntimeConfig = { readonly mode: 'disabled' } | { readonly mode: 'openrouter'; readonly modelId: string; readonly timeoutMs: number; readonly spendLimitUsdCents: 0; readonly secretRef: string; readonly allowedFreeModelIds: readonly string[] };
const PREFIX = 'JOY_MEDIA_JOY_CODE_RUNTIME_';
const KEYS = new Set(['MODE', 'MODEL_ID', 'TIMEOUT_MS', 'SPEND_LIMIT_USD_CENTS', 'SECRET_REF', 'ALLOWED_FREE_MODEL_IDS']);
export function parseJoyCodeRuntimeConfig(env: Readonly<Record<string, string | undefined>>): JoyCodeRuntimeConfig {
  if (Object.keys(env).some((key) => key.startsWith(PREFIX) && !KEYS.has(key.slice(PREFIX.length)))) return { mode: 'disabled' };
  if (env[`${PREFIX}MODE`]?.trim().toLowerCase() !== 'openrouter') return { mode: 'disabled' };
  const modelId = env[`${PREFIX}MODEL_ID`]?.trim();
  const timeoutMs = parseIntBounded(env[`${PREFIX}TIMEOUT_MS`], 1_000, 30_000);
  const spend = env[`${PREFIX}SPEND_LIMIT_USD_CENTS`]?.trim();
  const secretRef = env[`${PREFIX}SECRET_REF`]?.trim();
  const allowlist = env[`${PREFIX}ALLOWED_FREE_MODEL_IDS`]?.split(',').map((item) => item.trim());
  if (modelId !== JOY_CODE_MODEL_ID || timeoutMs === undefined || spend !== '0' || secretRef !== JOY_CODE_SECRET_REFERENCE || allowlist?.length !== 1 || allowlist[0] !== JOY_CODE_MODEL_ID) return { mode: 'disabled' };
  return { mode: 'openrouter', modelId, timeoutMs, spendLimitUsdCents: 0, secretRef, allowedFreeModelIds: allowlist };
}
export function isJoyCodeRuntimeEnabled(config: JoyCodeRuntimeConfig): config is Extract<JoyCodeRuntimeConfig, { mode: 'openrouter' }> { return config.mode === 'openrouter'; }
function parseIntBounded(value: string | undefined, min: number, max: number): number | undefined { if (value === undefined || !/^\d+$/.test(value.trim())) return undefined; const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined; }
