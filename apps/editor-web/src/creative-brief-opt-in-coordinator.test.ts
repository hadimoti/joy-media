import { describe, expect, it, vi, beforeEach, type MockedFunction } from 'vitest';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { ControlPlaneProjectBinding } from './project-control-plane.js';
import { getControlPlaneProjectBinding } from './project-control-plane.js';
import {
  coordinateCreativeBriefOptIn,
  type CreativeBriefOptInTransport,
} from './creative-brief-opt-in-coordinator.js';

const MOCK_EDITOR_PROJECT_ID = 'local-edit-1';
const MOCK_CONTROL_PLANE_PROJECT_ID = 'project-server-1';
const MOCK_TITLE = 'Test Project';

function memoryStorage(): BrowserKeyValueStore {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  };
}

function baseBinding(revision?: number): ControlPlaneProjectBinding {
  return {
    editorProjectId: MOCK_EDITOR_PROJECT_ID,
    controlPlaneProjectId: MOCK_CONTROL_PLANE_PROJECT_ID,
    title: MOCK_TITLE,
    ...(revision === undefined ? {} : { revision }),
  };
}

describe('coordinateCreativeBriefOptIn', () => {
  let storage: BrowserKeyValueStore;
  let mockTransport: MockedFunction<CreativeBriefOptInTransport>;

  beforeEach(() => {
    storage = memoryStorage();
    mockTransport = vi.fn<CreativeBriefOptInTransport>();
  });

  describe('enable opt-in', () => {
    it('calls transport exactly once with correct arguments for enable', async () => {
      const binding = baseBinding(0);
      const expectedResponse = { creativeBriefOptIn: true, revision: 1 };
      mockTransport.mockResolvedValue(expectedResponse);

      await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      expect(mockTransport).toHaveBeenCalledTimes(1);
      expect(mockTransport).toHaveBeenCalledWith(MOCK_CONTROL_PLANE_PROJECT_ID, true, 0);
    });

    it('persists binding with new revision on matching response', async () => {
      const binding = baseBinding(0);
      const expectedResponse = { creativeBriefOptIn: true, revision: 5 };
      mockTransport.mockResolvedValue(expectedResponse);

      const result = await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      expect(result).toEqual({
        kind: 'success',
        previousRevision: 0,
        newRevision: 5,
      });

      const persisted = getControlPlaneProjectBinding(storage, MOCK_EDITOR_PROJECT_ID, 'local');
      expect(persisted).toBeDefined();
      expect(persisted?.revision).toBe(5);
      expect(persisted?.editorProjectId).toBe(MOCK_EDITOR_PROJECT_ID);
      expect(persisted?.controlPlaneProjectId).toBe(MOCK_CONTROL_PLANE_PROJECT_ID);
      expect(persisted?.title).toBe(MOCK_TITLE);
    });
  });

  describe('disable opt-in', () => {
    it('calls transport exactly once with correct arguments for disable', async () => {
      const binding = baseBinding(3);
      const expectedResponse = { creativeBriefOptIn: false, revision: 4 };
      mockTransport.mockResolvedValue(expectedResponse);

      await coordinateCreativeBriefOptIn(binding, false, storage, mockTransport);

      expect(mockTransport).toHaveBeenCalledTimes(1);
      expect(mockTransport).toHaveBeenCalledWith(MOCK_CONTROL_PLANE_PROJECT_ID, false, 3);
    });

    it('persists binding with new revision on matching disable response', async () => {
      const binding = baseBinding(2);
      const expectedResponse = { creativeBriefOptIn: false, revision: 3 };
      mockTransport.mockResolvedValue(expectedResponse);

      const result = await coordinateCreativeBriefOptIn(binding, false, storage, mockTransport);

      expect(result).toEqual({
        kind: 'success',
        previousRevision: 2,
        newRevision: 3,
      });

      const persisted = getControlPlaneProjectBinding(storage, MOCK_EDITOR_PROJECT_ID, 'local');
      expect(persisted).toBeDefined();
      expect(persisted?.revision).toBe(3);
    });
  });

  describe('revision fallback', () => {
    it('uses 0 as baseRevision when binding.revision is undefined', async () => {
      const binding: ControlPlaneProjectBinding = {
        editorProjectId: MOCK_EDITOR_PROJECT_ID,
        controlPlaneProjectId: MOCK_CONTROL_PLANE_PROJECT_ID,
        title: MOCK_TITLE,
      };
      const expectedResponse = { creativeBriefOptIn: true, revision: 1 };
      mockTransport.mockResolvedValue(expectedResponse);

      await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      expect(mockTransport).toHaveBeenCalledWith(MOCK_CONTROL_PLANE_PROJECT_ID, true, 0);
    });
  });

  describe('owner-scoped persistence', () => {
    it('persists to specified ownerKey', async () => {
      const binding = baseBinding(0);
      const expectedResponse = { creativeBriefOptIn: true, revision: 1 };
      mockTransport.mockResolvedValue(expectedResponse);

      await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport, {
        ownerKey: 'gmail-user',
      });

      const persisted = getControlPlaneProjectBinding(
        storage,
        MOCK_EDITOR_PROJECT_ID,
        'gmail-user',
      );
      expect(persisted).toBeDefined();
      expect(persisted?.revision).toBe(1);

      const notPersisted = getControlPlaneProjectBinding(storage, MOCK_EDITOR_PROJECT_ID, 'local');
      expect(notPersisted).toBeUndefined();
    });

    it('defaults to local ownerKey', async () => {
      const binding = baseBinding(0);
      const expectedResponse = { creativeBriefOptIn: true, revision: 1 };
      mockTransport.mockResolvedValue(expectedResponse);

      await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      const persisted = getControlPlaneProjectBinding(storage, MOCK_EDITOR_PROJECT_ID, 'local');
      expect(persisted).toBeDefined();
      expect(persisted?.revision).toBe(1);
    });
  });

  describe('response mismatch', () => {
    it('returns mismatch result when opt-in state does not match', async () => {
      const binding = baseBinding(0);
      const expectedResponse = { creativeBriefOptIn: false, revision: 1 };
      mockTransport.mockResolvedValue(expectedResponse);

      const result = await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      expect(result).toEqual({
        kind: 'mismatch',
        expectedOptIn: true,
        actualOptIn: false,
        responseRevision: 1,
      });

      const notPersisted = getControlPlaneProjectBinding(storage, MOCK_EDITOR_PROJECT_ID, 'local');
      expect(notPersisted).toBeUndefined();
    });

    it('does not persist on mismatch', async () => {
      const binding = baseBinding(10);
      const expectedResponse = { creativeBriefOptIn: false, revision: 11 };
      mockTransport.mockResolvedValue(expectedResponse);

      await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      const notPersisted = getControlPlaneProjectBinding(storage, MOCK_EDITOR_PROJECT_ID, 'local');
      expect(notPersisted).toBeUndefined();
    });
  });

  describe('invalid revision', () => {
    it('returns invalid-revision result for non-number revision', async () => {
      const binding = baseBinding(0);
      const expectedResponse = { creativeBriefOptIn: true, revision: 'not-a-number' };
      mockTransport.mockResolvedValue(expectedResponse as never);

      const result = await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      expect(result).toEqual({
        kind: 'invalid-revision',
        revision: 'not-a-number',
      });
    });

    it('returns invalid-revision result for negative revision', async () => {
      const binding = baseBinding(0);
      const expectedResponse = { creativeBriefOptIn: true, revision: -1 };
      mockTransport.mockResolvedValue(expectedResponse);

      const result = await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      expect(result).toEqual({
        kind: 'invalid-revision',
        revision: -1,
      });
    });

    it('returns invalid-revision result for non-integer revision', async () => {
      const binding = baseBinding(0);
      const expectedResponse = { creativeBriefOptIn: true, revision: 1.5 };
      mockTransport.mockResolvedValue(expectedResponse);

      const result = await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      expect(result).toEqual({
        kind: 'invalid-revision',
        revision: 1.5,
      });
    });

    it('does not persist on invalid revision', async () => {
      const binding = baseBinding(0);
      const expectedResponse = { creativeBriefOptIn: true, revision: -1 };
      mockTransport.mockResolvedValue(expectedResponse);

      await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      const notPersisted = getControlPlaneProjectBinding(storage, MOCK_EDITOR_PROJECT_ID, 'local');
      expect(notPersisted).toBeUndefined();
    });
  });

  describe('transport error', () => {
    it('maps transport error to transport-failure result', async () => {
      const binding = baseBinding(0);
      const transportError = new Error('Network error');
      mockTransport.mockRejectedValue(transportError);

      const result = await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      expect(result).toEqual({
        kind: 'transport-failure',
        error: transportError,
      });
    });

    it('does not persist on transport error', async () => {
      const binding = baseBinding(0);
      mockTransport.mockRejectedValue(new Error('Network error'));

      await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      const notPersisted = getControlPlaneProjectBinding(storage, MOCK_EDITOR_PROJECT_ID, 'local');
      expect(notPersisted).toBeUndefined();
    });
  });

  describe('input immutability', () => {
    it('does not mutate input binding on success', async () => {
      const binding = baseBinding(0);
      const expectedResponse = { creativeBriefOptIn: true, revision: 5 };
      mockTransport.mockResolvedValue(expectedResponse);

      const originalRevision = binding.revision;
      const originalTitle = binding.title;

      await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      expect(binding.revision).toBe(originalRevision);
      expect(binding.title).toBe(originalTitle);
    });

    it('does not mutate input binding on mismatch', async () => {
      const binding = baseBinding(10);
      const expectedResponse = { creativeBriefOptIn: false, revision: 11 };
      mockTransport.mockResolvedValue(expectedResponse);

      const originalRevision = binding.revision;

      await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      expect(binding.revision).toBe(originalRevision);
    });

    it('does not mutate input binding on invalid revision', async () => {
      const binding = baseBinding(10);
      const expectedResponse = { creativeBriefOptIn: true, revision: -1 };
      mockTransport.mockResolvedValue(expectedResponse);

      const originalRevision = binding.revision;

      await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      expect(binding.revision).toBe(originalRevision);
    });

    it('does not mutate input binding on transport error', async () => {
      const binding = baseBinding(10);
      mockTransport.mockRejectedValue(new Error('Network error'));

      const originalRevision = binding.revision;

      await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      expect(binding.revision).toBe(originalRevision);
    });
  });

  describe('exact transport arguments', () => {
    it('passes the opaque control-plane ID from binding', async () => {
      const customControlPlaneId = 'custom-project-id-123';
      const binding: ControlPlaneProjectBinding = {
        editorProjectId: MOCK_EDITOR_PROJECT_ID,
        controlPlaneProjectId: customControlPlaneId,
        title: MOCK_TITLE,
        revision: 5,
      };
      const expectedResponse = { creativeBriefOptIn: true, revision: 6 };
      mockTransport.mockResolvedValue(expectedResponse);

      await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      expect(mockTransport).toHaveBeenCalledWith(customControlPlaneId, true, 5);
    });

    it('passes enabled state as-is', async () => {
      const binding = baseBinding(0);
      mockTransport.mockResolvedValue({ creativeBriefOptIn: true, revision: 1 });

      await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);
      expect(mockTransport).toHaveBeenCalledWith(MOCK_CONTROL_PLANE_PROJECT_ID, true, 0);

      mockTransport.mockReset();
      mockTransport.mockResolvedValue({ creativeBriefOptIn: false, revision: 1 });

      await coordinateCreativeBriefOptIn(binding, false, storage, mockTransport);
      expect(mockTransport).toHaveBeenCalledWith(MOCK_CONTROL_PLANE_PROJECT_ID, false, 0);
    });

    it('passes baseRevision from binding.revision', async () => {
      const binding = baseBinding(42);
      mockTransport.mockResolvedValue({ creativeBriefOptIn: true, revision: 43 });

      await coordinateCreativeBriefOptIn(binding, true, storage, mockTransport);

      expect(mockTransport).toHaveBeenCalledWith(MOCK_CONTROL_PLANE_PROJECT_ID, true, 42);
    });
  });
});
