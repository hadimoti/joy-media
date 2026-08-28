import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { JoyProjectV1, ProjectRevisionId } from '@joy-media/project-schema';
import type {
  CreativeBriefRequestV1,
  CreativeBriefV1,
  CreativeBriefScope,
} from '@joy-media/agent-tools';
import type { ControlPlaneProjectBinding } from './project-control-plane.js';
import type { SyncProjectDocument } from './project-document-sync.js';
import {
  createCreativeBriefPanelRunner,
  type CreativeBriefTransport,
  type CreativeBriefRequestFactory,
} from './creative-brief-panel-runner.js';

// Test constants
const MOCK_PROJECT_ID = 'local-edit-1';
const MOCK_CONTROL_PLANE_PROJECT_ID = 'project-server-1';
const MOCK_REVISION_ID: ProjectRevisionId = 'cas-rev-abc123';
const MOCK_OWNER_KEY = 'test-owner';

// Mock binding
const mockBinding: ControlPlaneProjectBinding = {
  editorProjectId: MOCK_PROJECT_ID,
  controlPlaneProjectId: MOCK_CONTROL_PLANE_PROJECT_ID,
  title: 'Test Project',
  documentRevisionId: '',
};

// Mock project
const mockProject: JoyProjectV1 = {
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

// Mock brief
const mockBrief: CreativeBriefV1 = {
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
      warnings: [],
      evidence: [],
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
      warnings: [],
      sceneCount: 0,
      scenesWithVisuals: 0,
      scenesWithAudio: 0,
      scenesWithCaptions: 0,
      evidence: [],
    },
    rules: [],
  },
  warnings: [],
  meta: {
    generatedAt: '2024-01-01T00:00:00Z',
    modelAdapter: 'test-adapter',
    processingTimeMs: 100,
  },
};

// Mock storage
const mockStorage = {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
} satisfies BrowserKeyValueStore;

// Mock sync transport that succeeds
const createMockSyncTransportSuccess = (): SyncProjectDocument => {
  return vi.fn().mockImplementation((_controlPlaneProjectId: string, _params) => {
    return Promise.resolve({
      projectId: MOCK_CONTROL_PLANE_PROJECT_ID,
      revisionId: MOCK_REVISION_ID,
    });
  });
};

// Mock sync transport that fails with a generic error
const createMockSyncTransportFailure = (error: unknown): SyncProjectDocument => {
  return vi.fn().mockRejectedValue(error);
};

// Mock sync transport that returns a 409 conflict error
const createMockSyncTransportConflict = (): SyncProjectDocument => {
  return vi.fn().mockRejectedValue({
    status: 409,
    code: 'DOCUMENT_REVISION_CONFLICT',
    message: 'Revision conflict',
  });
};

// Mock brief transport that succeeds
const createMockBriefTransportSuccess = (
  brief: CreativeBriefV1 = mockBrief,
): CreativeBriefTransport => {
  return vi
    .fn()
    .mockImplementation((_controlPlaneProjectId: string, _request: CreativeBriefRequestV1) => {
      return Promise.resolve(brief);
    });
};

// Mock brief transport that fails
const createMockBriefTransportFailure = (error: unknown): CreativeBriefTransport => {
  return vi.fn().mockRejectedValue(error);
};

// Mock request factory
const createMockRequestFactory = () => {
  const state = {
    lastCall: null as { text: string; projectId: string; revisionId: ProjectRevisionId } | null,
  };
  const factory: CreativeBriefRequestFactory = (text, projectId, revisionId) => {
    state.lastCall = { text, projectId, revisionId };
    return {
      projectId,
      snapshotRevisionId: revisionId,
      request: text,
      scope: 'general' as CreativeBriefScope,
    };
  };
  return {
    factory,
    get lastCall() {
      return state.lastCall;
    },
  };
};

// Mock request factory that produces mismatched projectId
const createBadProjectIdRequestFactory = (): CreativeBriefRequestFactory => {
  return () => ({
    projectId: 'wrong-project-id',
    snapshotRevisionId: MOCK_REVISION_ID,
    request: 'test',
    scope: 'general' as CreativeBriefScope,
  });
};

// Mock request factory that produces mismatched revisionId
const createBadRevisionIdRequestFactory = (): CreativeBriefRequestFactory => {
  return () => ({
    projectId: MOCK_PROJECT_ID,
    snapshotRevisionId: 'wrong-revision-id' as ProjectRevisionId,
    request: 'test',
    scope: 'general' as CreativeBriefScope,
  });
};

describe('createCreativeBriefPanelRunner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockStorage.getItem.mockReset().mockReturnValue(null);
    mockStorage.setItem.mockReset();
    mockStorage.removeItem.mockReset();
  });

  describe('blank input', () => {
    it('should reject with blank-input error for empty string', async () => {
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createMockRequestFactory().factory,
      });

      await expect(runner('')).rejects.toMatchObject({
        details: {
          kind: 'blank-input',
          reason: 'Input is blank after trimming',
        },
      });
    });

    it('should reject with blank-input error for whitespace-only string', async () => {
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createMockRequestFactory().factory,
      });

      await expect(runner('   ')).rejects.toMatchObject({
        details: {
          kind: 'blank-input',
          reason: 'Input is blank after trimming',
        },
      });
    });

    it('should reject with blank-input error for tabs and newlines only', async () => {
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createMockRequestFactory().factory,
      });

      await expect(runner('\t\n  \r')).rejects.toMatchObject({
        details: {
          kind: 'blank-input',
          reason: 'Input is blank after trimming',
        },
      });
    });

    it('should not call request factory for blank input', async () => {
      const mockFactory = createMockRequestFactory();
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: mockFactory.factory,
      });

      await expect(runner('')).rejects.toMatchObject({ details: { kind: 'blank-input' } });
      expect(mockFactory.lastCall).toBeNull();
    });

    it('should not call sync for blank input', async () => {
      const syncProjectDocument = vi.fn();
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument,
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createMockRequestFactory().factory,
      });

      await expect(runner('')).rejects.toMatchObject({ details: { kind: 'blank-input' } });
      expect(syncProjectDocument).not.toHaveBeenCalled();
    });

    it('should not call brief transport for blank input', async () => {
      const creativeBriefTransport = vi.fn();
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport,
        requestFactory: createMockRequestFactory().factory,
      });

      await expect(runner('')).rejects.toMatchObject({ details: { kind: 'blank-input' } });
      expect(creativeBriefTransport).not.toHaveBeenCalled();
    });
  });

  describe('request factory arguments', () => {
    it('should call request factory with trimmed text', async () => {
      const mockFactory = createMockRequestFactory();
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: mockFactory.factory,
      });

      await runner('  trimmed text  ');
      expect(mockFactory.lastCall).toEqual({
        text: 'trimmed text',
        projectId: MOCK_PROJECT_ID,
        revisionId: MOCK_REVISION_ID,
      });
    });

    it('should call request factory with project id from joyProject', async () => {
      const mockFactory = createMockRequestFactory();
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: mockFactory.factory,
      });

      await runner('test request');
      expect(mockFactory.lastCall?.projectId).toBe(MOCK_PROJECT_ID);
    });

    it('should call request factory with revision id from options', async () => {
      const mockFactory = createMockRequestFactory();
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: mockFactory.factory,
      });

      await runner('test request');
      expect(mockFactory.lastCall?.revisionId).toBe(MOCK_REVISION_ID);
    });
  });

  describe('sync-before-brief ordering', () => {
    it('should call sync before brief transport on success', async () => {
      const syncProjectDocument = vi.fn().mockImplementation((_cp: string, _params) => {
        return Promise.resolve({
          projectId: MOCK_CONTROL_PLANE_PROJECT_ID,
          revisionId: MOCK_REVISION_ID,
        });
      });
      const creativeBriefTransport = vi.fn().mockResolvedValue(mockBrief);
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument,
        creativeBriefTransport,
        requestFactory: createMockRequestFactory().factory,
      });

      await runner('test');
      expect(syncProjectDocument).toHaveBeenCalled();
      expect(creativeBriefTransport).toHaveBeenCalled();
      expect(syncProjectDocument).toHaveBeenCalledBefore(creativeBriefTransport);
    });

    it('should not call brief transport when sync fails', async () => {
      const creativeBriefTransport = vi.fn<CreativeBriefTransport>();
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportFailure(new Error('Sync failed')),
        creativeBriefTransport,
        requestFactory: createMockRequestFactory().factory,
      });

      await expect(runner('test')).rejects.toBeDefined();
      expect(creativeBriefTransport).not.toHaveBeenCalled();
    });

    it('should not call brief transport when sync has conflict', async () => {
      const creativeBriefTransport = vi.fn<CreativeBriefTransport>();
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportConflict(),
        creativeBriefTransport,
        requestFactory: createMockRequestFactory().factory,
      });

      await expect(runner('test')).rejects.toMatchObject({ details: { kind: 'stale' } });
      expect(creativeBriefTransport).not.toHaveBeenCalled();
    });
  });

  describe('success', () => {
    it('should return brief on successful coordination', async () => {
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createMockRequestFactory().factory,
      });

      const result = await runner('test request');
      expect(result).toEqual(mockBrief);
    });

    it('should preserve brief identity from transport', async () => {
      const customBrief: CreativeBriefV1 = {
        ...mockBrief,
        request: 'custom request',
      };
      const creativeBriefTransport = createMockBriefTransportSuccess(customBrief);
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport,
        requestFactory: createMockRequestFactory().factory,
      });

      const result = await runner('test');
      expect(result).toBe(customBrief);
    });
  });

  describe('parity failure', () => {
    it('should reject with parity-failure for projectId mismatch', async () => {
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createBadProjectIdRequestFactory(),
      });

      await expect(runner('test')).rejects.toMatchObject({
        details: {
          kind: 'parity-failure',
          reason: 'projectId-mismatch',
          expectedProjectId: MOCK_PROJECT_ID,
          actualProjectId: 'wrong-project-id',
          expectedSnapshotRevisionId: MOCK_REVISION_ID,
          actualSnapshotRevisionId: MOCK_REVISION_ID,
        },
      });
    });

    it('should reject with parity-failure for snapshotRevisionId mismatch', async () => {
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createBadRevisionIdRequestFactory(),
      });

      await expect(runner('test')).rejects.toMatchObject({
        details: {
          kind: 'parity-failure',
          reason: 'snapshotRevisionId-mismatch',
          expectedProjectId: MOCK_PROJECT_ID,
          actualProjectId: MOCK_PROJECT_ID,
          expectedSnapshotRevisionId: MOCK_REVISION_ID,
          actualSnapshotRevisionId: 'wrong-revision-id',
        },
      });
    });

    it('should not call sync for parity failure', async () => {
      const syncProjectDocument = vi.fn();
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument,
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createBadProjectIdRequestFactory(),
      });

      await expect(runner('test')).rejects.toMatchObject({ details: { kind: 'parity-failure' } });
      expect(syncProjectDocument).not.toHaveBeenCalled();
    });

    it('should not call brief transport for parity failure', async () => {
      const creativeBriefTransport = vi.fn();
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport,
        requestFactory: createBadProjectIdRequestFactory(),
      });

      await expect(runner('test')).rejects.toMatchObject({ details: { kind: 'parity-failure' } });
      expect(creativeBriefTransport).not.toHaveBeenCalled();
    });
  });

  describe('stale conflict', () => {
    it('should reject with stale error when sync returns conflict', async () => {
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportConflict(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createMockRequestFactory().factory,
      });

      await expect(runner('test')).rejects.toMatchObject({
        details: {
          kind: 'stale',
          message: 'Revision conflict',
        },
      });
    });

    it('should not call brief transport for stale conflict', async () => {
      const creativeBriefTransport = vi.fn();
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportConflict(),
        creativeBriefTransport,
        requestFactory: createMockRequestFactory().factory,
      });

      await expect(runner('test')).rejects.toMatchObject({ details: { kind: 'stale' } });
      expect(creativeBriefTransport).not.toHaveBeenCalled();
    });
  });

  describe('sync failure', () => {
    it('should reject with sync-failure error when sync transport fails', async () => {
      const syncError = new Error('Sync failed');
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportFailure(syncError),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createMockRequestFactory().factory,
      });

      await expect(runner('test')).rejects.toMatchObject({
        details: {
          kind: 'sync-failure',
          error: syncError,
        },
      });
    });

    it('should not call brief transport when sync fails', async () => {
      const creativeBriefTransport = vi.fn();
      const syncError = new Error('Sync failed');
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportFailure(syncError),
        creativeBriefTransport,
        requestFactory: createMockRequestFactory().factory,
      });

      await expect(runner('test')).rejects.toMatchObject({ details: { kind: 'sync-failure' } });
      expect(creativeBriefTransport).not.toHaveBeenCalled();
    });

    it('should preserve original sync error', async () => {
      const syncError = new Error('Original sync error');
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportFailure(syncError),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createMockRequestFactory().factory,
      });

      await expect(runner('test')).rejects.toMatchObject({
        details: {
          kind: 'sync-failure',
          error: syncError,
        },
      });
    });
  });

  describe('brief failure', () => {
    it('should reject with brief-failure error when brief transport fails', async () => {
      const briefError = new Error('Brief failed');
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportFailure(briefError),
        requestFactory: createMockRequestFactory().factory,
      });

      await expect(runner('test')).rejects.toMatchObject({
        details: {
          kind: 'brief-failure',
          error: briefError,
        },
      });
    });

    it('should have called sync before brief transport fails', async () => {
      const syncProjectDocument = vi.fn().mockImplementation((_cp: string, _params) => {
        return Promise.resolve({
          projectId: MOCK_CONTROL_PLANE_PROJECT_ID,
          revisionId: MOCK_REVISION_ID,
        });
      });
      const creativeBriefTransport = vi.fn().mockRejectedValue(new Error('Brief failed'));
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument,
        creativeBriefTransport,
        requestFactory: createMockRequestFactory().factory,
      });

      await expect(runner('test')).rejects.toMatchObject({ details: { kind: 'brief-failure' } });
      expect(syncProjectDocument).toHaveBeenCalled();
      expect(creativeBriefTransport).toHaveBeenCalled();
    });

    it('should preserve original brief error', async () => {
      const briefError = new Error('Original brief error');
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportFailure(briefError),
        requestFactory: createMockRequestFactory().factory,
      });

      await expect(runner('test')).rejects.toMatchObject({
        details: {
          kind: 'brief-failure',
          error: briefError,
        },
      });
    });
  });

  describe('ownerKey forwarding', () => {
    it('should forward ownerKey to coordinator', async () => {
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createMockRequestFactory().factory,
        ownerKey: MOCK_OWNER_KEY,
      });

      const result = await runner('test');
      expect(result).toEqual(mockBrief);
    });

    it('should work without ownerKey (defaults to undefined)', async () => {
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createMockRequestFactory().factory,
      });

      const result = await runner('test');
      expect(result).toEqual(mockBrief);
    });
  });

  describe('input immutability', () => {
    it('should not mutate the input requestText', async () => {
      const requestText = '  test request  ';
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createMockRequestFactory().factory,
      });

      await runner(requestText);
      expect(requestText).toBe('  test request  ');
    });

    it('should not mutate the joyProject option', async () => {
      const project = { ...mockProject };
      const originalProject = { ...project };
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: mockBinding,
        joyProject: project,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createMockRequestFactory().factory,
      });

      await runner('test');
      expect(project).toEqual(originalProject);
    });

    it('should not mutate the binding option', async () => {
      const binding = { ...mockBinding };
      const originalBinding = { ...binding };
      const runner = createCreativeBriefPanelRunner({
        controlPlaneProjectBinding: binding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createMockRequestFactory().factory,
      });

      await runner('test');
      expect(binding).toEqual(originalBinding);
    });

    it('should not mutate options object', async () => {
      const options = {
        controlPlaneProjectBinding: mockBinding,
        joyProject: mockProject,
        projectRevisionId: MOCK_REVISION_ID,
        browserKeyValueStore: mockStorage,
        syncProjectDocument: createMockSyncTransportSuccess(),
        creativeBriefTransport: createMockBriefTransportSuccess(),
        requestFactory: createMockRequestFactory().factory,
      };
      const originalBindingRef = options.controlPlaneProjectBinding;
      const originalProjectRef = options.joyProject;
      const runner = createCreativeBriefPanelRunner(options);

      await runner('test');
      expect(options.controlPlaneProjectBinding).toBe(originalBindingRef);
      expect(options.joyProject).toBe(originalProjectRef);
    });
  });
});
