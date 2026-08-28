/**
 * Project Snapshot Service Tests - WP-37 S4 Phase 2-A
 * Tests for the pure API-internal semantic snapshot service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JoyProjectV1, ProjectRevisionId } from '@joy-media/project-schema';
import type { Rational } from '@joy-media/project-schema';
import {
  ProjectSnapshotService,
  createProjectSnapshot,
  type ProjectSnapshotServiceOptions,
} from './project-snapshot-service.js';

// ==========================================================================
// Test Fixtures
// ==========================================================================

import type { CaptionDocumentV1 } from '@joy-media/project-schema';

function r(num: number, den: number): Rational {
  return { num, den };
}

function createProject(
  id: string = 'project-1',
  rootCompositionId: string = 'comp-1',
  captionDocuments: Record<string, CaptionDocumentV1> = {},
): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id,
    title: 'Test Project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rootCompositionId,
    settings: { defaultLocale: 'en-US' },
    compositions: {
      [rootCompositionId]: {
        id: rootCompositionId,
        name: 'Test Composition',
        width: 1920,
        height: 1080,
        pixelAspectRatio: r(1, 1),
        frameRate: r(30, 1),
        durationUs: 10_000_000,
        background: '#00000000',
        tracks: [],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments,
    pluginData: {},
  };
}

// ==========================================================================
// Test Suites
// ==========================================================================

describe('project-snapshot-service', () => {
  describe('ProjectSnapshotService class', () => {
    it('should create snapshot with deterministic clock', () => {
      const clock = () => '2026-01-01T00:00:00.000Z';
      const service = new ProjectSnapshotService({ clock });
      const project = createProject();
      const revisionId: ProjectRevisionId =
        'local-revision:v1:test:timeline=1:document=1:graph=1:artifacts=1';

      const snapshot = service.createSnapshot(project, revisionId);

      expect(snapshot.capturedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(snapshot.projectId).toBe('project-1');
      expect(snapshot.revisionId).toBe(revisionId);
      expect(snapshot.schemaVersion).toBe(1);
    });

    it('should produce byte-stable output for identical inputs', () => {
      const clock = () => '2026-01-01T00:00:00.000Z';
      const service = new ProjectSnapshotService({ clock });
      const project = createProject();
      const revisionId: ProjectRevisionId =
        'local-revision:v1:test:timeline=1:document=1:graph=1:artifacts=1';

      const snapshot1 = service.createSnapshot(project, revisionId);
      const snapshot2 = service.createSnapshot(project, revisionId);

      const json1 = JSON.stringify(snapshot1);
      const json2 = JSON.stringify(snapshot2);
      expect(json1).toBe(json2);
    });

    it('should propagate revision id correctly', () => {
      const service = new ProjectSnapshotService();
      const project = createProject();
      const revisionId1: ProjectRevisionId =
        'local-revision:v1:test:timeline=1:document=1:graph=1:artifacts=1';
      const revisionId2: ProjectRevisionId =
        'local-revision:v1:test:timeline=2:document=1:graph=1:artifacts=1';

      const snapshot1 = service.createSnapshot(project, revisionId1);
      const snapshot2 = service.createSnapshot(project, revisionId2);

      expect(snapshot1.revisionId).toBe(revisionId1);
      expect(snapshot2.revisionId).toBe(revisionId2);
      expect(snapshot1.revisionId).not.toBe(snapshot2.revisionId);
    });

    it('should preserve Persian RTL captions', () => {
      const clock = () => '2026-01-01T00:00:00.000Z';
      const service = new ProjectSnapshotService({ clock });
      const persianCaption: CaptionDocumentV1 = {
        id: 'caption-fa',
        language: 'fa-IR',
        direction: 'rtl',
        speakers: [],
        words: {},
        segments: [
          { id: 'seg-1', startUs: 0, endUs: 1_000_000, wordIds: [], textOverride: 'سلام دنیا' },
        ],
      };
      const project = createProject('persian-project', 'comp-1', {
        'caption-fa': persianCaption,
      });
      const revisionId: ProjectRevisionId =
        'local-revision:v1:persian:timeline=1:document=1:graph=1:artifacts=1';

      const snapshot = service.createSnapshot(project, revisionId);

      expect(snapshot.capabilities['caption-detection']).toBe('ready');
      // Persian locale should be preserved in caption coverage
      expect(snapshot.scenes.some((s) => s.captionCoverage?.locale === 'fa-IR')).toBe(true);
    });

    it('should not mutate input project', () => {
      const clock = () => '2026-01-01T00:00:00.000Z';
      const service = new ProjectSnapshotService({ clock });
      const project = createProject();
      const projectBefore = JSON.parse(JSON.stringify(project));
      const revisionId: ProjectRevisionId =
        'local-revision:v1:test:timeline=1:document=1:graph=1:artifacts=1';

      service.createSnapshot(project, revisionId);

      const projectAfter = JSON.parse(JSON.stringify(project));
      expect(projectBefore).toEqual(projectAfter);
    });

    it('should accept options via constructor', () => {
      const clock = () => '2026-02-01T12:00:00.000Z';
      const service = new ProjectSnapshotService({
        clock,
        maxScenes: 5,
        maxAssets: 10,
        maxClipsPerScene: 3,
      });
      const project = createProject();
      const revisionId: ProjectRevisionId =
        'local-revision:v1:test:timeline=1:document=1:graph=1:artifacts=1';

      const snapshot = service.createSnapshot(project, revisionId);

      expect(snapshot.capturedAt).toBe('2026-02-01T12:00:00.000Z');
      expect(snapshot.truncation).toBeDefined();
    });

    it('should work without options', () => {
      const service = new ProjectSnapshotService();
      const project = createProject();
      const revisionId: ProjectRevisionId =
        'local-revision:v1:test:timeline=1:document=1:graph=1:artifacts=1';

      const snapshot = service.createSnapshot(project, revisionId);

      expect(snapshot.capturedAt).toBeDefined();
      expect(snapshot.projectId).toBe('project-1');
      expect(snapshot.revisionId).toBe(revisionId);
    });
  });

  describe('createProjectSnapshot function', () => {
    it('should create snapshot with deterministic clock', () => {
      const clock = () => '2026-01-01T00:00:00.000Z';
      const project = createProject();
      const revisionId: ProjectRevisionId =
        'local-revision:v1:test:timeline=1:document=1:graph=1:artifacts=1';

      const snapshot = createProjectSnapshot(project, revisionId, { clock });

      expect(snapshot.capturedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(snapshot.projectId).toBe('project-1');
      expect(snapshot.revisionId).toBe(revisionId);
    });

    it('should produce byte-stable output for identical inputs', () => {
      const clock = () => '2026-01-01T00:00:00.000Z';
      const project = createProject();
      const revisionId: ProjectRevisionId =
        'local-revision:v1:test:timeline=1:document=1:graph=1:artifacts=1';

      const snapshot1 = createProjectSnapshot(project, revisionId, { clock });
      const snapshot2 = createProjectSnapshot(project, revisionId, { clock });

      const json1 = JSON.stringify(snapshot1);
      const json2 = JSON.stringify(snapshot2);
      expect(json1).toBe(json2);
    });

    it('should propagate revision id correctly', () => {
      const project = createProject();
      const revisionId1: ProjectRevisionId =
        'local-revision:v1:test:timeline=1:document=1:graph=1:artifacts=1';
      const revisionId2: ProjectRevisionId =
        'local-revision:v1:test:timeline=2:document=1:graph=1:artifacts=1';

      const snapshot1 = createProjectSnapshot(project, revisionId1);
      const snapshot2 = createProjectSnapshot(project, revisionId2);

      expect(snapshot1.revisionId).toBe(revisionId1);
      expect(snapshot2.revisionId).toBe(revisionId2);
      expect(snapshot1.revisionId).not.toBe(snapshot2.revisionId);
    });

    it('should preserve Persian RTL captions', () => {
      const clock = () => '2026-01-01T00:00:00.000Z';
      const persianCaption: CaptionDocumentV1 = {
        id: 'caption-fa',
        language: 'fa-IR',
        direction: 'rtl',
        speakers: [],
        words: {},
        segments: [
          { id: 'seg-1', startUs: 0, endUs: 1_000_000, wordIds: [], textOverride: 'سلام دنیا' },
        ],
      };
      const project = createProject('persian-project', 'comp-1', {
        'caption-fa': persianCaption,
      });
      const revisionId: ProjectRevisionId =
        'local-revision:v1:persian:timeline=1:document=1:graph=1:artifacts=1';

      const snapshot = createProjectSnapshot(project, revisionId, { clock });

      expect(snapshot.capabilities['caption-detection']).toBe('ready');
      expect(snapshot.scenes.some((s) => s.captionCoverage?.locale === 'fa-IR')).toBe(true);
    });

    it('should not mutate input project', () => {
      const clock = () => '2026-01-01T00:00:00.000Z';
      const project = createProject();
      const projectBefore = JSON.parse(JSON.stringify(project));
      const revisionId: ProjectRevisionId =
        'local-revision:v1:test:timeline=1:document=1:graph=1:artifacts=1';

      createProjectSnapshot(project, revisionId, { clock });

      const projectAfter = JSON.parse(JSON.stringify(project));
      expect(projectBefore).toEqual(projectAfter);
    });

    it('should work without options', () => {
      const project = createProject();
      const revisionId: ProjectRevisionId =
        'local-revision:v1:test:timeline=1:document=1:graph=1:artifacts=1';

      const snapshot = createProjectSnapshot(project, revisionId);

      expect(snapshot.capturedAt).toBeDefined();
      expect(snapshot.projectId).toBe('project-1');
      expect(snapshot.revisionId).toBe(revisionId);
    });
  });

  describe('byte-stability with different clocks', () => {
    it('should produce different capturedAt with different clocks', () => {
      const project = createProject();
      const revisionId: ProjectRevisionId =
        'local-revision:v1:test:timeline=1:document=1:graph=1:artifacts=1';

      const clock1 = () => '2026-01-01T00:00:00.000Z';
      const clock2 = () => '2026-02-01T00:00:00.000Z';

      const snapshot1 = createProjectSnapshot(project, revisionId, { clock: clock1 });
      const snapshot2 = createProjectSnapshot(project, revisionId, { clock: clock2 });

      expect(snapshot1.capturedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(snapshot2.capturedAt).toBe('2026-02-01T00:00:00.000Z');
    });

    it('should have same content except capturedAt when clocks differ', () => {
      const project = createProject();
      const revisionId: ProjectRevisionId =
        'local-revision:v1:test:timeline=1:document=1:graph=1:artifacts=1';

      const clock1 = () => '2026-01-01T00:00:00.000Z';
      const clock2 = () => '2026-02-01T00:00:00.000Z';

      const snapshot1 = createProjectSnapshot(project, revisionId, { clock: clock1 });
      const snapshot2 = createProjectSnapshot(project, revisionId, { clock: clock2 });

      // Clear capturedAt to compare rest
      const { capturedAt: _c1, ...rest1 } = snapshot1;
      const { capturedAt: _c2, ...rest2 } = snapshot2;

      expect(rest1).toEqual(rest2);
    });
  });
});
