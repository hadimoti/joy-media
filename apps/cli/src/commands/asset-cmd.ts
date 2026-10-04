/* global console */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, extname, resolve } from 'node:path';
import type { AssetRecordV1, JoyProjectV1 } from '@joy-media/project-schema';
import type { CliFlags } from '../cli.js';
import { logError, logSuccess } from '../utils/logger.js';
import { loadProject, saveProject } from '../utils/project-loader.js';

interface ProbeResult {
  readonly streams?: readonly {
    readonly codec_type?: string;
    readonly width?: number;
    readonly height?: number;
  }[];
  readonly format?: { readonly duration?: string; readonly format_name?: string };
}

export async function handleAssetCommand(args: string[], flags: CliFlags): Promise<number> {
  const subcommand = args[0];
  if (!flags.project) {
    logError('Please specify target project via --project <id|file.json>');
    return 1;
  }
  let info;
  try {
    info = loadProject(flags.project, flags.sqlitePath);
  } catch (error) {
    logError(`Cannot load project: ${String(error)}`);
    return 1;
  }

  const project = structuredClone(info.project) as JoyProjectV1;
  const assets = project.assets as Record<string, AssetRecordV1>;
  if (subcommand === 'list') {
    const rows = Object.values(assets);
    if (rows.length === 0) console.log('No assets found.');
    for (const asset of rows) {
      const duration = asset.descriptor?.durationUs;
      console.log(
        `${asset.id}\t${asset.kind}\t${asset.displayName}${duration ? `\t${(duration / 1_000_000).toFixed(3)}s` : ''}`,
      );
    }
    return 0;
  }
  if (subcommand !== 'import') {
    logError('Usage: joy-media asset <import <file>|list> --project <id|file.json>');
    return 1;
  }
  const source = args[1];
  if (!source) {
    logError('Usage: joy-media asset import <file> --project <id|file.json> [--id <assetId>]');
    return 1;
  }
  const filePath = resolve(source);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    logError(`Media file does not exist or is not a file: ${filePath}`);
    return 1;
  }
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
    { shell: false, encoding: 'utf8' },
  );
  if (probe.error || probe.status !== 0) {
    logError(
      `ffprobe failed: ${probe.error?.message ?? (probe.stderr.trim() || 'unable to inspect media')}`,
    );
    return 1;
  }
  let metadata: ProbeResult;
  try {
    metadata = JSON.parse(probe.stdout) as ProbeResult;
  } catch (error) {
    logError(`ffprobe returned invalid JSON: ${String(error)}`);
    return 1;
  }
  const streamList = metadata.streams ?? [];
  const video = streamList.find((stream) => stream.codec_type === 'video');
  const audio = streamList.find((stream) => stream.codec_type === 'audio');
  const extension = extname(filePath).toLowerCase();
  const imageExtensions = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.gif',
    '.bmp',
    '.tif',
    '.tiff',
  ]);
  const kind: AssetRecordV1['kind'] = imageExtensions.has(extension)
    ? 'image'
    : video
      ? 'video'
      : audio
        ? 'audio'
        : 'other';
  const mimeType = extensionMime(extension, kind);
  const duration = Number(metadata.format?.duration);
  const stat = statSync(filePath);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  const id = flags.id ?? `asset-${randomUUID()}`;
  if (!id.trim() || id in assets) {
    logError(`Asset id is empty or already exists: ${id}`);
    return 1;
  }
  const asset: AssetRecordV1 = {
    id,
    kind,
    displayName: basename(filePath),
    sha256: hash.digest('hex'),
    bytes: stat.size,
    descriptor: {
      mimeType,
      ...(Number.isFinite(duration) && duration > 0
        ? { durationUs: Math.round(duration * 1_000_000) }
        : {}),
      ...(video?.width ? { width: video.width } : {}),
      ...(video?.height ? { height: video.height } : {}),
    },
    localSource: { path: filePath, mtimeMs: stat.mtimeMs },
    ...(kind === 'video' ? { hasAudio: audio !== undefined } : {}),
  };
  assets[id] = asset;
  try {
    saveProject(project, { source: info.source, path: info.path, revision: info.revision });
  } catch (error) {
    logError(`Could not save imported asset: ${String(error)}`);
    return 1;
  }
  logSuccess(`Imported ${asset.displayName} as ${asset.id}.`);
  return 0;
}

function extensionMime(extension: string, kind: AssetRecordV1['kind']): string {
  const known: Readonly<Record<string, string>> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  return (
    known[extension] ??
    (kind === 'audio'
      ? 'audio/octet-stream'
      : kind === 'video'
        ? 'video/octet-stream'
        : 'application/octet-stream')
  );
}
