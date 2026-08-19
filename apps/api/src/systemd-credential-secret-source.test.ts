import { describe, expect, it, vi } from 'vitest';
import { CREATIVE_BRIEF_SECRET_REFERENCE } from './creative-brief-secret-resolver.js';
import {
  DEFAULT_SYSTEMD_CREDENTIAL_DIRECTORY,
  OPENROUTER_SYSTEMD_CREDENTIAL_ID,
  createSystemdCredentialSecretSource,
} from './systemd-credential-secret-source.js';

describe('systemd credential secret source', () => {
  it('reads the canonical credential once at source creation', () => {
    const readFile = vi.fn(() => 'sk-test-secret\n');
    const source = createSystemdCredentialSecretSource(readFile);

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(
      `${DEFAULT_SYSTEMD_CREDENTIAL_DIRECTORY}/${OPENROUTER_SYSTEMD_CREDENTIAL_ID}`,
      'utf8',
    );
    expect(source.getSecret(CREATIVE_BRIEF_SECRET_REFERENCE)).toBe('sk-test-secret');
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('does not delegate unknown references or construct caller-controlled paths', () => {
    const readFile = vi.fn(() => 'sk-test-secret');
    const source = createSystemdCredentialSecretSource(readFile);

    expect(source.getSecret('other/ref')).toBeUndefined();
    expect(source.getSecret('../openrouter-api-key')).toBeUndefined();
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('supports an injected credential directory without accepting a reference path', () => {
    const readFile = vi.fn(() => 'sk-test-secret');
    const source = createSystemdCredentialSecretSource(readFile, '/run/credentials/test-service');

    expect(readFile).toHaveBeenCalledWith(
      '/run/credentials/test-service/openrouter-api-key',
      'utf8',
    );
    expect(source.getSecret(CREATIVE_BRIEF_SECRET_REFERENCE)).toBe('sk-test-secret');
  });

  it('fails closed when the credential is missing or unreadable', () => {
    const source = createSystemdCredentialSecretSource(() => {
      throw new Error('permission denied');
    });

    expect(source.getSecret(CREATIVE_BRIEF_SECRET_REFERENCE)).toBeUndefined();
  });

  it('treats an empty credential as unavailable', () => {
    const source = createSystemdCredentialSecretSource(() => ' \n\t');

    expect(source.getSecret(CREATIVE_BRIEF_SECRET_REFERENCE)).toBeUndefined();
  });
});
