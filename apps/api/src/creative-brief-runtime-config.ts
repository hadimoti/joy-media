/**
 * Creative Brief Runtime Configuration Parser - WP-37 S4-F9
 *
 * Safe, fail-closed parser for Creative Brief runtime configuration.
 * Accepts an injected readonly environment map; never reads process.env directly.
 * On any error (invalid values, missing required values, unknown keys), returns disabled.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Valid configuration modes for Creative Brief runtime.
 */
export type CreativeBriefRuntimeMode = 'disabled' | 'openrouter';

/**
 * Configuration for OpenRouter mode.
 * Contains only non-sensitive reference names, never actual secret values.
 */
export interface OpenRouterConfig {
  /** The mode identifier. */
  readonly mode: 'openrouter';
  /** OpenRouter model ID to use. */
  readonly modelId: string;
  /** Request timeout in milliseconds (1000-300000). */
  readonly timeoutMs: number;
  /** Maximum spend limit in USD cents (1-10000). */
  readonly spendLimitUsdCents: number;
  /** Opaque name reference to the secret (e.g., "openrouter-api-key"). */
  readonly secretRef: string;
}

/**
 * Disabled configuration.
 */
export interface DisabledConfig {
  readonly mode: 'disabled';
}

/**
 * Parsed Creative Brief runtime configuration.
 * Always valid - parser fails closed to disabled on any error.
 */
export type CreativeBriefRuntimeConfig = DisabledConfig | OpenRouterConfig;

// ============================================================================
// Constants
// ============================================================================

const PREFIX = 'JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_';

const MODE_KEY = `${PREFIX}MODE`;
const MODEL_ID_KEY = `${PREFIX}MODEL_ID`;
const TIMEOUT_MS_KEY = `${PREFIX}TIMEOUT_MS`;
const SPEND_LIMIT_USD_CENTS_KEY = `${PREFIX}SPEND_LIMIT_USD_CENTS`;
const SECRET_REF_KEY = `${PREFIX}SECRET_REF`;

/** All valid keys for this configuration prefix. */
const VALID_KEYS: ReadonlySet<string> = new Set([
  MODE_KEY,
  MODEL_ID_KEY,
  TIMEOUT_MS_KEY,
  SPEND_LIMIT_USD_CENTS_KEY,
  SECRET_REF_KEY,
]);

// Validation bounds
const TIMEOUT_MIN = 1000;
const TIMEOUT_MAX = 300000;
const SPEND_LIMIT_MIN = 1;
const SPEND_LIMIT_MAX = 10000;

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse Creative Brief runtime configuration from environment variables.
 *
 * @param env - Readonly environment variable map. Must not be process.env.
 * @returns A valid configuration object. On any parse error, returns disabled.
 *
 * @example
 * ```ts
 * const config = parseCreativeBriefRuntimeConfig({
 *   JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_MODE: 'openrouter',
 *   JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_MODEL_ID: 'openrouter/mistral-large',
 *   JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_TIMEOUT_MS: '60000',
 *   JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_SPEND_LIMIT_USD_CENTS: '500',
 *   JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_SECRET_REF: 'my-openrouter-key',
 * });
 * // => { mode: 'openrouter', modelId: 'openrouter/mistral-large', timeoutMs: 60000, spendLimitUsdCents: 500, secretRef: 'my-openrouter-key' }
 * ```
 *
 * @example
 * ```ts
 * const config = parseCreativeBriefRuntimeConfig({});
 * // => { mode: 'disabled' }
 * ```
 */
export function parseCreativeBriefRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
): CreativeBriefRuntimeConfig {
  // Check for unknown prefixed keys - fail closed on any unexpected key
  const envKeys = Object.keys(env);
  const prefixedKeys = envKeys.filter((k) => k.startsWith(PREFIX));
  const unknownKeys = prefixedKeys.filter((k) => !VALID_KEYS.has(k));
  if (unknownKeys.length > 0) {
    return { mode: 'disabled' };
  }

  // Parse mode (trim before comparison)
  const rawMode = env[MODE_KEY]?.trim().toLowerCase();
  const mode: CreativeBriefRuntimeMode = rawMode === 'openrouter' ? 'openrouter' : 'disabled';

  // If mode is disabled, we're done (disabled is the default and requires nothing else)
  if (mode === 'disabled') {
    // Still check that if openrouter-specific keys exist, they're valid
    // But only if mode wasn't explicitly set to disabled - be lenient
    if (rawMode === 'disabled') {
      return { mode: 'disabled' };
    }
    // Mode was not explicitly set or was invalid -> disabled
    // Check if any openrouter keys are present - that's an error
    if (
      env[MODEL_ID_KEY] !== undefined ||
      env[TIMEOUT_MS_KEY] !== undefined ||
      env[SPEND_LIMIT_USD_CENTS_KEY] !== undefined ||
      env[SECRET_REF_KEY] !== undefined
    ) {
      return { mode: 'disabled' };
    }
    return { mode: 'disabled' };
  }

  // Mode is openrouter - validate all required fields
  const modelId = env[MODEL_ID_KEY];
  const timeoutMsRaw = env[TIMEOUT_MS_KEY];
  const spendLimitUsdCentsRaw = env[SPEND_LIMIT_USD_CENTS_KEY];
  const secretRef = env[SECRET_REF_KEY];

  // All required fields must be present and non-empty
  if (
    modelId === undefined ||
    modelId.trim() === '' ||
    timeoutMsRaw === undefined ||
    spendLimitUsdCentsRaw === undefined ||
    secretRef === undefined ||
    secretRef.trim() === ''
  ) {
    return { mode: 'disabled' };
  }

  // Parse timeout
  const timeoutMs = parseInteger(timeoutMsRaw);
  if (
    timeoutMs === null ||
    timeoutMs < TIMEOUT_MIN ||
    timeoutMs > TIMEOUT_MAX
  ) {
    return { mode: 'disabled' };
  }

  // Parse spend limit
  const spendLimitUsdCents = parseInteger(spendLimitUsdCentsRaw);
  if (
    spendLimitUsdCents === null ||
    spendLimitUsdCents < SPEND_LIMIT_MIN ||
    spendLimitUsdCents > SPEND_LIMIT_MAX
  ) {
    return { mode: 'disabled' };
  }

  // All validations passed
  return {
    mode: 'openrouter',
    modelId: modelId.trim(),
    timeoutMs,
    spendLimitUsdCents,
    secretRef: secretRef.trim(),
  };
}

/**
 * Parse a string to an integer, returning null if not a valid integer.
 */
function parseInteger(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // Must be a valid integer string (no decimals, no scientific notation)
  if (!/^-?\d+$/.test(trimmed)) return null;
  const num = Number(trimmed);
  // Check for safe integer range
  if (!Number.isSafeInteger(num)) return null;
  return num;
}

// ============================================================================
// Guards
// ============================================================================

/**
 * Type guard for disabled configuration.
 */
export function isDisabledConfig(
  config: CreativeBriefRuntimeConfig,
): config is DisabledConfig {
  return config.mode === 'disabled';
}

/**
 * Type guard for OpenRouter configuration.
 */
export function isOpenRouterConfig(
  config: CreativeBriefRuntimeConfig,
): config is OpenRouterConfig {
  return config.mode === 'openrouter';
}
