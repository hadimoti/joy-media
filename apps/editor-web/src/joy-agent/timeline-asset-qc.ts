import type { HostRpcJson } from './host-rpc.js';

export interface TimelineAssetClip {
  readonly id?: string;
  readonly kind?: string;
  readonly assetId?: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly sourceInUs?: number;
  readonly playbackRate?: number;
}

export interface TimelineAssetTrack {
  readonly enabled?: boolean;
  readonly clips: readonly TimelineAssetClip[];
}

export interface TimelineAssetComposition {
  readonly tracks: readonly TimelineAssetTrack[];
}

export interface ResolvedTimelineAssetClip {
  readonly assetId: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly sourceInUs: number;
  readonly playbackRate: number;
}

export interface TimelineAssetQcFinding {
  readonly type: string;
  readonly severity: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly label: string;
  readonly measured?: Readonly<Record<string, HostRpcJson>>;
  readonly fixable: boolean;
  readonly evidenceIds: readonly string[];
}

const CLIPPING_PEAK_DB = -0.1;
const TRUE_PEAK_MAX_DB = -1;
const LOUDNESS_MIN_LUFS = -26;
const LOUDNESS_MAX_LUFS = -9;
const MIN_FREEZE_TAIL_US = 1_000_000;
const AV_TOLERANCE_US = 500_000;

export function collectTimelineAssetClips(
  composition: TimelineAssetComposition | undefined,
): readonly ResolvedTimelineAssetClip[] {
  if (composition === undefined) return [];
  const clips: ResolvedTimelineAssetClip[] = [];
  for (const track of composition.tracks) {
    if (track.enabled === false) continue;
    for (const clip of track.clips) {
      if (clip.kind !== undefined && clip.kind !== 'video' && clip.kind !== 'audio') continue;
      if (typeof clip.assetId !== 'string' || clip.assetId.length === 0) continue;
      if (!Number.isSafeInteger(clip.startUs) || !Number.isSafeInteger(clip.durationUs)) continue;
      if (clip.startUs < 0 || clip.durationUs < 1) continue;
      const sourceInUs =
        typeof clip.sourceInUs === 'number' &&
        Number.isSafeInteger(clip.sourceInUs) &&
        clip.sourceInUs >= 0
          ? clip.sourceInUs
          : 0;
      const playbackRate =
        typeof clip.playbackRate === 'number' &&
        Number.isFinite(clip.playbackRate) &&
        clip.playbackRate > 0
          ? clip.playbackRate
          : 1;
      clips.push({
        assetId: clip.assetId,
        startUs: clip.startUs,
        durationUs: clip.durationUs,
        sourceInUs,
        playbackRate,
      });
    }
  }
  return clips.sort((a, b) => a.startUs - b.startUs);
}

export async function resolveTimelineAssetReports(input: {
  readonly clips: readonly ResolvedTimelineAssetClip[];
  readonly cache?: Map<string, Readonly<Record<string, unknown>>>;
  readonly checkAsset?: (
    assetId: string,
    signal: AbortSignal,
  ) => Promise<Readonly<Record<string, unknown>> | undefined>;
  readonly signal: AbortSignal;
}): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
  const reports = new Map<string, Readonly<Record<string, unknown>>>();
  if (input.clips.length === 0) return reports;
  const uniqueAssetIds = [...new Set(input.clips.map((clip) => clip.assetId))];
  await Promise.all(
    uniqueAssetIds.map(async (assetId) => {
      input.signal.throwIfAborted();
      const cached = input.cache?.get(assetId);
      if (cached !== undefined) {
        reports.set(assetId, cached);
        return;
      }
      if (input.checkAsset === undefined) return;
      try {
        const fetched = await input.checkAsset(assetId, input.signal);
        if (fetched !== undefined && Array.isArray(fetched['findings'])) {
          input.cache?.set(assetId, fetched);
          reports.set(assetId, fetched);
        }
      } catch (error) {
        if (input.signal.aborted) throw error;
      }
    }),
  );
  return reports;
}

export function mapAssetQcReportsToTimelineFindings(input: {
  readonly clips: readonly ResolvedTimelineAssetClip[];
  readonly reports: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly timesUs: readonly number[];
  readonly frameIdAt: (timeUs: number) => string;
  readonly masterGain: number;
}): readonly TimelineAssetQcFinding[] {
  const out: TimelineAssetQcFinding[] = [];
  const gainDb =
    Number.isFinite(input.masterGain) && input.masterGain > 0
      ? 20 * Math.log10(input.masterGain)
      : -Infinity;

  for (const clip of input.clips) {
    const report = input.reports.get(clip.assetId);
    const rawFindings = report?.['findings'];
    if (!Array.isArray(rawFindings)) continue;
    const sourceStartUs = clip.sourceInUs;
    const sourceSpanUs = Math.max(1, Math.round(clip.durationUs * clip.playbackRate));
    const sourceEndUs = sourceStartUs + sourceSpanUs;
    const clipEndUs = clip.startUs + clip.durationUs;

    const parsed = rawFindings.filter(isFindingRecord);
    const silentSpanUs = totalOverlapSpan(
      parsed.filter((item) => item.type === 'silence'),
      sourceStartUs,
      sourceEndUs,
    );
    const mostlySilent = silentSpanUs >= sourceSpanUs * 0.9;
    const hasNativeFrozenInTail = (tailStart: number, tailEnd: number) =>
      parsed.some(
        (item) => item.type === 'frozen' && item.startUs < tailEnd && item.endUs > tailStart,
      );

    let addedTailFreeze = false;
    for (const item of parsed) {
      const point = item.startUs === item.endUs;
      if (point) {
        if (item.startUs < sourceStartUs || item.startUs > sourceEndUs) continue;
      } else if (item.startUs >= sourceEndUs || item.endUs <= sourceStartUs) {
        continue;
      }

      if (item.type === 'av-length-mismatch') {
        const videoDurationUs = numberOf(item.measured?.['videoDurationUs']);
        if (videoDurationUs !== undefined && videoDurationUs >= 0) {
          const freezeStartUs = Math.max(sourceStartUs, videoDurationUs);
          const tailUs = sourceEndUs - freezeStartUs;
          if (
            !addedTailFreeze &&
            tailUs >= MIN_FREEZE_TAIL_US &&
            !hasNativeFrozenInTail(freezeStartUs, sourceEndUs)
          ) {
            addedTailFreeze = true;
            const tlFreezeStartUs = Math.min(
              clipEndUs,
              clip.startUs + Math.floor((freezeStartUs - sourceStartUs) / clip.playbackRate),
            );
            const tlDurationUs = clipEndUs - tlFreezeStartUs;
            if (tlDurationUs >= MIN_FREEZE_TAIL_US) {
              out.push({
                type: 'frozen',
                severity: 'major',
                startUs: tlFreezeStartUs,
                endUs: clipEndUs,
                label: `Frozen picture for ${(tlDurationUs / 1_000_000).toFixed(1)} s at ${formatClock(tlFreezeStartUs)}.`,
                measured: {
                  freezeDurationUs: tlDurationUs,
                  videoDurationUs,
                },
                fixable: true,
                evidenceIds: nearestEvidenceId(
                  input.timesUs,
                  input.frameIdAt,
                  tlFreezeStartUs,
                  clipEndUs,
                ),
              });
            }
          }
          // Skip av-length-mismatch once any held video-short tail has been trimmed cleanly to fit.
          if (sourceEndUs <= videoDurationUs + AV_TOLERANCE_US) continue;
        }
      }

      const overlapStart = Math.max(item.startUs, sourceStartUs);
      const overlapEnd = Math.min(item.endUs, sourceEndUs);
      const tlStartUs = Math.max(
        clip.startUs,
        clip.startUs + Math.floor((overlapStart - sourceStartUs) / clip.playbackRate),
      );
      const tlEndUs = point
        ? tlStartUs
        : Math.min(
            clipEndUs,
            Math.max(
              tlStartUs + 1,
              clip.startUs + Math.ceil((overlapEnd - sourceStartUs) / clip.playbackRate),
            ),
          );

      if (item.type === 'clipping') {
        const adjusted = adjustClipping(item.measured, gainDb, tlStartUs);
        if (adjusted === undefined) continue;
        out.push({
          type: 'clipping',
          severity: item.severity,
          startUs: tlStartUs,
          endUs: tlEndUs,
          label: adjusted.label,
          measured: adjusted.measured,
          fixable: true,
          evidenceIds: nearestEvidenceId(input.timesUs, input.frameIdAt, tlStartUs, tlEndUs),
        });
        continue;
      }

      if (item.type === 'loudness') {
        const rawLufs = numberOf(item.measured?.['integratedLufs']);
        if (mostlySilent && rawLufs !== undefined && rawLufs <= -69) continue;
        const adjusted = adjustLoudness(item.measured, gainDb);
        if (adjusted === undefined) continue;
        out.push({
          type: 'loudness',
          severity: item.severity,
          startUs: tlStartUs,
          endUs: tlEndUs,
          label: adjusted.label,
          measured: adjusted.measured,
          fixable: true,
          evidenceIds: nearestEvidenceId(input.timesUs, input.frameIdAt, tlStartUs, tlEndUs),
        });
        continue;
      }

      out.push({
        type: item.type,
        severity: item.severity,
        startUs: tlStartUs,
        endUs: tlEndUs,
        label: relabelAt(item.type, tlStartUs, tlEndUs, item.measured, item.label),
        ...(item.measured === undefined ? {} : { measured: item.measured }),
        fixable: item.fixable,
        evidenceIds: nearestEvidenceId(input.timesUs, input.frameIdAt, tlStartUs, tlEndUs),
      });
    }
  }
  return out;
}

interface ParsedSourceFinding {
  readonly type: string;
  readonly severity: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly label: string;
  readonly measured?: Readonly<Record<string, HostRpcJson>>;
  readonly fixable: boolean;
}

function isFindingRecord(value: unknown): value is ParsedSourceFinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['type'] === 'string' &&
    typeof record['severity'] === 'string' &&
    typeof record['startUs'] === 'number' &&
    Number.isSafeInteger(record['startUs']) &&
    typeof record['endUs'] === 'number' &&
    Number.isSafeInteger(record['endUs']) &&
    typeof record['label'] === 'string' &&
    typeof record['fixable'] === 'boolean'
  );
}

function adjustClipping(
  measured: Readonly<Record<string, HostRpcJson>> | undefined,
  gainDb: number,
  tlStartUs: number,
):
  { readonly measured: Readonly<Record<string, HostRpcJson>>; readonly label: string } | undefined {
  const rawPeak = numberOf(measured?.['peakDb']);
  const rawTruePeak = numberOf(measured?.['truePeakDbfs']);
  const nextPeak = rawPeak === undefined ? undefined : round1(rawPeak + gainDb);
  const nextTruePeak = rawTruePeak === undefined ? undefined : round1(rawTruePeak + gainDb);
  const peakOk = nextPeak === undefined || nextPeak < CLIPPING_PEAK_DB;
  const truePeakOk = nextTruePeak === undefined || nextTruePeak <= TRUE_PEAK_MAX_DB;
  if (peakOk && truePeakOk) return undefined;
  const peakShown = nextTruePeak ?? nextPeak ?? 0;
  return {
    measured: {
      ...(measured ?? {}),
      ...(nextPeak === undefined ? {} : { peakDb: nextPeak }),
      ...(nextTruePeak === undefined ? {} : { truePeakDbfs: nextTruePeak }),
    },
    label: `The sound reaches ${peakShown.toFixed(1)} dBFS near ${formatClock(tlStartUs)} and may distort.`,
  };
}

function adjustLoudness(
  measured: Readonly<Record<string, HostRpcJson>> | undefined,
  gainDb: number,
):
  { readonly measured: Readonly<Record<string, HostRpcJson>>; readonly label: string } | undefined {
  const rawLufs = numberOf(measured?.['integratedLufs']);
  const rawTruePeak = numberOf(measured?.['truePeakDbfs']);
  const nextLufs = rawLufs === undefined ? undefined : round1(rawLufs + gainDb);
  const nextTruePeak = rawTruePeak === undefined ? undefined : round1(rawTruePeak + gainDb);
  const lufsOk =
    nextLufs === undefined || (nextLufs >= LOUDNESS_MIN_LUFS && nextLufs <= LOUDNESS_MAX_LUFS);
  const peakOk = nextTruePeak === undefined || nextTruePeak <= TRUE_PEAK_MAX_DB;
  if (lufsOk && peakOk) return undefined;
  const summary =
    nextLufs !== undefined && nextLufs > LOUDNESS_MAX_LUFS
      ? `loud: ${nextLufs.toFixed(1)} LUFS`
      : nextLufs !== undefined && nextLufs < LOUDNESS_MIN_LUFS
        ? `quiet: ${nextLufs.toFixed(1)} LUFS`
        : `peaking at ${(nextTruePeak ?? 0).toFixed(1)} dBFS`;
  return {
    measured: {
      ...(measured ?? {}),
      ...(nextLufs === undefined ? {} : { integratedLufs: nextLufs }),
      ...(nextTruePeak === undefined ? {} : { truePeakDbfs: nextTruePeak }),
    },
    label: `Audio segment is ${summary}.`,
  };
}

function relabelAt(
  type: string,
  tlStartUs: number,
  tlEndUs: number,
  measured: Readonly<Record<string, HostRpcJson>> | undefined,
  fallback: string,
): string {
  const durSec = ((tlEndUs - tlStartUs) / 1_000_000).toFixed(1);
  const at = formatClock(tlStartUs);
  switch (type) {
    case 'black':
      return `Black picture for ${durSec} s at ${at}.`;
    case 'frozen':
      return `Frozen picture for ${durSec} s at ${at}.`;
    case 'silence':
      return `Silence for ${durSec} s at ${at}.`;
    case 'exposure': {
      const kind = measured?.['kind'] === 'bright' ? 'bright' : 'dark';
      return `Too ${kind} for ${durSec} s at ${at}.`;
    }
    case 'scene-cut':
      return `Hard cut at ${at}.`;
    default:
      return fallback;
  }
}

function totalOverlapSpan(
  findings: readonly ParsedSourceFinding[],
  startUs: number,
  endUs: number,
): number {
  let total = 0;
  for (const item of findings) {
    const from = Math.max(item.startUs, startUs);
    const to = Math.min(item.endUs, endUs);
    if (to > from) total += to - from;
  }
  return total;
}

function nearestEvidenceId(
  timesUs: readonly number[],
  frameIdAt: (timeUs: number) => string,
  startUs: number,
  endUs: number,
): readonly string[] {
  if (timesUs.length === 0) return [];
  const midpoint = Math.floor(startUs + (endUs - startUs) / 2);
  let bestTime = timesUs[0]!;
  let bestDist = Math.abs(bestTime - midpoint);
  for (const t of timesUs) {
    const dist = Math.abs(t - midpoint);
    if (dist < bestDist) {
      bestDist = dist;
      bestTime = t;
    }
  }
  return [frameIdAt(bestTime)];
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatClock(timeUs: number): string {
  const totalSec = Math.max(0, Math.floor(timeUs / 1_000_000));
  const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}
