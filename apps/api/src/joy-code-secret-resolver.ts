import type { SecretSource } from './creative-brief-secret-resolver.js';
import { JOY_CODE_OPENROUTER_REF } from './openrouter-systemd-credential-source.js';

export const JOY_CODE_SECRET_REFERENCE = JOY_CODE_OPENROUTER_REF;

export interface JoyCodeSecretResolver {
  resolve(reference: string): string | undefined;
}

export function createJoyCodeSecretResolver(source: SecretSource): JoyCodeSecretResolver {
  return {
    resolve(reference: string): string | undefined {
      if (reference !== JOY_CODE_SECRET_REFERENCE) return undefined;
      try {
        return source.getSecret(reference);
      } catch {
        return undefined;
      }
    },
  };
}
