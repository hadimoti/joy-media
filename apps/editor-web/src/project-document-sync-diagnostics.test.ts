import { describe, expect, it } from 'vitest';
import { BrowserControlPlaneError } from './control-plane-errors.js';
import { classifyProjectDocumentSyncFailure } from './project-document-sync-diagnostics.js';

describe('project document sync diagnostics', () => {
  it('classifies remote queue failures without leaking raw error details', () => {
    const result = classifyProjectDocumentSyncFailure(
      new BrowserControlPlaneError('UNKNOWN', 'token=secret project-id=hidden', 500),
    );
    expect(result).toEqual({
      reason: 'server-unavailable',
      recoveryHint: 'Try again shortly; your local work is safe.',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('hidden');
  });

  it.each([
    ['DOCUMENT_NOT_FOUND', 404, 'conflict-or-invalid-response'],
    ['REQUEST_TIMEOUT', 408, 'server-unavailable'],
    ['REVISION_CONFLICT', 409, 'conflict-or-invalid-response'],
    ['ROUTE_NOT_FOUND', 404, 'route-or-method-missing'],
  ] as const)('preserves reviewed semantics for %s', (code, status, reason) => {
    expect(
      classifyProjectDocumentSyncFailure(new BrowserControlPlaneError(code, 'raw', status)),
    ).toMatchObject({ reason });
  });
});
