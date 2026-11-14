/**
 * The view model, Markdown and JSON of one Joy Code QC report card (card T-B07).
 *
 * The report itself is the `QcReport` shape of `@joy-media/job-protocol` (T-B04 / T-B08); this module reads it
 * and never changes it. The timeline check adds two finding types the file check does not have
 * (`safe-area`, `text-legibility`) and a `frames` list, so the reader is tolerant: it keeps what it can
 * verify, drops what it cannot, and never throws on a report that came from a model tool or a saved file.
 */
import type { QcFindingState, QcReport, QcSeverity } from '@joy-media/job-protocol';
import { QC_DEFAULT_RUN_FRAME_BUDGET } from './joy-agent/qc-request-intent.js';

const MAX_FINDINGS = 400;
const MAX_FRAMES = 96;
const MAX_TEXT_CHARS = 240;
const SAFE_FILE_PART = /[^A-Za-z0-9._-]+/g;

export interface QcCardFinding {
  readonly id: string;
  readonly type: string;
  readonly severity: QcSeverity;
  readonly state: QcFindingState;
  readonly startUs: number;
  readonly endUs: number;
  readonly label: string;
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

export interface QcReportView {
  readonly reportId: string;
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
  readonly frameBudget: number;
  readonly frames: readonly QcCardFrame[];
  readonly truncated: readonly string[];
  /** The report as received, trimmed to what this module verified. It is what "Save report" writes as JSON. */
  readonly source: Readonly<Record<string, unknown>>;
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
  const label = shortText(value['label']);
  const { startUs, endUs } = value;
  if (id === undefined || type === undefined || label === undefined) return undefined;
  if (!isTimeUs(startUs) || !isTimeUs(endUs) || endUs < startUs) return undefined;
  return {
    id,
    type,
    label,
    startUs,
    endUs,
    severity: isSeverity(value['severity']) ? value['severity'] : 'minor',
    state: isState(value['state']) ? value['state'] : 'unconfirmed',
    fixable: value['fixable'] === true,
  };
}

function readFrames(value: unknown): readonly QcCardFrame[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const frames: QcCardFrame[] = [];
  for (const item of value as readonly unknown[]) {
    if (!isObject(item)) continue;
    const id = item['frameId'];
    const timeUs = item['timeUs'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) continue;
    if (!isTimeUs(timeUs) || seen.has(id)) continue;
    seen.add(id);
    frames.push({ id, timeUs });
    if (frames.length === MAX_FRAMES) break;
  }
  return frames.sort((left, right) => left.timeUs - right.timeUs);
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
export function readQcReportView(
  value: unknown,
  frameBudget: number = QC_DEFAULT_RUN_FRAME_BUDGET,
): QcReportView | undefined {
  if (!isObject(value)) return undefined;
  const report = value as Partial<Record<keyof QcReport, unknown>> & Record<string, unknown>;
  const reportId = shortText(report['reportId']);
  if (report['version'] !== 1 || reportId === undefined || !Array.isArray(report['findings']))
    return undefined;

  const findings = (report['findings'] as readonly unknown[])
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
  const durationUs = isTimeUs(targetRange['endUs'])
    ? targetRange['endUs']
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
  const complete = coverage['completeSourceCoverage'] === true;
  const truncated = Array.isArray(technical['truncated'])
    ? (technical['truncated'] as readonly unknown[])
        .map(shortText)
        .filter((text): text is string => text !== undefined)
    : [];

  return {
    reportId,
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
    frames: readFrames(report['frames']),
    truncated,
    source: report,
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

export function qcReportJson(view: QcReportView): string {
  return `${JSON.stringify(view.source, null, 2)}\n`;
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
  lines.push(`- Frames: ${view.framesSent} of ${view.frameBudget}`);
  if (!view.completeCoverage) lines.push('- Coverage: sampled, not every frame');
  for (const note of view.truncated) lines.push(`- Note: ${mdCell(note)}`);
  lines.push('');
  if (view.groups.length === 0) {
    lines.push('No findings.', '');
  }
  for (const group of view.groups) {
    lines.push(`## ${group.name} (${group.findings.length})`, '');
    lines.push('| Time | Severity | State | Finding |', '| --- | --- | --- | --- |');
    for (const finding of group.findings)
      lines.push(
        `| ${formatQcRange(finding)} | ${finding.severity} | ${finding.state} | ${mdCell(finding.label)} |`,
      );
    lines.push('');
  }
  lines.push('The model is not guaranteed to have understood any picture.', '');
  return lines.join('\n');
}
