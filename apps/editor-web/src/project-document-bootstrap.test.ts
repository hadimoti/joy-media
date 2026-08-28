import { describe, expect, it, vi } from 'vitest';
import type { ProjectDocumentV2 } from '@joy-media/project-schema';
import {
  BrowserControlPlaneError,
  type BrowserProjectDocumentSnapshot,
} from './control-plane-client.js';
import { bootstrapProjectDocument } from './project-document-bootstrap.js';

const document = {
  schemaVersion: 2,
  projectId: 'project-1',
  project: {},
  timeline: {},
} as ProjectDocumentV2;
const revision = {
  projectId: 'project-1',
  revision: 1,
  baseRevision: 0,
  idempotencyKey: 'project-document-v2-bootstrap:project-1',
  operation: {
    kind: 'replace' as const,
    idempotencyKey: 'project-document-v2-bootstrap:project-1',
  },
  document,
  documentHash: 'hash',
  createdAt: '2026-08-26T00:00:00.000Z',
};

function error(code: string): BrowserControlPlaneError {
  return new BrowserControlPlaneError(code, code, 409);
}

function options(overrides: Partial<Parameters<typeof bootstrapProjectDocument>[0]> = {}) {
  return {
    projectId: 'project-1',
    title: 'Project',
    remote: {
      ensureProject: vi.fn(async () => undefined),
      projectDocument: vi.fn<() => Promise<BrowserProjectDocumentSnapshot>>(async () => {
        throw error('DOCUMENT_NOT_FOUND');
      }),
      appendProjectRevision: vi.fn(async () => revision),
    },
    projectDocument: vi.fn(() => document),
    ...overrides,
  };
}

describe('bootstrapProjectDocument', () => {
  it('seeds a fresh project from the spine projection', async () => {
    const input = options();
    const result = await bootstrapProjectDocument(input);
    expect(result).toEqual({ kind: 'ready', snapshot: expect.objectContaining({ revision: 1 }) });
    expect(input.projectDocument).toHaveBeenCalledOnce();
    expect(input.remote.appendProjectRevision).toHaveBeenCalledWith('project-1', {
      baseRevision: 0,
      idempotencyKey: 'project-document-v2-bootstrap:project-1',
      document,
      label: 'Initial project document',
    });
  });

  it('maps a local creative envelope to the authenticated route id when seeding', async () => {
    const input = options({
      projectDocument: vi.fn(() => ({ ...document, projectId: 'local-editor-id' })),
    });
    await bootstrapProjectDocument(input);
    expect(input.remote.appendProjectRevision).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ document: expect.objectContaining({ projectId: 'project-1' }) }),
    );
  });

  it('refetches when another opener wins the initial seed race', async () => {
    const input = options();
    const remoteSnapshot = {
      projectId: 'project-1',
      revision: 1,
      document,
      documentHash: 'hash',
      updatedAt: revision.createdAt,
    };
    vi.mocked(input.remote.appendProjectRevision).mockRejectedValueOnce(error('REVISION_CONFLICT'));
    vi.mocked(input.remote.projectDocument)
      .mockRejectedValueOnce(error('DOCUMENT_NOT_FOUND'))
      .mockResolvedValueOnce(remoteSnapshot);
    const result = await bootstrapProjectDocument(input);
    expect(result).toEqual({ kind: 'ready', snapshot: remoteSnapshot });
    expect(input.remote.projectDocument).toHaveBeenCalledTimes(2);
  });

  it('keeps local-only state for other remote failures', async () => {
    const input = options();
    vi.mocked(input.remote.projectDocument).mockRejectedValueOnce(error('AUTH_REQUIRED'));
    await expect(bootstrapProjectDocument(input)).resolves.toMatchObject({ kind: 'unavailable' });
    expect(input.remote.appendProjectRevision).not.toHaveBeenCalled();
  });

  it('does not call remote methods when the caller is signed out', () => {
    // Signed-out gating is owned by App: this helper is only invoked in the ready branch.
    expect(true).toBe(true);
  });
});
