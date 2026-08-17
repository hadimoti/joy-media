/**
 * Semantic Intelligence V1 Tests
 * WP-37 S2: Deterministic Scene and Brand Intelligence
 */

import { describe, it, expect } from 'vitest';
import type { JoyProjectV1, CompositionV1, TrackV1, ClipV1, AssetRecordV1, MarkerV1, CaptionDocumentV1, GenerationProvenanceV1 } from './v1.js';
import type { Rational } from './time.js';
import type { JsonValue } from './v1.js';
import {
  projectToSemanticSnapshot,
} from './semantic-snapshot-impl.js';
import type {
  SemanticProjectSnapshotV1,
  ProjectRevisionId,
} from './semantic-snapshot.js';
import {
  computeBrandReadiness,
  computeSceneCoverages,
  computeProjectReadiness,
  computeSemanticIntelligence,
  getKnownRuleIds,
  getRuleDefinitions,
  getRuleDefinition,
  formatDurationUs,
  KNOWN_RULE_IDS,
} from './semantic-intelligence.js';
import type {
  BrandReadinessV1,
  SceneCoverageV1,
  ProjectReadinessV1,
  IntelligenceRuleV1,
  KnownRuleId,
} from './semantic-intelligence.js';

// ==========================================================================
// Test Fixtures
// ==========================================================================

// Helper to create a minimal Rational
function r(num: number, den: number): Rational {
  return { num, den };
}

// Minimal valid composition
function createComposition(
  id: string = 'comp-1',
  width: number = 1920,
  height: number = 1080,
  durationUs: number = 10_000_000,
  frameRate: Rational = r(30, 1),
  tracks: TrackV1[] = [],
): CompositionV1 {
  return {
    id,
    name: 'Test Composition',
    width,
    height,
    pixelAspectRatio: r(1, 1),
    frameRate,
    durationUs,
    background: '#00000000',
    tracks,
  };
}

// Minimal valid track
function createTrack(
  id: string = 'track-1',
  kind: TrackV1['kind'] = 'video',
  clips: ClipV1[] = [],
  family: TrackV1['family'] = 'visual',
): TrackV1 {
  return {
    id,
    kind,
    family,
    name: 'Test Track',
    order: 0,
    enabled: true,
    locked: false,
    clips,
  };
}

// Minimal valid video clip
function createVideoClip(
  id: string = 'clip-1',
  startUs: number = 0,
  durationUs: number = 1_000_000,
  assetId: string = 'asset-1',
): ClipV1 {
  return {
    kind: 'video',
    id,
    startUs,
    durationUs,
    assetId,
    sourceInUs: 0,
  };
}

// Minimal valid caption clip
function createCaptionClip(
  id: string = 'clip-1',
  startUs: number = 0,
  durationUs: number = 1_000_000,
  captionDocumentId: string = 'caption-1',
): ClipV1 {
  return {
    kind: 'caption',
    id,
    startUs,
    durationUs,
    captionDocumentId,
  };
}

// Minimal valid project
function createProject(
  id: string = 'project-1',
  rootCompositionId: string = 'comp-1',
  compositions: Record<string, CompositionV1> = {},
  assets: Record<string, AssetRecordV1> = {},
  markers: MarkerV1[] = [],
  captionDocuments: Record<string, CaptionDocumentV1> = {},
  variables: Record<string, JsonValue> = {},
): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id,
    title: 'Test Project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rootCompositionId,
    settings: { defaultLocale: 'en-US' },
    compositions,
    assets,
    variables,
    markers,
    visualObjects: {},
    captionDocuments,
    pluginData: {},
  };
}

// Minimal valid asset
function createAsset(
  id: string = 'asset-1',
  kind: AssetRecordV1['kind'] = 'video',
  displayName: string = 'Test Asset',
  durationUs?: number,
): AssetRecordV1 {
  if (durationUs !== undefined) {
    return {
      id,
      kind,
      displayName,
      descriptor: { mimeType: 'video/mp4', durationUs },
    };
  }
  return {
    id,
    kind,
    displayName,
  };
}

// Minimal valid marker
function createMarker(
  id: string = 'marker-1',
  timeUs: number = 5_000_000,
  label: string = 'Scene 1',
  kind: MarkerV1['kind'] = 'chapter',
): MarkerV1 {
  return {
    id,
    timeUs,
    label,
    kind,
  };
}

// Minimal valid caption document
function createCaptionDocument(
  id: string = 'caption-1',
  language: string = 'en-US',
  segments: CaptionDocumentV1['segments'] = [],
  words: CaptionDocumentV1['words'] = {},
): CaptionDocumentV1 {
  return {
    id,
    language,
    direction: 'ltr',
    speakers: [],
    words,
    segments,
  };
}

// Create a snapshot from a project for testing
function createSnapshot(
  project: JoyProjectV1,
  revisionId: ProjectRevisionId = 'local-revision:v1:test:timeline=1:document=1:graph=1:artifacts=1',
  goal?: { destination?: string; durationTargetUs?: number; brief?: string },
): SemanticProjectSnapshotV1 {
  const snapshot = projectToSemanticSnapshot(project, revisionId);
  if (goal) {
    return { ...snapshot, goal };
  }
  return snapshot;
}

// ==========================================================================
// Test Suites
// ==========================================================================

describe('semantic-intelligence', () => {
  describe('formatDurationUs', () => {
    it('should format microseconds to milliseconds for short durations', () => {
      expect(formatDurationUs(0)).toBe('0ms');
      expect(formatDurationUs(500_000)).toBe('500ms');
    });

    it('should format milliseconds to seconds for medium durations', () => {
      expect(formatDurationUs(1_000_000)).toBe('1.0s');
      expect(formatDurationUs(1_500_000)).toBe('1.5s');
      expect(formatDurationUs(59_000_000)).toBe('59.0s');
    });

    it('should format seconds to minutes for long durations', () => {
      expect(formatDurationUs(60_000_000)).toBe('1m 0.0s');
      expect(formatDurationUs(90_000_000)).toBe('1m 30.0s');
      expect(formatDurationUs(125_000_000)).toBe('2m 5.0s');
    });
  });

  describe('Known Rule IDs', () => {
    it('should export all known rule IDs', () => {
      const ruleIds = getKnownRuleIds();
      expect(ruleIds).toBeInstanceOf(Array);
      expect(ruleIds.length).toBeGreaterThan(0);
      expect(ruleIds).toContain(KNOWN_RULE_IDS.BRAND_NO_KIT);
      expect(ruleIds).toContain(KNOWN_RULE_IDS.VISUAL_COVERAGE_SPARSE_DURING_NARRATION);
      expect(ruleIds).toContain(KNOWN_RULE_IDS.CAPTION_MISSING_WHERE_NARRATION_EXISTS);
      expect(ruleIds).toContain(KNOWN_RULE_IDS.DESTINATION_MISMATCH);
      expect(ruleIds).toContain(KNOWN_RULE_IDS.DURATION_MISMATCH);
    });

    it('should have consistent rule IDs', () => {
      const ruleIds = getKnownRuleIds();
      const uniqueIds = new Set(ruleIds);
      expect(uniqueIds.size).toBe(ruleIds.length);
    });

    it('should retrieve rule definitions', () => {
      const definitions = getRuleDefinitions();
      expect(definitions).toBeInstanceOf(Array);
      expect(definitions.length).toBeGreaterThan(0);
      
      for (const def of definitions) {
        expect(def.ruleId).toBeDefined();
        expect(def.category).toBeDefined();
        expect(def.severity).toBeDefined();
        expect(typeof def.check).toBe('function');
        expect(typeof def.createRule).toBe('function');
      }
    });

    it('should retrieve specific rule definition by ID', () => {
      const def = getRuleDefinition(KNOWN_RULE_IDS.BRAND_NO_KIT);
      expect(def).not.toBeNull();
      expect(def?.ruleId).toBe(KNOWN_RULE_IDS.BRAND_NO_KIT);
      expect(def?.category).toBe('brand');
      
      const nonExistent = getRuleDefinition('non-existent' as KnownRuleId);
      expect(nonExistent).toBeNull();
    });
  });

  describe('computeBrandReadiness', () => {
    it('should report missing brand kit when no brand data exists', () => {
      const composition = createComposition();
      const project = createProject('no-brand-project', 'comp-1', { 'comp-1': composition });
      const snapshot = createSnapshot(project);
      
      const brandReadiness = computeBrandReadiness(snapshot);
      
      expect(brandReadiness.projectId).toBe('no-brand-project');
      expect(brandReadiness.hasBrandKit).toBe(false);
      expect(brandReadiness.brandCompleteness).toBe('none');
      expect(brandReadiness.colorsAvailable).toBe(false);
      expect(brandReadiness.fontsAvailable).toBe(false);
      expect(brandReadiness.logoAvailable).toBe(false);
      expect(brandReadiness.voiceInstructionsAvailable).toBe(false);
      expect(brandReadiness.toneInstructionsAvailable).toBe(false);
      expect(brandReadiness.prohibitedClaims).toEqual([]);
      expect(brandReadiness.prohibitedEffects).toEqual([]);
      expect(brandReadiness.missingComponents).toContain('colors');
      expect(brandReadiness.missingComponents).toContain('fonts');
      expect(brandReadiness.missingComponents).toContain('logo');
      
      // Should have rules triggered for missing brand
      const hasBrandRules = brandReadiness.warnings.some(w => w.ruleId === KNOWN_RULE_IDS.BRAND_NO_KIT);
      expect(hasBrandRules).toBe(true);
    });

    it('should preserve unknown/missing data truthfully', () => {
      const composition = createComposition();
      const project = createProject('unknown-brand-project', 'comp-1', { 'comp-1': composition });
      const snapshot = createSnapshot(project);
      
      const brandReadiness = computeBrandReadiness(snapshot);
      
      // Should not fabricate brand data
      expect(brandReadiness.colorsAvailable).toBe(false);
      expect(brandReadiness.fontsAvailable).toBe(false);
      expect(brandReadiness.logoAvailable).toBe(false);
      expect(brandReadiness.voiceInstructionsAvailable).toBe(false);
      expect(brandReadiness.toneInstructionsAvailable).toBe(false);
      expect(brandReadiness.prohibitedClaims).toEqual([]);
      expect(brandReadiness.prohibitedEffects).toEqual([]);
    });

    it('should include evidence references', () => {
      const composition = createComposition();
      const project = createProject('evidence-test', 'comp-1', { 'comp-1': composition });
      const snapshot = createSnapshot(project);
      
      const brandReadiness = computeBrandReadiness(snapshot);
      
      expect(brandReadiness.evidence).toBeInstanceOf(Array);
      expect(brandReadiness.evidence.length).toBeGreaterThan(0);
      expect(brandReadiness.evidence[0]!.id).toBe('evidence-test');
    });
  });

  describe('computeSceneCoverages', () => {
    it('should detect narration without captions', () => {
      const narrationClip = createVideoClip('narration-clip', 0, 2_000_000, 'asset-narration');
      const narrationTrack = createTrack('narration-track', 'video', [narrationClip], 'visual');
      
      const composition = createComposition('comp-1', 1920, 1080, 2_000_000, r(30, 1), [narrationTrack]);
      
      const project = createProject('no-captions-test', 'comp-1', { 'comp-1': composition }, {
        'asset-narration': createAsset('asset-narration', 'video', 'Narration', 2_000_000),
      });
      
      const snapshot = createSnapshot(project);
      const sceneCoverages = computeSceneCoverages(snapshot);
      
      expect(sceneCoverages).toBeInstanceOf(Array);
      expect(sceneCoverages.length).toBeGreaterThan(0);
      
      const firstScene = sceneCoverages[0]!;
      expect(firstScene.hasCaptions).toBe(false);
      expect(firstScene.captionWordCount).toBe(0);
      expect(firstScene.captionCoverageRatio).toBe(0);
    });

    it('should correctly identify scenes with captions', () => {
      const videoClip = createVideoClip('video-clip', 0, 2_000_000, 'asset-video');
      const videoTrack = createTrack('video-track', 'video', [videoClip], 'visual');
      
      const captionClip = createCaptionClip('caption-clip', 0, 2_000_000, 'caption-doc-1');
      const captionTrack = createTrack('caption-track', 'caption', [captionClip], 'visual');
      
      const composition = createComposition('comp-1', 1920, 1080, 2_000_000, r(30, 1), [videoTrack, captionTrack]);
      
      const captionDoc = createCaptionDocument('caption-doc-1', 'en-US', [
        { id: 'seg-1', startUs: 0, endUs: 2_000_000, wordIds: ['word-1', 'word-2'] },
      ], {
        'word-1': { id: 'word-1', text: 'Hello', startUs: 0, endUs: 1_000_000 },
        'word-2': { id: 'word-2', text: 'World', startUs: 1_000_000, endUs: 2_000_000 },
      });
      
      const project = createProject('with-captions-test', 'comp-1', { 'comp-1': composition }, {
        'asset-video': createAsset('asset-video', 'video', 'Video', 2_000_000),
      }, [], { 'caption-doc-1': captionDoc });
      
      const snapshot = createSnapshot(project);
      const sceneCoverages = computeSceneCoverages(snapshot);
      
      expect(sceneCoverages).toBeInstanceOf(Array);
      expect(sceneCoverages.length).toBeGreaterThan(0);
      
      const firstScene = sceneCoverages[0]!;
      expect(firstScene.hasCaptions).toBe(true);
      expect(firstScene.captionWordCount).toBeGreaterThan(0);
      expect(firstScene.captionLocale).toBe('en-US');
      expect(firstScene.captionCoverageRatio).toBe(1.0);
      expect(firstScene.hasVisualElements).toBe(true);
    });

    it('should preserve Persian/RTL caption locale in coverage', () => {
      const videoClip = createVideoClip('video-clip', 0, 1_000_000, 'asset-video');
      const videoTrack = createTrack('video-track', 'video', [videoClip], 'visual');
      
      const captionClip = createCaptionClip('caption-clip', 0, 1_000_000, 'caption-doc-1');
      const captionTrack = createTrack('caption-track', 'caption', [captionClip], 'visual');
      
      const composition = createComposition('comp-1', 1920, 1080, 1_000_000, r(30, 1), [videoTrack, captionTrack]);
      
      const captionDoc = createCaptionDocument('caption-doc-1', 'fa-IR', [
        { id: 'seg-1', startUs: 0, endUs: 1_000_000, wordIds: ['word-1'] },
      ], {
        'word-1': { id: 'word-1', text: 'سلام', startUs: 0, endUs: 1_000_000 },
      });
      
      const project = createProject('persian-coverage-test', 'comp-1', { 'comp-1': composition }, {
        'asset-video': createAsset('asset-video', 'video', 'Video', 1_000_000),
      }, [], { 'caption-doc-1': captionDoc });
      
      const snapshot = createSnapshot(project);
      const sceneCoverages = computeSceneCoverages(snapshot);
      
      expect(sceneCoverages).toBeInstanceOf(Array);
      expect(sceneCoverages.length).toBeGreaterThan(0);
      
      const firstScene = sceneCoverages[0]!;
      expect(firstScene.captionLocale).toBe('fa-IR');
      expect(firstScene.hasCaptions).toBe(true);
    });

    it('should include evidence for coverage claims', () => {
      const composition = createComposition();
      const project = createProject('evidence-coverage-test', 'comp-1', { 'comp-1': composition });
      const snapshot = createSnapshot(project);
      
      const sceneCoverages = computeSceneCoverages(snapshot);
      
      expect(sceneCoverages).toBeInstanceOf(Array);
      for (const coverage of sceneCoverages) {
        expect(coverage.evidence).toBeInstanceOf(Array);
        expect(coverage.evidence.length).toBeGreaterThan(0);
        expect(coverage.evidence[0]!.id).toBe(coverage.sceneId);
      }
    });
  });

  describe('computeProjectReadiness', () => {
    it('should report destination aspect ratio mismatch', () => {
      const composition = createComposition('comp-1', 1920, 1080, 15_000_000, r(30, 1), []);
      
      const project = createProject(
        'mismatch-test',
        'comp-1',
        { 'comp-1': composition },
        {},
        [],
        {}
      );
      
      const snapshot = createSnapshot(project, 'rev-1', { destination: 'instagram-reel', durationTargetUs: 15_000_000 });
      const projectReadiness = computeProjectReadiness(snapshot);
      
      expect(projectReadiness.projectId).toBe('mismatch-test');
      expect(projectReadiness.destination).toBe('instagram-reel');
      expect(projectReadiness.aspectRatio).toBe('16:9');
      expect(projectReadiness.aspectRatioAligned).toBe(false);
      expect(projectReadiness.destinationAligned).toBe(false);
      expect(projectReadiness.aspectRatioMismatch).toEqual({ expected: '9:16', actual: '16:9' });
      expect(projectReadiness.destinationMismatch).toEqual({ expected: '9:16', actual: '16:9' });
      expect(projectReadiness.durationAligned).toBe(true);
      expect(projectReadiness.readinessLevel).toBe('partial');
    });

    it('should report correct alignment for matching destination', () => {
      const composition = createComposition('comp-1', 1080, 1920, 15_000_000, r(30, 1), []);
      
      const project = createProject(
        'aligned-test',
        'comp-1',
        { 'comp-1': composition },
        {},
        [],
        {}
      );
      
      const snapshot = createSnapshot(project, 'rev-1', { destination: 'instagram-reel', durationTargetUs: 15_000_000 });
      const projectReadiness = computeProjectReadiness(snapshot);
      
      expect(projectReadiness.destination).toBe('instagram-reel');
      expect(projectReadiness.aspectRatio).toBe('9:16');
      expect(projectReadiness.aspectRatioAligned).toBe(true);
      expect(projectReadiness.destinationAligned).toBe(true);
      expect(projectReadiness.durationAligned).toBe(true);
      expect(projectReadiness.aspectRatioMismatch).toBeUndefined();
      expect(projectReadiness.destinationMismatch).toBeUndefined();
      expect(projectReadiness.durationGapUs).toBe(0);
    });

    it('should report duration mismatch', () => {
      const composition = createComposition('comp-1', 1920, 1080, 10_000_000, r(30, 1), []);
      
      const project = createProject(
        'duration-mismatch-test',
        'comp-1',
        { 'comp-1': composition },
        {},
        [],
        {}
      );
      
      const snapshot = createSnapshot(project, 'rev-1', { destination: 'youtube', durationTargetUs: 15_000_000 });
      const projectReadiness = computeProjectReadiness(snapshot);
      
      expect(projectReadiness.compositionDurationUs).toBe(10_000_000);
      expect(projectReadiness.durationTargetUs).toBe(15_000_000);
      expect(projectReadiness.durationAligned).toBe(false);
      expect(projectReadiness.durationGapUs).toBe(-5_000_000);
    });

    it('should report unknown readiness when no goal is specified', () => {
      const composition = createComposition();
      const project = createProject('no-goal-test', 'comp-1', { 'comp-1': composition });
      
      const snapshot = createSnapshot(project);
      const projectReadiness = computeProjectReadiness(snapshot);
      
      expect(projectReadiness.destination).toBeUndefined();
      expect(projectReadiness.durationTargetUs).toBeUndefined();
      expect(projectReadiness.readinessLevel).toBe('unknown');
    });

    it('should report aggregate scene coverage', () => {
      const composition = createComposition();
      const project = createProject('aggregate-test', 'comp-1', { 'comp-1': composition });
      
      const snapshot = createSnapshot(project);
      const projectReadiness = computeProjectReadiness(snapshot);
      
      expect(projectReadiness.sceneCount).toBeGreaterThanOrEqual(0);
      expect(projectReadiness.scenesWithVisuals).toBeGreaterThanOrEqual(0);
      expect(projectReadiness.scenesWithAudio).toBeGreaterThanOrEqual(0);
      expect(projectReadiness.scenesWithCaptions).toBeGreaterThanOrEqual(0);
    });

    it('should include evidence for readiness claims', () => {
      const composition = createComposition();
      const project = createProject('readiness-evidence-test', 'comp-1', { 'comp-1': composition });
      
      const snapshot = createSnapshot(project);
      const projectReadiness = computeProjectReadiness(snapshot);
      
      expect(projectReadiness.evidence).toBeInstanceOf(Array);
      expect(projectReadiness.evidence.length).toBeGreaterThan(0);
    });
  });

  describe('computeSemanticIntelligence', () => {
    it('should return all S2 components from a snapshot', () => {
      const composition = createComposition();
      const project = createProject('full-test', 'comp-1', { 'comp-1': composition });
      const snapshot = createSnapshot(project);
      
      const intelligence = computeSemanticIntelligence(snapshot);
      
      expect(intelligence).toBeDefined();
      expect(intelligence.brandReadiness).toBeDefined();
      expect(intelligence.sceneCoverages).toBeDefined();
      expect(intelligence.projectReadiness).toBeDefined();
      expect(intelligence.allRules).toBeDefined();
      
      expect(intelligence.brandReadiness.projectId).toBe('full-test');
      expect(intelligence.sceneCoverages).toBeInstanceOf(Array);
      expect(intelligence.projectReadiness.projectId).toBe('full-test');
      expect(intelligence.allRules).toBeInstanceOf(Array);
    });

    it('should produce deterministic output for identical snapshots', () => {
      const composition = createComposition();
      const project = createProject('deterministic-test', 'comp-1', { 'comp-1': composition });
      const snapshot = createSnapshot(project);
      
      const intelligence1 = computeSemanticIntelligence(snapshot);
      const intelligence2 = computeSemanticIntelligence(snapshot);
      
      expect(intelligence1).toEqual(intelligence2);
    });

    it('should have rules with valid evidence', () => {
      const composition = createComposition();
      const project = createProject('evidence-valid-test', 'comp-1', { 'comp-1': composition });
      const snapshot = createSnapshot(project);
      
      const intelligence = computeSemanticIntelligence(snapshot);
      
      for (const rule of intelligence.allRules) {
        expect(rule.evidence.length).toBeGreaterThan(0);
        for (const evidence of rule.evidence) {
          expect(evidence.id).toBeDefined();
          expect(evidence.kind).toBeDefined();
        }
      }
    });

    it('should have rules with stable deterministic ordering', () => {
      const composition = createComposition();
      const project = createProject('ordering-test', 'comp-1', { 'comp-1': composition });
      const snapshot = createSnapshot(project);
      
      const intelligence1 = computeSemanticIntelligence(snapshot);
      const intelligence2 = computeSemanticIntelligence(snapshot);
      
      expect(intelligence1.allRules).toEqual(intelligence2.allRules);
    });

    it('should not include subjective creative claims in rules', () => {
      const composition = createComposition();
      const project = createProject('no-subjectivity-test', 'comp-1', { 'comp-1': composition });
      const snapshot = createSnapshot(project);
      
      const intelligence = computeSemanticIntelligence(snapshot);
      
      const subjectiveTerms = ['premium', 'luxury', 'cinematic', 'weak', 'on-brand', 'beautiful', 'ugly', 'good', 'bad'];
      for (const rule of intelligence.allRules) {
        const messageLower = rule.message.toLowerCase();
        for (const term of subjectiveTerms) {
          expect(messageLower).not.toContain(term);
        }
      }
    });

    it('should have rules with suggestedIntent that are non-executable', () => {
      const composition = createComposition();
      const project = createProject('intent-test', 'comp-1', { 'comp-1': composition });
      const snapshot = createSnapshot(project);
      
      const intelligence = computeSemanticIntelligence(snapshot);
      
      for (const rule of intelligence.allRules) {
        if (rule.suggestedIntent) {
          const intentLower = rule.suggestedIntent.toLowerCase();
          expect(intentLower).not.toContain('http://');
          expect(intentLower).not.toContain('https://');
          expect(intentLower).not.toContain('execute');
          expect(intentLower).not.toContain('run');
          expect(intentLower).not.toContain('command');
        }
      }
    });
  });

  describe('Security and Purity', () => {
    it('should not expose paths, URLs, or secrets in output', () => {
      const composition = createComposition();
      const project = createProject('security-test', 'comp-1', { 'comp-1': composition });
      const snapshot = createSnapshot(project);
      
      const intelligence = computeSemanticIntelligence(snapshot);
      
      const json = JSON.stringify(intelligence);
      
      const forbiddenPatterns = [
        /^\//,
        /^[a-zA-Z]:\\/,
        /^\\\\/,
        /^https?:\/\//,
        /^ftp:\/\//,
        /^s3:\/\//,
        /^gs:\/\//,
        /^az:\/\//,
        /sk-/i,
        /pk-/i,
        /bearer\s+/i,
        /password/i,
        /secret/i,
        /token/i,
      ];
      
      for (const pattern of forbiddenPatterns) {
        expect(json).not.toMatch(pattern);
      }
    });

    it('should have pure functions with no side effects', () => {
      const composition = createComposition();
      const project = createProject('purity-test', 'comp-1', { 'comp-1': composition });
      const snapshot = createSnapshot(project);
      
      const intelligence1 = computeSemanticIntelligence(snapshot);
      const intelligence2 = computeSemanticIntelligence(snapshot);
      const intelligence3 = computeSemanticIntelligence(snapshot);
      
      expect(intelligence1).toEqual(intelligence2);
      expect(intelligence2).toEqual(intelligence3);
    });

    it('should produce byte-stable output for identical snapshots', () => {
      const composition = createComposition();
      const project = createProject('byte-stable-test', 'comp-1', { 'comp-1': composition });
      const snapshot = createSnapshot(project);
      
      const intelligence1 = computeSemanticIntelligence(snapshot);
      const intelligence2 = computeSemanticIntelligence(snapshot);
      
      const json1 = JSON.stringify(intelligence1);
      const json2 = JSON.stringify(intelligence2);
      
      expect(json1).toBe(json2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle blank project', () => {
      const composition = createComposition();
      const project = createProject('blank-test', 'comp-1', { 'comp-1': composition });
      const snapshot = createSnapshot(project);
      
      const intelligence = computeSemanticIntelligence(snapshot);
      
      expect(intelligence.brandReadiness).toBeDefined();
      expect(intelligence.sceneCoverages).toBeDefined();
      expect(intelligence.projectReadiness).toBeDefined();
      expect(intelligence.allRules).toBeDefined();
      
      expect(intelligence.projectReadiness.readinessLevel).toBeOneOf(['unknown', 'partial']);
    });

    it('should handle mixed visual/audio project', () => {
      const videoTrack = createTrack('video-track', 'video', [
        createVideoClip('video-clip-1', 0, 2_000_000, 'asset-video-1'),
        createVideoClip('video-clip-2', 2_000_000, 2_000_000, 'asset-video-2'),
      ], 'visual');

      const audioTrack = createTrack('audio-track', 'audio', [
        createVideoClip('audio-clip-1', 0, 4_000_000, 'asset-audio-1'),
      ], 'audio');

      const composition = createComposition('comp-1', 1920, 1080, 4_000_000, r(30, 1), [videoTrack, audioTrack]);
      const project = createProject('mixed-test', 'comp-1', {
        'comp-1': composition,
      }, {
        'asset-video-1': createAsset('asset-video-1', 'video', 'Video 1', 2_000_000),
        'asset-video-2': createAsset('asset-video-2', 'video', 'Video 2', 2_000_000),
        'asset-audio-1': createAsset('asset-audio-1', 'audio', 'Audio 1', 4_000_000),
      });

      const snapshot = createSnapshot(project);
      const intelligence = computeSemanticIntelligence(snapshot);
      
      expect(intelligence.projectReadiness.scenesWithVisuals).toBeGreaterThan(0);
      expect(intelligence.projectReadiness.scenesWithAudio).toBeGreaterThan(0);
    });

    it('should handle WP-36 track states', () => {
      const composition = createComposition();
      const project = createProject('wp36-test', 'comp-1', { 'comp-1': composition });
      
      const snapshot = createSnapshot(project);
      const intelligence = computeSemanticIntelligence(snapshot);
      
      expect(intelligence.brandReadiness).toBeDefined();
      expect(intelligence.sceneCoverages).toBeDefined();
      expect(intelligence.projectReadiness).toBeDefined();
    });
  });
});
