/**
 * Creative Brief Secret Resolver Tests - WP-37 S4-F10-E1
 *
 * Focused tests for the server-side opaque secret-reference resolver boundary.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CREATIVE_BRIEF_SECRET_REFERENCE,
  createCreativeBriefSecretResolver,
  type SecretSource,
  type CreativeBriefSecretResolver,
} from './creative-brief-secret-resolver.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_SENTINEL = 'sk-test-sentinel-value' as const;

// In-memory secret source for testing
class InMemorySecretSource implements SecretSource {
  #store: Map<string, string>;
  #getSecretCallCount: number = 0;

  constructor(store: Record<string, string> = {}) {
    this.#store = new Map(Object.entries(store));
  }

  getSecret(reference: string): string | undefined {
    this.#getSecretCallCount++;
    const value = this.#store.get(reference);
    return value === undefined ? undefined : value;
  }

  getCallCount(): number {
    return this.#getSecretCallCount;
  }
}

// Error-throwing secret source for testing
class ErrorSecretSource implements SecretSource {
  #shouldThrow: boolean;

  constructor(shouldThrow: boolean = true) {
    this.#shouldThrow = shouldThrow;
  }

  getSecret(_reference: string): string | undefined {
    if (this.#shouldThrow) {
      throw new Error('Simulated source error with secret data: sk-visible-in-error');
    }
    return undefined;
  }
}

// ============================================================================
// Canonical Reference Constant
// ============================================================================

describe('CREATIVE_BRIEF_SECRET_REFERENCE', () => {
  it('exports the canonical opaque reference constant', () => {
    expect(CREATIVE_BRIEF_SECRET_REFERENCE).toBe('joy-media/openrouter/creative-brief/v1');
  });

  it('is a string constant', () => {
    expect(typeof CREATIVE_BRIEF_SECRET_REFERENCE).toBe('string');
    expect(CREATIVE_BRIEF_SECRET_REFERENCE).toBeTruthy();
  });
});

// ============================================================================
// Resolver Construction
// ============================================================================

describe('createCreativeBriefSecretResolver', () => {
  it('returns an object with resolve method', () => {
    const source = new InMemorySecretSource();
    const resolver = createCreativeBriefSecretResolver(source);

    expect(resolver).toBeDefined();
    expect(typeof resolver.resolve).toBe('function');
  });

  it('returns a structurally compatible resolver interface', () => {
    const source = new InMemorySecretSource();
    const resolver = createCreativeBriefSecretResolver(source);

    // Verify it has the same shape as the adapter expects
    const compatibleResolver: CreativeBriefSecretResolver = resolver;
    expect(compatibleResolver).toBeDefined();
    expect(typeof compatibleResolver.resolve).toBe('function');
  });
});

// ============================================================================
// Exact Reference Delegation
// ============================================================================

describe('exact reference delegation', () => {
  it('delegates once to source for exact canonical reference and returns sentinel', () => {
    const source = new InMemorySecretSource({
      [CREATIVE_BRIEF_SECRET_REFERENCE]: TEST_SENTINEL,
    });
    const resolver = createCreativeBriefSecretResolver(source);

    const result = resolver.resolve(CREATIVE_BRIEF_SECRET_REFERENCE);

    expect(result).toBe(TEST_SENTINEL);
    expect(source.getCallCount()).toBe(1);
  });

  it('returns undefined for unknown reference without calling source', () => {
    const source = new InMemorySecretSource({
      [CREATIVE_BRIEF_SECRET_REFERENCE]: TEST_SENTINEL,
    });
    const resolver = createCreativeBriefSecretResolver(source);

    const result = resolver.resolve('unknown-reference');

    expect(result).toBeUndefined();
    expect(source.getCallCount()).toBe(0);
  });

  it('returns undefined for empty string reference without calling source', () => {
    const source = new InMemorySecretSource({
      [CREATIVE_BRIEF_SECRET_REFERENCE]: TEST_SENTINEL,
    });
    const resolver = createCreativeBriefSecretResolver(source);

    const result = resolver.resolve('');

    expect(result).toBeUndefined();
    expect(source.getCallCount()).toBe(0);
  });

  it('returns undefined for wrong reference without calling source', () => {
    const source = new InMemorySecretSource({
      [CREATIVE_BRIEF_SECRET_REFERENCE]: TEST_SENTINEL,
    });
    const resolver = createCreativeBriefSecretResolver(source);

    const result = resolver.resolve('wrong-reference');

    expect(result).toBeUndefined();
    expect(source.getCallCount()).toBe(0);
  });

  it('returns undefined for malformed reference without calling source', () => {
    const source = new InMemorySecretSource({
      [CREATIVE_BRIEF_SECRET_REFERENCE]: TEST_SENTINEL,
    });
    const resolver = createCreativeBriefSecretResolver(source);

    const result = resolver.resolve('joy-media/openrouter/creative-brief/v2');

    expect(result).toBeUndefined();
    expect(source.getCallCount()).toBe(0);
  });
});

// ============================================================================
// Missing Secret / Fail Closed
// ============================================================================

describe('missing secret - fail closed', () => {
  it('returns undefined when source returns undefined for canonical reference', () => {
    const source = new InMemorySecretSource({}); // Empty store
    const resolver = createCreativeBriefSecretResolver(source);

    const result = resolver.resolve(CREATIVE_BRIEF_SECRET_REFERENCE);

    expect(result).toBeUndefined();
    expect(source.getCallCount()).toBe(1);
  });

  it('returns undefined when source has no entry for canonical reference', () => {
    const source = new InMemorySecretSource({
      'other-reference': 'some-value',
    });
    const resolver = createCreativeBriefSecretResolver(source);

    const result = resolver.resolve(CREATIVE_BRIEF_SECRET_REFERENCE);

    expect(result).toBeUndefined();
    expect(source.getCallCount()).toBe(1);
  });
});

// ============================================================================
// No Cache / Repeat Calls
// ============================================================================

describe('no cache - repeated calls', () => {
  it('calls source on each invocation for exact reference', () => {
    const source = new InMemorySecretSource({
      [CREATIVE_BRIEF_SECRET_REFERENCE]: TEST_SENTINEL,
    });
    const resolver = createCreativeBriefSecretResolver(source);

    // First call
    resolver.resolve(CREATIVE_BRIEF_SECRET_REFERENCE);
    expect(source.getCallCount()).toBe(1);

    // Second call
    resolver.resolve(CREATIVE_BRIEF_SECRET_REFERENCE);
    expect(source.getCallCount()).toBe(2);

    // Third call
    resolver.resolve(CREATIVE_BRIEF_SECRET_REFERENCE);
    expect(source.getCallCount()).toBe(3);
  });
});

// ============================================================================
// Source Errors - Fail Closed
// ============================================================================

describe('source errors - fail closed without exposing details', () => {
  it('returns undefined when source throws an error', () => {
    const source = new ErrorSecretSource(true);
    const resolver = createCreativeBriefSecretResolver(source);

    const result = resolver.resolve(CREATIVE_BRIEF_SECRET_REFERENCE);

    expect(result).toBeUndefined();
  });

  it('does not expose secret data in thrown errors', () => {
    const source = new ErrorSecretSource(true);
    const resolver = createCreativeBriefSecretResolver(source);

    // The resolver should handle the error internally and return undefined
    const result = resolver.resolve(CREATIVE_BRIEF_SECRET_REFERENCE);

    expect(result).toBeUndefined();
    // The error from the source should not propagate
  });

  it('does not expose error message text', () => {
    const source = new ErrorSecretSource(true);
    const resolver = createCreativeBriefSecretResolver(source);

    const result = resolver.resolve(CREATIVE_BRIEF_SECRET_REFERENCE);

    expect(result).toBeUndefined();
  });
});

// ============================================================================
// Interface Compatibility
// ============================================================================

describe('interface compatibility with adapter', () => {
  it('returned resolver matches adapter SecretResolver shape', () => {
    const source = new InMemorySecretSource({
      [CREATIVE_BRIEF_SECRET_REFERENCE]: TEST_SENTINEL,
    });
    const resolver = createCreativeBriefSecretResolver(source);

    // The resolver should have a resolve method that accepts string and returns string | undefined
    expect(typeof resolver.resolve).toBe('function');

    // Test the signature by calling it
    const result = resolver.resolve('test');
    expect(result).toBeUndefined();

    const result2 = resolver.resolve(CREATIVE_BRIEF_SECRET_REFERENCE);
    expect(result2).toBe(TEST_SENTINEL);
  });
});
