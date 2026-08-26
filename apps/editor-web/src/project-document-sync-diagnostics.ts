import { BrowserControlPlaneError } from './control-plane-errors.js';

export type ProjectDocumentSyncFailureReason =
  | 'auth-required'
  | 'route-or-method-missing'
  | 'server-unavailable'
  | 'conflict-or-invalid-response';

export interface ProjectDocumentSyncFailure {
  readonly reason: ProjectDocumentSyncFailureReason;
  readonly recoveryHint: string;
}

/** Classify remote failures into safe, coarse diagnostics for rendered UI. */
export function classifyProjectDocumentSyncFailure(error: unknown): ProjectDocumentSyncFailure {
  const code = errorCode(error);
  const status = errorStatus(error);
  if (
    code === 'AUTH_REQUIRED' ||
    code === 'UNAUTHENTICATED' ||
    status === 401 ||
    status === 403 ||
    /session required|sign in|authentication required/i.test(errorMessage(error))
  ) {
    return { reason: 'auth-required', recoveryHint: 'Sign in to resume cloud sync.' };
  }
  if (
    status === 405 ||
    code === 'ROUTE_NOT_FOUND' ||
    code === 'METHOD_NOT_ALLOWED' ||
    code === 'ENDPOINT_NOT_FOUND'
  ) {
    return {
      reason: 'route-or-method-missing',
      recoveryHint: 'Try again after the cloud service is updated.',
    };
  }
  if (
    status === 408 ||
    status === 423 ||
    status === 429 ||
    code === 'RATE_LIMITED' ||
    code === 'REQUEST_TIMEOUT' ||
    code === 'PROJECT_LOCKED' ||
    code === 'PERSISTENCE_PROJECT_LOCKED' ||
    code === 'LOCKED'
  ) {
    return {
      reason: 'server-unavailable',
      recoveryHint: 'Try again shortly; your local work is safe.',
    };
  }
  if (
    code === 'REVISION_CONFLICT' ||
    code === 'IDEMPOTENCY_CONFLICT' ||
    code === 'DOCUMENT_NOT_FOUND' ||
    code === 'REQUEST_INVALID' ||
    status === 409 ||
    status === 422
  ) {
    return {
      reason: 'conflict-or-invalid-response',
      recoveryHint: 'Refresh the project, then try syncing again.',
    };
  }
  return {
    reason: 'server-unavailable',
    recoveryHint: 'Try again shortly; your local work is safe.',
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof BrowserControlPlaneError
    ? error.code
    : typeof error === 'object' && error !== null && 'code' in error
      ? typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined
      : undefined;
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : undefined
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}
