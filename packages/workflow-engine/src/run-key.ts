/** P07 WP-07.1 — canonical serialization and deterministic run keys (§23.5). */

import { sha256Hex } from './sha256.js';

export class CanonicalJsonError extends Error {
  readonly code = 'workflow/non-canonical-value';

  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * Canonical JSON: object keys sorted recursively, arrays kept in order.
 * Rejects values that cannot serialize deterministically (undefined, functions,
 * symbols, bigints, non-finite numbers) instead of silently dropping them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError('non-finite numbers are not canonicalizable');
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`values of type ${typeof value} are not canonicalizable`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const item = record[key];
    if (item === undefined) {
      throw new CanonicalJsonError(`key "${key}" is undefined; omit it instead`);
    }
    parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
  }
  return `{${parts.join(',')}}`;
}

/** §23.5 run-key ingredients: workflow/version, normalized inputs, project revision, settings. */
export interface RunKeyInput {
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly nodeId: string;
  readonly nodeType: string;
  readonly params: unknown;
  /** Outputs of upstream nodes keyed by node id, plus workflow inputs for source nodes. */
  readonly normalizedInputs: unknown;
  readonly projectRevision: string;
  /** Provider/model/workflow version string when a provider participates. */
  readonly providerVersion?: string;
  /** Any additional settings that affect the node's result. */
  readonly settings?: unknown;
}

/** Deterministic sha-256 run key; equal ingredients always produce the equal key. */
export function computeRunKey(input: RunKeyInput): string {
  const canonical = canonicalJson({
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion,
    nodeId: input.nodeId,
    nodeType: input.nodeType,
    params: input.params,
    normalizedInputs: input.normalizedInputs,
    projectRevision: input.projectRevision,
    providerVersion: input.providerVersion ?? null,
    settings: input.settings ?? null,
  });
  return sha256Hex(canonical);
}
