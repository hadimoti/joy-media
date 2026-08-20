import type { SecretSource } from './creative-brief-secret-resolver.js';

export const OPENROUTER_SYSTEMD_CREDENTIAL_ID = 'openrouter-api-key' as const;
export const DEFAULT_SYSTEMD_CREDENTIAL_DIRECTORY =
  '/run/credentials/joy-media@api.service' as const;
export const CREATIVE_BRIEF_OPENROUTER_REF = 'joy-media/openrouter/creative-brief/v1' as const;
export const JOY_CODE_OPENROUTER_REF = 'joy-media/openrouter/joy-code-planner/v1' as const;
export const OPENROUTER_SECRET_REFERENCE_MAP = {
  [CREATIVE_BRIEF_OPENROUTER_REF]: OPENROUTER_SYSTEMD_CREDENTIAL_ID,
  [JOY_CODE_OPENROUTER_REF]: OPENROUTER_SYSTEMD_CREDENTIAL_ID,
} as const;

type ReadCredentialFile = (path: string, encoding: 'utf8') => string;

/** Captures the one encrypted systemd credential at startup and exposes only two code-owned refs. */
export function createOpenRouterSystemdCredentialSource(
  readFile: ReadCredentialFile,
  credentialDirectory: string = DEFAULT_SYSTEMD_CREDENTIAL_DIRECTORY,
  referenceMap: Readonly<Record<string, string>> = OPENROUTER_SECRET_REFERENCE_MAP,
): SecretSource {
  let captured: string | undefined;
  const credentialId =
    referenceMap[CREATIVE_BRIEF_OPENROUTER_REF] ?? referenceMap[JOY_CODE_OPENROUTER_REF];
  if (credentialId === undefined) return { getSecret: () => undefined };
  try {
    const value = readFile(`${credentialDirectory}/${credentialId}`, 'utf8').replace(/\r?\n$/, '');
    if (value.trim() !== '') captured = value;
  } catch {
    captured = undefined;
  }
  return {
    getSecret: (reference: string) =>
      referenceMap[reference] === credentialId ? captured : undefined,
  };
}

export type { ReadCredentialFile };
