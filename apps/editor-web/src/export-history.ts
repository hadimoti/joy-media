/**
 * Session export history for the header processes menu. Metadata persists in
 * localStorage; only the most recent export's bytes are retained in memory
 * (as an object URL owned by the App) so re-download stays possible without
 * unbounded blob growth.
 */

export type DeliveryQualityStatus = 'pass' | 'warn' | 'fail';

export interface DeliveryRenderReport {
  readonly version?: number;
  readonly findings: readonly {
    readonly status: DeliveryQualityStatus;
  }[];
  readonly artifact?: {
    readonly outputRef: string;
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly facts?: unknown;
  readonly checkedAt?: string;
  readonly promiseId?: string;
}

export interface ExportProcessEntry {
  readonly id: string;
  readonly filename: string;
  readonly status: 'running' | 'completed' | 'failed' | 'canceled';
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly totalBytes?: number;
  readonly frameCount?: number;
  readonly error?: string;
  readonly channel?: ExportProcessChannel;
  readonly exportJobId?: string;
  readonly inspectJobId?: string;
  readonly reportRef?: string;
  readonly inspection?: DeliveryInspectionRecord;
}

export type ExportProcessChannel = 'quick-browser-export' | 'verified-delivery';

export interface DeliveryInspectionRecord {
  readonly state: 'not-requested' | 'queued' | 'running' | 'completed' | 'canceled' | 'failed';
  readonly reportRef?: string;
  readonly report?: DeliveryRenderReport;
  readonly waiver?: DeliveryWaiver;
  readonly error?: string;
}

export interface DeliveryWaiver {
  readonly actor: string;
  readonly reason: string;
  readonly recordedAt?: string;
}

export interface DeliveryGateResult {
  readonly status:
    'pass' | 'warn' | 'blocked' | 'waived' | 'pending' | 'canceled' | 'failed' | 'unverified';
  readonly canDeliver: boolean;
  readonly label: string;
  readonly reason: string;
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
  };
  readonly waiver?: DeliveryWaiver;
}

export const EXPORT_HISTORY_KEY = 'joy-media.export-history.v1';
const MAX_ENTRIES = 20;

export interface ExportHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadExportHistory(storage: ExportHistoryStorage): readonly ExportProcessEntry[] {
  const raw = storage.getItem(EXPORT_HISTORY_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).map(normalizeInterrupted);
  } catch {
    return [];
  }
}

export function saveExportHistory(
  storage: ExportHistoryStorage,
  entries: readonly ExportProcessEntry[],
): void {
  storage.setItem(EXPORT_HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

/** Newest first; replaces an existing entry with the same id. */
export function upsertEntry(
  entries: readonly ExportProcessEntry[],
  entry: ExportProcessEntry,
): readonly ExportProcessEntry[] {
  const rest = entries.filter((existing) => existing.id !== entry.id);
  return [entry, ...rest].slice(0, MAX_ENTRIES);
}

function isEntry(value: unknown): value is ExportProcessEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<ExportProcessEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.filename === 'string' &&
    (entry.status === 'running' ||
      entry.status === 'completed' ||
      entry.status === 'failed' ||
      entry.status === 'canceled') &&
    typeof entry.startedAt === 'string'
  );
}

/** An entry still 'running' from a previous page load can never finish. */
function normalizeInterrupted(entry: ExportProcessEntry): ExportProcessEntry {
  if (entry.status !== 'running') return entry;
  return { ...entry, status: 'failed', error: 'interrupted by page reload' };
}

export function deliveryGate(entry: ExportProcessEntry): DeliveryGateResult {
  const inspection = entry.inspection;
  if (inspection === undefined || inspection.state === 'not-requested') {
    return gate(
      'unverified',
      false,
      'Not verified',
      'No render inspection report is linked to this export.',
    );
  }
  if (inspection.state === 'queued' || inspection.state === 'running') {
    return gate(
      'pending',
      false,
      'Inspection pending',
      'Render inspection has not recorded a report yet.',
    );
  }
  if (inspection.state === 'canceled') {
    return gate(
      'canceled',
      false,
      'Inspection canceled',
      'Render inspection was canceled before a report was recorded.',
    );
  }
  if (inspection.state === 'failed') {
    return gate(
      'failed',
      false,
      'Inspection failed',
      inspection.error ?? 'Render inspection failed before a report was recorded.',
    );
  }
  const report = inspection.report;
  if (report === undefined) {
    return gate(
      'unverified',
      false,
      'Not verified',
      'No render inspection report is linked to this export.',
    );
  }
  const summary = summarizeReport(report);
  if (summary.fail > 0) {
    if (isAuthorizedWaiver(inspection.waiver)) {
      return gate(
        'waived',
        true,
        'Waived',
        'Blocking failures are covered by an authorized delivery waiver.',
        summary,
        inspection.waiver,
      );
    }
    return gate('blocked', false, 'Blocked', 'Render inspection found blocking failures.', summary);
  }
  if (summary.warn > 0) {
    return gate('warn', true, 'Warning', 'Render inspection recorded warnings.', summary);
  }
  return gate('pass', true, 'Verified', 'Render inspection passed.', summary);
}

function summarizeReport(report: DeliveryRenderReport): DeliveryGateResult['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const finding of report.findings) summary[finding.status]++;
  return summary;
}

function isAuthorizedWaiver(waiver: DeliveryWaiver | undefined): waiver is DeliveryWaiver {
  return waiver !== undefined && waiver.actor.trim().length > 0 && waiver.reason.trim().length > 0;
}

function gate(
  status: DeliveryGateResult['status'],
  canDeliver: boolean,
  label: string,
  reason: string,
  summary: DeliveryGateResult['summary'] = { pass: 0, warn: 0, fail: 0 },
  waiver?: DeliveryWaiver,
): DeliveryGateResult {
  return {
    status,
    canDeliver,
    label,
    reason,
    summary,
    ...(waiver === undefined ? {} : { waiver }),
  };
}
