/**
 * `media.qc` Worker job (ADR-0045 layer 1, T-B02). Runs ffmpeg filters over one file and returns one JSON
 * report. No model, no network, no cost: the numbers are the same on every machine and for every provider.
 *
 * Three bounded ffmpeg passes, each with its own filter chain:
 *  - video:  blackdetect, freezedetect, scdet        (full frame rate, so times are frame-accurate)
 *  - audio:  ebur128, silencedetect, astats          (loudness, silence, clipping)
 *  - stats:  signalstats on a sampled frame rate     (exposure and colour cast)
 *
 * Every time in the report is in microseconds. A pass is capped in run time and in captured output; a
 * pass that hits a cap says so in the report instead of pretending it looked at everything. The report holds
 * no path, command line or credential.
 */
import { spawn } from 'node:child_process';
import type {
  MediaQcJobPayload,
  QcFileFindingType,
  QcFinding,
  QcRange,
  QcReport,
  QcSeverity,
  QcThresholds,
} from '@joy-media/job-protocol';

/** The eight file checks. Kept here as well as in job-protocol so this file needs no rebuilt package. */
const ALL_CHECKS: readonly QcFileFindingType[] = [
  'black',
  'frozen',
  'scene-cut',
  'loudness',
  'silence',
  'clipping',
  'exposure',
  'colour-cast',
];

export const DEFAULT_QC_THRESHOLDS: QcThresholds = {
  blackMinDurationSec: 0.2,
  blackPixelThreshold: 0.1,
  freezeNoiseDb: -60,
  freezeMinDurationSec: 1,
  sceneCutThreshold: 10,
  maxSceneCuts: 200,
  silenceDb: -50,
  silenceMinDurationSec: 0.5,
  clippingPeakDb: -0.1,
  loudnessMinLufs: -26,
  loudnessMaxLufs: -9,
  truePeakMaxDb: -1,
  underexposedYavg: 45,
  overexposedYavg: 205,
  exposureMinRunSec: 1,
  colourCastMax: 12,
};

/** The lowest and highest value a payload may give each threshold. Anything outside is refused, not clamped. */
const THRESHOLD_RANGES: Readonly<Record<keyof QcThresholds, readonly [number, number]>> = {
  blackMinDurationSec: [0.04, 60],
  blackPixelThreshold: [0, 0.5],
  freezeNoiseDb: [-90, -10],
  freezeMinDurationSec: [0.2, 600],
  sceneCutThreshold: [1, 100],
  maxSceneCuts: [0, 1000],
  silenceDb: [-100, -10],
  silenceMinDurationSec: [0.1, 600],
  clippingPeakDb: [-6, 0],
  loudnessMinLufs: [-70, -5],
  loudnessMaxLufs: [-30, 0],
  truePeakMaxDb: [-6, 3],
  underexposedYavg: [16, 120],
  overexposedYavg: [150, 235],
  exposureMinRunSec: [0.2, 600],
  colourCastMax: [1, 128],
};

/** Whole-run time cap. A payload may lower it; it may not raise it past the maximum. */
export const DEFAULT_QC_MAX_RUN_MS = 10 * 60 * 1000;
export const MAX_QC_MAX_RUN_MS = 30 * 60 * 1000;
/** The report is cut down (scene cuts first) until its JSON fits this. */
export const MAX_QC_REPORT_BYTES = 256 * 1024;
/** Captured ffmpeg text per pass. The head and the tail are kept: filter lines run through, the summary is last. */
const STDERR_HEAD_BYTES = 1024 * 1024;
const STDERR_TAIL_BYTES = 1024 * 1024;
const STDOUT_HEAD_BYTES = 8 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 30_000;
/** At most this many frames are sampled for exposure and colour, whatever the file length. */
const MAX_SAMPLED_FRAMES = 600;
const MAX_SAMPLE_FPS = 2;
/** A sampled frame whose brightest pixel is below this is black: `black` reports it, exposure ignores it. */
const BLACK_FRAME_YMAX = 40;
/** Chroma planes sit at 128 when the picture is neutral. */
const NEUTRAL_CHROMA = 128;

const NUM = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const NUM_OR_INF = String.raw`(?:${NUM}|-?inf)`;

// ---------------------------------------------------------------------------------------------------------
// Payload

export interface ParsedMediaQcPayload {
  readonly checks: ReadonlySet<QcFileFindingType>;
  readonly thresholds: QcThresholds;
  readonly maxRunMs: number;
}

/** Validates a job payload. An empty or absent payload runs every check with the default thresholds. */
export function parseMediaQcPayload(payload: unknown): ParsedMediaQcPayload {
  if (payload === undefined || payload === null)
    return {
      checks: new Set(ALL_CHECKS),
      thresholds: DEFAULT_QC_THRESHOLDS,
      maxRunMs: DEFAULT_QC_MAX_RUN_MS,
    };
  if (typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('media.qc payload must be a JSON object');
  const candidate = payload as Partial<Record<keyof MediaQcJobPayload, unknown>>;
  if (candidate.schemaVersion !== undefined && candidate.schemaVersion !== 1)
    throw new Error('media.qc payload has an unsupported schemaVersion');

  let checks: ReadonlySet<QcFileFindingType> = new Set(ALL_CHECKS);
  if (candidate.checks !== undefined) {
    if (!Array.isArray(candidate.checks) || candidate.checks.length === 0)
      throw new Error('media.qc checks must be a non-empty list');
    const chosen = new Set<QcFileFindingType>();
    for (const item of candidate.checks as readonly unknown[]) {
      if (typeof item !== 'string' || !(ALL_CHECKS as readonly string[]).includes(item))
        throw new Error('media.qc checks has an unknown check');
      chosen.add(item as QcFileFindingType);
    }
    checks = chosen;
  }

  let thresholds = DEFAULT_QC_THRESHOLDS;
  if (candidate.thresholds !== undefined) {
    const given = candidate.thresholds;
    if (given === null || typeof given !== 'object' || Array.isArray(given))
      throw new Error('media.qc thresholds must be a JSON object');
    const merged: Record<string, number> = { ...DEFAULT_QC_THRESHOLDS };
    for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
      if (!Object.hasOwn(THRESHOLD_RANGES, key))
        throw new Error(`media.qc thresholds has an unknown setting ${key}`);
      const range = THRESHOLD_RANGES[key as keyof QcThresholds];
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < range[0] ||
        value > range[1]
      )
        throw new Error(
          `media.qc threshold ${key} must be a number from ${range[0]} to ${range[1]}`,
        );
      merged[key] = value;
    }
    thresholds = merged as unknown as QcThresholds;
  }

  let maxRunMs = DEFAULT_QC_MAX_RUN_MS;
  if (candidate.maxRunMs !== undefined) {
    if (
      typeof candidate.maxRunMs !== 'number' ||
      !Number.isFinite(candidate.maxRunMs) ||
      candidate.maxRunMs < 1000
    )
      throw new Error('media.qc maxRunMs must be a number of at least 1000');
    maxRunMs = Math.min(candidate.maxRunMs, MAX_QC_MAX_RUN_MS);
  }
  return { checks, thresholds, maxRunMs };
}

// ---------------------------------------------------------------------------------------------------------
// Parsers (pure: ffmpeg text in, numbers out; times in microseconds)

export interface QcInterval {
  readonly startUs: number;
  readonly endUs: number;
}
export interface QcSceneCut {
  readonly timeUs: number;
  readonly score: number;
}
export interface QcLoudness {
  readonly integratedLufs: number | null;
  readonly loudnessRangeLu: number | null;
  readonly truePeakDbfs: number | null;
}
export interface QcAudioStats {
  readonly peakDb: number | null;
  readonly peakCount: number | null;
  readonly samples: number | null;
}
export interface QcSignalFrame {
  readonly timeUs: number;
  readonly yavg: number;
  readonly ymax: number;
  readonly uavg: number;
  readonly vavg: number;
}

function secondsToUs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.round(seconds * 1_000_000) : undefined;
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined || /inf/i.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Keeps an interval inside the file and drops one that is empty. */
function clampInterval(startUs: number, endUs: number, durationUs: number): QcInterval | undefined {
  const start = Math.max(0, startUs);
  const end = durationUs > 0 ? Math.min(endUs, durationUs) : endUs;
  return end > start ? { startUs: start, endUs: end } : undefined;
}

/** `[blackdetect @ ..] black_start:2 black_end:3 black_duration:1` */
export function parseBlackdetect(text: string, durationUs: number): QcInterval[] {
  const pattern = new RegExp(`black_start:\\s*(${NUM})\\s+black_end:\\s*(${NUM})`, 'g');
  const out: QcInterval[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = secondsToUs(match[1]);
    const end = secondsToUs(match[2]);
    if (start === undefined || end === undefined) continue;
    const interval = clampInterval(start, end, durationUs);
    if (interval !== undefined) out.push(interval);
  }
  return out;
}

/**
 * `lavfi.freezedetect.freeze_start / freeze_duration / freeze_end`. A freeze that runs to the end of the file
 * has a start and no end: `openEndUs` closes it, and `undefined` drops it (a pass that was cut short does not
 * know where it would have ended).
 */
export function parseFreezedetect(
  text: string,
  durationUs: number,
  openEndUs: number | undefined,
): QcInterval[] {
  const pattern = new RegExp(
    `lavfi\\.freezedetect\\.freeze_(start|duration|end):\\s*(${NUM})`,
    'g',
  );
  const out: QcInterval[] = [];
  let open: { startUs: number; durationUs?: number } | undefined;
  const closeOpen = (): void => {
    if (open === undefined) return;
    const endUs = open.durationUs !== undefined ? open.startUs + open.durationUs : openEndUs;
    if (endUs !== undefined) {
      const interval = clampInterval(open.startUs, endUs, durationUs);
      if (interval !== undefined) out.push(interval);
    }
    open = undefined;
  };
  for (const match of text.matchAll(pattern)) {
    const value = secondsToUs(match[2]);
    if (value === undefined) continue;
    if (match[1] === 'start') {
      closeOpen();
      open = { startUs: value };
    } else if (match[1] === 'duration') {
      if (open !== undefined) open.durationUs = value;
    } else if (open !== undefined) {
      const interval = clampInterval(open.startUs, value, durationUs);
      if (interval !== undefined) out.push(interval);
      open = undefined;
    }
  }
  closeOpen();
  return out;
}

/** `[scdet @ ..] lavfi.scd.score: 45.211, lavfi.scd.time: 2` */
export function parseScdet(text: string): QcSceneCut[] {
  const pattern = new RegExp(
    `lavfi\\.scd\\.score:\\s*(${NUM}),\\s*lavfi\\.scd\\.time:\\s*(${NUM})`,
    'g',
  );
  const out: QcSceneCut[] = [];
  for (const match of text.matchAll(pattern)) {
    const timeUs = secondsToUs(match[2]);
    const score = Number(match[1]);
    if (timeUs !== undefined && Number.isFinite(score))
      out.push({ timeUs: Math.max(0, timeUs), score });
  }
  return out;
}

/** `silence_start: 6` then `silence_end: 8 | silence_duration: 2`. An open stretch ends at `openEndUs`. */
export function parseSilencedetect(
  text: string,
  durationUs: number,
  openEndUs: number | undefined,
): QcInterval[] {
  const pattern = new RegExp(
    `silence_start:\\s*(${NUM})|silence_end:\\s*(${NUM})\\s*\\|\\s*silence_duration:\\s*(${NUM})`,
    'g',
  );
  const out: QcInterval[] = [];
  let openStartUs: number | undefined;
  for (const match of text.matchAll(pattern)) {
    if (match[1] !== undefined) {
      openStartUs = secondsToUs(match[1]);
      continue;
    }
    const endUs = secondsToUs(match[2]);
    if (endUs === undefined) continue;
    const durationOfRun = secondsToUs(match[3]);
    const startUs =
      openStartUs ?? (durationOfRun === undefined ? undefined : endUs - durationOfRun);
    openStartUs = undefined;
    if (startUs === undefined) continue;
    const interval = clampInterval(startUs, endUs, durationUs);
    if (interval !== undefined) out.push(interval);
  }
  if (openStartUs !== undefined && openEndUs !== undefined) {
    const interval = clampInterval(openStartUs, openEndUs, durationUs);
    if (interval !== undefined) out.push(interval);
  }
  return out;
}

/** The `Summary:` block ebur128 prints at the end of a run. */
export function parseEbur128Summary(text: string): QcLoudness | undefined {
  const index = text.lastIndexOf('Summary:');
  if (index < 0) return undefined;
  const section = text.slice(index);
  const integrated = new RegExp(`\\bI:\\s*(${NUM_OR_INF})\\s*LUFS`).exec(section);
  if (integrated === null) return undefined;
  const range = new RegExp(`LRA:\\s*(${NUM_OR_INF})\\s*LU\\b`).exec(section);
  const peak = new RegExp(`Peak:\\s*(${NUM_OR_INF})\\s*dBFS`).exec(section);
  return {
    integratedLufs: numberOrNull(integrated[1]),
    loudnessRangeLu: numberOrNull(range?.[1]),
    truePeakDbfs: numberOrNull(peak?.[1]),
  };
}

/** The `Overall` block astats prints at the end of a run. Per-channel blocks come first and are skipped. */
export function parseAstatsOverall(text: string): QcAudioStats | undefined {
  const index = text.lastIndexOf('Overall');
  const section = index >= 0 ? text.slice(index) : text;
  const peak = new RegExp(`Peak level dB:\\s*(${NUM_OR_INF})`).exec(section);
  if (peak === null) return undefined;
  const count = new RegExp(`Peak count:\\s*(${NUM})`).exec(section);
  const samples = /Number of samples:\s*(\d+)/.exec(section);
  return {
    peakDb: numberOrNull(peak[1]),
    peakCount: numberOrNull(count?.[1]),
    samples: numberOrNull(samples?.[1]),
  };
}

/**
 * `metadata=print` output of signalstats: a `frame:N pts:N pts_time:T` line, then `lavfi.signalstats.KEY=VALUE`
 * lines. Works for the stdout form and for the log form, where each line has a `[Parsed_metadata_N @ ..]` prefix.
 */
export function parseSignalstats(text: string): QcSignalFrame[] {
  const frames: QcSignalFrame[] = [];
  let current: { timeUs: number; keys: Record<string, number> } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    const { keys, timeUs } = current;
    const yavg = keys['YAVG'];
    const ymax = keys['YMAX'];
    const uavg = keys['UAVG'];
    const vavg = keys['VAVG'];
    if (yavg !== undefined && ymax !== undefined && uavg !== undefined && vavg !== undefined)
      frames.push({ timeUs, yavg, ymax, uavg, vavg });
    current = undefined;
  };
  const framePattern = new RegExp(`frame:\\s*\\d+.*?pts_time:\\s*(${NUM})`);
  const keyPattern = new RegExp(`lavfi\\.signalstats\\.(\\w+)=(${NUM})`);
  for (const line of text.split(/\r?\n/)) {
    const frame = framePattern.exec(line);
    if (frame !== null) {
      flush();
      const timeUs = secondsToUs(frame[1]);
      current = timeUs === undefined ? undefined : { timeUs, keys: {} };
      continue;
    }
    const key = keyPattern.exec(line);
    if (key !== null && current !== undefined && key[1] !== undefined) {
      const value = Number(key[2]);
      if (Number.isFinite(value)) current.keys[key[1]] = value;
    }
  }
  flush();
  return frames;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export interface QcExposureRun {
  readonly kind: 'dark' | 'bright';
  readonly startUs: number;
  readonly endUs: number;
  readonly meanLuma: number;
}
export interface QcPictureAnalysis {
  readonly sampledFrames: number;
  readonly meanLuma: number;
  readonly medianChromaDistance: number;
  readonly exposureRuns: readonly QcExposureRun[];
}

/** Turns sampled signalstats frames into exposure runs and one colour-cast number. Black frames are ignored. */
export function analysePicture(
  frames: readonly QcSignalFrame[],
  sampleIntervalUs: number,
  thresholds: QcThresholds,
): QcPictureAnalysis {
  const usable = frames.filter((frame) => frame.ymax >= BLACK_FRAME_YMAX);
  const meanLuma =
    usable.length === 0 ? 0 : usable.reduce((sum, frame) => sum + frame.yavg, 0) / usable.length;
  const medianChromaDistance = median(
    usable.map((frame) => Math.hypot(frame.uavg - NEUTRAL_CHROMA, frame.vavg - NEUTRAL_CHROMA)),
  );
  const runs: QcExposureRun[] = [];
  const minRunUs = thresholds.exposureMinRunSec * 1_000_000;
  let run:
    | {
        kind: 'dark' | 'bright';
        first: QcSignalFrame;
        last: QcSignalFrame;
        sum: number;
        count: number;
      }
    | undefined;
  const closeRun = (): void => {
    if (run === undefined) return;
    const startUs = run.first.timeUs;
    const endUs = run.last.timeUs + sampleIntervalUs;
    if (endUs - startUs >= minRunUs)
      runs.push({ kind: run.kind, startUs, endUs, meanLuma: run.sum / run.count });
    run = undefined;
  };
  for (const frame of frames) {
    const kind: 'dark' | 'bright' | undefined =
      frame.ymax < BLACK_FRAME_YMAX
        ? undefined
        : frame.yavg < thresholds.underexposedYavg
          ? 'dark'
          : frame.yavg > thresholds.overexposedYavg
            ? 'bright'
            : undefined;
    if (kind === undefined || (run !== undefined && run.kind !== kind)) closeRun();
    if (kind === undefined) continue;
    if (run === undefined) run = { kind, first: frame, last: frame, sum: frame.yavg, count: 1 };
    else {
      run.last = frame;
      run.sum += frame.yavg;
      run.count += 1;
    }
  }
  closeRun();
  return { sampledFrames: usable.length, meanLuma, medianChromaDistance, exposureRuns: runs };
}

// ---------------------------------------------------------------------------------------------------------
// Report

/** Everything the passes measured. A field is `undefined` when that pass did not run or was not wanted. */
export interface QcMeasurements {
  readonly durationUs: number;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly checksRun: readonly QcFileFindingType[];
  readonly black?: readonly QcInterval[];
  readonly frozen?: readonly QcInterval[];
  readonly sceneCuts?: readonly QcSceneCut[];
  readonly silence?: readonly QcInterval[];
  readonly loudness?: QcLoudness;
  readonly audioStats?: QcAudioStats;
  readonly picture?: QcPictureAnalysis;
  readonly sampleIntervalUs?: number;
  /** True when a pass hit its time cap, so what it looked at is not the whole file. */
  readonly incomplete: boolean;
  readonly truncated: readonly string[];
  readonly elapsedMs: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
function timecode(us: number): string {
  const total = Math.max(0, Math.floor(us / 1_000_000));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}
function secondsText(us: number): string {
  return `${(us / 1_000_000).toFixed(1)} s`;
}
function dbText(value: number): string {
  return `${value.toFixed(1)}`;
}

/** A finding before it is numbered into a report. */
export type DraftFinding = Omit<QcFinding, 'id'>;

function measuredFinding(
  type: QcFileFindingType,
  severity: QcSeverity,
  range: QcRange,
  label: string,
  measured: Record<string, number | string | null>,
  fixable: boolean,
): DraftFinding {
  return {
    type,
    state: 'measured',
    severity,
    startUs: range.startUs,
    endUs: range.endUs,
    label,
    measured,
    fixable,
    evidenceIds: [],
  };
}

/** Builds the findings from the measurements. Pure: the same numbers always give the same report. */
export function qcFindings(measurements: QcMeasurements, thresholds: QcThresholds): DraftFinding[] {
  const drafts: DraftFinding[] = [];
  const { durationUs } = measurements;
  const wholeFile: QcRange = { startUs: 0, endUs: durationUs };

  for (const range of measurements.black ?? []) {
    const length = range.endUs - range.startUs;
    drafts.push(
      measuredFinding(
        'black',
        length >= 3_000_000 ? 'major' : 'minor',
        range,
        `Black picture for ${secondsText(length)} at ${timecode(range.startUs)}.`,
        { blackDurationUs: length },
        false,
      ),
    );
  }
  for (const range of measurements.frozen ?? []) {
    const length = range.endUs - range.startUs;
    drafts.push(
      measuredFinding(
        'frozen',
        length >= 5_000_000 ? 'major' : 'minor',
        range,
        `The picture is frozen for ${secondsText(length)} at ${timecode(range.startUs)}.`,
        { freezeDurationUs: length },
        false,
      ),
    );
  }
  const cuts = measurements.sceneCuts ?? [];
  for (const cut of cuts.slice(0, thresholds.maxSceneCuts)) {
    drafts.push(
      measuredFinding(
        'scene-cut',
        'minor',
        { startUs: cut.timeUs, endUs: cut.timeUs },
        `Hard cut at ${timecode(cut.timeUs)}.`,
        { score: Math.round(cut.score * 1000) / 1000 },
        false,
      ),
    );
  }
  for (const range of measurements.silence ?? []) {
    const length = range.endUs - range.startUs;
    drafts.push(
      measuredFinding(
        'silence',
        length >= 5_000_000 ? 'major' : 'minor',
        range,
        `Silence for ${secondsText(length)} at ${timecode(range.startUs)}.`,
        { silenceDurationUs: length },
        true,
      ),
    );
  }
  const loudness = measurements.loudness;
  if (loudness !== undefined) {
    const lufs = loudness.integratedLufs;
    const truePeak = loudness.truePeakDbfs;
    const tooQuiet = lufs !== null && lufs < thresholds.loudnessMinLufs;
    const tooLoud = lufs !== null && lufs > thresholds.loudnessMaxLufs;
    const peaky = truePeak !== null && truePeak > thresholds.truePeakMaxDb;
    if (tooQuiet || tooLoud || peaky) {
      const away = tooQuiet
        ? thresholds.loudnessMinLufs - (lufs ?? 0)
        : tooLoud
          ? (lufs ?? 0) - thresholds.loudnessMaxLufs
          : 0;
      const label = tooQuiet
        ? `The whole cut is quiet: ${dbText(lufs ?? 0)} LUFS.`
        : tooLoud
          ? `The whole cut is loud: ${dbText(lufs ?? 0)} LUFS.`
          : `The loudest peak is high: ${dbText(truePeak ?? 0)} dBFS.`;
      drafts.push(
        measuredFinding(
          'loudness',
          away > 6 ? 'major' : 'minor',
          wholeFile,
          label,
          {
            integratedLufs: lufs,
            loudnessRangeLu: loudness.loudnessRangeLu,
            truePeakDbfs: truePeak,
          },
          true,
        ),
      );
    }
  }
  const stats = measurements.audioStats;
  if (stats !== undefined && stats.peakDb !== null && stats.peakDb >= thresholds.clippingPeakDb) {
    drafts.push(
      measuredFinding(
        'clipping',
        stats.peakDb >= 0 ? 'major' : 'minor',
        wholeFile,
        `The sound reaches ${dbText(stats.peakDb)} dBFS and may distort.`,
        { peakDb: stats.peakDb, peakCount: stats.peakCount },
        true,
      ),
    );
  }
  const picture = measurements.picture;
  if (picture !== undefined) {
    for (const run of picture.exposureRuns) {
      const length = run.endUs - run.startUs;
      drafts.push(
        measuredFinding(
          'exposure',
          length >= 5_000_000 ? 'major' : 'minor',
          { startUs: run.startUs, endUs: run.endUs },
          `${run.kind === 'dark' ? 'Too dark' : 'Too bright'} for ${secondsText(length)} at ${timecode(run.startUs)}.`,
          { meanLuma: Math.round(run.meanLuma * 10) / 10, kind: run.kind },
          false,
        ),
      );
    }
    if (picture.sampledFrames > 0 && picture.medianChromaDistance > thresholds.colourCastMax) {
      drafts.push(
        measuredFinding(
          'colour-cast',
          picture.medianChromaDistance > thresholds.colourCastMax * 2 ? 'major' : 'minor',
          wholeFile,
          'The picture leans toward one colour through most of the cut.',
          { medianChromaDistance: Math.round(picture.medianChromaDistance * 10) / 10 },
          false,
        ),
      );
    }
  }
  return drafts.sort((a, b) => a.startUs - b.startUs || a.type.localeCompare(b.type));
}

export interface BuildQcReportInput {
  readonly reportId: string;
  readonly assetId: string;
  readonly createdAt: string;
  readonly thresholds: QcThresholds;
  readonly measurements: QcMeasurements;
  /** Test seam; defaults to `MAX_QC_REPORT_BYTES`. */
  readonly maxReportBytes?: number;
}

export function buildQcReport(input: BuildQcReportInput): QcReport {
  const { measurements, thresholds } = input;
  const maxBytes = input.maxReportBytes ?? MAX_QC_REPORT_BYTES;
  const drafts = qcFindings(measurements, thresholds);
  const truncated = [...measurements.truncated];
  if ((measurements.sceneCuts?.length ?? 0) > thresholds.maxSceneCuts)
    truncated.push(
      `${(measurements.sceneCuts?.length ?? 0) - thresholds.maxSceneCuts} hard cuts were not listed (limit ${thresholds.maxSceneCuts})`,
    );

  const compose = (kept: readonly DraftFinding[], reasons: readonly string[]): QcReport => {
    const { durationUs } = measurements;
    const complete = !measurements.incomplete;
    return {
      version: 1,
      reportId: input.reportId,
      createdAt: input.createdAt,
      target: { kind: 'file', assetId: input.assetId },
      run: { layer1: true, layer2: false, modelId: null, framesSent: 0, framesSkipped: 0 },
      coverage: {
        completeSourceCoverage: complete,
        sampledRanges: complete && durationUs > 0 ? [{ startUs: 0, endUs: durationUs }] : [],
        unsampledRanges: complete || durationUs <= 0 ? [] : [{ startUs: 0, endUs: durationUs }],
      },
      findings: kept.map((draft, index) => ({ id: `qc-finding-${index + 1}`, ...draft })),
      notes: [],
      technical: {
        durationUs,
        hasVideo: measurements.hasVideo,
        hasAudio: measurements.hasAudio,
        checksRun: measurements.checksRun,
        loudness: measurements.loudness ?? null,
        audioPeakDb: measurements.audioStats?.peakDb ?? null,
        exposure:
          measurements.picture === undefined || measurements.sampleIntervalUs === undefined
            ? null
            : {
                sampledFrames: measurements.picture.sampledFrames,
                sampleIntervalUs: measurements.sampleIntervalUs,
                meanLuma: Math.round(measurements.picture.meanLuma * 10) / 10,
                medianChromaDistance:
                  Math.round(measurements.picture.medianChromaDistance * 10) / 10,
              },
        thresholds,
        truncated: reasons,
        elapsedMs: measurements.elapsedMs,
      },
      modelComprehensionGuaranteed: false,
    };
  };

  let report = compose(drafts, truncated);
  if (Buffer.byteLength(JSON.stringify(report)) <= maxBytes) return report;

  // Too big: drop scene cuts first (the cheapest fact to lose), then the last findings, until it fits.
  const sizes = drafts.map(
    (draft) => Buffer.byteLength(JSON.stringify({ id: 'qc-finding-0000', ...draft })) + 1,
  );
  let total = Buffer.byteLength(JSON.stringify(compose([], [...truncated, 'x'.repeat(80)])));
  for (const size of sizes) total += size;
  const kept = [...drafts];
  const keptSizes = [...sizes];
  let dropped = 0;
  while (total > maxBytes && kept.length > 0) {
    let index = -1;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      if (kept[i]?.type === 'scene-cut') {
        index = i;
        break;
      }
    }
    if (index < 0) index = kept.length - 1;
    total -= keptSizes[index] ?? 0;
    kept.splice(index, 1);
    keptSizes.splice(index, 1);
    dropped += 1;
  }
  report = compose(kept, [
    ...truncated,
    `${dropped} findings were not listed to keep the report under ${Math.round(maxBytes / 1024)} KB`,
  ]);
  return report;
}

// ---------------------------------------------------------------------------------------------------------
// Running ffmpeg

/** Keeps the first `headLimit` characters and the last `tailLimit`; the middle is dropped. */
class BoundedText {
  #head = '';
  #tail = '';
  #dropped = false;
  constructor(
    private readonly headLimit: number,
    private readonly tailLimit: number,
  ) {}
  push(chunk: string): void {
    let rest = chunk;
    if (this.#head.length < this.headLimit) {
      const room = this.headLimit - this.#head.length;
      this.#head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (rest.length === 0) return;
    if (this.tailLimit === 0) {
      this.#dropped = true;
      return;
    }
    this.#tail += rest;
    if (this.#tail.length > this.tailLimit) {
      this.#tail = this.#tail.slice(-this.tailLimit);
      this.#dropped = true;
    }
  }
  get truncated(): boolean {
    return this.#dropped;
  }
  text(): string {
    return this.#dropped ? `${this.#head}\n${this.#tail}` : this.#head + this.#tail;
  }
}

export interface ProcessOutcome {
  readonly state: 'completed' | 'cancelled' | 'timed-out' | 'failed';
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when captured output was cut to its size limit. */
  readonly truncated: boolean;
}

interface ProcessLimits {
  readonly cancelled: () => boolean;
  readonly timeoutMs: number;
  readonly stdoutHeadBytes: number;
  readonly stderrHeadBytes: number;
  readonly stderrTailBytes: number;
}

/** Runs one child process under a time cap, a cancel poll and bounded output capture. Never uses a shell. */
export function runProcess(
  command: string,
  args: readonly string[],
  limits: ProcessLimits,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const stdout = new BoundedText(limits.stdoutHeadBytes, 0);
    const stderr = new BoundedText(limits.stderrHeadBytes, limits.stderrTailBytes);
    let intent: 'cancelled' | 'timed-out' | undefined;
    let settled = false;
    // Assigned after spawn: finish() can run earlier (spawn failure), so these cannot be const.
    // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout> | undefined;
    // eslint-disable-next-line prefer-const
    let poll: ReturnType<typeof setInterval> | undefined;
    const finish = (state: ProcessOutcome['state'], exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (poll !== undefined) clearInterval(poll);
      resolve({
        state,
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated || stderr.truncated,
      });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      finish('failed', null);
      return;
    }
    const stop = (why: 'cancelled' | 'timed-out'): void => {
      if (intent !== undefined) return;
      intent = why;
      child.kill();
    };
    timer = setTimeout(() => stop('timed-out'), limits.timeoutMs);
    poll = setInterval(() => {
      if (limits.cancelled()) stop('cancelled');
    }, 50);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
    child.once('error', () => finish('failed', null));
    child.once('close', (code) => finish(intent ?? (code === 0 ? 'completed' : 'failed'), code));
  });
}

interface ProbeResult {
  readonly durationUs: number;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
}

/** Reads `ffprobe -of json` output. A cover-art picture inside an audio file is not a video stream. */
export function parseProbe(json: string): ProbeResult {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('FFprobe returned an unreadable answer');
  }
  const record = (candidate: unknown): Record<string, unknown> =>
    candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : {};
  const root = record(value);
  const streams = Array.isArray(root['streams']) ? (root['streams'] as unknown[]).map(record) : [];
  const hasVideo = streams.some(
    (stream) =>
      stream['codec_type'] === 'video' && record(stream['disposition'])['attached_pic'] !== 1,
  );
  const hasAudio = streams.some((stream) => stream['codec_type'] === 'audio');
  const formatSeconds = Number(record(root['format'])['duration']);
  const streamSeconds = streams
    .map((stream) => Number(stream['duration']))
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0);
  const seconds =
    Number.isFinite(formatSeconds) && formatSeconds > 0
      ? formatSeconds
      : streamSeconds.length > 0
        ? Math.max(...streamSeconds)
        : 0;
  return { durationUs: Math.round(seconds * 1_000_000), hasVideo, hasAudio };
}

export interface MediaQcReceipt {
  readonly kind: 'media.qc';
  readonly assetId: string;
  readonly report: QcReport;
}

export interface MediaQcRunOptions {
  readonly jobId: string;
  readonly assetId: string;
  readonly sourcePath: string;
  /** The job payload as received; validated here. */
  readonly payload?: unknown;
  readonly cancelled: () => boolean;
  readonly progress: (progress: number) => Promise<void>;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly now?: () => Date;
}

const COMMON_FFMPEG_ARGS = ['-hide_banner', '-nostdin', '-nostats', '-v', 'info'] as const;

/** Runs the technical check over one file and returns the report. Throws `canceled` when cancelled. */
export async function runMediaQc(options: MediaQcRunOptions): Promise<MediaQcReceipt> {
  const { checks, thresholds, maxRunMs } = parseMediaQcPayload(options.payload);
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const ffprobe = options.ffprobePath ?? 'ffprobe';
  const started = Date.now();
  const deadline = started + maxRunMs;
  const truncated: string[] = [];
  let incomplete = false;

  const run = async (
    label: string,
    command: string,
    args: readonly string[],
    timeoutCapMs = Number.POSITIVE_INFINITY,
  ): Promise<ProcessOutcome | undefined> => {
    if (options.cancelled()) throw new Error('canceled');
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      truncated.push(`${label} was skipped: the time limit was reached`);
      incomplete = true;
      return undefined;
    }
    const outcome = await runProcess(command, args, {
      cancelled: options.cancelled,
      timeoutMs: Math.min(remaining, timeoutCapMs),
      stdoutHeadBytes: STDOUT_HEAD_BYTES,
      stderrHeadBytes: STDERR_HEAD_BYTES,
      stderrTailBytes: STDERR_TAIL_BYTES,
    });
    if (outcome.state === 'cancelled' || options.cancelled()) throw new Error('canceled');
    if (outcome.state === 'failed')
      throw new Error(`${label} failed (exit ${outcome.exitCode ?? 'signal'})`);
    if (outcome.state === 'timed-out') {
      truncated.push(`${label} stopped at the time limit; its results are partial`);
      incomplete = true;
    } else if (outcome.truncated) truncated.push(`${label} output was cut to its size limit`);
    return outcome;
  };

  await options.progress(5);
  const probed = await run(
    'FFprobe',
    ffprobe,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,duration:stream_disposition=attached_pic',
      '-of',
      'json',
      options.sourcePath,
    ],
    PROBE_TIMEOUT_MS,
  );
  if (probed === undefined || probed.state === 'timed-out')
    throw new Error('FFprobe could not read the file in time');
  const probe = parseProbe(probed.stdout);
  if (!probe.hasVideo && !probe.hasAudio) throw new Error('the file has no audio or video stream');
  const { durationUs } = probe;
  // A pass that was cut short does not know where an open stretch would have ended.
  const openEnd = (passIncomplete: boolean): number | undefined =>
    passIncomplete || durationUs <= 0 ? undefined : durationUs;
  const checksRun: QcFileFindingType[] = [];

  // Video pass: black, frozen, hard cuts.
  const videoChain: string[] = [];
  if (probe.hasVideo && checks.has('black')) {
    videoChain.push(
      `blackdetect=d=${thresholds.blackMinDurationSec}:pix_th=${thresholds.blackPixelThreshold}`,
    );
    checksRun.push('black');
  }
  if (probe.hasVideo && checks.has('frozen')) {
    videoChain.push(
      `freezedetect=n=${thresholds.freezeNoiseDb}dB:d=${thresholds.freezeMinDurationSec}`,
    );
    checksRun.push('frozen');
  }
  if (probe.hasVideo && checks.has('scene-cut')) {
    videoChain.push(`scdet=t=${thresholds.sceneCutThreshold}`);
    checksRun.push('scene-cut');
  }
  let black: QcInterval[] | undefined;
  let frozen: QcInterval[] | undefined;
  let sceneCuts: QcSceneCut[] | undefined;
  if (videoChain.length > 0) {
    await options.progress(10);
    const outcome = await run('the video check', ffmpeg, [
      ...COMMON_FFMPEG_ARGS,
      '-i',
      options.sourcePath,
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      videoChain.join(','),
      '-f',
      'null',
      '-',
    ]);
    if (outcome !== undefined) {
      const partial = outcome.state === 'timed-out';
      const text = outcome.stderr;
      if (checks.has('black')) black = parseBlackdetect(text, durationUs);
      if (checks.has('frozen')) frozen = parseFreezedetect(text, durationUs, openEnd(partial));
      if (checks.has('scene-cut')) sceneCuts = parseScdet(text);
    }
  }

  // Audio pass: loudness, silence, clipping.
  const audioChain: string[] = [];
  if (probe.hasAudio && checks.has('loudness')) {
    audioChain.push('ebur128=peak=true:framelog=quiet');
    checksRun.push('loudness');
  }
  if (probe.hasAudio && checks.has('silence')) {
    audioChain.push(
      `silencedetect=n=${thresholds.silenceDb}dB:d=${thresholds.silenceMinDurationSec}`,
    );
    checksRun.push('silence');
  }
  if (probe.hasAudio && checks.has('clipping')) {
    audioChain.push('astats');
    checksRun.push('clipping');
  }
  let silence: QcInterval[] | undefined;
  let loudness: QcLoudness | undefined;
  let audioStats: QcAudioStats | undefined;
  if (audioChain.length > 0) {
    await options.progress(40);
    const outcome = await run('the audio check', ffmpeg, [
      ...COMMON_FFMPEG_ARGS,
      '-i',
      options.sourcePath,
      '-map',
      '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      '-af',
      audioChain.join(','),
      '-f',
      'null',
      '-',
    ]);
    if (outcome !== undefined) {
      const partial = outcome.state === 'timed-out';
      const text = outcome.stderr;
      if (checks.has('silence')) silence = parseSilencedetect(text, durationUs, openEnd(partial));
      // The summaries are printed only when ffmpeg ends cleanly, so a partial run has none.
      if (checks.has('loudness')) loudness = parseEbur128Summary(text);
      if (checks.has('clipping')) audioStats = parseAstatsOverall(text);
    }
  }

  // Stats pass: exposure and colour cast on a sampled frame rate.
  let picture: QcPictureAnalysis | undefined;
  let sampleIntervalUs: number | undefined;
  const wantPicture = checks.has('exposure') || checks.has('colour-cast');
  if (probe.hasVideo && wantPicture) {
    if (checks.has('exposure')) checksRun.push('exposure');
    if (checks.has('colour-cast')) checksRun.push('colour-cast');
    await options.progress(70);
    const seconds = durationUs / 1_000_000;
    const fps = Math.max(
      0.01,
      seconds > 0 ? Math.min(MAX_SAMPLE_FPS, MAX_SAMPLED_FRAMES / seconds) : 1,
    );
    sampleIntervalUs = Math.round(1_000_000 / Number(fps.toFixed(4)));
    const outcome = await run('the picture check', ffmpeg, [
      ...COMMON_FFMPEG_ARGS,
      '-i',
      options.sourcePath,
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      `fps=${fps.toFixed(4)},signalstats,metadata=mode=print:file=-`,
      '-f',
      'null',
      '-',
    ]);
    if (outcome !== undefined) {
      // The metadata is written to stdout; the log form is accepted too, in case a build prints it there.
      const frames = parseSignalstats(`${outcome.stdout}\n${outcome.stderr}`);
      picture = analysePicture(frames, sampleIntervalUs, thresholds);
    }
  }

  await options.progress(95);
  const measurements: QcMeasurements = {
    durationUs,
    hasVideo: probe.hasVideo,
    hasAudio: probe.hasAudio,
    checksRun,
    ...(black === undefined ? {} : { black }),
    ...(frozen === undefined ? {} : { frozen }),
    ...(sceneCuts === undefined ? {} : { sceneCuts }),
    ...(silence === undefined ? {} : { silence }),
    ...(loudness === undefined ? {} : { loudness }),
    ...(audioStats === undefined ? {} : { audioStats }),
    ...(picture === undefined ? {} : { picture }),
    ...(sampleIntervalUs === undefined ? {} : { sampleIntervalUs }),
    incomplete,
    truncated,
    elapsedMs: Date.now() - started,
  };
  const report = buildQcReport({
    reportId: `qc-report-${options.jobId}`,
    assetId: options.assetId,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    thresholds,
    measurements,
  });
  await options.progress(100);
  return { kind: 'media.qc', assetId: options.assetId, report };
}
