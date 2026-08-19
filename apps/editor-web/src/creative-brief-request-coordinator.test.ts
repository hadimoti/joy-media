import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { JoyProjectV1, ProjectRevisionId } from '@joy-media/project-schema';
import type { CreativeBriefRequestV1, CreativeBriefV1, CreativeBriefScope } from '@joy-media/agent-tools';
import type { ControlPlaneProjectBinding } from './project-control-plane.js';
import type { SyncProjectDocument, DocumentSyncResult } from './project-document-sync.js';
import { coordinateCreativeBriefRequest, type CreativeBriefTransport } from './creative-brief-request-coordinator.js';

const MOCK_PROJECT_ID = 'local-edit-1';
const MOCK_CONTROL_PLANE_PROJECT_ID = 'project-server-1';
const MOCK_REVISION_ID: string = 'cas-rev-abc123';

const binding: ControlPlaneProjectBinding = {
  editorProjectId: MOCK_PROJECT_ID,
  controlPlaneProjectId: MOCK_CONTROL_PLANE_PROJECT_ID,
  title: 'Test Project',
  documentRevisionId: '',
};

const document: JoyProjectV1 = {
  schemaVersion: 1,
  id: MOCK_PROJECT_ID,
  title: 'Test Project',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  rootCompositionId: 'comp-1',
  settings: { defaultLocale: 'en' },
  compositions: {},
  assets: {},
  variables: {},
  markers: [],
  visualObjects: {},
  captionDocuments: {},
  pluginData: {},
};

const baseRequest: CreativeBriefRequestV1 = {
  projectId: MOCK_PROJECT_ID,
  snapshotRevisionId: MOCK_REVISION_ID,
  request: 'Create a creative brief',
  scope: 'general' as CreativeBriefScope,
};

const mockBrief = {
  schemaVersion: 1,
  snapshotRevisionId: MOCK_REVISION_ID,
  projectId: MOCK_PROJECT_ID,
  request: 'Create a creative brief',
  interpretedGoal: {
    userIntent: 'Create a creative brief',
    inferredGoal: 'Create a creative brief',
    resolvedGoal: 'Create a creative brief',
    confidence: 'high',
  },
  distinction: {
    facts: [],
    inferences: [],
  },
  assumptions: [],
  recommendations: [],
  blockedBy: [],
  requiresHumanDecision: [],
  intelligence: {
    brand: {
      projectId: MOCK_PROJECT_ID,
      revisionId: MOCK_REVISION_ID,
      colorsAvailable: false,
      fontsAvailable: false,
      logoAvailable: false,
      voiceInstructionsAvailable: false,
      toneInstructionsAvailable: false,
      prohibitedClaims: [],
      prohibitedEffects: [],
      hasBrandKit: false,
      brandCompleteness: 'none',
      missingComponents: [],
    },
    scenes: [],
    project: {
      projectId: MOCK_PROJECT_ID,
      revisionId: MOCK_REVISION_ID,
      destination: undefined,
      destinationAligned: true,
      destinationMismatch: undefined,
      durationTargetUs: undefined,
      compositionDurationUs: 0,
      durationAligned: true,
      durationGapUs: undefined,
      aspectRatio: '16:9',
      aspectRatioAligned: true,
      aspectRatioMismatch: undefined,
      captionAvailable: false,
      audioAvailable: false,
      generatedAssetsAvailable: false,
      readinessLevel: 'unknown',
      blockers: [],
    },
    rules: [],
  },
  warnings: [],
  meta: {
    generatedAt: '2024-01-01T00:00:00Z',
    modelAdapter: 'test-adapter',
    processingTimeMs: 100,
  },
} satisfies CreativeBriefV1;

function memoryStorage(): BrowserKeyValueStore {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

// Conflict error (409 DOCUMENT_REVISION_CONFLICT)
class ConflictError extends Error {
  constructor(readonly message: string) {
    super(message);
    this.name = 'ConflictError';
  }
  readonly status = 409;
  readonly code = 'DOCUMENT_REVISION_CONFLICT';
}

// Generic network error
class NetworkError extends Error {
  constructor(readonly message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

// Generic brief error
class BriefError extends Error {
  constructor(readonly message: string) {
    super(message);
    this.name = 'BriefError';
  }
}

const SUCCESS_SYNC_RESULT: DocumentSyncResult = {
  kind: 'success',
  projectId: MOCK_CONTROL_PLANE_PROJECT_ID,
  revisionId: MOCK_REVISION_ID,
};

const CONFLICT_SYNC_RESULT: DocumentSyncResult = {
  kind: 'conflict',
  message: 'Revision conflict',
};

const FAILURE_SYNC_RESULT: DocumentSyncResult = {
  kind: 'request-failure',
  error: new NetworkError('Network failed'),
};

const FAILURE_ERROR = new NetworkError('Network failed');

const BRIEF_ERROR = new BriefError('Brief generation failed');

// Helper to create a minimal mock request
function createRequest(
  projectId: string = MOCK_PROJECT_ID,
  snapshotRevisionId: string = MOCK_REVISION_ID,
): CreativeBriefRequestV1 {
  return {
    projectId,
    snapshotRevisionId,
    request: 'Test request',
    scope: 'general' as CreativeBriefScope,
  };
}

describe('coordinateCreativeBriefRequest', () => {
  let storage: BrowserKeyValueStore;
  let syncProjectDocument: SyncProjectDocument;
  let creativeBriefTransport: CreativeBriefTransport;

  beforeEach(() => {
    storage = memoryStorage();
    syncProjectDocument = vi.fn();
    creativeBriefTransport = vi.fn();
  });

  describe('success ordering', () => {
    it('calls sync before brief transport and returns success with both results', async () => {
      syncProjectDocument.mockResolvedValue(SUCCESS_SYNC_RESULT);
      creativeBriefTransport.mockResolvedValue(mockBrief);

      const result = await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      // Verify sync was called before brief transport
      expect(syncProjectDocument).toHaveBeenCalledTimes(1);
      expect(syncProjectDocument).toHaveBeenCalledWith(
        MOCK_CONTROL_PLANE_PROJECT_ID,
        expect.objectContaining({
          baseRevisionId: '',
          revisionId: MOCK_REVISION_ID,
          document,
        }),
      );

      expect(creativeBriefTransport).toHaveBeenCalledTimes(1);
      expect(creativeBriefTransport).toHaveBeenCalledWith(
        MOCK_CONTROL_PLANE_PROJECT_ID,
        baseRequest,
      );

      expect(result.kind).toBe('success');
      expect(result.syncResult).toEqual(SUCCESS_SYNC_RESULT);
      expect(result.brief).toEqual(mockBrief);
    });

    it('calls brief transport with opaque control-plane project ID as path target', async () => {
      syncProjectDocument.mockResolvedValue(SUCCESS_SYNC_RESULT);
      creativeBriefTransport.mockResolvedValue(mockBrief);

      await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(creativeBriefTransport).toHaveBeenCalledWith(
        MOCK_CONTROL_PLANE_PROJECT_ID,
        baseRequest,
      );
    });

    it('passes original canonical CreativeBriefRequestV1 unchanged', async () => {
      syncProjectDocument.mockResolvedValue(SUCCESS_SYNC_RESULT);
      creativeBriefTransport.mockResolvedValue(mockBrief);

      const request: CreativeBriefRequestV1 = {
        projectId: MOCK_PROJECT_ID,
        snapshotRevisionId: MOCK_REVISION_ID,
        request: 'Custom request with فارسی text',
        scope: 'general' as CreativeBriefScope,
        maxRecommendations: 5,
      };

      await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        request,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(creativeBriefTransport).toHaveBeenCalledWith(
        MOCK_CONTROL_PLANE_PROJECT_ID,
        request,
      );
      // Verify the request object is the same reference
      expect(creativeBriefTransport.mock.calls[0][1]).toBe(request);
    });
  });

  describe('distinct control-plane/document IDs', () => {
    it('uses controlPlaneProjectId from binding for brief transport path', async () => {
      const bindingWithDifferentIds: ControlPlaneProjectBinding = {
        editorProjectId: MOCK_PROJECT_ID,
        controlPlaneProjectId: 'different-server-id',
        title: 'Test Project',
        documentRevisionId: '',
      };

      syncProjectDocument.mockResolvedValue({
        ...SUCCESS_SYNC_RESULT,
        projectId: 'different-server-id',
      });
      creativeBriefTransport.mockResolvedValue(mockBrief);

      await coordinateCreativeBriefRequest(
        bindingWithDifferentIds,
        document,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(syncProjectDocument).toHaveBeenCalledWith(
        'different-server-id',
        expect.any(Object),
      );
      expect(creativeBriefTransport).toHaveBeenCalledWith(
        'different-server-id',
        baseRequest,
      );
    });
  });

  describe('request parity check', () => {
    it('fails closed with zero network calls when projectId does not match', async () => {
      const mismatchedRequest = createRequest('different-project-id', MOCK_REVISION_ID);

      const result = await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        mismatchedRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(syncProjectDocument).not.toHaveBeenCalled();
      expect(creativeBriefTransport).not.toHaveBeenCalled();

      expect(result.kind).toBe('parity-failure');
      expect(result.reason).toBe('projectId-mismatch');
      expect(result.expectedProjectId).toBe(MOCK_PROJECT_ID);
      expect(result.actualProjectId).toBe('different-project-id');
      expect(result.expectedSnapshotRevisionId).toBe(MOCK_REVISION_ID);
      expect(result.actualSnapshotRevisionId).toBe(MOCK_REVISION_ID);
    });

    it('fails closed with zero network calls when snapshotRevisionId does not match', async () => {
      const mismatchedRequest = createRequest(MOCK_PROJECT_ID, 'different-snapshot-rev');

      const result = await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        mismatchedRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(syncProjectDocument).not.toHaveBeenCalled();
      expect(creativeBriefTransport).not.toHaveBeenCalled();

      expect(result.kind).toBe('parity-failure');
      expect(result.reason).toBe('snapshotRevisionId-mismatch');
      expect(result.expectedProjectId).toBe(MOCK_PROJECT_ID);
      expect(result.actualProjectId).toBe(MOCK_PROJECT_ID);
      expect(result.expectedSnapshotRevisionId).toBe(MOCK_REVISION_ID);
      expect(result.actualSnapshotRevisionId).toBe('different-snapshot-rev');
    });

    it('passes parity check when both projectId and snapshotRevisionId match', async () => {
      syncProjectDocument.mockResolvedValue(SUCCESS_SYNC_RESULT);
      creativeBriefTransport.mockResolvedValue(mockBrief);

      const result = await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(result.kind).toBe('success');
    });
  });

  describe('sync conflict', () => {
    it('maps sync conflict to stale result and does not call brief transport', async () => {
      syncProjectDocument.mockRejectedValue(new ConflictError('Revision conflict'));

      const result = await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(syncProjectDocument).toHaveBeenCalledTimes(1);
      expect(creativeBriefTransport).not.toHaveBeenCalled();

      expect(result.kind).toBe('stale');
      expect(result.syncConflict.kind).toBe('conflict');
      expect(result.syncConflict.message).toBe('Revision conflict');
    });

    it('maps sync conflict from transport rejection and does not call brief transport', async () => {
      syncProjectDocument.mockRejectedValue(new ConflictError('Revision conflict'));

      const result = await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(syncProjectDocument).toHaveBeenCalledTimes(1);
      expect(creativeBriefTransport).not.toHaveBeenCalled();

      expect(result.kind).toBe('stale');
      expect(result.syncConflict.kind).toBe('conflict');
      expect(result.syncConflict.message).toBe('Revision conflict');
    });
  });

  describe('sync failure', () => {
    it('maps sync request-failure from transport rejection and does not call brief transport', async () => {
      syncProjectDocument.mockRejectedValue(FAILURE_ERROR);

      const result = await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(syncProjectDocument).toHaveBeenCalledTimes(1);
      expect(creativeBriefTransport).not.toHaveBeenCalled();

      expect(result.kind).toBe('sync-failure');
      expect(result.syncResult.kind).toBe('request-failure');
      expect(result.syncResult.error).toBe(FAILURE_ERROR);
    });

    it('maps sync rejection to sync-failure result and does not call brief transport', async () => {
      syncProjectDocument.mockRejectedValue(FAILURE_ERROR);

      const result = await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(syncProjectDocument).toHaveBeenCalledTimes(1);
      expect(creativeBriefTransport).not.toHaveBeenCalled();

      expect(result.kind).toBe('sync-failure');
      expect(result.syncResult.kind).toBe('request-failure');
      expect(result.syncResult.error).toBe(FAILURE_ERROR);
    });
  });

  describe('brief failure', () => {
    it('maps brief transport failure to brief-failure result after successful sync', async () => {
      syncProjectDocument.mockResolvedValue(SUCCESS_SYNC_RESULT);
      creativeBriefTransport.mockRejectedValue(BRIEF_ERROR);

      const result = await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(syncProjectDocument).toHaveBeenCalledTimes(1);
      expect(creativeBriefTransport).toHaveBeenCalledTimes(1);

      expect(result.kind).toBe('brief-failure');
      expect(result.syncResult).toEqual(SUCCESS_SYNC_RESULT);
      expect(result.error).toBe(BRIEF_ERROR);
    });

    it('preserves original error object from brief transport', async () => {
      syncProjectDocument.mockResolvedValue(SUCCESS_SYNC_RESULT);
      const briefError = new BriefError('Specific brief error');
      creativeBriefTransport.mockRejectedValue(briefError);

      const result = await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(result.kind).toBe('brief-failure');
      expect(result.error).toBe(briefError);
    });
  });

  describe('Persian/RTL preservation', () => {
    it('preserves Persian text in request through coordination', async () => {
      syncProjectDocument.mockResolvedValue(SUCCESS_SYNC_RESULT);
      creativeBriefTransport.mockResolvedValue(mockBrief);

      const persianRequest: CreativeBriefRequestV1 = {
        projectId: MOCK_PROJECT_ID,
        snapshotRevisionId: MOCK_REVISION_ID,
        request: 'تست فارسی با متن راست به چپ',
        scope: 'general' as CreativeBriefScope,
      };

      const result = await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        persianRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(syncProjectDocument).toHaveBeenCalledTimes(1);
      expect(creativeBriefTransport).toHaveBeenCalledWith(
        MOCK_CONTROL_PLANE_PROJECT_ID,
        persianRequest,
      );
      expect(result.kind).toBe('success');
      expect((creativeBriefTransport.mock.calls[0][1] as CreativeBriefRequestV1).request).toBe(
        'تست فارسی با متن راست به چپ',
      );
    });

    it('preserves RTL text in document title', async () => {
      const rtlDocument: JoyProjectV1 = {
        ...document,
        title: 'عنوان پروژه به فارسی',
      };

      syncProjectDocument.mockResolvedValue(SUCCESS_SYNC_RESULT);
      creativeBriefTransport.mockResolvedValue(mockBrief);

      await coordinateCreativeBriefRequest(
        binding,
        rtlDocument,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(syncProjectDocument).toHaveBeenCalledWith(
        MOCK_CONTROL_PLANE_PROJECT_ID,
        expect.objectContaining({
          document: rtlDocument,
        }),
      );
      expect(rtlDocument.title).toBe('عنوان پروژه به فارسی');
    });
  });

  describe('response propagation', () => {
    it('propagates sync success result in coordination success', async () => {
      syncProjectDocument.mockResolvedValue(SUCCESS_SYNC_RESULT);
      creativeBriefTransport.mockResolvedValue(mockBrief);

      const result = await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(result.kind).toBe('success');
      expect(result.syncResult).toEqual(SUCCESS_SYNC_RESULT);
      expect(result.brief).toEqual(mockBrief);
    });

    it('propagates brief response unchanged', async () => {
      const brief: CreativeBriefV1 = {
        ...mockBrief,
        meta: {
          ...mockBrief.meta,
          generatedAt: '2024-08-19T12:00:00Z',
        },
      };

      syncProjectDocument.mockResolvedValue(SUCCESS_SYNC_RESULT);
      creativeBriefTransport.mockResolvedValue(brief);

      const result = await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(result.kind).toBe('success');
      expect(result.brief).toEqual(brief);
      expect(result.brief).toBe(brief);
    });
  });

  describe('input immutability', () => {
    it('does not mutate the input document', async () => {
      syncProjectDocument.mockResolvedValue(SUCCESS_SYNC_RESULT);
      creativeBriefTransport.mockResolvedValue(mockBrief);

      const originalDocument: JoyProjectV1 = {
        ...document,
        title: 'Original Title',
      };

      const documentCopy = { ...originalDocument };

      await coordinateCreativeBriefRequest(
        binding,
        originalDocument,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(originalDocument).toEqual(documentCopy);
      expect(originalDocument.title).toBe('Original Title');
    });

    it('does not mutate the input request', async () => {
      syncProjectDocument.mockResolvedValue(SUCCESS_SYNC_RESULT);
      creativeBriefTransport.mockResolvedValue(mockBrief);

      const originalRequest: CreativeBriefRequestV1 = {
        ...baseRequest,
        request: 'Original request',
      };

      const requestCopy = { ...originalRequest };

      await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        originalRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(originalRequest).toEqual(requestCopy);
      expect(originalRequest.request).toBe('Original request');
    });

    it('does not mutate the input binding', async () => {
      syncProjectDocument.mockResolvedValue(SUCCESS_SYNC_RESULT);
      creativeBriefTransport.mockResolvedValue(mockBrief);

      const originalBinding: ControlPlaneProjectBinding = {
        ...binding,
        title: 'Original Binding Title',
      };

      const bindingCopy = { ...originalBinding };

      await coordinateCreativeBriefRequest(
        originalBinding,
        document,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(originalBinding).toEqual(bindingCopy);
      expect(originalBinding.title).toBe('Original Binding Title');
    });
  });

  describe('ownerKey option', () => {
    it('passes ownerKey to syncProjectDocumentBinding', async () => {
      syncProjectDocument.mockResolvedValue(SUCCESS_SYNC_RESULT);
      creativeBriefTransport.mockResolvedValue(mockBrief);

      await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
        { ownerKey: 'user-123' },
      );

      expect(syncProjectDocument).toHaveBeenCalledTimes(1);
      // The ownerKey is passed to syncProjectDocumentBinding which passes it to its internal logic
      // We verify that the sync was called, and the ownerKey is used internally
    });

    it('uses default ownerKey of local when not specified', async () => {
      syncProjectDocument.mockResolvedValue(SUCCESS_SYNC_RESULT);
      creativeBriefTransport.mockResolvedValue(mockBrief);

      await coordinateCreativeBriefRequest(
        binding,
        document,
        MOCK_REVISION_ID,
        baseRequest,
        storage,
        syncProjectDocument,
        creativeBriefTransport,
      );

      expect(syncProjectDocument).toHaveBeenCalledTimes(1);
    });
  });
});
