import type { SecretSource } from './creative-brief-secret-resolver.js';
import { CREATIVE_BRIEF_SECRET_REFERENCE } from './creative-brief-secret-resolver.js';

/** systemd LoadCredential/LoadCredentialEncrypted credential filename. */
export const OPENROUTER_SYSTEMD_CREDENTIAL_ID = 'openrouter-api-key' as const;

/** Default per-service credential directory used by the JOY Media API unit. */
export const DEFAULT_SYSTEMD_CREDENTIAL_DIRECTORY =
  '/run/credentials/joy-media@api.service' as const;

type ReadCredentialFile = (path: string, encoding: 'utf8') => string;

/**
 * Create a startup-only SecretSource backed by one systemd credential file.
 *
 * The file is read exactly once while creating the source. Request handling
 * only returns the captured opaque value for the one canonical reference; it
 * never accesses the filesystem and never accepts a caller-supplied path.
 */
export function createSystemdCredentialSecretSource(
  readFile: ReadCredentialFile,
  credentialDirectory: string = DEFAULT_SYSTEMD_CREDENTIAL_DIRECTORY,
): SecretSource {
  let capturedSecret: string | undefined;
  try {
    const value = readFile(
      `${credentialDirectory}/${OPENROUTER_SYSTEMD_CREDENTIAL_ID}`,
      'utf8',
    ).replace(/\r?\n$/, '');
    if (value.trim() !== '') {
      capturedSecret = value;
    }
  } catch {
    capturedSecret = undefined;
  }

  return {
    getSecret(reference: string): string | undefined {
      if (reference !== CREATIVE_BRIEF_SECRET_REFERENCE) {
        return undefined;
      }
      return capturedSecret;
    },
  };
}

export type { ReadCredentialFile };
