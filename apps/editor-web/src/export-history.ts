import type { DeliveryPromiseV1 } from '@joy-media/production-quality';

/**
 * Session export history for the header processes menu. Metadata persists in
 * localStorage; only the most recent export's bytes are retained in memory
 * (as an object URL owned by the App) so re-download stays possible without
 * unbounded blob growth.
 */

export type DeliveryQualityStatus = 'pass' | 'warn' | 'fail';

export interface DeliveryRenderReport {
  readonly version?: number;
  readonly evidenceLevel?: 'sampled';
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
  /** Small deterministic contract needed to queue standalone inspection after export. */
  readonly inspectionPromise?: DeliveryPromiseV1;
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

export interface DeliveryJobProjection {
  readonly id: string;
  readonly type: string;
  readonly state: 'queued' | 'leased' | 'completed' | 'canceled' | 'failed';
  readonly error?: string;
  readonly derivative?: {
    readonly kind?: string;
    readonly reportRef?: string;
    readonly qualityReport?: DeliveryRenderReport;
    readonly report?: DeliveryRenderReport;
  };
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
    return parsed.filter(isEntry).map(normalizePersistedEntry);
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

function normalizePersistedEntry(entry: ExportProcessEntry): ExportProcessEntry {
  const normalized = normalizeInterrupted(entry);
  if (entry.status === 'running' || normalized.error === undefined) return normalized;
  return {
    ...normalized,
    error:
      normalized.channel === 'verified-delivery'
        ? 'Delivery could not be verified. Please retry.'
        : 'Export failed. Please try again.',
  };
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
      'Render inspection failed. Please retry verification.',
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

/** Process status for exports that do not use the verified-delivery gate. */
export function exportProcessGate(entry: ExportProcessEntry): DeliveryGateResult {
  const channel = entry.channel === 'quick-browser-export' ? 'Browser export' : 'Legacy export';
  switch (entry.status) {
    case 'running':
      return {
        status: 'pending',
        canDeliver: false,
        label: `${channel} in progress`,
        reason: `${channel} is still in progress.`,
        summary: { pass: 0, warn: 0, fail: 0 },
      };
    case 'failed':
      return {
        status: 'failed',
        canDeliver: false,
        label: `${channel} failed`,
        reason: entry.error ?? `${channel} failed before it completed.`,
        summary: { pass: 0, warn: 0, fail: 0 },
      };
    case 'canceled':
      return {
        status: 'canceled',
        canDeliver: false,
        label: `${channel} canceled`,
        reason: `${channel} was canceled before it completed.`,
        summary: { pass: 0, warn: 0, fail: 0 },
      };
    case 'completed':
      return {
        status: 'pass',
        canDeliver: false,
        label: `${channel} complete`,
        reason: `${channel} completed; no delivery inspection was requested.`,
        summary: { pass: 0, warn: 0, fail: 0 },
      };
  }
}

/** Text used by the Recent processes menu; keeps channel semantics in one place. */
export function recentProcessLabel(entry: ExportProcessEntry): string {
  const gate =
    entry.channel === 'verified-delivery' ? deliveryGate(entry) : exportProcessGate(entry);
  if (entry.status === 'completed' && entry.totalBytes !== undefined) {
    return `${(entry.totalBytes / 1_048_576).toFixed(1)} MB · ${gate.label}`;
  }
  return gate.label;
}

export function reconcileDeliveryInspections(
  entries: readonly ExportProcessEntry[],
  jobs: readonly DeliveryJobProjection[],
): readonly ExportProcessEntry[] {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.channel !== 'verified-delivery' || entry.exportJobId === undefined) return entry;
    // Once an inspect job exists, never fall back to the export job's inline
    // QA. That report is advisory and cannot satisfy the verified gate.
    const job =
      entry.inspectJobId === undefined
        ? jobsById.get(entry.exportJobId)
        : jobsById.get(entry.inspectJobId);
    if (job === undefined) return entry;
    const reconciled = reconcileEntry(entry, job);
    if (reconciled !== entry) changed = true;
    return reconciled;
  });
  return changed ? next : entries;
}

function reconcileEntry(entry: ExportProcessEntry, job: DeliveryJobProjection): ExportProcessEntry {
  const previousInspection = entry.inspection;
  const reportRef = job.derivative?.reportRef ?? previousInspection?.reportRef ?? entry.reportRef;
  const waiver = previousInspection?.waiver;
  if (job.state === 'queued' || job.state === 'leased') {
    return replaceInspection(entry, {
      state: job.state === 'queued' ? 'queued' : 'running',
      ...(reportRef === undefined ? {} : { reportRef }),
      ...(waiver === undefined ? {} : { waiver }),
    });
  }
  if (job.state === 'canceled') {
    return replaceInspection(
      entry,
      {
        state: 'canceled',
        ...(reportRef === undefined ? {} : { reportRef }),
        ...(waiver === undefined ? {} : { waiver }),
      },
      'canceled',
    );
  }
  if (job.state === 'failed') {
    return replaceInspection(
      entry,
      {
        state: 'failed',
        ...(reportRef === undefined ? {} : { reportRef }),
        error: 'Render inspection failed. Please retry verification.',
        ...(waiver === undefined ? {} : { waiver }),
      },
      'failed',
    );
  }
  // An export's inline report is intentionally advisory only. Standalone
  // inspection must read the retained artifact before this gate can pass.
  if (entry.inspectJobId === undefined && entry.inspectionPromise !== undefined) {
    return replaceInspection(entry, {
      state: 'queued',
      ...(reportRef === undefined ? {} : { reportRef }),
      ...(waiver === undefined ? {} : { waiver }),
    });
  }
  const report = job.derivative?.report ?? job.derivative?.qualityReport;
  if (report === undefined) {
    return replaceInspection(
      entry,
      {
        state: 'failed',
        ...(reportRef === undefined ? {} : { reportRef }),
        error: 'Render job completed without an API-safe quality report.',
        ...(waiver === undefined ? {} : { waiver }),
      },
      'failed',
    );
  }
  const totalBytes = entry.totalBytes ?? report.artifact?.bytes;
  return {
    ...entry,
    status: 'completed',
    finishedAt: entry.finishedAt ?? report.checkedAt ?? new Date(0).toISOString(),
    ...(totalBytes === undefined ? {} : { totalBytes }),
    inspection: {
      state: 'completed',
      report,
      ...(reportRef === undefined ? {} : { reportRef }),
      ...(waiver === undefined ? {} : { waiver }),
    },
  };
}

function replaceInspection(
  entry: ExportProcessEntry,
  inspection: DeliveryInspectionRecord,
  terminalStatus?: Extract<ExportProcessEntry['status'], 'canceled' | 'failed'>,
): ExportProcessEntry {
  const next =
    terminalStatus === undefined
      ? { ...entry, inspection }
      : {
          ...entry,
          status: terminalStatus,
          finishedAt: entry.finishedAt ?? new Date(0).toISOString(),
          ...(terminalStatus === 'failed' && inspection.error !== undefined
            ? { error: inspection.error }
            : {}),
          inspection,
        };
  if (JSON.stringify(entry) === JSON.stringify(next)) return entry;
  return next;
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
