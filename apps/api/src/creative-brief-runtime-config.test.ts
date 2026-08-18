/**
 * Creative Brief Runtime Configuration Parser Tests - WP-37 S4-F9
 *
 * Focused tests for safe, fail-closed Creative Brief runtime configuration parsing.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCreativeBriefRuntimeConfig,
  isDisabledConfig,
  isOpenRouterConfig,
} from './creative-brief-runtime-config.js';
import type { CreativeBriefRuntimeConfig, OpenRouterConfig } from './creative-brief-runtime-config.js';

const PREFIX = 'JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_';

// ============================================================================
// Valid Configurations
// ============================================================================

describe('parseCreativeBriefRuntimeConfig - valid configurations', () => {
  it('should return disabled config for empty env', () => {
    const result = parseCreativeBriefRuntimeConfig({});
    expect(result).toEqual({ mode: 'disabled' });
    expect(isDisabledConfig(result)).toBe(true);
    expect(isOpenRouterConfig(result)).toBe(false);
  });

  it('should return disabled config when mode is explicitly disabled', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'disabled',
    });
    expect(result).toEqual({ mode: 'disabled' });
    expect(isDisabledConfig(result)).toBe(true);
  });

  it('should return openrouter config with valid minimal parameters', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    expect(result).toEqual({
      mode: 'openrouter',
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'my-openrouter-key',
      allowedFreeModelIds: ['openrouter/mistral-large'],
    });
    expect(isOpenRouterConfig(result)).toBe(true);
    expect(isDisabledConfig(result)).toBe(false);
  });

  it('should accept mode with mixed case', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'OpenRouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    expect(result.mode).toBe('openrouter');
  });

  it('should trim whitespace from string values', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: '  openrouter  ',
      [ `${PREFIX}MODEL_ID` ]: '  openrouter/mistral-large  ',
      [ `${PREFIX}TIMEOUT_MS` ]: '  60000  ',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '  500  ',
      [ `${PREFIX}SECRET_REF` ]: '  my-openrouter-key  ',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: '  openrouter/mistral-large  ',
    });
    expect(result).toEqual({
      mode: 'openrouter',
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'my-openrouter-key',
      allowedFreeModelIds: ['openrouter/mistral-large'],
    });
  });
});

// ============================================================================
// Invalid - Missing Required Fields
// ============================================================================

describe('parseCreativeBriefRuntimeConfig - missing required fields', () => {
  it('should fail closed to disabled when openrouter mode is set but modelId is missing', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when openrouter mode is set but timeoutMs is missing', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when openrouter mode is set but spendLimitUsdCents is missing', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when openrouter mode is set but secretRef is missing', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when modelId is empty string', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: '',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when secretRef is empty string', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: '',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when secretRef is whitespace only', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: '   ',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });
});

// ============================================================================
// Invalid - Invalid Values
// ============================================================================

describe('parseCreativeBriefRuntimeConfig - invalid numeric values', () => {
  it('should fail closed to disabled when timeoutMs is not an integer', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: 'not-a-number',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when timeoutMs is a float', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000.5',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when timeoutMs is below minimum (1000)', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '999',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when timeoutMs is above maximum (300000)', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '300001',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should accept timeoutMs at minimum boundary (1000)', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '1000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    if (isOpenRouterConfig(result)) {
      expect(result.timeoutMs).toBe(1000);
    } else {
      expect.fail('Expected openrouter config');
    }
  });

  it('should accept timeoutMs at maximum boundary (300000)', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '300000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    if (isOpenRouterConfig(result)) {
      expect(result.timeoutMs).toBe(300000);
    } else {
      expect.fail('Expected openrouter config');
    }
  });

  it('should fail closed to disabled when spendLimitUsdCents is not an integer', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: 'not-a-number',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when spendLimitUsdCents is a float', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500.5',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when spendLimitUsdCents is a fractional value like 0.5', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '0.5',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when spendLimitUsdCents is above maximum (10000)', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '10001',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should accept spendLimitUsdCents at zero (free-only policy)', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '0',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    if (isOpenRouterConfig(result)) {
      expect(result.spendLimitUsdCents).toBe(0);
    } else {
      expect.fail('Expected openrouter config');
    }
  });

  it('should accept spendLimitUsdCents at minimum boundary (1)', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '1',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    if (isOpenRouterConfig(result)) {
      expect(result.spendLimitUsdCents).toBe(1);
    } else {
      expect.fail('Expected openrouter config');
    }
  });

  it('should accept spendLimitUsdCents at maximum boundary (10000)', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '10000',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    if (isOpenRouterConfig(result)) {
      expect(result.spendLimitUsdCents).toBe(10000);
    } else {
      expect.fail('Expected openrouter config');
    }
  });
});

// ============================================================================
// Invalid - Unknown Keys
// ============================================================================

describe('parseCreativeBriefRuntimeConfig - unknown prefixed keys', () => {
  it('should fail closed to disabled when an unknown prefixed key is present', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
      [ `${PREFIX}UNKNOWN_KEY` ]: 'some-value',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when an unknown prefixed key is present even with disabled mode', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'disabled',
      [ `${PREFIX}UNKNOWN_KEY` ]: 'some-value',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when an unknown prefixed key is present with no mode', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}UNKNOWN_KEY` ]: 'some-value',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });
});

// ============================================================================
// Invalid - Malformed Mode
// ============================================================================

describe('parseCreativeBriefRuntimeConfig - malformed mode', () => {
  it('should fail closed to disabled when mode is invalid value', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'invalid-mode',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when openrouter keys are present but mode is not openrouter', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed to disabled when mode is empty string', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: '',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });
});

// ============================================================================
// Security - No Secret Data Leakage
// ============================================================================

describe('parseCreativeBriefRuntimeConfig - security', () => {
  it('should never include actual secret values in output', () => {
    // Simulate someone accidentally putting a secret value in the wrong place
    const secretValue = 'sk-actual-secret-key-1234567890';
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
      // This is an invalid key, but we want to ensure no secret leakage
      [ `${PREFIX}API_KEY` ]: secretValue,
    });
    // Should fail closed due to unknown key
    expect(result).toEqual({ mode: 'disabled' });
    // Ensure the secret value is NOT in the result
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain(secretValue);
  });

  it('should only store opaque secret reference name, not actual secret', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'openrouter-api-key-ref',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    expect(isOpenRouterConfig(result)).toBe(true);
    // The secretRef is just a reference name, not an actual secret
    if (isOpenRouterConfig(result)) {
      expect(result.secretRef).toBe('openrouter-api-key-ref');
      expect(result.secretRef).not.toMatch(/^sk-/);
      expect(result.secretRef).not.toMatch(/^key-/);
    }
  });

  it('should not expose secret-like patterns in error cases', () => {
    const secretValue = 'sk-1234567890abcdef';
    // Mode is invalid, should fail closed
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: secretValue,
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
      // secretRef is missing - should fail closed
    });
    expect(result).toEqual({ mode: 'disabled' });
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain(secretValue);
  });
});

// ============================================================================
// Type Guards
// ============================================================================

describe('type guards', () => {
  it('isDisabledConfig should correctly identify disabled config', () => {
    const config: CreativeBriefRuntimeConfig = { mode: 'disabled' };
    expect(isDisabledConfig(config)).toBe(true);
    expect(isOpenRouterConfig(config)).toBe(false);
  });

  it('isOpenRouterConfig should correctly identify openrouter config', () => {
    const config: CreativeBriefRuntimeConfig = {
      mode: 'openrouter',
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'my-key',
      allowedFreeModelIds: ['openrouter/mistral-large'],
    };
    expect(isOpenRouterConfig(config)).toBe(true);
    expect(isDisabledConfig(config)).toBe(false);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('parseCreativeBriefRuntimeConfig - edge cases', () => {
  it('should handle negative timeoutMs as invalid', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '-1000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should handle negative spendLimitUsdCents as invalid', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '-1',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should handle very large timeoutMs as invalid', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '999999999999',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should handle very large spendLimitUsdCents as invalid', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '999999999',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should handle timeoutMs with leading zeros', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '0060000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    if (isOpenRouterConfig(result)) {
      expect(result.timeoutMs).toBe(60000);
    } else {
      expect.fail('Expected openrouter config');
    }
  });

  it('should handle spendLimitUsdCents with leading zeros', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '00500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    if (isOpenRouterConfig(result)) {
      expect(result.spendLimitUsdCents).toBe(500);
    } else {
      expect.fail('Expected openrouter config');
    }
  });

  it('should ignore non-prefixed environment keys', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
      SOME_OTHER_KEY: 'should-be-ignored',
      ANOTHER_KEY: 'also-ignored',
    });
    expect(result.mode).toBe('openrouter');
    expect(isOpenRouterConfig(result)).toBe(true);
    if (isOpenRouterConfig(result)) {
      expect(result.modelId).toBe('openrouter/mistral-large');
    }
  });

  it('should handle undefined values in env map', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'disabled',
      [ `${PREFIX}MODEL_ID` ]: undefined,
      [ `${PREFIX}TIMEOUT_MS` ]: undefined,
    });
    expect(result).toEqual({ mode: 'disabled' });
  });
});

// ============================================================================
// Allowed Free Model IDs - WP-37 S4-F10-E2
// ============================================================================

describe('parseCreativeBriefRuntimeConfig - allowed free model IDs', () => {
  it('should parse single allowed free model ID', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large',
    });
    expect(isOpenRouterConfig(result)).toBe(true);
    if (isOpenRouterConfig(result)) {
      expect(result.allowedFreeModelIds).toEqual(['openrouter/mistral-large']);
    }
  });

  it('should parse multiple allowed free model IDs', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large,openrouter/llama3-70b,openrouter/gemma-7b',
    });
    expect(isOpenRouterConfig(result)).toBe(true);
    if (isOpenRouterConfig(result)) {
      expect(result.allowedFreeModelIds).toEqual([
        'openrouter/mistral-large',
        'openrouter/llama3-70b',
        'openrouter/gemma-7b',
      ]);
    }
  });

  it('should maintain deterministic ordering of allowed model IDs', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/llama3-70b',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/gemma-7b,openrouter/mistral-large,openrouter/llama3-70b',
    });
    expect(isOpenRouterConfig(result)).toBe(true);
    if (isOpenRouterConfig(result)) {
      expect(result.allowedFreeModelIds).toEqual([
        'openrouter/gemma-7b',
        'openrouter/mistral-large',
        'openrouter/llama3-70b',
      ]);
    }
  });

  it('should fail closed when allowed free model IDs is missing', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed when allowed free model IDs is empty string', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: '',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed when allowed free model IDs contains blank entries', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large,,openrouter/llama3-70b',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed when allowed free model IDs contains only whitespace entries', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large,  ,openrouter/llama3-70b',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed when allowed free model IDs contains duplicates', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large,openrouter/llama3-70b,openrouter/mistral-large',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should fail closed when modelId is not in allowed free model IDs', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/not-allowed-model',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: 'openrouter/mistral-large,openrouter/llama3-70b',
    });
    expect(result).toEqual({ mode: 'disabled' });
  });

  it('should trim whitespace from allowed free model IDs', () => {
    const result = parseCreativeBriefRuntimeConfig({
      [ `${PREFIX}MODE` ]: 'openrouter',
      [ `${PREFIX}MODEL_ID` ]: 'openrouter/mistral-large',
      [ `${PREFIX}TIMEOUT_MS` ]: '60000',
      [ `${PREFIX}SPEND_LIMIT_USD_CENTS` ]: '500',
      [ `${PREFIX}SECRET_REF` ]: 'my-openrouter-key',
      [ `${PREFIX}ALLOWED_FREE_MODEL_IDS` ]: '  openrouter/mistral-large  ,  openrouter/llama3-70b  ',
    });
    expect(isOpenRouterConfig(result)).toBe(true);
    if (isOpenRouterConfig(result)) {
      expect(result.allowedFreeModelIds).toEqual([
        'openrouter/mistral-large',
        'openrouter/llama3-70b',
      ]);
    }
  });
});
