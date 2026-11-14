/**
 * Technical quality check (QC) types, ADR-0045 sections 6, 7 and 11.
 *
 * The `media.qc` Worker job runs ffmpeg filters over one file and returns one `QcReport`. Every time is in
 * microseconds. No path, command line or credential ever enters a report: only numbers, ranges and plain
 * sentences, so the report can be shown to the owner, stored with a project, or handed to a model as is.
 */

/** The eight check types that read a stream of samples. The two document-only checks are not Worker jobs. */
export type QcFileFindingType =
  | 'black'
  | 'frozen'
  | 'scene-cut'
  | 'loudness'
  | 'silence'
  | 'clipping'
  | 'exposure'
  | 'colour-cast';

export const QC_FILE_FINDING_TYPES: readonly QcFileFindingType[] = [
  'black',
  'frozen',
  'scene-cut',
  'loudness',
  'silence',
  'clipping',
  'exposure',
  'colour-cast',
] as const;

/** `blocker` is data loss or a wrong export; the file checks only ever produce `major` and `minor`. */
export type QcSeverity = 'blocker' | 'major' | 'minor';

/** ADR-0045 section 2: a Worker measurement is always `measured`; the other two come from the seeing layer. */
export type QcFindingState = 'measured' | 'model-observed' | 'unconfirmed';

/**
 * Every threshold is a setting, not a constant: ADR-0045 admits they are guesses until they have run on real
 * cuts. A job payload may override any of them; the Worker clamps each value into a sane range.
 */
export interface QcThresholds {
  /** Shortest black run to report, seconds. */
  readonly blackMinDurationSec: number;
  /** A pixel counts as black at or below this luma fraction (0 to 1). */
  readonly blackPixelThreshold: number;
  /** Frame-to-frame noise below which two frames count as identical, dB (negative). */
  readonly freezeNoiseDb: number;
  /** Shortest frozen run to report, seconds. */
  readonly freezeMinDurationSec: number;
  /** ffmpeg `scdet` score at or above which a hard cut is reported (0 to 100). */
  readonly sceneCutThreshold: number;
  /** Most hard cuts listed; further cuts are dropped and the report says so. */
  readonly maxSceneCuts: number;
  /** Audio at or below this level counts as silent, dBFS (negative). */
  readonly silenceDb: number;
  /** Shortest silent stretch to report, seconds. */
  readonly silenceMinDurationSec: number;
  /** Overall sample peak at or above this level counts as clipping, dBFS. */
  readonly clippingPeakDb: number;
  /** Integrated loudness below this is reported as too quiet, LUFS. */
  readonly loudnessMinLufs: number;
  /** Integrated loudness above this is reported as too loud, LUFS. */
  readonly loudnessMaxLufs: number;
  /** True peak above this is reported, dBFS. */
  readonly truePeakMaxDb: number;
  /** A sampled frame with average luma (16 to 235 scale) below this is too dark. */
  readonly underexposedYavg: number;
  /** A sampled frame with average luma above this is too bright. */
  readonly overexposedYavg: number;
  /** Shortest too-dark or too-bright run to report, seconds. */
  readonly exposureMinRunSec: number;
  /** Median chroma distance from neutral (0 to 128 scale) above which the picture leans one way. */
  readonly colourCastMax: number;
}

/** The payload of a `media.qc` job. Every field is optional: an empty payload runs all eight checks. */
export interface MediaQcJobPayload {
  readonly schemaVersion?: 1;
  /** Checks to run; omitted means all eight. */
  readonly checks?: readonly QcFileFindingType[];
  readonly thresholds?: Partial<QcThresholds>;
  /** Whole-run time cap, milliseconds. The Worker clamps it to its own maximum. */
  readonly maxRunMs?: number;
}

export interface QcRange {
  readonly startUs: number;
  readonly endUs: number;
}

export interface QcFinding {
  readonly id: string;
  readonly type: QcFileFindingType;
  readonly state: QcFindingState;
  readonly severity: QcSeverity;
  readonly startUs: number;
  readonly endUs: number;
  /** One plain sentence for the owner. */
  readonly label: string;
  /** The numbers behind the finding. Values are numbers, short strings or null (for example -inf). */
  readonly measured: Readonly<Record<string, number | string | null>>;
  /** Whether a fix can be proposed for this type (ADR-0045 section 7). */
  readonly fixable: boolean;
  readonly evidenceIds: readonly string[];
}

export interface QcNote {
  readonly id: string;
  readonly frameId: string;
  readonly timeUs: number;
  readonly text: string;
}

export interface QcTarget {
  readonly kind: 'timeline' | 'file';
  readonly assetId?: string;
  readonly range?: {
    readonly domain: 'source' | 'composition';
    readonly startUs: number;
    readonly endUs: number;
  };
}

/** The whole-file numbers that are not findings: the report always carries them, clean or not. */
export interface QcTechnicalSummary {
  readonly durationUs: number;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  /** The checks this run actually ran. A check that did not run has no findings because it did not look. */
  readonly checksRun: readonly QcFileFindingType[];
  readonly loudness: {
    readonly integratedLufs: number | null;
    readonly loudnessRangeLu: number | null;
    readonly truePeakDbfs: number | null;
  } | null;
  readonly audioPeakDb: number | null;
  readonly exposure: {
    readonly sampledFrames: number;
    readonly sampleIntervalUs: number;
    readonly meanLuma: number;
    readonly medianChromaDistance: number;
  } | null;
  /** The thresholds this run used, so a report can be read without the settings that produced it. */
  readonly thresholds: QcThresholds;
  /** Plain reasons the report is incomplete or was cut down: a timed-out pass, a dropped finding list. */
  readonly truncated: readonly string[];
  readonly elapsedMs: number;
}

export interface QcReport {
  readonly version: 1;
  readonly reportId: string;
  readonly projectId?: string;
  readonly createdAt: string;
  readonly target: QcTarget;
  readonly run: {
    readonly layer1: boolean;
    readonly layer2: boolean;
    readonly modelId: string | null;
    readonly framesSent: number;
    readonly framesSkipped: number;
  };
  readonly coverage: {
    readonly completeSourceCoverage: boolean;
    readonly sampledRanges: readonly QcRange[];
    readonly unsampledRanges: readonly QcRange[];
  };
  readonly findings: readonly QcFinding[];
  readonly notes: readonly QcNote[];
  readonly technical?: QcTechnicalSummary;
  /** The literal `false`: JOY never claims a model understood a picture (ADR-0045 section 10). */
  readonly modelComprehensionGuaranteed: false;
}
