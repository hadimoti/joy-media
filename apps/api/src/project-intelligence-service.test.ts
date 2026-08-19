/**
 * Project Intelligence Service Tests - WP-37 S4 Phase 3-A
 * Tests for the pure API-internal semantic intelligence service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JoyProjectV1, ProjectRevisionId, SemanticProjectSnapshotV1 } from '@joy-media/project-schema';
import type { Rational } from '@joy-media/project-schema';
import { projectToSemanticSnapshot } from '@joy-media/project-schema';
import { computeSemanticIntelligence, KNOWN_RULE_IDS } from '@joy-media/project-schema';
import {
  ProjectIntelligenceService,
  computeProjectIntelligence,
  type S2IntelligenceResult,
} from './project-intelligence-service.js';

// ==========================================================================
// Test Fixtures
// ==========================================================================

function r(num: number, den: number): Rational {
  return { num, den };
}

function createComposition(
  id: string = 'comp-1',
  width: number = 1920,
  height: number = 1080,
  durationUs: number = 10_000_000,
): { id: string; name: string; width: number; height: number; pixelAspectRatio: Rational; frameRate: Rational; durationUs: number; background: string; tracks: never[] } {
  return {
    id,
    name: 'Test Composition',
    width,
    height,
    pixelAspectRatio: r(1, 1),
    frameRate: r(30, 1),
    durationUs,
    background: '#00000000',
    tracks: [],
  };
}

function createProject(
  id: string = 'project-1',
  rootCompositionId: string = 'comp-1',
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
      [rootCompositionId]: createComposition(rootCompositionId),
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: {},
    pluginData: {},
  };
}

function createMinimalSnapshot(
  projectId: string = 'project-1',
  revisionId: ProjectRevisionId = 'local-revision:v1:test:timeline=1:document=1:graph=1:artifacts=1',
): SemanticProjectSnapshotV1 {
  const project = createProject(projectId);
  const snapshot = projectToSemanticSnapshot(project, revisionId);
  return snapshot;
}

// ==========================================================================
// Test Suites
// ==========================================================================

describe('project-intelligence-service', () => {
  describe('ProjectIntelligenceService class', () => {
    it('should delegate to canonical computeSemanticIntelligence', () => {
      const service = new ProjectIntelligenceService();
      const snapshot = createMinimalSnapshot();

      const result = service.computeIntelligence(snapshot);
      const canonical = computeSemanticIntelligence(snapshot);

      expect(result).toEqual(canonical);
      expect(result.brandReadiness).toEqual(canonical.brandReadiness);
      expect(result.sceneCoverages).toEqual(canonical.sceneCoverages);
      expect(result.projectReadiness).toEqual(canonical.projectReadiness);
      expect(result.allRules).toEqual(canonical.allRules);
    });

    it('should produce byte-stable output for identical snapshot input', () => {
      const service = new ProjectIntelligenceService();
      const snapshot = createMinimalSnapshot();

      const result1 = service.computeIntelligence(snapshot);
      const result2 = service.computeIntelligence(snapshot);

      const json1 = JSON.stringify(result1);
      const json2 = JSON.stringify(result2);
      expect(json1).toBe(json2);
    });

    it('should not mutate the input snapshot', () => {
      const service = new ProjectIntelligenceService();
      const snapshot = createMinimalSnapshot();

      // Deep clone the snapshot for comparison
      const snapshotCopy = JSON.parse(JSON.stringify(snapshot));

      service.computeIntelligence(snapshot);

      // Verify snapshot was not mutated
      expect(snapshot).toEqual(snapshotCopy);
    });

    it('should handle snapshot with brand kit missing and trigger BRAND_NO_KIT rule', () => {
      const service = new ProjectIntelligenceService();
      const snapshot = createMinimalSnapshot();

      const result = service.computeIntelligence(snapshot);

      // The minimal snapshot has no brand kit, so BRAND_NO_KIT should be triggered
      const brandNoKitRule = result.allRules.find(
        (rule) => rule.ruleId === KNOWN_RULE_IDS.BRAND_NO_KIT,
      );
      expect(brandNoKitRule).toBeDefined();
      expect(brandNoKitRule!.severity).toBe('warning');
      expect(brandNoKitRule!.category).toBe('brand');
    });

    it('should return all S2 components', () => {
      const service = new ProjectIntelligenceService();
      const snapshot = createMinimalSnapshot();

      const result = service.computeIntelligence(snapshot);

      expect(result.brandReadiness).toBeDefined();
      expect(result.sceneCoverages).toBeDefined();
      expect(result.projectReadiness).toBeDefined();
      expect(result.allRules).toBeDefined();

      expect(result.brandReadiness.projectId).toBe('project-1');
      expect(result.sceneCoverages).toBeInstanceOf(Array);
      expect(result.projectReadiness.projectId).toBe('project-1');
      expect(result.allRules).toBeInstanceOf(Array);
    });
  });

  describe('computeProjectIntelligence standalone function', () => {
    it('should delegate to canonical computeSemanticIntelligence', () => {
      const snapshot = createMinimalSnapshot();

      const result = computeProjectIntelligence(snapshot);
      const canonical = computeSemanticIntelligence(snapshot);

      expect(result).toEqual(canonical);
    });

    it('should produce byte-stable output for identical snapshot input', () => {
      const snapshot = createMinimalSnapshot();

      const result1 = computeProjectIntelligence(snapshot);
      const result2 = computeProjectIntelligence(snapshot);

      const json1 = JSON.stringify(result1);
      const json2 = JSON.stringify(result2);
      expect(json1).toBe(json2);
    });

    it('should not mutate the input snapshot', () => {
      const snapshot = createMinimalSnapshot();
      const snapshotCopy = JSON.parse(JSON.stringify(snapshot));

      computeProjectIntelligence(snapshot);

      expect(snapshot).toEqual(snapshotCopy);
    });

    it('should return S2IntelligenceResult with correct structure', () => {
      const snapshot = createMinimalSnapshot();

      const result: S2IntelligenceResult = computeProjectIntelligence(snapshot);

      expect(result.brandReadiness).toHaveProperty('projectId');
      expect(result.brandReadiness).toHaveProperty('revisionId');
      expect(result.brandReadiness).toHaveProperty('hasBrandKit');
      expect(result.projectReadiness).toHaveProperty('projectId');
      expect(result.projectReadiness).toHaveProperty('revisionId');
      expect(result.projectReadiness).toHaveProperty('readinessLevel');
      expect(Array.isArray(result.sceneCoverages)).toBe(true);
      expect(Array.isArray(result.allRules)).toBe(true);
    });
  });

  describe('Determinism and Purity', () => {
    it('should produce identical results across multiple calls with same snapshot', () => {
      const service = new ProjectIntelligenceService();
      const snapshot = createMinimalSnapshot();

      const results = Array.from({ length: 5 }, () =>
        service.computeIntelligence(snapshot),
      );

      const firstJson = JSON.stringify(results[0]);
      for (const result of results.slice(1)) {
        expect(JSON.stringify(result)).toBe(firstJson);
      }
    });

    it('should handle different snapshots independently', () => {
      const service = new ProjectIntelligenceService();
      const snapshot1 = createMinimalSnapshot('project-a');
      const snapshot2 = createMinimalSnapshot('project-b');

      const result1 = service.computeIntelligence(snapshot1);
      const result2 = service.computeIntelligence(snapshot2);

      expect(result1.brandReadiness.projectId).toBe('project-a');
      expect(result2.brandReadiness.projectId).toBe('project-b');
    });
  });
});
