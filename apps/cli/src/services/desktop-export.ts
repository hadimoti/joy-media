import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectV3ToDesktopDocuments, type JoyProjectV3 } from '@joy-media/project-schema';

const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const FONT_DIRECTORY = fileURLToPath(
  new URL(
    '../../../../packages/html-scene-runtime/assets/fonts/noto-sans-arabic/',
    import.meta.url,
  ),
);

export class DesktopExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DesktopExportError';
  }
}

interface FontManifest {
  readonly files: readonly {
    readonly family: string;
    readonly weight: number;
    readonly subset: string;
    readonly file: string;
    readonly byteLength: number;
    readonly sha256: string;
  }[];
}

function verifyBundledFonts(): ReadonlyMap<number, string> {
  let manifest: FontManifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(FONT_DIRECTORY, 'manifest.json'), 'utf8'),
    ) as FontManifest;
  } catch {
    throw new DesktopExportError(
      'DESKTOP_EXPORT_FONT_UNSUPPORTED',
      'The bundled Noto Sans Arabic font manifest is unavailable or invalid.',
    );
  }
  if (!Array.isArray(manifest.files))
    throw new DesktopExportError(
      'DESKTOP_EXPORT_FONT_UNSUPPORTED',
      'The bundled Noto Sans Arabic font manifest is unavailable or invalid.',
    );
  const arabicHashes = new Map<number, string>();
  for (const weight of [400, 700]) {
    for (const subset of ['arabic', 'latin']) {
      const entry = manifest.files.find(
        (candidate) =>
          candidate.family === 'Noto Sans Arabic' &&
          candidate.weight === weight &&
          candidate.subset === subset,
      );
      if (entry === undefined)
        throw new DesktopExportError(
          'DESKTOP_EXPORT_FONT_UNSUPPORTED',
          `The bundled Noto Sans Arabic ${subset} font at weight ${weight} is unavailable.`,
        );
      try {
        const bytes = readFileSync(join(FONT_DIRECTORY, entry.file));
        const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        if (bytes.byteLength !== entry.byteLength || hash !== entry.sha256)
          throw new Error('font integrity mismatch');
      } catch {
        throw new DesktopExportError(
          'DESKTOP_EXPORT_FONT_UNSUPPORTED',
          `The bundled Noto Sans Arabic ${subset} font at weight ${weight} failed integrity verification.`,
        );
      }
      if (subset === 'arabic') arabicHashes.set(weight, entry.sha256);
    }
  }
  return arabicHashes;
}

function validateTitleFonts(project: JoyProjectV3): void {
  const hashes = verifyBundledFonts();
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
) {
  validateTitleFonts(project);
  const documents = projectV3ToDesktopDocuments(project);
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
): void {
  const envelope = buildDesktopProjectEnvelope(project, sources, exportedAt);
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
