/**
 * Semantic Project Snapshot V1 Tests
 * WP-37 S1: Semantic Project Intelligence and Critique
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JoyProjectV1, CompositionV1, TrackV1, ClipV1, AssetRecordV1, MarkerV1, CaptionDocumentV1 } from './v1.js';
import type { Rational } from './time.js';
import {
  projectToSemanticSnapshot,
  validateSemanticProjectSnapshot,
  segmentCompositionIntoScenes,
} from './semantic-snapshot-impl.js';
import type {
  SemanticProjectSnapshotV1,
  ProjectRevisionId,
} from './semantic-snapshot.js';

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

// Minimal valid composition clip
function createCompositionClip(
  id: string = 'clip-1',
  startUs: number = 0,
  durationUs: number = 1_000_000,
  compositionId: string = 'comp-2',
): ClipV1 {
  return {
    kind: 'composition',
    id,
    startUs,
    durationUs,
    compositionId,
    childOffsetUs: 0,
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
    variables: {},
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

// ==========================================================================
// Test Suites
// ==========================================================================

describe('semantic-snapshot', () => {
  describe('projectToSemanticSnapshot', () => {
    // Test 1: Blank project
    it('should handle a blank project with no tracks or clips', () => {
      const composition = createComposition();
      const project = createProject('blank-project', 'comp-1', { 'comp-1': composition });
      const revisionId: ProjectRevisionId = 'local-revision:v1:blank-project:timeline=1:document=1:graph=1:artifacts=1';

      const snapshot = projectToSemanticSnapshot(project, revisionId);

      expect(snapshot.schemaVersion).toBe(1);
      expect(snapshot.projectId).toBe('blank-project');
      expect(snapshot.revisionId).toBe(revisionId);
      expect(snapshot.composition.durationUs).toBe(10_000_000);
      expect(snapshot.composition.width).toBe(1920);
      expect(snapshot.composition.height).toBe(1080);
      expect(snapshot.composition.frameRate).toEqual({ num: 30, den: 1 });
      expect(snapshot.scenes).toBeInstanceOf(Array);
      expect(snapshot.scenes.length).toBeGreaterThan(0);
      expect(snapshot.timeline.visualTrackCount).toBe(0);
      expect(snapshot.assets).toEqual([]);
      expect(snapshot.warnings).toBeInstanceOf(Array);
      expect(snapshot.truncation).toBeDefined();
    });

    // Test 2: Mixed visual/audio project
    it('should correctly describe a mixed visual and audio project', () => {
      const videoTrack = createTrack('video-track', 'video', [
        createVideoClip('video-clip-1', 0, 2_000_000, 'asset-video-1'),
        createVideoClip('video-clip-2', 2_000_000, 2_000_000, 'asset-video-2'),
      ], 'visual');

      const audioTrack = createTrack('audio-track', 'audio', [
        createVideoClip('audio-clip-1', 0, 4_000_000, 'asset-audio-1'),
      ], 'audio');

      const composition = createComposition('comp-1', 1920, 1080, 4_000_000, r(30, 1), [videoTrack, audioTrack]);
      const project = createProject('mixed-project', 'comp-1', {
        'comp-1': composition,
      }, {
        'asset-video-1': createAsset('asset-video-1', 'video', 'Video 1', 2_000_000),
        'asset-video-2': createAsset('asset-video-2', 'video', 'Video 2', 2_000_000),
        'asset-audio-1': createAsset('asset-audio-1', 'audio', 'Audio 1', 4_000_000),
      });

      const revisionId: ProjectRevisionId = 'local-revision:v1:mixed-project:timeline=1:document=1:graph=1:artifacts=1';
      const snapshot = projectToSemanticSnapshot(project, revisionId);

      expect(snapshot.timeline.visualTrackCount).toBe(1);
      expect(snapshot.timeline.audioTrackCount).toBe(1);
      expect(snapshot.timeline.totalClipCount).toBe(3);
      expect(snapshot.assets.length).toBe(3);
      expect(snapshot.assets.some(a => a.kind === 'video')).toBe(true);
      expect(snapshot.assets.some(a => a.kind === 'audio')).toBe(true);
    });

    // Test 3: Persian/RTL captions
    it('should preserve Persian/RTL caption text', () => {
      const track = createTrack('caption-track', 'caption', [
        createCaptionClip('caption-clip-1', 0, 1_000_000, 'caption-doc-1'),
      ], 'visual');

      const composition = createComposition('comp-1', 1920, 1080, 1_000_000, r(30, 1), [track]);

      // Persian text with RTL direction
      const captionDoc = createCaptionDocument('caption-doc-1', 'fa-IR', [
        {
          id: 'seg-1',
          startUs: 0,
          endUs: 1_000_000,
          wordIds: ['word-1', 'word-2'],
        },
      ], {
        'word-1': { id: 'word-1', text: 'سلام', startUs: 0, endUs: 500_000 },
        'word-2': { id: 'word-2', text: 'دنیا', startUs: 500_000, endUs: 1_000_000 },
      });

      const project = createProject('persian-project', 'comp-1', {
        'comp-1': composition,
      }, {}, [], { 'caption-doc-1': captionDoc });

      const revisionId: ProjectRevisionId = 'local-revision:v1:persian-project:timeline=1:document=1:graph=1:artifacts=1';
      const snapshot = projectToSemanticSnapshot(project, revisionId);

      expect(snapshot.scenes.length).toBeGreaterThan(0);
      // The caption coverage should have the Persian locale
      const sceneWithCaptions = snapshot.scenes.find(s => s.captionCoverage?.hasCaptions);
      expect(sceneWithCaptions).toBeDefined();
      expect(sceneWithCaptions?.captionCoverage?.locale).toBe('fa-IR');
    });

    // Test 4: Generated asset provenance
    it('should capture generated asset provenance', () => {
      const assetWithProvenance: AssetRecordV1 = {
        id: 'generated-asset-1',
        kind: 'image',
        displayName: 'Generated Image',
        generationProvenance: {
          providerId: 'provider-comfy',
          modelId: 'sdxl-1.0',
          modelVersion: '1.0',
          prompt: 'A beautiful sunset',
          inputAssetHashes: [],
          parameters: {},
          generatedAssetId: 'generated-asset-1',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      };

      const track = createTrack('video-track', 'video', [
        createVideoClip('clip-1', 0, 1_000_000, 'generated-asset-1'),
      ]);

      const composition = createComposition('comp-1', 1920, 1080, 1_000_000, r(30, 1), [track]);
      const project = createProject('generated-project', 'comp-1', {
        'comp-1': composition,
      }, {
        'generated-asset-1': assetWithProvenance,
      });

      const revisionId: ProjectRevisionId = 'local-revision:v1:generated-project:timeline=1:document=1:graph=1:artifacts=1';
      const snapshot = projectToSemanticSnapshot(project, revisionId);

      expect(snapshot.assets.length).toBe(1);
      expect(snapshot.assets[0]!.hasProvenance).toBe(true);
      expect(snapshot.assets[0]!.isGenerated).toBe(true);
      expect(snapshot.assets[0]!.providerId).toBe('provider-comfy');
      expect(snapshot.assets[0]!.modelId).toBe('sdxl-1.0');
      expect(snapshot.capabilities['generated-assets']).toBe('ready');
    });

    // Test 5: Locked/hidden WP-36 tracks
    it('should capture WP-36 track lock and visibility state', () => {
      const lockedTrack: TrackV1 = {
        ...createTrack('locked-track', 'video', [], 'visual'),
        locked: true,
      };

      const hiddenTrack: TrackV1 = {
        ...createTrack('hidden-track', 'video', [], 'visual'),
        enabled: false,
      };

      const composition = createComposition('comp-1', 1920, 1080, 1_000_000, r(30, 1), [
        lockedTrack,
        hiddenTrack,
      ]);

      const project = createProject('wp36-tracks-project', 'comp-1', { 'comp-1': composition });
      const revisionId: ProjectRevisionId = 'local-revision:v1:wp36-tracks-project:timeline=1:document=1:graph=1:artifacts=1';

      const snapshot = projectToSemanticSnapshot(project, revisionId);

      expect(snapshot.timeline.visualTrackCount).toBe(2);
      expect(snapshot.timeline.visualRowIds).toContain('locked-track');
      expect(snapshot.timeline.visualRowIds).toContain('hidden-track');
    });

    // Test 6: Byte-stable result for identical canonical state
    it('should produce byte-stable snapshot for identical project and revision', () => {
      const track = createTrack('track-1', 'video', [
        createVideoClip('clip-1', 0, 1_000_000, 'asset-1'),
      ]);

      const composition = createComposition('comp-1', 1920, 1080, 1_000_000, r(30, 1), [track]);
      const project = createProject('stable-project', 'comp-1', {
        'comp-1': composition,
      }, {
        'asset-1': createAsset('asset-1', 'video', 'Asset 1', 1_000_000),
      });

      const revisionId: ProjectRevisionId = 'local-revision:v1:stable-project:timeline=1:document=1:graph=1:artifacts=1';

      // Create snapshot with deterministic clock
      const clock = () => '2026-01-01T00:00:00.000Z';
      const snapshot1 = projectToSemanticSnapshot(project, revisionId, { clock });
      const snapshot2 = projectToSemanticSnapshot(project, revisionId, { clock });

      // Should be byte-stable
      const json1 = JSON.stringify(snapshot1);
      const json2 = JSON.stringify(snapshot2);
      expect(json1).toBe(json2);
    });

    // Test 7: Different revision yields distinct snapshot
    it('should produce different snapshot for changed revision', () => {
      const track = createTrack('track-1', 'video', [
        createVideoClip('clip-1', 0, 1_000_000, 'asset-1'),
      ]);

      const composition = createComposition('comp-1', 1920, 1080, 1_000_000, r(30, 1), [track]);
      const project = createProject('revision-project', 'comp-1', {
        'comp-1': composition,
      }, {
        'asset-1': createAsset('asset-1', 'video', 'Asset 1', 1_000_000),
      });

      const revisionId1: ProjectRevisionId = 'local-revision:v1:revision-project:timeline=1:document=1:graph=1:artifacts=1';
      const revisionId2: ProjectRevisionId = 'local-revision:v1:revision-project:timeline=2:document=1:graph=1:artifacts=1';

      const clock = () => '2026-01-01T00:00:00.000Z';
      const snapshot1 = projectToSemanticSnapshot(project, revisionId1, { clock });
      const snapshot2 = projectToSemanticSnapshot(project, revisionId2, { clock });

      expect(snapshot1.revisionId).toBe(revisionId1);
      expect(snapshot2.revisionId).toBe(revisionId2);
      expect(snapshot1.revisionId).not.toBe(snapshot2.revisionId);
    });

    // Test 8: No mutation of project bytes
    it('should not mutate the input project', () => {
      const track = createTrack('track-1', 'video', [
        createVideoClip('clip-1', 0, 1_000_000, 'asset-1'),
      ]);

      const composition = createComposition('comp-1', 1920, 1080, 1_000_000, r(30, 1), [track]);
      const project = createProject('no-mutation-project', 'comp-1', {
        'comp-1': composition,
      }, {
        'asset-1': createAsset('asset-1', 'video', 'Asset 1', 1_000_000),
      });

      // Deep clone the project to compare
      const projectBefore = JSON.parse(JSON.stringify(project));

      const revisionId: ProjectRevisionId = 'local-revision:v1:no-mutation-project:timeline=1:document=1:graph=1:artifacts=1';
      projectToSemanticSnapshot(project, revisionId);

      // Project should be unchanged
      const projectAfter = JSON.parse(JSON.stringify(project));
      expect(projectBefore).toEqual(projectAfter);
    });

    // Test 9: Truncation with oversized project
    it('should handle oversized project with truncation', () => {
      // Create a project with many clips
      const clips: ClipV1[] = [];
      for (let i = 0; i < 100; i++) {
        clips.push(createVideoClip(`clip-${i}`, i * 100_000, 100_000, `asset-${i}`));
      }

      const track = createTrack('track-1', 'video', clips, 'visual');
      const composition = createComposition('comp-1', 1920, 1080, 10_000_000, r(30, 1), [track]);

      const assets: Record<string, AssetRecordV1> = {};
      for (let i = 0; i < 100; i++) {
        assets[`asset-${i}`] = createAsset(`asset-${i}`, 'video', `Asset ${i}`, 100_000);
      }

      const project = createProject('oversized-project', 'comp-1', {
        'comp-1': composition,
      }, assets);

      const revisionId: ProjectRevisionId = 'local-revision:v1:oversized-project:timeline=1:document=1:graph=1:artifacts=1';
      const snapshot = projectToSemanticSnapshot(project, revisionId, {
        maxScenes: 5,
        maxAssets: 10,
        maxClipsPerScene: 5,
      });

      expect(snapshot.scenes.length).toBeLessThanOrEqual(5);
      expect(snapshot.assets.length).toBeLessThanOrEqual(10);
      expect(snapshot.truncation.assetsOmitted).toBeGreaterThan(0);
      expect(snapshot.warnings.some(w => w.code === 'truncated')).toBe(true);
    });

    // Test 10: Security - no forbidden data in output
    it('should reject projects with forbidden path/secret data', () => {
      // Create a malicious project with path-like data
      const projectWithPath = {
        ...createProject('malicious-project'),
        id: '/path/to/project', // Invalid - path-like
      } as unknown as JoyProjectV1;

      const revisionId: ProjectRevisionId = 'local-revision:v1:malicious-project:timeline=1:document=1:graph=1:artifacts=1';

      // This should throw due to forbidden data validation
      expect(() => {
        projectToSemanticSnapshot(projectWithPath, revisionId);
      }).toThrow();
    });

    // Test 11: Validation - reject malformed IDs/ranges
    it('should reject snapshots with invalid scene ranges via validation', () => {
      const invalidSnapshot = {
        schemaVersion: 1,
        projectId: 'test',
        revisionId: 'rev-1',
        capturedAt: '2026-01-01T00:00:00.000Z',
        composition: {
          durationUs: 1000,
          frameRate: { num: 30, den: 1 },
          width: 1920,
          height: 1080,
          aspectRatio: '16:9',
        },
        brand: {
          hasBrandKit: false,
          colorsAvailable: false,
          fontsAvailable: false,
          logoAvailable: false,
          voiceInstructionsAvailable: false,
          toneInstructionsAvailable: false,
          prohibitedClaims: [],
          prohibitedEffects: [],
          warnings: [],
        },
        scenes: [
          {
            id: 'scene-1',
            startUs: 1000, // Invalid: startUs >= endUs
            endUs: 500,
            purpose: 'unknown',
            elements: [],
            visualCoverage: 'none',
            evidence: [],
          },
        ],
        timeline: {
          compositionId: 'comp-1',
          durationUs: 1000,
          frameRate: { num: 30, den: 1 },
          width: 1920,
          height: 1080,
          aspectRatio: '16:9',
          visualTrackCount: 0,
          audioTrackCount: 0,
          totalClipCount: 0,
          visualRowIds: [],
          audioRowIds: [],
        },
        assets: [],
        capabilities: {},
        warnings: [],
        truncation: {
          clipsOmitted: 0,
          assetsOmitted: 0,
          visualObjectsOmitted: 0,
          scenesOmitted: 0,
          totalEstimateBytes: 0,
        },
      };

      const result = validateSemanticProjectSnapshot(invalidSnapshot);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    // Test 12: Explicit marker boundaries preferred
    it('should prefer explicit marker boundaries over fallback boundaries', () => {
      const track = createTrack('track-1', 'video', [
        createVideoClip('clip-1', 0, 2_000_000, 'asset-1'),
        createVideoClip('clip-2', 2_000_000, 2_000_000, 'asset-1'),
      ]);

      const composition = createComposition('comp-1', 1920, 1080, 4_000_000, r(30, 1), [track]);

      // Add explicit scene markers
      const markers = [
        createMarker('marker-1', 1_000_000, 'Scene 1'),
        createMarker('marker-2', 3_000_000, 'Scene 2'),
      ];

      const project = createProject('marker-project', 'comp-1', {
        'comp-1': composition,
      }, {
        'asset-1': createAsset('asset-1', 'video', 'Asset 1', 4_000_000),
      }, markers);

      const revisionId: ProjectRevisionId = 'local-revision:v1:marker-project:timeline=1:document=1:graph=1:artifacts=1';
      const snapshot = projectToSemanticSnapshot(project, revisionId);

      // Should have scenes based on markers at 0, 1M, 3M, 4M
      expect(snapshot.scenes.length).toBeGreaterThanOrEqual(2);
      expect(snapshot.scenes.some(s => s.startUs === 1_000_000)).toBe(true);
      expect(snapshot.scenes.some(s => s.startUs === 3_000_000)).toBe(true);
    });

    // Test 13: Deterministic cuts and gaps segmentation
    it('should handle deterministic cuts and gap segmentation', () => {
      const track1 = createTrack('track-1', 'video', [
        createVideoClip('clip-1', 0, 1_000_000, 'asset-1'),
        createVideoClip('clip-2', 2_000_000, 1_000_000, 'asset-2'), // Gap from 1M to 2M
      ]);

      const track2 = createTrack('track-2', 'video', [
        createVideoClip('clip-3', 1_000_000, 1_000_000, 'asset-3'),
      ]);

      const composition = createComposition('comp-1', 1920, 1080, 3_000_000, r(30, 1), [track1, track2]);

      const project = createProject('cuts-gaps-project', 'comp-1', {
        'comp-1': composition,
      }, {
        'asset-1': createAsset('asset-1', 'video', 'Asset 1', 1_000_000),
        'asset-2': createAsset('asset-2', 'video', 'Asset 2', 1_000_000),
        'asset-3': createAsset('asset-3', 'video', 'Asset 3', 1_000_000),
      });

      const revisionId: ProjectRevisionId = 'local-revision:v1:cuts-gaps-project:timeline=1:document=1:graph=1:artifacts=1';
      const snapshot = projectToSemanticSnapshot(project, revisionId);

      // Should detect scenes based on cuts and gaps
      expect(snapshot.scenes.length).toBeGreaterThanOrEqual(1);
    });

    // Test 14: Unavailable asset details
    it('should handle unavailable asset details gracefully', () => {
      const track = createTrack('track-1', 'video', [
        createVideoClip('clip-1', 0, 1_000_000, 'missing-asset'),
      ]);

      const composition = createComposition('comp-1', 1920, 1080, 1_000_000, r(30, 1), [track]);

      // Asset not in assets map - unavailable
      const project = createProject('unavailable-project', 'comp-1', {
        'comp-1': composition,
      }, {});

      const revisionId: ProjectRevisionId = 'local-revision:v1:unavailable-project:timeline=1:document=1:graph=1:artifacts=1';
      const snapshot = projectToSemanticSnapshot(project, revisionId);

      expect(snapshot.assets.length).toBe(0);
      expect(snapshot.scenes.length).toBeGreaterThan(0);
    });

    // Test 15: Capabilities detection
    it('should correctly detect capabilities', () => {
      const projectNoCaptions = createProject('no-captions', 'comp-1', {
        'comp-1': createComposition('comp-1'),
      });

      const revisionId: ProjectRevisionId = 'local-revision:v1:no-captions:timeline=1:document=1:graph=1:artifacts=1';
      const snapshot = projectToSemanticSnapshot(projectNoCaptions, revisionId);

      expect(snapshot.capabilities['semantic-snapshot']).toBe('ready');
      expect(snapshot.capabilities['scene-segmentation']).toBe('ready');
      expect(snapshot.capabilities['caption-detection']).toBe('unavailable');
    });
  });

  describe('segmentCompositionIntoScenes', () => {
    it('should create scenes from explicit markers', () => {
      const track = createTrack('track-1', 'video', [
        createVideoClip('clip-1', 0, 4_000_000, 'asset-1'),
      ]);

      const composition = createComposition('comp-1', 1920, 1080, 4_000_000, r(30, 1), [track]);

      const markers = [
        createMarker('marker-1', 1_000_000, 'Scene 1'),
        createMarker('marker-2', 3_000_000, 'Scene 2'),
      ];

      const scenes = segmentCompositionIntoScenes(composition, {}, markers);

      expect(scenes.length).toBe(3); // 0-1M, 1M-3M, 3M-4M
      expect(scenes[0]!.startUs).toBe(0);
      expect(scenes[0]!.endUs).toBe(1_000_000);
      expect(scenes[1]!.startUs).toBe(1_000_000);
      expect(scenes[1]!.endUs).toBe(3_000_000);
      expect(scenes[2]!.startUs).toBe(3_000_000);
      expect(scenes[2]!.endUs).toBe(4_000_000);
    });

    it('should respect maxScenes limit', () => {
      const track = createTrack('track-1', 'video', [
        createVideoClip('clip-1', 0, 100_000_000, 'asset-1'),
      ]);

      const composition = createComposition('comp-1', 1920, 1080, 100_000_000, r(30, 1), [track]);

      const markers: MarkerV1[] = [];
      for (let i = 0; i < 50; i++) {
        markers.push(createMarker(`marker-${i}`, i * 2_000_000, `Scene ${i}`));
      }

      const scenes = segmentCompositionIntoScenes(composition, {}, markers, { maxScenes: 10 });
      expect(scenes.length).toBeLessThanOrEqual(10);
    });
  });

  describe('validateSemanticProjectSnapshot', () => {
    it('should validate a valid snapshot', () => {
      const track = createTrack('track-1', 'video', [
        createVideoClip('clip-1', 0, 1_000_000, 'asset-1'),
      ]);

      const composition = createComposition('comp-1', 1920, 1080, 1_000_000, r(30, 1), [track]);
      const project = createProject('validation-project', 'comp-1', {
        'comp-1': composition,
      }, {
        'asset-1': createAsset('asset-1', 'video', 'Asset 1', 1_000_000),
      });

      const revisionId: ProjectRevisionId = 'local-revision:v1:validation-project:timeline=1:document=1:graph=1:artifacts=1';
      const snapshot = projectToSemanticSnapshot(project, revisionId);

      const result = validateSemanticProjectSnapshot(snapshot);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('should reject snapshot with missing projectId', () => {
      const invalidSnapshot = {
        schemaVersion: 1,
        // Missing projectId
        revisionId: 'rev-1',
        capturedAt: '2026-01-01T00:00:00.000Z',
        composition: {
          durationUs: 1000,
          frameRate: { num: 30, den: 1 },
          width: 1920,
          height: 1080,
          aspectRatio: '16:9',
        },
        brand: {
          hasBrandKit: false,
          colorsAvailable: false,
          fontsAvailable: false,
          logoAvailable: false,
          voiceInstructionsAvailable: false,
          toneInstructionsAvailable: false,
          prohibitedClaims: [],
          prohibitedEffects: [],
          warnings: [],
        },
        scenes: [],
        timeline: {
          compositionId: 'comp-1',
          durationUs: 1000,
          frameRate: { num: 30, den: 1 },
          width: 1920,
          height: 1080,
          aspectRatio: '16:9',
          visualTrackCount: 0,
          audioTrackCount: 0,
          totalClipCount: 0,
          visualRowIds: [],
          audioRowIds: [],
        },
        assets: [],
        capabilities: {},
        warnings: [],
        truncation: {
          clipsOmitted: 0,
          assetsOmitted: 0,
          visualObjectsOmitted: 0,
          scenesOmitted: 0,
          totalEstimateBytes: 0,
        },
      };

      const result = validateSemanticProjectSnapshot(invalidSnapshot);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('projectId'))).toBe(true);
    });

    it('should reject snapshot with forbidden data', () => {
      const snapshotWithPath = {
        schemaVersion: 1,
        projectId: '/path/to/project', // Forbidden path
        revisionId: 'rev-1',
        capturedAt: '2026-01-01T00:00:00.000Z',
        composition: {
          durationUs: 1000,
          frameRate: { num: 30, den: 1 },
          width: 1920,
          height: 1080,
          aspectRatio: '16:9',
        },
        brand: {
          hasBrandKit: false,
          colorsAvailable: false,
          fontsAvailable: false,
          logoAvailable: false,
          voiceInstructionsAvailable: false,
          toneInstructionsAvailable: false,
          prohibitedClaims: [],
          prohibitedEffects: [],
          warnings: [],
        },
        scenes: [],
        timeline: {
          compositionId: 'comp-1',
          durationUs: 1000,
          frameRate: { num: 30, den: 1 },
          width: 1920,
          height: 1080,
          aspectRatio: '16:9',
          visualTrackCount: 0,
          audioTrackCount: 0,
          totalClipCount: 0,
          visualRowIds: [],
          audioRowIds: [],
        },
        assets: [],
        capabilities: {},
        warnings: [],
        truncation: {
          clipsOmitted: 0,
          assetsOmitted: 0,
          visualObjectsOmitted: 0,
          scenesOmitted: 0,
          totalEstimateBytes: 0,
        },
      };

      const result = validateSemanticProjectSnapshot(snapshotWithPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('forbidden'))).toBe(true);
    });
  });
});
