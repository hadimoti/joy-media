import { CREATIVE_BRIEF_SECRET_REFERENCE } from './creative-brief-secret-resolver.js';
import {
  createOpenRouterSystemdCredentialSource,
  OPENROUTER_SYSTEMD_CREDENTIAL_ID,
  DEFAULT_SYSTEMD_CREDENTIAL_DIRECTORY,
  type ReadCredentialFile,
} from './openrouter-systemd-credential-source.js';
import type { SecretSource } from './creative-brief-secret-resolver.js';

export {
  OPENROUTER_SYSTEMD_CREDENTIAL_ID,
  DEFAULT_SYSTEMD_CREDENTIAL_DIRECTORY,
} from './openrouter-systemd-credential-source.js';

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
  return createOpenRouterSystemdCredentialSource(readFile, credentialDirectory, {
    [CREATIVE_BRIEF_SECRET_REFERENCE]: OPENROUTER_SYSTEMD_CREDENTIAL_ID,
  });
}

export type { ReadCredentialFile };
