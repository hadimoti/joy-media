/**
 * The view model, Markdown and JSON of one Joy Code QC report card (card T-B07).
 *
 * The report itself is the `QcReport` shape of `@joy-media/job-protocol` (T-B04 / T-B08); this module reads it
 * and never changes it. The timeline check adds two finding types the file check does not have
 * (`safe-area`, `text-legibility`) and a `frames` list, so the reader is tolerant: it keeps what it can
 * verify, drops what it cannot, and never throws on a report that came from a model tool or a saved file.
 */
import type { QcFindingState, QcReport, QcSeverity } from '@joy-media/job-protocol';

const MAX_FINDINGS = 400;
const MAX_FRAMES = 96;
const MAX_NOTES = 96;
const MAX_FRAME_SCAN = MAX_FRAMES * 4;
const MAX_NOTE_SCAN = MAX_NOTES * 4;
const MAX_MEASUREMENT_FIELDS = 12;
const MAX_TRUNCATION_NOTES = 12;
const MAX_TEXT_CHARS = 240;
const MAX_MEASUREMENT_VALUE_CHARS = 120;
const SAFE_FILE_PART = /[^A-Za-z0-9._-]+/g;

export type QcMeasurementValue = number | string | boolean | null;

export interface QcCardFinding {
  readonly id: string;
  readonly type: string;
  readonly severity: QcSeverity;
  readonly state: QcFindingState;
  readonly startUs: number;
  readonly endUs: number;
  readonly label: string;
  readonly measured: Readonly<Record<string, QcMeasurementValue>>;
  readonly measurementsTruncated: boolean;
  readonly fixable: boolean;
}

export interface QcCardGroup {
  readonly type: string;
  readonly name: string;
  readonly findings: readonly QcCardFinding[];
}

export interface QcCardFrame {
  readonly id: string;
  readonly timeUs: number;
}

export interface QcCardNote {
  readonly timeUs?: number;
  readonly text: string;
}

export interface QcReportView {
  readonly reportId: string;
  /** Shared by reports from one run; undefined when the input has no safe lineage. */
  readonly reportLineageId: string | undefined;
  readonly createdAt: string;
  readonly targetKind: 'timeline' | 'file';
  /** The span the report looked at, microseconds; undefined when the report does not say. */
  readonly durationUs: number | undefined;
  readonly summary: string;
  readonly findingCount: number;
  readonly groups: readonly QcCardGroup[];
  /** True only when the report claims it read every part of the source. */
  readonly completeCoverage: boolean;
  /** The seeing model that was sent frames; null when nothing left this device. */
  readonly modelId: string | null;
  readonly layer2: boolean;
  readonly framesSent: number;
  readonly frameBudget: number | undefined;
  readonly frames: readonly QcCardFrame[];
  readonly notes: readonly QcCardNote[];
  readonly truncated: readonly string[];
}

const GROUP_NAMES: Readonly<Record<string, string>> = {
  black: 'Black frames',
  frozen: 'Frozen picture',
  'scene-cut': 'Hard cuts',
  loudness: 'Loudness',
  silence: 'Silence',
  clipping: 'Clipping',
  exposure: 'Exposure',
  'colour-cast': 'Colour cast',
  'av-length-mismatch': 'Video and sound length',
  'safe-area': 'Safe area',
  'text-legibility': 'Text legibility',
};

/** Display order: picture, then sound, then text, then anything a later build adds. */
const GROUP_ORDER: readonly string[] = [
  'black',
  'frozen',
  'scene-cut',
  'exposure',
  'colour-cast',
  'av-length-mismatch',
  'silence',
  'clipping',
  'loudness',
  'safe-area',
  'text-legibility',
];

const SEVERITY_RANK: Readonly<Record<QcSeverity, number>> = { blocker: 0, major: 1, minor: 2 };

export function qcGroupName(type: string): string {
  const known = GROUP_NAMES[type];
  if (known !== undefined) return known;
  const words = type.replace(/[^A-Za-z0-9]+/g, ' ').trim();
  return words.length === 0 ? 'Other' : words.charAt(0).toUpperCase() + words.slice(1);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimeUs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function shortText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length === 0 ? undefined : clean.slice(0, MAX_TEXT_CHARS);
}

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return undefined;
  return clean.length > MAX_TEXT_CHARS ? `${clean.slice(0, MAX_TEXT_CHARS - 1)}…` : clean;
}

function readMeasured(value: unknown): {
  values: Readonly<Record<string, QcMeasurementValue>>;
  truncated: boolean;
} {
  if (!isObject(value)) return { values: {}, truncated: false };
  const measured: Record<string, QcMeasurementValue> = {};
  let accepted = 0;
  let truncated = false;
  for (const rawKey of Object.keys(value)) {
    if (accepted >= MAX_MEASUREMENT_FIELDS) {
      truncated = true;
      break;
    }
    const key = shortText(rawKey);
    if (key === undefined) continue;
    try {
      const rawValue = value[rawKey];
      if (rawValue === null) measured[key] = null;
      else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) measured[key] = rawValue;
      else if (typeof rawValue === 'boolean') measured[key] = rawValue;
      else if (typeof rawValue === 'string') {
        const text = boundedLabel(rawValue);
        if (text === undefined) continue;
        measured[key] =
          text.length > MAX_MEASUREMENT_VALUE_CHARS
            ? `${text.slice(0, MAX_MEASUREMENT_VALUE_CHARS - 1)}…`
            : text;
      } else continue;
      accepted += 1;
    } catch {
      // Ignore a field that cannot be read from an untrusted report object.
    }
  }
  return { values: measured, truncated };
}

function isSeverity(value: unknown): value is QcSeverity {
  return value === 'blocker' || value === 'major' || value === 'minor';
}

function isState(value: unknown): value is QcFindingState {
  return value === 'measured' || value === 'model-observed' || value === 'unconfirmed';
}

function readFinding(value: unknown): QcCardFinding | undefined {
  if (!isObject(value)) return undefined;
  const id = shortText(value['id']);
  const type = shortText(value['type']);
  const label = boundedLabel(value['label']);
  const { startUs, endUs } = value;
  if (id === undefined || type === undefined || label === undefined) return undefined;
  if (!isTimeUs(startUs) || !isTimeUs(endUs) || endUs < startUs) return undefined;
  const measured = readMeasured(value['measured']);
  return {
    id,
    type,
    label,
    startUs,
    endUs,
    severity: isSeverity(value['severity']) ? value['severity'] : 'minor',
    state: isState(value['state']) ? value['state'] : 'unconfirmed',
    measured: measured.values,
    measurementsTruncated: measured.truncated,
    fixable: value['fixable'] === true,
  };
}

function readFrames(value: unknown): { frames: readonly QcCardFrame[]; truncated: boolean } {
  if (!Array.isArray(value)) return { frames: [], truncated: false };
  const seen = new Set<string>();
  const frames: QcCardFrame[] = [];
  const scanCount = Math.min(value.length, MAX_FRAME_SCAN);
  let truncated = value.length > scanCount;
  for (let index = 0; index < scanCount; index += 1) {
    const item = value[index] as unknown;
    if (!isObject(item)) continue;
    const id = item['frameId'];
    const timeUs = item['timeUs'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) continue;
    if (!isTimeUs(timeUs) || seen.has(id)) continue;
    seen.add(id);
    if (frames.length === MAX_FRAMES) {
      truncated = true;
      break;
    }
    frames.push({ id, timeUs });
  }
  return { frames: frames.sort((left, right) => left.timeUs - right.timeUs), truncated };
}

function readNotes(value: unknown): { notes: readonly QcCardNote[]; truncated: boolean } {
  const notes: QcCardNote[] = [];
  try {
    if (!Array.isArray(value)) return { notes, truncated: false };
    const scanCount = Math.min(value.length, MAX_NOTE_SCAN);
    let truncated = value.length > scanCount;
    for (let index = 0; index < scanCount; index += 1) {
      try {
        const item = value[index] as unknown;
        if (!isObject(item)) continue;
        const text = boundedLabel(item['text']);
        if (text === undefined) continue;
        if (notes.length === MAX_NOTES) {
          truncated = true;
          break;
        }
        const timeUs = item['timeUs'];
        notes.push({
          ...(isTimeUs(timeUs) ? { timeUs } : {}),
          text,
        });
      } catch {
        // A malformed note cannot prevent the rest of the report from being shown.
      }
    }
    return { notes, truncated };
  } catch {
    // A broken notes container cannot prevent the rest of the report from being shown.
    return { notes, truncated: true };
  }
}

function reportLineageId(
  reportId: string,
  report: Record<string, unknown>,
  run: Record<string, unknown>,
): string | undefined {
  const explicitRunId = shortText(report['runId']) ?? shortText(run['runId']);
  if (explicitRunId !== undefined) return `run:${explicitRunId}`;
  const reportIdMatch = /^(qc-report-.+)-\d+$/.exec(reportId);
  return reportIdMatch?.[1];
}

function validFrameBudget(value: unknown, framesSent: number): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 48 &&
    framesSent <= value
    ? value
    : undefined;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function summaryLine(
  findings: readonly QcCardFinding[],
  groupCount: number,
  complete: boolean,
): string {
  if (findings.length === 0) return complete ? 'No findings' : 'No findings in the sampled frames';
  const counts = (['blocker', 'major', 'minor'] as const)
    .map((severity) => [severity, findings.filter((f) => f.severity === severity).length] as const)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`)
    .join(', ');
  return `${plural(findings.length, 'finding', 'findings')} (${counts}) in ${plural(groupCount, 'type', 'types')}`;
}

/**
 * Reads one report into the card's view. Returns undefined for anything that is not a version 1 report with a
 * report id and a findings list, so a malformed value never reaches the screen.
 */
export function readQcReportView(value: unknown): QcReportView | undefined {
  if (!isObject(value)) return undefined;
  const report = value as Partial<Record<keyof QcReport, unknown>> & Record<string, unknown>;
  const reportId = shortText(report['reportId']);
  if (report['version'] !== 1 || reportId === undefined || !Array.isArray(report['findings']))
    return undefined;

  const rawFindings = report['findings'] as readonly unknown[];
  const findings = rawFindings
    .slice(0, MAX_FINDINGS)
    .map(readFinding)
    .filter((finding): finding is QcCardFinding => finding !== undefined);

  const byType = new Map<string, QcCardFinding[]>();
  for (const finding of findings) {
    const list = byType.get(finding.type) ?? [];
    list.push(finding);
    byType.set(finding.type, list);
  }
  const rank = (type: string): number => {
    const index = GROUP_ORDER.indexOf(type);
    return index === -1 ? GROUP_ORDER.length : index;
  };
  const groups: QcCardGroup[] = [...byType.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([type, list]) => ({
      type,
      name: qcGroupName(type),
      findings: [...list].sort(
        (a, b) => a.startUs - b.startUs || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
      ),
    }));

  const target = isObject(report['target']) ? report['target'] : {};
  const targetRange = isObject(target['range']) ? target['range'] : {};
  const technical = isObject(report['technical']) ? report['technical'] : {};
  const durationUs =
    isTimeUs(targetRange['startUs']) &&
    isTimeUs(targetRange['endUs']) &&
    targetRange['endUs'] >= targetRange['startUs']
      ? targetRange['endUs'] - targetRange['startUs']
      : isTimeUs(technical['durationUs'])
        ? technical['durationUs']
        : undefined;

  const run = isObject(report['run']) ? report['run'] : {};
  const coverage = isObject(report['coverage']) ? report['coverage'] : {};
  const modelId = shortText(run['modelId']) ?? null;
  const framesSent =
    typeof run['framesSent'] === 'number' &&
    Number.isSafeInteger(run['framesSent']) &&
    run['framesSent'] >= 0
      ? run['framesSent']
      : 0;
  const frameBudget =
    validFrameBudget(report['frameBudget'], framesSent) ??
    validFrameBudget(run['frameBudget'], framesSent);
  const complete = coverage['completeSourceCoverage'] === true;
  const frameResult = readFrames(report['frames']);
  let notesInput: unknown;
  try {
    notesInput = report['notes'];
  } catch {
    notesInput = undefined;
  }
  const noteResult = readNotes(notesInput);
  const truncated: string[] = [];
  if (Array.isArray(technical['truncated'])) {
    for (const text of technical['truncated'] as readonly unknown[]) {
      const bounded = boundedLabel(text);
      if (bounded !== undefined) truncated.push(bounded);
      if (truncated.length === MAX_TRUNCATION_NOTES) break;
    }
    if (technical['truncated'].length > MAX_TRUNCATION_NOTES)
      truncated.push('Report notes truncated…');
  }
  if (rawFindings.length > MAX_FINDINGS) truncated.push('Findings truncated…');
  if (noteResult.truncated) truncated.push('Notes truncated…');
  if (frameResult.truncated) truncated.push('Frames truncated…');

  return {
    reportId,
    reportLineageId: reportLineageId(reportId, report, run),
    createdAt: shortText(report['createdAt']) ?? '',
    targetKind: target['kind'] === 'file' ? 'file' : 'timeline',
    durationUs,
    summary: summaryLine(findings, groups.length, complete),
    findingCount: findings.length,
    groups,
    completeCoverage: complete,
    modelId,
    layer2: run['layer2'] === true,
    framesSent,
    frameBudget,
    frames: frameResult.frames,
    notes: noteResult.notes,
    truncated: [...new Set(truncated)],
  };
}

/** `m:ss.mmm`, or `h:mm:ss.mmm` from one hour. Microseconds in, no date and no path. */
export function formatQcTimecode(timeUs: number): string {
  if (!isTimeUs(timeUs)) return '0:00.000';
  const ms = Math.floor(timeUs / 1_000);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  const rest = `${seconds.toString().padStart(2, '0')}.${(ms % 1_000).toString().padStart(3, '0')}`;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${rest}`
    : `${minutes}:${rest}`;
}

export function formatQcRange(finding: Pick<QcCardFinding, 'startUs' | 'endUs'>): string {
  return finding.endUs > finding.startUs
    ? `${formatQcTimecode(finding.startUs)}–${formatQcTimecode(finding.endUs)}`
    : formatQcTimecode(finding.startUs);
}

const MEASUREMENT_NAMES: Readonly<Record<string, string>> = {
  blackDurationSec: 'Black duration',
  blackDurationMs: 'Black duration',
  blackDurationUs: 'Black duration',
  blackDurationSeconds: 'Black duration',
  freezeDurationSec: 'Freeze length',
  freezeDurationMs: 'Freeze length',
  freezeDurationUs: 'Freeze length',
  freezeDurationSeconds: 'Freeze length',
  freezeLengthSec: 'Freeze length',
  freezeLengthMs: 'Freeze length',
  freezeLengthUs: 'Freeze length',
  freezeLengthSeconds: 'Freeze length',
  integratedLufs: 'Loudness',
  loudnessLufs: 'Loudness',
  truePeakDbfs: 'True peak',
  insideSafeArea: 'Inside safe area',
  contrastRatio: 'Contrast ratio',
  videoDurationUs: 'Video duration',
  audioDurationUs: 'Sound duration',
  differenceUs: 'Length difference',
};

function measurementName(key: string): string {
  const known = MEASUREMENT_NAMES[key];
  if (known !== undefined) return known;
  const base = key.replace(/(?:Microseconds|Milliseconds|Seconds|Us|Ms|Sec)$/, '');
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return words.length === 0 ? 'Value' : words.charAt(0).toUpperCase() + words.slice(1);
}

function measurementValue(key: string, value: QcMeasurementValue): string {
  if (value === null) return 'Unavailable';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (/(?:duration|length|difference)(?:Us|Microseconds)$/i.test(key))
    return `${trimDecimal(value / 1_000_000)} s`;
  if (/(?:duration|length)(?:Ms|Milliseconds)$/i.test(key))
    return `${trimDecimal(value / 1_000)} s`;
  if (/(?:duration|length)(?:Sec|Seconds)$/i.test(key)) return `${value} s`;
  if (/lufs$/i.test(key)) return `${value} LUFS`;
  if (/dbfs$/i.test(key)) return `${value} dBFS`;
  if (/db$/i.test(key)) return `${value} dB`;
  if (/ratio$/i.test(key)) return `${value}:1`;
  if (/(?:pct|percent|percentage)$/i.test(key)) return `${value}%`;
  if (/(?:frame|frames)$/i.test(key)) return `${value} frames`;
  return String(value);
}

function trimDecimal(value: number): string {
  return value
    .toFixed(3)
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '');
}

/** Plain names and units for the measurements attached to a finding. */
export function formatQcMeasurements(
  finding: Pick<QcCardFinding, 'measured' | 'measurementsTruncated'>,
): string {
  const values = Object.entries(finding.measured).map(
    ([key, value]) => `${measurementName(key)}: ${measurementValue(key, value)}`,
  );
  if (finding.measurementsTruncated) values.push('…');
  return values.join(', ');
}

/** What went where: one short line for the card and the Markdown. */
export function qcSentLine(view: Pick<QcReportView, 'layer2' | 'modelId' | 'framesSent'>): string {
  if (!view.layer2 && view.framesSent === 0) return 'Kept on this device';
  return `Sent to ${view.modelId ?? 'an unnamed model'}`;
}

/** The two file names of a saved report: the id made safe for a file name. */
export function qcReportFileNames(reportId: string): { markdown: string; json: string } {
  const base =
    reportId
      .replace(SAFE_FILE_PART, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'qc-report';
  return { markdown: `${base}.md`, json: `${base}.json` };
}

export function qcReportJson(
  view: QcReportView,
  before?: { readonly findingCount: number },
): string {
  return `${JSON.stringify(
    {
      version: 1,
      reportId: view.reportId,
      createdAt: view.createdAt,
      targetKind: view.targetKind,
      durationUs: view.durationUs,
      summary: view.summary,
      findingCount: view.findingCount,
      ...(before === undefined ? {} : { before }),
      completeCoverage: view.completeCoverage,
      modelId: view.modelId,
      layer2: view.layer2,
      framesSent: view.framesSent,
      ...(view.frameBudget === undefined ? {} : { frameBudget: view.frameBudget }),
      groups: view.groups,
      notes: view.notes,
      frames: view.frames,
      truncated: view.truncated,
      modelComprehensionGuaranteed: false,
    },
    null,
    2,
  )}\n`;
}

function mdCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

/**
 * The Markdown of a report. `before` is the finding count of the check before the edit, when there was one.
 */
export function qcReportMarkdown(
  view: QcReportView,
  before?: { readonly findingCount: number },
): string {
  const lines: string[] = [`# QC report ${mdCell(view.reportId)}`, '', view.summary, ''];
  if (view.createdAt.length > 0) lines.push(`- Created: ${mdCell(view.createdAt)}`);
  lines.push(`- Target: ${view.targetKind}`);
  if (view.durationUs !== undefined) lines.push(`- Length: ${formatQcTimecode(view.durationUs)}`);
  lines.push(
    before === undefined
      ? `- Findings: ${view.findingCount}`
      : `- Before: ${before.findingCount} findings, after: ${view.findingCount} findings`,
  );
  lines.push(`- ${qcSentLine(view)}`);
  lines.push(
    view.frameBudget === undefined
      ? `- Frames: ${view.framesSent}`
      : `- Frames: ${view.framesSent} of ${view.frameBudget}`,
  );
  if (!view.completeCoverage) lines.push('- Coverage: sampled, not every frame');
  for (const note of view.truncated) lines.push(`- Note: ${mdCell(note)}`);
  lines.push('');
  if (view.groups.length === 0) {
    lines.push('No findings.', '');
  }
  for (const group of view.groups) {
    lines.push(`## ${group.name} (${group.findings.length})`, '');
    lines.push(
      '| Time | Severity | State | Finding | Measured |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const finding of group.findings)
      lines.push(
        `| ${formatQcRange(finding)} | ${finding.severity} | ${finding.state} | ${mdCell(finding.label)} | ${mdCell(formatQcMeasurements(finding))} |`,
      );
    lines.push('');
  }
  if (view.notes.length > 0) {
    lines.push('## Notes', '');
    for (const note of view.notes)
      lines.push(
        `- ${note.timeUs === undefined ? '' : `${formatQcTimecode(note.timeUs)} `}${mdCell(note.text)}`,
      );
    lines.push('');
  }
  lines.push('The model is not guaranteed to have understood any picture.', '');
  return lines.join('\n');
}
