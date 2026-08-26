export type QualityStatus = 'pass' | 'warn' | 'fail';

export interface DeliveryManifestLike {
  readonly projectId: string;
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly durationUs: number;
  readonly preset: string;
}

export interface QualityFindingV1 {
  readonly code: string;
  readonly status: QualityStatus;
  readonly message: string;
  readonly refId?: string;
  readonly evidence?: Readonly<Record<string, string | number | boolean>>;
}

export interface DeliveryPromiseV1 {
  readonly version: 1;
  readonly id: string;
  readonly container: 'mp4' | 'mov' | 'wav';
  readonly video: {
    readonly required: boolean;
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly frameRate: number;
    readonly durationUs: number;
    readonly expectedFrames: number;
    readonly durationToleranceUs: number;
    readonly frameTolerance: number;
    readonly fpsTolerance: number;
    readonly maxBlackFrames: number;
    readonly maxBlankFrames: number;
    readonly maxDuplicateFrames: number;
  };
  readonly audio: {
    readonly required: boolean;
    readonly codec: string;
    readonly sampleRate: number;
    readonly channels: number;
    readonly minRms: number;
    readonly maxPeak: number;
    readonly maxClippedSamples: number;
  };
  readonly captions: {
    readonly mode: 'none' | 'burned-in' | 'sidecar';
    readonly required?: boolean;
    /** Optional signed cue evidence. Without it, generic inspection must not
     * claim that caption pixels were proven. */
    readonly burnIn?: {
      readonly styleRef: string;
      readonly segments: readonly {
        readonly startUs: number;
        readonly endUs: number;
        readonly text: string;
        readonly direction: 'ltr' | 'rtl';
      }[];
    };
  };
  readonly deterministic: {
    readonly requireDeterministicEffects: boolean;
    readonly allowedEffectIds?: readonly string[];
  };
  readonly workflow?: {
    readonly requiredInputIds: readonly string[];
    readonly resolvedInputIds: readonly string[];
  };
  readonly approval?: {
    readonly required: boolean;
    readonly approved: boolean;
    readonly approvalRef?: string;
  };
}

export interface RenderReportV1 {
  readonly version: 1;
  readonly promiseId: string;
  readonly checkedAt: string;
  /** The measured scope of this report; sampled never implies whole-file coverage. */
  readonly evidenceLevel?: 'sampled';
  readonly artifact?: {
    readonly outputRef: string;
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly facts: RenderFactsV1;
  readonly findings: readonly QualityFindingV1[];
}

export interface RenderFactsV1 {
  readonly container?: string;
  readonly video?: {
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly frameRate: number;
    readonly durationUs: number;
    readonly frames: number;
    readonly sampledFrames: number;
    readonly blackFrames: number;
    readonly blankFrames?: number;
    readonly duplicateFrames: number;
    /** Number of sampled frames with visible activity in the caption safe area. */
    readonly captionPixelFrames?: number;
  };
  readonly audio?: {
    readonly codec: string;
    readonly sampleRate: number;
    readonly channels: number;
    readonly durationUs: number;
    readonly sampledDurationUs?: number;
    readonly rms: number;
    readonly peak: number;
    readonly clippedSamples: number;
  };
  readonly subtitles?: {
    readonly streams: number;
  };
}

export function deliveryPromiseFromManifest(manifest: DeliveryManifestLike): DeliveryPromiseV1 {
  const expectedFrames = Math.round((manifest.durationUs / 1_000_000) * manifest.frameRate);
  return deepFreeze({
    version: 1,
    id: `promise-${manifest.projectId}-${manifest.revision}-${manifest.preset}`,
    container: 'mp4',
    video: {
      required: true,
      codec: 'h264',
      width: manifest.width,
      height: manifest.height,
      frameRate: manifest.frameRate,
      durationUs: manifest.durationUs,
      expectedFrames,
      durationToleranceUs: Math.max(50_000, Math.round(1_000_000 / manifest.frameRate)),
      frameTolerance: 1,
      fpsTolerance: 0.01,
      maxBlackFrames: Math.max(5, Math.ceil(expectedFrames * 0.1)),
      maxBlankFrames: Math.max(5, Math.ceil(expectedFrames * 0.1)),
      maxDuplicateFrames: Math.max(10, Math.ceil(expectedFrames * 0.2)),
    },
    audio: {
      required: true,
      codec: 'aac',
      sampleRate: 48000,
      channels: 2,
      minRms: 0.0001,
      maxPeak: 1,
      maxClippedSamples: 0,
    },
    captions: { mode: 'none' },
    deterministic: { requireDeterministicEffects: true },
  });
}

export function reportSummary(report: Pick<RenderReportV1, 'findings'>): {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
} {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const finding of report.findings) summary[finding.status]++;
  return summary;
}

export function assertApiSafeRenderReport(report: RenderReportV1): void {
  const encoded = JSON.stringify(report);
  if (encoded.length > 65_536) throw new Error('render report is too large for the API');
  assertNoPaths(report);
  const hash = report.artifact?.sha256;
  if (hash !== undefined && !/^[a-f0-9]{64}$/.test(hash))
    throw new Error('render report artifact hash is invalid');
  if (report.evidenceLevel !== undefined && report.evidenceLevel !== 'sampled')
    throw new Error('render report evidence level is invalid');
}

export function finding(
  code: string,
  status: QualityStatus,
  message: string,
  options: {
    readonly refId?: string;
    readonly evidence?: Readonly<Record<string, string | number | boolean>>;
  } = {},
): QualityFindingV1 {
  return {
    code,
    status,
    message,
    ...(options.refId === undefined ? {} : { refId: options.refId }),
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
  };
}

function assertNoPaths(value: unknown): void {
  if (typeof value === 'string') {
    if (looksLikePathOrUrl(value)) throw new Error('render report must not contain paths or urls');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoPaths(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) assertNoPaths(item);
  }
}

function looksLikePathOrUrl(value: string): boolean {
  return (
    value.startsWith('file:') ||
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\')
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
