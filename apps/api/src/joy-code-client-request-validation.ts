import { validateCreativeBrief, type CreativeBriefV1 } from '@joy-media/agent-tools';

export const MAX_JOY_CODE_PROMPT_BYTES = 64 * 1024;
export const MAX_JOY_CODE_PROMPT_CHARS = 20_000;
export const MAX_JOY_CODE_SELECTION_IDS = 24;
export interface JoyCodeClientRequestEnvelope {
  readonly projectId: string;
  readonly snapshotRevisionId: string;
  readonly prompt: string;
  readonly creativeBrief?: CreativeBriefV1;
  readonly selection: {
    readonly clipIds: readonly string[];
    readonly objectIds?: readonly string[];
  };
}
export interface JoyCodeClientValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function validateJoyCodeClientRequest(value: unknown): JoyCodeClientValidationResult {
  const errors: string[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { valid: false, errors: ['envelope must be an object'] };
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_JOY_CODE_PROMPT_BYTES)
      errors.push('envelope too large');
  } catch {
    errors.push('envelope malformed');
  }
  const envelope = value as Record<string, unknown>;
  const keys = Object.keys(envelope);
  if (
    keys.some(
      (key) =>
        !['projectId', 'snapshotRevisionId', 'prompt', 'creativeBrief', 'selection'].includes(key),
    )
  )
    errors.push('unknown or forbidden envelope field');
  for (const key of ['projectId', 'snapshotRevisionId', 'prompt'])
    if (typeof envelope[key] !== 'string' || (envelope[key] as string).trim() === '')
      errors.push(`${key} must be non-empty`);
  if (typeof envelope.prompt === 'string' && envelope.prompt.length > MAX_JOY_CODE_PROMPT_CHARS)
    errors.push('prompt too large');
  if (containsForbidden(String(envelope.prompt ?? '')))
    errors.push('prompt contains forbidden data');
  if (envelope.creativeBrief !== undefined) {
    const validation = validateCreativeBrief(envelope.creativeBrief);
    if (!validation.valid) errors.push('creativeBrief invalid');
    else {
      const brief = envelope.creativeBrief as unknown as Record<string, unknown>;
      if (brief.projectId !== envelope.projectId)
        errors.push('creativeBrief projectId does not match projectId');
      if (brief.snapshotRevisionId !== envelope.snapshotRevisionId)
        errors.push('creativeBrief snapshotRevisionId does not match snapshotRevisionId');
    }
  }
  const selection = envelope.selection;
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection))
    errors.push('selection must be an object');
  else {
    const selectionRecord = selection as Record<string, unknown>;
    if (Object.keys(selectionRecord).some((key) => !['clipIds', 'objectIds'].includes(key)))
      errors.push('selection contains unknown fields');
    for (const key of ['clipIds', 'objectIds']) {
      const ids = selectionRecord[key];
      if (ids === undefined && key === 'objectIds') continue;
      if (
        !Array.isArray(ids) ||
        ids.length > MAX_JOY_CODE_SELECTION_IDS ||
        ids.some((id) => typeof id !== 'string' || id.trim() === '' || containsForbidden(id))
      )
        errors.push(`${key} invalid`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function isValidJoyCodeClientRequest(value: unknown): value is JoyCodeClientRequestEnvelope {
  return validateJoyCodeClientRequest(value).valid;
}

function containsForbidden(value: string): boolean {
  return /(?:https?|ftp):\/\/|(?:^|[\\/])\.\.?[\\/]|(?:^|\s)(?:sk|pk)-[A-Za-z0-9_-]{8,}|bearer\s|authorization\s*:|(?:password|secret|token|api[_-]?key)\s*=/i.test(
    value,
  );
}
