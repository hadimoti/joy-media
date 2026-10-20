import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

export function buildDesktopProjectEnvelope(
  project: JoyProjectV3,
  sources: Readonly<Record<string, string>>,
  exportedAt = new Date(),
  projectedDocuments = projectV3ToDesktopDocuments(project),
) {
  const documents = projectedDocuments;
  const media = Object.values(project.assets).map((asset) => {
    const path = sources[asset.id];
    if (path === undefined)
      fail('DESKTOP_EXPORT_MEDIA_MISSING', `Original media is missing for asset ${asset.id}.`);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      fail(
        'DESKTOP_EXPORT_MEDIA_MISSING',
        `Original media is missing or unreadable for asset ${asset.id}.`,
      );
    }
    if (
      bytes.byteLength > MAX_MEDIA_BYTES ||
      (asset.bytes !== undefined && asset.bytes > MAX_MEDIA_BYTES)
    )
      fail(
        'DESKTOP_EXPORT_MEDIA_TOO_LARGE',
        `Original media for asset ${asset.id} exceeds 256 MiB.`,
      );
    if (asset.bytes !== undefined && bytes.byteLength !== asset.bytes)
      fail('DESKTOP_EXPORT_MEDIA_CORRUPT', `Original media size does not match asset ${asset.id}.`);
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
    documents,
    media,
  };
}

/** Write the complete desktop package to a sibling temp file before replacing the destination. */
export function writeDesktopProjectExport(
  project: JoyProjectV3,
  sources: Readonly<Record<string, string>>,
  outputPath: string,
  exportedAt = new Date(),
): void | Promise<void> {
  const documents = projectV3ToDesktopDocuments(project);
  const write = () => {
    const envelope = buildDesktopProjectEnvelope(project, sources, exportedAt, documents);
    installDesktopEnvelope(envelope, outputPath);
  };
  if (process.argv[1]?.includes('joy-media-bundle')) {
    return verifyBundledFonts().then((hashes) => {
      validateTitleFonts(project, hashes);
      write();
    });
  }
  write();
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
