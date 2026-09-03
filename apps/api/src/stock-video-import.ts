import type { StockVideoImportRecord, StockVideoImportState } from './stock-video.js';

export const STOCK_VIDEO_IMPORT_STATES = [
  'claimed',
  'downloading',
  'object-stored',
  'registered',
  'completed',
  'failed',
] as const satisfies readonly StockVideoImportState[];

export interface StockVideoImportClaimRepository<T = unknown> {
  claim(key: string): Promise<T>;
}

export interface StockVideoImportCoordinatorOptions<T = unknown> {
  readonly repository: StockVideoImportClaimRepository<T>;
}

/**
 * Small durable-claim boundary kept separate from the HTTP service so workers
 * can share the same idempotency primitive without receiving provider secrets.
 */
export function createStockVideoImportCoordinator<T>(
  options: StockVideoImportCoordinatorOptions<T>,
) {
  return {
    claim: (key: string): Promise<T> => options.repository.claim(key),
    forBrowser: stockVideoImportForBrowser,
  };
}

/** Return only the stable, owner-authorized status fields exposed to clients. */
export function stockVideoImportForBrowser(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Partial<StockVideoImportRecord> & Record<string, unknown>;
  const state = STOCK_VIDEO_IMPORT_STATES.includes(record.state as StockVideoImportState)
    ? record.state
    : undefined;
  return {
    ...(typeof record.importId === 'string' ? { importId: record.importId } : {}),
    ...(state === undefined ? {} : { state }),
    ...(typeof record.assetId === 'string' ? { assetId: record.assetId } : {}),
    ...(typeof record.errorCode === 'string' && /^[A-Z0-9_]+$/.test(record.errorCode)
      ? { errorCode: record.errorCode }
      : {}),
    ...(typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? { updatedAt: record.updatedAt }
      : {}),
  };
}
