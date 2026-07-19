/** Coded scene diagnostics — the boundary for untrusted scene packages. */

export interface SceneDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export function sceneDiagnostic(code: string, message: string, path = ''): SceneDiagnostic {
  return { code, message, path };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
