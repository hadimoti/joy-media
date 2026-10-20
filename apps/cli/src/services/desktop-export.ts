import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { projectV3ToDesktopDocuments, type JoyProjectV3 } from '@joy-media/project-schema';

const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
interface NotoSansArabicFace {
  readonly family: string;
  readonly weight: number;
  readonly subset: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export class DesktopExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DesktopExportError';
  }
}

async function verifyBundledFonts(): Promise<ReadonlyMap<number, string>> {
  let faces: NotoSansArabicFace[];
  try {
    const runtime = await import('@joy-media/html-scene-runtime');
    faces = runtime.loadNotoSansArabicFaces();
  } catch {
    throw new DesktopExportError(
      'DESKTOP_EXPORT_FONT_UNSUPPORTED',
      'The bundled Noto Sans Arabic font manifest is unavailable or invalid.',
    );
  }
  if (
    faces.length !== 4 ||
    faces.some(
      (face) =>
        face.family !== 'Noto Sans Arabic' ||
        (face.weight !== 400 && face.weight !== 700) ||
        (face.subset !== 'arabic' && face.subset !== 'latin'),
    )
  )
    throw new DesktopExportError(
      'DESKTOP_EXPORT_FONT_UNSUPPORTED',
      'The bundled Noto Sans Arabic font manifest is unavailable or invalid.',
    );
  const arabicHashes = new Map<number, string>();
  for (const weight of [400, 700]) {
    for (const subset of ['arabic', 'latin']) {
      const face = faces.find(
        (candidate) => candidate.weight === weight && candidate.subset === subset,
      );
      if (face === undefined)
        throw new DesktopExportError(
          'DESKTOP_EXPORT_FONT_UNSUPPORTED',
          `The bundled Noto Sans Arabic ${subset} font at weight ${weight} is unavailable.`,
        );
      const hash = `sha256:${createHash('sha256').update(face.bytes).digest('hex')}`;
      if (hash !== face.sha256)
        throw new DesktopExportError(
          'DESKTOP_EXPORT_FONT_UNSUPPORTED',
          `The bundled Noto Sans Arabic ${subset} font at weight ${weight} failed integrity verification.`,
        );
      if (subset === 'arabic') arabicHashes.set(weight, face.sha256);
    }
  }
  return arabicHashes;
}

function validateTitleFonts(project: JoyProjectV3, hashes: ReadonlyMap<number, string>): void {
  const plugin = project.pluginData['joy.contentTemplates'];
  if (plugin === null || typeof plugin !== 'object' || Array.isArray(plugin)) return;
  const instances = (plugin as Record<string, unknown>).instances;
  if (instances === null || typeof instances !== 'object' || Array.isArray(instances)) return;
  for (const [id, candidate] of Object.entries(instances)) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.templateId !== 'string' || !record.templateId.startsWith('joy.p0.')) continue;
    const font = record.font;
    if (font === null || typeof font !== 'object' || Array.isArray(font)) {
      throw new DesktopExportError(
        'DESKTOP_EXPORT_FONT_UNSUPPORTED',
        `Title instance "${id}" has no supported font descriptor.`,
      );
    }
    const value = font as Record<string, unknown>;
    if (
      value.family !== 'Noto Sans Arabic' ||
      (value.weight !== 400 && value.weight !== 700) ||
      value.sha256 !== hashes.get(value.weight)
    ) {
      throw new DesktopExportError(
        'DESKTOP_EXPORT_FONT_UNSUPPORTED',
        `Title instance "${id}" uses a font outside the supported Noto Sans Arabic subset.`,
      );
    }
  }
}

function fail(code: string, message: string): never {
  throw new DesktopExportError(code, message);
}

function findAssetIdCollision(
  value: unknown,
  assetIds: ReadonlySet<string>,
  path: string,
): string | undefined {
  if (typeof value === 'string') {
    const isTimelineClipAssetReference =
      /^documents\.(?:visual|timeline\.project)\.compositions\.[^.]+\.tracks\[\d+\]\.clips\[\d+\]\.assetId$/u.test(
        path,
      );
    const isUniversalTimelineAssetReference =
      /^documents\.(?:visual|timeline)\.universalTimeline\.items\[\d+\]\.source\.id$/u.test(path);
    const isVisualClipBindingAssetReference =
      /^documents\.(?:visual|timeline)\.clipBindings\[\d+\]\.clip\.assetId$/u.test(path);
    const isTimelineSourceBindingAssetReference =
      /^documents\.timeline\.clipBindings\[\d+\]\.(?:clip\.assetId|sourceBinding\.source\.id)$/u.test(
        path,
      );
    if (
      assetIds.has(value) &&
      !isTimelineClipAssetReference &&
      !isUniversalTimelineAssetReference &&
      !isVisualClipBindingAssetReference &&
      !isTimelineSourceBindingAssetReference
    )
      return path;
    return undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const collision = findAssetIdCollision(value[index], assetIds, `${path}[${index}]`);
      if (collision !== undefined) return collision;
    }
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === 'assets' && path === 'documents.visual') continue;
    const childPath = `${path}.${key}`;
    if (assetIds.has(key)) return childPath;
    const collision = findAssetIdCollision(child, assetIds, childPath);
    if (collision !== undefined) return collision;
  }
  return undefined;
}

export function buildDesktopProjectEnvelope(
  project: JoyProjectV3,
  sources: Readonly<Record<string, string>>,
  exportedAt = new Date(),
  projectedDocuments = projectV3ToDesktopDocuments(project),
  readMedia: (path: string, asset: JoyProjectV3['assets'][string]) => Buffer = readBoundedMedia,
) {
  const documents = projectedDocuments;
  const collision = findAssetIdCollision(
    documents,
    new Set(Object.keys(project.assets)),
    'documents',
  );
  if (collision !== undefined)
    fail(
      'DESKTOP_EXPORT_ASSET_ID_COLLISION',
      `Exported document string at ${collision} equals an asset id and would be remapped on import.`,
    );
  const media = Object.values(project.assets).map((asset) => {
    const path = sources[asset.id];
    if (path === undefined)
      fail('DESKTOP_EXPORT_MEDIA_MISSING', `Original media is missing for asset ${asset.id}.`);
    if (asset.bytes !== undefined && asset.bytes > MAX_MEDIA_BYTES)
      fail(
        'DESKTOP_EXPORT_MEDIA_TOO_LARGE',
        `Original media for asset ${asset.id} exceeds 256 MiB.`,
      );
    const bytes = readMedia(path, asset);
    if (asset.sha256 !== undefined) {
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (hash !== asset.sha256.replace(/^sha256:/u, ''))
        fail(
          'DESKTOP_EXPORT_MEDIA_CORRUPT',
          `Original media hash does not match asset ${asset.id}.`,
        );
    }
    return {
      asset,
      status: 'embedded' as const,
      dataBase64: bytes.toString('base64'),
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mimeType: asset.descriptor?.mimeType ?? 'application/octet-stream',
    };
  });
  return {
    format: 'joy-media-project' as const,
    schemaVersion: 1 as const,
    app: 'JOY Studio' as const,
    exportedAt: exportedAt.toISOString(),
    source: {
      id: project.id,
      title: project.title,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    documents: { ...documents, timeline: documents.timeline.project },
    media,
  };
}

function readBoundedMedia(path: string, asset: JoyProjectV3['assets'][string]): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch {
    fail(
      'DESKTOP_EXPORT_MEDIA_MISSING',
      `Original media is missing or unreadable for asset ${asset.id}.`,
    );
  }
  try {
    const recordedSize = fstatSync(descriptor).size;
    if (recordedSize > MAX_MEDIA_BYTES)
      fail(
        'DESKTOP_EXPORT_MEDIA_TOO_LARGE',
        `Original media for asset ${asset.id} exceeds 256 MiB.`,
      );
    if (asset.bytes !== undefined && recordedSize !== asset.bytes)
      fail('DESKTOP_EXPORT_MEDIA_CORRUPT', `Original media size does not match asset ${asset.id}.`);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes < recordedSize) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, recordedSize - totalBytes));
      const bytesRead = readSync(descriptor, chunk, 0, chunk.byteLength, totalBytes);
      if (bytesRead === 0)
        fail(
          'DESKTOP_EXPORT_MEDIA_CORRUPT',
          `Original media size changed while reading asset ${asset.id}.`,
        );
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    if (readSync(descriptor, growthProbe, 0, 1, recordedSize) !== 0)
      fail('DESKTOP_EXPORT_MEDIA_CORRUPT', `Original media grew while reading asset ${asset.id}.`);
    return Buffer.concat(chunks, totalBytes);
  } catch (error) {
    if (error instanceof DesktopExportError) throw error;
    fail('DESKTOP_EXPORT_MEDIA_CORRUPT', `Original media could not be read for asset ${asset.id}.`);
  } finally {
    closeSync(descriptor);
  }
}

/** Write the complete desktop package to a sibling temp file before replacing the destination. */
export async function writeDesktopProjectExport(
  project: JoyProjectV3,
  sources: Readonly<Record<string, string>>,
  outputPath: string,
  exportedAt = new Date(),
): Promise<void> {
  const documents = projectV3ToDesktopDocuments(project);
  const hashes = await verifyBundledFonts();
  validateTitleFonts(project, hashes);
  const envelope = buildDesktopProjectEnvelope(project, sources, exportedAt, documents);
  installDesktopEnvelope(envelope, outputPath);
}

function installDesktopEnvelope(
  envelope: ReturnType<typeof buildDesktopProjectEnvelope>,
  outputPath: string,
): void {
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, JSON.stringify(envelope, null, 2), 'utf8');
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      /* Preserve the original write error. */
    }
    throw error;
  }
}
