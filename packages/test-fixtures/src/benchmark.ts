export interface TimelineScaleCounts {
  readonly durationUs: number;
  readonly trackCount: number;
  readonly clipCount: number;
  readonly captionWordCount: number;
  readonly keyframeCount: number;
  readonly assetCount: number;
}

/** §30.3 target profile. It is data-only and can be constructed on reference hardware. */
export const TIMELINE_SCALE_REFERENCE: TimelineScaleCounts = {
  durationUs: 3_600_000_000,
  trackCount: 100,
  clipCount: 10_000,
  captionWordCount: 100_000,
  keyframeCount: 50_000,
  assetCount: 5_000,
};

/** CI-friendly first pass that preserves the same ratios and virtualization shape. */
export const TIMELINE_SCALE_SCALED_DOWN: TimelineScaleCounts = {
  durationUs: TIMELINE_SCALE_REFERENCE.durationUs,
  trackCount: 10,
  clipCount: 1_000,
  captionWordCount: 10_000,
  keyframeCount: 5_000,
  assetCount: 500,
};

export interface TimelineScaleFixture {
  readonly version: 1;
  readonly profile: 'reference' | 'scaled-down';
  readonly counts: TimelineScaleCounts;
  readonly tracks: readonly TimelineScaleTrack[];
  readonly clips: readonly TimelineScaleClip[];
  readonly captionWords: readonly string[];
  readonly keyframes: readonly number[];
  readonly assets: readonly string[];
}

/** Structural shape consumed by the timeline virtualizer without importing it. */
export interface TimelineScaleTrack {
  readonly id: string;
  readonly heightPx: number;
  readonly locked: boolean;
  readonly visible: boolean;
  readonly solo: boolean;
}

export interface TimelineScaleClip {
  readonly id: string;
  readonly startUs: number;
  readonly durationUs: number;
}

/** Deterministic synthetic data: no licensed media or machine-specific state. */
export function createTimelineScaleFixture(
  profile: TimelineScaleFixture['profile'] = 'scaled-down',
): TimelineScaleFixture {
  const counts = profile === 'reference' ? TIMELINE_SCALE_REFERENCE : TIMELINE_SCALE_SCALED_DOWN;
  const clipsPerTrack = counts.clipCount / counts.trackCount;
  const clipDurationUs = Math.floor(counts.durationUs / clipsPerTrack);
  const tracks = Array.from({ length: counts.trackCount }, (_, index) => ({
    id: `track-${index}`,
    heightPx: 36,
    locked: false,
    visible: true,
    solo: false,
  }));
  const clips = Array.from({ length: counts.clipCount }, (_, index) => ({
    id: `clip-${index}`,
    startUs: (index % clipsPerTrack) * clipDurationUs,
    durationUs: clipDurationUs,
  }));
  return {
    version: 1,
    profile,
    counts,
    tracks,
    clips,
    captionWords: Array.from({ length: counts.captionWordCount }, (_, index) => `word-${index}`),
    keyframes: Array.from({ length: counts.keyframeCount }, (_, index) => index),
    assets: Array.from({ length: counts.assetCount }, (_, index) => `asset-${index}`),
  };
}
