import type { SecretStore } from './types.js';

export function createMemorySecretStore(): SecretStore {
  const secrets = new Map<string, string>();

  return {
    async set(handleId: string, value: string): Promise<void> {
      secrets.set(handleId, value);
    },

    async get(handleId: string): Promise<string | null> {
      return secrets.get(handleId) ?? null;
    },

    async delete(handleId: string): Promise<void> {
      secrets.delete(handleId);
    },

    redact(logLine: string, _providerId: string): string {
      let result = logLine;
      for (const value of secrets.values()) {
        if (value.length > 0) {
          result = result.replaceAll(value, '***REDACTED***');
        }
      }
      return result;
    },
  };
}
