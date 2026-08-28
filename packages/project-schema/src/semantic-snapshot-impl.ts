/**
 * Semantic Project Snapshot V1 - Implementation
 * WP-37 S1: Semantic Project Intelligence and Critique
 *
 * This file contains the pure implementation functions.
 * Keep it separate from types for easier maintenance.
 */

import type { TimeUs } from './time.js';
import type { CompositionId } from './model.js';
import type {
  JoyProjectV1,
  CompositionV1,
  TrackV1,
  ClipV1,
  AssetRecordV1,
  MarkerV1,
  CaptionDocumentV1,
} from './v1.js';
import type {
  ProjectRevisionId,
  SemanticProjectSnapshotV1,
  SceneSummaryV1,
  SemanticElementSummaryV1,
  AssetSummaryV1,
  BrandSummaryV1,
  TimelineSummaryV1,
  SnapshotWarningV1,
  SnapshotOptions,
  SnapshotValidationResult,
  EvidenceRefV1,
  VisualCoverageV1,
} from './semantic-snapshot.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_SCENES = 20;
const DEFAULT_MAX_ASSETS = 50;
const DEFAULT_MAX_CLIP_PER_SCENE = 10;
const FRAME_THRESHOLD_US = 16667; // ~1 frame at 60fps

// ============================================================================
// Helper Functions
// ============================================================================

/** Calculate aspect ratio string from width and height */
export function calculateAspectRatio(width: number, height: number): string {
  if (height === 0 || width === 0) return '0:0';
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const simplifiedWidth = width / gcd(width, height);
  const simplifiedHeight = height / gcd(width, height);
  return `${simplifiedWidth}:${simplifiedHeight}`;
}

/** Check if a string looks like a filesystem path or URL */
export function looksLikePathOrUrl(value: string): boolean {
  const pathPatterns = [
    /^\//,
    /^[a-zA-Z]:\\/,
    /^\\\\/,
    /\.\./,
    /\.\//,
    /^https?:\/\//,
    /^ftp:\/\//,
    /^file:\/\//,
    /^s3:\/\//,
    /^gs:\/\//,
    /^az:\/\//,
  ];
  return pathPatterns.some((pattern) => pattern.test(value));
}

/** Check if a string looks like a credential or secret */
export function looksLikeSecret(value: string): boolean {
  const secretPatterns = [
    /^sk-/i,
    /^pk-/i,
    /^AKIA[0-9A-Z]/,
    /^AIza[0-9A-Za-z-_]/,
    /^eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+/,
    /bearer\s+/i,
    /password\s*[=:]\s*/i,
    /secret\s*[=:]\s*/i,
    /token\s*[=:]\s*/i,
    /api[_-]?key\s*[=:]\s*/i,
  ];
  return secretPatterns.some((pattern) => pattern.test(value));
}

/** Check if a value contains any forbidden path/secret-like strings */
export function containsForbiddenData(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  if (Array.isArray(obj)) {
    return obj.some((item) => containsForbiddenData(item));
  }
  for (const [, value] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof value === 'string') {
      if (looksLikePathOrUrl(value) || looksLikeSecret(value)) {
        return true;
      }
    } else if (typeof value === 'object' && value !== null) {
      if (containsForbiddenData(value)) {
        return true;
      }
    }
  }
  return false;
}

// ============================================================================
// Scene Segmentation
// ============================================================================

interface SceneBoundary {
  readonly timeUs: TimeUs;
  readonly source: 'marker' | 'cut' | 'gap' | 'caption' | 'composition';
  readonly refId?: string;
}

function getExplicitSceneMarkers(
  markers: readonly MarkerV1[],
  compositionDurationUs: TimeUs,
): SceneBoundary[] {
  const boundaries: SceneBoundary[] = [];
  for (const marker of markers) {
    if (marker.kind === 'chapter' || marker.label.toLowerCase().includes('scene')) {
      boundaries.push({ timeUs: marker.timeUs, source: 'marker', refId: marker.id });
    }
  }
  if (boundaries.length === 0 || boundaries[0]!.timeUs > 0) {
    boundaries.unshift({ timeUs: 0, source: 'composition', refId: 'start' });
  }
  if (
    boundaries.length === 0 ||
    boundaries[boundaries.length - 1]!.timeUs < compositionDurationUs
  ) {
    boundaries.push({ timeUs: compositionDurationUs, source: 'composition', refId: 'end' });
  }
  return boundaries.sort((a, b) => a.timeUs - b.timeUs);
}

function getCutBoundaries(
  tracks: readonly TrackV1[],
  compositionDurationUs: TimeUs,
): SceneBoundary[] {
  const cutTimes = new Set<TimeUs>();
  for (const track of tracks) {
    for (const clip of track.clips) {
      const clipEndUs = clip.startUs + clip.durationUs;
      for (const otherTrack of tracks) {
        for (const otherClip of otherTrack.clips) {
          if (otherClip.id !== clip.id && otherClip.startUs === clipEndUs) {
            cutTimes.add(clipEndUs);
          }
        }
      }
    }
  }
  const boundaries: SceneBoundary[] = Array.from(cutTimes).map((t) => ({
    timeUs: t,
    source: 'cut',
  }));
  if (!cutTimes.has(0)) boundaries.push({ timeUs: 0, source: 'composition' });
  if (!cutTimes.has(compositionDurationUs))
    boundaries.push({ timeUs: compositionDurationUs, source: 'composition' });
  return boundaries.sort((a, b) => a.timeUs - b.timeUs);
}

function getGapBoundaries(
  tracks: readonly TrackV1[],
  compositionDurationUs: TimeUs,
  gapThresholdUs: TimeUs = 500_000,
): SceneBoundary[] {
  const boundaries: SceneBoundary[] = [];
  for (const track of tracks) {
    const sortedClips = [...track.clips].sort((a, b) => a.startUs - b.startUs);
    for (let i = 0; i < sortedClips.length - 1; i++) {
      const currentClip = sortedClips[i]!;
      const nextClip = sortedClips[i + 1]!;
      const currentEndUs = currentClip.startUs + currentClip.durationUs;
      const gapUs = nextClip.startUs - currentEndUs;
      if (gapUs >= gapThresholdUs) {
        boundaries.push({ timeUs: currentEndUs, source: 'gap' });
        boundaries.push({ timeUs: nextClip.startUs, source: 'gap' });
      }
    }
  }
  return boundaries.sort((a, b) => a.timeUs - b.timeUs);
}

function getCaptionBoundaries(
  captionDocuments: Readonly<Record<string, CaptionDocumentV1>>,
): SceneBoundary[] {
  const boundaries: SceneBoundary[] = [];
  for (const doc of Object.values(captionDocuments)) {
    for (const segment of doc.segments) {
      boundaries.push({ timeUs: segment.startUs, source: 'caption', refId: segment.id });
    }
  }
  return boundaries.sort((a, b) => a.timeUs - b.timeUs);
}

function mergeBoundaries(...boundarySets: readonly SceneBoundary[][]): TimeUs[] {
  const allBoundaries = boundarySets.flat();
  const timeSet = new Set<TimeUs>();
  for (const boundary of allBoundaries) {
    timeSet.add(boundary.timeUs);
  }
  const times = Array.from(timeSet).sort((a, b) => a - b);
  const merged: TimeUs[] = [];
  for (const timeUs of times) {
    if (merged.length === 0) {
      merged.push(timeUs);
    } else {
      const last = merged[merged.length - 1]!;
      if (timeUs - last >= FRAME_THRESHOLD_US) {
        merged.push(timeUs);
      }
    }
  }
  return merged;
}

function createScenesFromBreakpoints(
  breakpoints: TimeUs[],
  compositionId: CompositionId,
): SceneSummaryV1[] {
  const scenes: SceneSummaryV1[] = [];
  for (let i = 0; i < breakpoints.length - 1; i++) {
    const startUs = breakpoints[i]!;
    const endUs = breakpoints[i + 1]!;
    const durationUs = endUs - startUs;
    if (durationUs > 0) {
      const evidence: EvidenceRefV1[] = [
        {
          id: compositionId,
          kind: 'composition',
          startUs,
          endUs,
        },
      ];
      scenes.push({
        id: `scene-${compositionId}-${i}`,
        startUs,
        endUs,
        purpose: 'unknown',
        elements: [],
        visualCoverage: 'none',
        evidence,
      });
    }
  }
  return scenes;
}

export function segmentCompositionIntoScenes(
  composition: CompositionV1,
  captionDocuments: Readonly<Record<string, CaptionDocumentV1>>,
  projectMarkers: readonly MarkerV1[],
  options?: { readonly maxScenes?: number },
): SceneSummaryV1[] {
  const maxScenes = options?.maxScenes ?? DEFAULT_MAX_SCENES;
  const compositionDurationUs = composition.durationUs;
  const markerBoundaries = getExplicitSceneMarkers(projectMarkers, compositionDurationUs);
  const cutBoundaries = getCutBoundaries(composition.tracks, compositionDurationUs);
  const gapBoundaries = getGapBoundaries(composition.tracks, compositionDurationUs);
  const captionBoundaries = getCaptionBoundaries(captionDocuments);
  const boundaryArrays: readonly SceneBoundary[][] = [
    markerBoundaries,
    cutBoundaries,
    gapBoundaries,
    captionBoundaries,
  ];
  const breakpoints = mergeBoundaries(...boundaryArrays);
  if (breakpoints.length === 0) {
    breakpoints.push(0, compositionDurationUs);
  } else if (breakpoints[0] !== 0) {
    breakpoints.unshift(0);
  }
  if (breakpoints[breakpoints.length - 1] !== compositionDurationUs) {
    breakpoints.push(compositionDurationUs);
  }
  let scenes = createScenesFromBreakpoints(breakpoints, composition.id);
  if (scenes.length > maxScenes) {
    scenes = scenes.slice(0, maxScenes);
  }
  return scenes;
}

// ============================================================================
// Element and Asset Summarization
// ============================================================================

function clipKindToSemanticKind(clip: ClipV1): SemanticElementSummaryV1['kind'] {
  switch (clip.kind) {
    case 'video':
      return 'video-clip';
    case 'composition':
      return 'composition-clip';
    case 'caption':
      return 'caption-clip';
    default:
      return 'unknown';
  }
}

function clipHasAudio(clip: ClipV1, assets: Readonly<Record<string, AssetRecordV1>>): boolean {
  if (clip.kind === 'video') {
    const asset = assets[clip.assetId];
    if (asset && (asset.kind === 'video' || asset.kind === 'audio')) {
      return true;
    }
  }
  return false;
}

function clipHasVisual(clip: ClipV1, assets: Readonly<Record<string, AssetRecordV1>>): boolean {
  if (clip.kind === 'video') {
    const asset = assets[clip.assetId];
    if (asset && (asset.kind === 'video' || asset.kind === 'image')) {
      return true;
    }
  } else if (clip.kind === 'composition') {
    return true;
  }
  return false;
}

function createClipElements(
  clips: readonly ClipV1[],
  assets: Readonly<Record<string, AssetRecordV1>>,
  maxElements: number,
): readonly SemanticElementSummaryV1[] {
  const elements: SemanticElementSummaryV1[] = [];
  for (const clip of clips) {
    if (elements.length >= maxElements) break;
    const hasAudio = clipHasAudio(clip, assets);
    const hasVisual = clipHasVisual(clip, assets);
    if (hasAudio || hasVisual || clip.kind === 'caption') {
      let element: SemanticElementSummaryV1 = {
        id: clip.id,
        kind: clipKindToSemanticKind(clip),
        startUs: clip.startUs,
        durationUs: clip.durationUs,
        hasAudio,
        hasVisual,
      };
      if (clip.kind === 'video') {
        element = { ...element, assetId: clip.assetId };
      } else if (clip.kind === 'composition') {
        element = { ...element, assetId: clip.compositionId };
      }
      elements.push(element);
    }
  }
  return elements;
}

function createAssetSummaries(
  assets: Readonly<Record<string, AssetRecordV1>>,
  maxAssets: number,
): readonly AssetSummaryV1[] {
  const summaries: AssetSummaryV1[] = [];
  const assetEntries = Object.entries(assets);
  for (let i = 0; i < Math.min(assetEntries.length, maxAssets); i++) {
    const [id, asset] = assetEntries[i]!;
    const hasProvenance = asset.generationProvenance !== undefined;
    const warnings: SnapshotWarningV1[] = [];
    if (!asset.displayName || asset.displayName.length === 0) {
      warnings.push({
        code: 'unavailable-asset',
        severity: 'warning',
        message: `Asset ${id} has no display name`,
      });
    }
    let kind: AssetSummaryV1['kind'];
    switch (asset.kind) {
      case 'video':
      case 'audio':
      case 'image':
        kind = asset.kind;
        break;
      case 'lut':
        kind = 'lutt';
        break;
      default:
        kind = 'unknown';
    }
    let summary: AssetSummaryV1 = {
      id,
      kind,
      name: asset.displayName || id,
      hasProvenance,
      isGenerated: hasProvenance,
      warnings,
    };
    if (asset.descriptor?.durationUs !== undefined) {
      summary = { ...summary, durationUs: asset.descriptor.durationUs };
    }
    if (asset.generationProvenance?.providerId !== undefined) {
      summary = { ...summary, providerId: asset.generationProvenance.providerId };
    }
    if (asset.generationProvenance?.modelId !== undefined) {
      summary = { ...summary, modelId: asset.generationProvenance.modelId };
    }
    summaries.push(summary);
  }
  return summaries;
}

function createBrandSummary(variables: Readonly<Record<string, unknown>>): BrandSummaryV1 {
  const warnings: SnapshotWarningV1[] = [];
  const hasBrandKit = Object.keys(variables).some(
    (k) =>
      k.toLowerCase().includes('brand') ||
      k.toLowerCase().includes('color') ||
      k.toLowerCase().includes('font'),
  );
  if (!hasBrandKit) {
    warnings.push({ code: 'missing-brand', severity: 'info', message: 'No brand kit data found' });
  }
  return {
    hasBrandKit,
    colorsAvailable: false,
    fontsAvailable: false,
    logoAvailable: false,
    voiceInstructionsAvailable: false,
    toneInstructionsAvailable: false,
    prohibitedClaims: [],
    prohibitedEffects: [],
    warnings,
  };
}

function createTimelineSummary(
  composition: CompositionV1,
  tracks: readonly TrackV1[],
): TimelineSummaryV1 {
  let visualTrackCount = 0;
  let audioTrackCount = 0;
  let totalClipCount = 0;
  const visualRowIds: string[] = [];
  const audioRowIds: string[] = [];
  for (const track of tracks) {
    const family = track.family ?? (track.kind === 'audio' ? 'audio' : 'visual');
    if (family === 'visual') {
      visualTrackCount++;
      visualRowIds.push(track.id);
    } else if (family === 'audio') {
      audioTrackCount++;
      audioRowIds.push(track.id);
    }
    totalClipCount += track.clips.length;
  }
  return {
    compositionId: composition.id,
    durationUs: composition.durationUs,
    frameRate: composition.frameRate,
    width: composition.width,
    height: composition.height,
    aspectRatio: calculateAspectRatio(composition.width, composition.height),
    visualTrackCount,
    audioTrackCount,
    totalClipCount,
    visualRowIds,
    audioRowIds,
  };
}

// ============================================================================
// Validation
// ============================================================================

export function validateSemanticProjectSnapshot(snapshot: unknown): SnapshotValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!snapshot || typeof snapshot !== 'object') {
    return { valid: false, errors: ['Snapshot must be an object'], warnings };
  }
  const s = snapshot as Partial<SemanticProjectSnapshotV1>;
  if (s.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, got ${String(s.schemaVersion)}`);
  }
  if (!s.projectId || typeof s.projectId !== 'string' || s.projectId.length === 0) {
    errors.push('projectId must be a non-empty string');
  }
  if (!s.revisionId || typeof s.revisionId !== 'string' || s.revisionId.length === 0) {
    errors.push('revisionId must be a non-empty string');
  }
  if (!s.capturedAt || typeof s.capturedAt !== 'string') {
    errors.push('capturedAt must be a non-empty string');
  }
  if (!s.composition) {
    errors.push('composition is required');
  } else {
    if (!s.composition.durationUs || typeof s.composition.durationUs !== 'number') {
      errors.push('composition.durationUs must be a number');
    }
    if (
      !s.composition.frameRate ||
      typeof s.composition.frameRate.num !== 'number' ||
      typeof s.composition.frameRate.den !== 'number'
    ) {
      errors.push('composition.frameRate must have num and den as numbers');
    }
    if (!s.composition.width || typeof s.composition.width !== 'number') {
      errors.push('composition.width must be a number');
    }
    if (!s.composition.height || typeof s.composition.height !== 'number') {
      errors.push('composition.height must be a number');
    }
  }
  if (!Array.isArray(s.scenes)) {
    errors.push('scenes must be an array');
  } else {
    for (const scene of s.scenes) {
      if (!scene.id || typeof scene.id !== 'string') {
        errors.push('scene.id must be a non-empty string');
      }
      if (typeof scene.startUs !== 'number' || typeof scene.endUs !== 'number') {
        errors.push('scene.startUs and scene.endUs must be numbers');
      } else if (scene.startUs >= scene.endUs) {
        errors.push(`scene ${scene.id} has invalid range`);
      }
    }
  }
  if (!s.timeline) {
    errors.push('timeline is required');
  }
  if (!Array.isArray(s.assets)) {
    errors.push('assets must be an array');
  }
  if (!s.truncation) {
    errors.push('truncation is required');
  }
  if (containsForbiddenData(snapshot)) {
    errors.push('Snapshot contains forbidden path/secret data');
  }
  return {
    valid: errors.length === 0,
    errors: errors as readonly string[],
    warnings: warnings as readonly string[],
  };
}

// ============================================================================
// Main Projector
// ============================================================================

export function projectToSemanticSnapshot(
  project: JoyProjectV1,
  revisionId: ProjectRevisionId,
  options?: SnapshotOptions,
): SemanticProjectSnapshotV1 {
  const clock = options?.clock ?? (() => new Date().toISOString());
  const maxScenes = options?.maxScenes ?? DEFAULT_MAX_SCENES;
  const maxAssets = options?.maxAssets ?? DEFAULT_MAX_ASSETS;
  const maxClipsPerScene = options?.maxClipsPerScene ?? DEFAULT_MAX_CLIP_PER_SCENE;

  const rootComposition = project.compositions[project.rootCompositionId];
  if (!rootComposition) {
    throw new Error(`Root composition ${project.rootCompositionId} not found`);
  }

  const allTracks: TrackV1[] = [...rootComposition.tracks];
  const allMarkers = [...project.markers];

  let scenes = segmentCompositionIntoScenes(rootComposition, project.captionDocuments, allMarkers, {
    maxScenes,
  });

  // Add elements to scenes
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!;
    const sceneClips: ClipV1[] = [];
    for (const track of allTracks) {
      for (const clip of track.clips) {
        const clipEndUs = clip.startUs + clip.durationUs;
        const overlapStart = Math.max(scene.startUs, clip.startUs);
        const overlapEnd = Math.min(scene.endUs, clipEndUs);
        if (overlapStart < overlapEnd) {
          sceneClips.push(clip);
        }
      }
    }
    const elements = createClipElements(
      sceneClips.slice(0, maxClipsPerScene),
      project.assets,
      maxClipsPerScene,
    );
    const visualElements = elements.filter((e) => e.hasVisual);
    const visualCoverage: VisualCoverageV1 =
      visualElements.length === 0
        ? 'none'
        : visualElements.length < 3
          ? 'sparse'
          : visualElements.length >= 10
            ? 'dense'
            : 'adequate';
    scenes[i] = { ...scene, elements, visualCoverage };
  }

  // Add caption coverage
  if (Object.keys(project.captionDocuments).length > 0) {
    let totalWordCount = 0;
    let firstLocale = 'en-US';
    for (const doc of Object.values(project.captionDocuments)) {
      totalWordCount += doc.words ? Object.keys(doc.words).length : 0;
      if (doc.language) firstLocale = doc.language;
    }
    scenes = scenes.map((s) => ({
      ...s,
      captionCoverage: { hasCaptions: true, wordCount: totalWordCount, locale: firstLocale },
    }));
  }

  const assets = createAssetSummaries(project.assets, maxAssets);
  const timeline = createTimelineSummary(rootComposition, allTracks);
  const brand = createBrandSummary(project.variables);

  const totalAssets = Object.keys(project.assets).length;
  const totalClips = allTracks.reduce((sum, track) => sum + track.clips.length, 0);
  const elementsPerScene = scenes.map((s) => s.elements.length);
  const totalElementsInScenes = elementsPerScene.reduce((a, b) => a + b, 0);
  const estimatedSize = JSON.stringify({ scenes, assets, timeline, brand }).length;

  const warnings: SnapshotWarningV1[] = [];
  if (assets.length < totalAssets) {
    warnings.push({
      code: 'truncated',
      severity: 'info',
      message: `Asset count truncated from ${totalAssets} to ${maxAssets}`,
    });
  }

  const snapshot: SemanticProjectSnapshotV1 = {
    schemaVersion: 1,
    projectId: project.id,
    revisionId,
    capturedAt: clock(),
    composition: {
      durationUs: rootComposition.durationUs,
      frameRate: rootComposition.frameRate,
      width: rootComposition.width,
      height: rootComposition.height,
      aspectRatio: calculateAspectRatio(rootComposition.width, rootComposition.height),
    },
    brand,
    scenes,
    timeline,
    assets,
    capabilities: {
      'semantic-snapshot': 'ready',
      'scene-segmentation': 'ready',
      'caption-detection':
        Object.keys(project.captionDocuments).length > 0 ? 'ready' : 'unavailable',
      'audio-analysis': project.audio !== undefined ? 'ready' : 'unavailable',
      'generated-assets': assets.some((a) => a.isGenerated) ? 'ready' : 'unavailable',
    },
    warnings,
    truncation: {
      clipsOmitted: Math.max(0, totalClips - totalElementsInScenes),
      assetsOmitted: Math.max(0, totalAssets - assets.length),
      visualObjectsOmitted: 0,
      scenesOmitted: 0,
      totalEstimateBytes: estimatedSize,
    },
  };

  if (containsForbiddenData(snapshot)) {
    throw new Error('Snapshot contains forbidden path/secret data');
  }

  return snapshot;
}
