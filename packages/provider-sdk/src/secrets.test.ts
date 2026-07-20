import { describe, expect, it } from 'vitest';
import { createMemorySecretStore } from './secrets.js';

describe('createMemorySecretStore', () => {
  it('stores and retrieves secrets', async () => {
    const store = createMemorySecretStore();
    await store.set('handle-1', 'secret-value-1');
    const value = await store.get('handle-1');
    expect(value).toBe('secret-value-1');
  });

  it('returns null for non-existent secrets', async () => {
    const store = createMemorySecretStore();
    const value = await store.get('non-existent');
    expect(value).toBeNull();
  });

  it('deletes secrets', async () => {
    const store = createMemorySecretStore();
    await store.set('handle-1', 'secret-value-1');
    await store.delete('handle-1');
    const value = await store.get('handle-1');
    expect(value).toBeNull();
  });

  it('overwrites existing secrets', async () => {
    const store = createMemorySecretStore();
    await store.set('handle-1', 'old-value');
    await store.set('handle-1', 'new-value');
    const value = await store.get('handle-1');
    expect(value).toBe('new-value');
  });

  it('redacts secrets from log lines', async () => {
    const store = createMemorySecretStore();
    await store.set('handle-1', 'my-api-key');
    await store.set('handle-2', 'another-secret');

    const logLine = 'Error: Failed to authenticate with key my-api-key and token another-secret';
    const redacted = store.redact(logLine, 'any-provider');

    expect(redacted).not.toContain('my-api-key');
    expect(redacted).not.toContain('another-secret');
    expect(redacted).toContain('***REDACTED***');
  });

  it('does not redact empty strings', async () => {
    const store = createMemorySecretStore();
    await store.set('handle-1', '');

    const logLine = 'Log with no secrets';
    const redacted = store.redact(logLine, 'any-provider');

    expect(redacted).toBe(logLine);
  });

  it('handles multiple occurrences of the same secret', async () => {
    const store = createMemorySecretStore();
    await store.set('handle-1', 'secret');

    const logLine = 'First secret and second secret appear here';
    const redacted = store.redact(logLine, 'any-provider');

    expect(redacted).toBe('First ***REDACTED*** and second ***REDACTED*** appear here');
  });

  it('redacts all secrets regardless of providerId', async () => {
    const store = createMemorySecretStore();
    await store.set('handle-1', 'secret1');
    await store.set('handle-2', 'secret2');

    const logLine = 'Contains secret1 and secret2';
    const redacted = store.redact(logLine, 'specific-provider');

    expect(redacted).not.toContain('secret1');
    expect(redacted).not.toContain('secret2');
  });
});
