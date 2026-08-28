import type {
  BrowserAnimationDescriptor,
  BrowserAsset,
  BrowserJob,
  BrowserMediaDescriptor,
} from './control-plane-client.js';

export function browserJobList(value: unknown): readonly BrowserJob[] {
  if (!Array.isArray(value)) throw invalidJobResponse();
  return value.map(browserJob);
}

export function browserJob(value: unknown): BrowserJob {
  if (!isRecord(value)) throw invalidJobResponse();
  const state = value.state;
  if (!['queued', 'leased', 'completed', 'canceled', 'failed'].includes(String(state)))
    throw invalidJobResponse();
  if (typeof value.cancelRequested !== 'boolean') throw invalidJobResponse();
  const derivative = value.derivative === undefined ? undefined : jobDerivative(value.derivative);
  return {
    id: opaque(value.id),
    projectId: opaque(value.projectId),
    type: opaque(value.type),
    ...(value.assetId === undefined ? {} : { assetId: opaque(value.assetId) }),
    state: state as BrowserJob['state'],
    progress: boundedInteger(value.progress, 0, 100),
    cancelRequested: value.cancelRequested,
    ...(value.error === undefined ? {} : { error: safeString(value.error) }),
    ...(derivative === undefined ? {} : { derivative }),
  };
}

function jobDerivative(value: unknown): NonNullable<BrowserJob['derivative']> {
  if (!isRecord(value)) throw invalidJobResponse();
  return {
    jobId: opaque(value.jobId),
    kind: opaque(value.kind),
    sha256: hash(value.sha256),
    bytes: positive(value.bytes),
    workerRef: opaque(value.workerRef),
    resultRef: resultRef(value.resultRef),
    verifiedAt: nonNegative(value.verifiedAt),
  };
}

export function browserAssetList(value: unknown): readonly BrowserAsset[] {
  if (!Array.isArray(value)) throw invalidAssetResponse();
  return value.map(browserAsset);
}

export function browserAsset(value: unknown): BrowserAsset {
  if (!isRecord(value)) throw invalidAssetResponse();
  if (!['video', 'audio', 'image'].includes(String(value.kind))) throw invalidAssetResponse();
  if (typeof value.cloudBacked !== 'boolean') throw invalidAssetResponse();
  return {
    id: string(value.id),
    projectId: string(value.projectId),
    kind: value.kind as BrowserAsset['kind'],
    displayName: string(value.displayName),
    sha256: hash(value.sha256),
    bytes: positive(value.bytes),
    descriptor: descriptor(value.descriptor),
    ...(value.tags === undefined ? {} : { tags: strings(value.tags) }),
    ...(value.sortName === undefined ? {} : { sortName: string(value.sortName) }),
    createdAt: nonNegative(value.createdAt),
    cloudBacked: value.cloudBacked,
  };
}

function descriptor(value: unknown): BrowserMediaDescriptor {
  if (!isRecord(value)) throw invalidAssetResponse();
  const animation = value.animation === undefined ? undefined : animated(value.animation);
  return {
    mimeType: string(value.mimeType),
    ...(value.durationUs === undefined ? {} : { durationUs: positive(value.durationUs) }),
    ...(value.width === undefined ? {} : { width: positive(value.width) }),
    ...(value.height === undefined ? {} : { height: positive(value.height) }),
    ...(animation === undefined ? {} : { animation }),
  };
}

function animated(value: unknown): BrowserAnimationDescriptor {
  if (!isRecord(value) || typeof value.hasAlpha !== 'boolean') throw invalidAssetResponse();
  return {
    frameCount: positive(value.frameCount),
    cycleDurationUs: positive(value.cycleDurationUs),
    loopCount: nonNegative(value.loopCount),
    hasAlpha: value.hasAlpha,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function string(value: unknown, error = invalidAssetResponse): string {
  if (typeof value !== 'string' || value.length === 0) throw error();
  return value;
}
function hash(value: unknown): string {
  const result = string(value);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw invalidAssetResponse();
  return result;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalidAssetResponse();
  return value as number;
}
function nonNegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidAssetResponse();
  return value as number;
}
function boundedInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw invalidJobResponse();
  return value as number;
}
function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw invalidAssetResponse();
  return value as readonly string[];
}
function opaque(value: unknown): string {
  const result = string(value, invalidJobResponse);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result)) throw invalidJobResponse();
  return result;
}
function resultRef(value: unknown): string {
  const result = string(value, invalidJobResponse);
  if (result.startsWith('derivative:')) {
    opaque(result.slice('derivative:'.length));
    return result;
  }
  return opaque(result);
}
function safeString(value: unknown): string {
  const result = string(value, invalidJobResponse);
  if (
    /^(?:file:|https?:\/\/)/iu.test(result) ||
    result.startsWith('/') ||
    /^[A-Za-z]:[\\/]/u.test(result) ||
    result.startsWith('\\\\')
  )
    throw invalidJobResponse();
  return result;
}
function invalidAssetResponse(): Error {
  return new Error('JOY Media API returned an invalid asset response');
}
function invalidJobResponse(): Error {
  return new Error('JOY Media API returned an invalid job response');
}
