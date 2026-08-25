import type { AgentHostManifest } from './types.js';

export interface AgentHostManifestValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

const EMBEDDED_SECRET_FIELD = /^(api[-_]?key|access[-_]?token|password|secret|credential)$/i;

/**
 * Validates the stable host boundary and rejects credential-shaped fields.
 * Secret references are identifiers only; raw credentials must be resolved by
 * the server transport at invocation time.
 */
export function validateAgentHostManifest(manifest: unknown): AgentHostManifestValidation {
  if (typeof manifest !== 'object' || manifest === null) {
    return { valid: false, errors: ['Manifest must be an object'] };
  }

  const value = manifest as Partial<AgentHostManifest>;
  const errors: string[] = [];

  if (value.manifestVersion !== 1) errors.push('manifestVersion must be 1');
  if (value.kind !== 'agent-host') errors.push('kind must be agent-host');
  if (!value.id) errors.push('id must be a non-empty string');
  if (!value.displayName) errors.push('displayName must be a non-empty string');
  if (!value.adapterVersion) errors.push('adapterVersion must be a non-empty string');
  if (value.transport !== 'code-server-extension') {
    errors.push('transport must be code-server-extension');
  }
  if (!Array.isArray(value.tools)) errors.push('tools must be an array');
  if (!Array.isArray(value.reasoningModels)) errors.push('reasoningModels must be an array');
  if (!Array.isArray(value.mediaProviders)) errors.push('mediaProviders must be an array');
  if (!Array.isArray(value.localExecutors)) errors.push('localExecutors must be an array');
  if (!value.health || value.health.strategy !== 'extension-heartbeat') {
    errors.push('health must use extension-heartbeat');
  }
  if (!value.cancellation || typeof value.cancellation.supported !== 'boolean') {
    errors.push('cancellation support must be declared');
  }
  if (!value.costReporting || typeof value.costReporting.supported !== 'boolean') {
    errors.push('cost reporting support must be declared');
  }
  if (!value.settings || !Array.isArray(value.settings.secretReferences)) {
    errors.push('settings.secretReferences must be an array');
  } else if (
    value.settings.secretReferences.some((reference) => reference.scope !== 'server-only')
  ) {
    errors.push('all secret references must be server-only');
  }

  findEmbeddedSecretFields(manifest, '$', errors);
  return { valid: errors.length === 0, errors };
}

function findEmbeddedSecretFields(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findEmbeddedSecretFields(item, `${path}[${index}]`, errors));
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  for (const [key, child] of Object.entries(value)) {
    if (EMBEDDED_SECRET_FIELD.test(key)) {
      errors.push(`${path}.${key} must be a server-only secret reference, not an embedded value`);
    }
    findEmbeddedSecretFields(child, `${path}.${key}`, errors);
  }
}
