/* global console, process */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CliFlags } from '../cli.js';

interface AssetEntry {
  id: string;
  kind: string;
  bytes: number;
  displayName: string;
  relativePath: string;
  [key: string]: unknown;
}

interface AssetCatalog {
  assets: AssetEntry[];
}

export function resolveAssetLibraryDirectory(override?: string, homeDirectory = homedir()): string {
  return override || process.env.JOY_MEDIA_ASSET_LIBRARY || join(homeDirectory, 'joy-media-assets');
}

/**
 * Reads the library catalog once and returns a checker: true when the catalog lists the asset
 * and its file is on disk (T-R04, the render's missing-media check). An unsafe or unreadable
 * entry counts as missing. A library with no catalog has no files.
 */
export function createAssetLibraryFileCheck(
  libraryDirectory: string,
): (assetId: string) => boolean {
  const catalog = readCatalog(libraryDirectory);
  const entries = new Map(
    (catalog?.assets ?? []).filter(isAssetEntry).map((entry) => [entry.id, entry] as const),
  );
  return (assetId) => {
    const entry = entries.get(assetId);
    if (entry === undefined) return false;
    try {
      return existsSync(getAbsoluteAssetPath(libraryDirectory, entry));
    } catch {
      return false;
    }
  };
}

function reportError(code: string, message: string, json: boolean): void {
  if (json) console.log(JSON.stringify({ code, error: message }));
  else console.error(message);
}

function readCatalog(libraryDirectory: string): AssetCatalog | undefined {
  const catalogPath = join(libraryDirectory, 'catalog.json');
  let contents: string;
  try {
    contents = readFileSync(catalogPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error(
      `Cannot read asset catalog: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let catalog: unknown;
  try {
    catalog = JSON.parse(contents);
  } catch {
    throw new Error('Asset catalog is not valid JSON.');
  }
  if (
    typeof catalog !== 'object' ||
    catalog === null ||
    !('assets' in catalog) ||
    !Array.isArray(catalog.assets)
  ) {
    throw new Error('Asset catalog must contain an assets array.');
  }
  return catalog as AssetCatalog;
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ['ENOENT', 'ENOTDIR'].includes(String(error.code))
    ) {
      return false;
    }
    throw error;
  }
}

function getAbsoluteAssetPath(libraryDirectory: string, entry: AssetEntry): string {
  const libraryPath = resolve(libraryDirectory);
  const absolutePath = resolve(libraryPath, entry.relativePath);
  const fromLibrary = relative(libraryPath, absolutePath);
  if (
    !entry.relativePath ||
    isAbsolute(entry.relativePath) ||
    fromLibrary === '..' ||
    fromLibrary.startsWith(`..${sep}`) ||
    isAbsolute(fromLibrary)
  ) {
    throw new Error(`Asset ${entry.id} has a relativePath that escapes the asset library.`);
  }
  const escapeMessage = `Asset ${entry.id} has a relativePath that escapes the asset library.`;
  let realLibraryPath: string;
  try {
    realLibraryPath = realpathSync(libraryDirectory);
  } catch (error) {
    throw new Error(
      `Cannot verify the path of asset ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let existingPath = absolutePath;
  while (true) {
    let pathExists: boolean;
    try {
      pathExists = lexists(existingPath);
    } catch (error) {
      throw new Error(
        `Cannot verify the path of asset ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (pathExists) break;
    const parentPath = dirname(existingPath);
    if (parentPath === existingPath) throw new Error(escapeMessage);
    existingPath = parentPath;
  }

  let realExistingPath: string;
  try {
    realExistingPath = realpathSync(existingPath);
  } catch (error) {
    let isDanglingLink = false;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      try {
        isDanglingLink = lstatSync(existingPath).isSymbolicLink();
      } catch {
        // The path changed while it was being checked.
      }
    }
    if (isDanglingLink) throw new Error(escapeMessage);
    throw new Error(
      `Cannot verify the path of asset ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const fromRealLibrary = relative(realLibraryPath, realExistingPath);
  if (
    fromRealLibrary === '..' ||
    fromRealLibrary.startsWith(`..${sep}`) ||
    isAbsolute(fromRealLibrary)
  ) {
    // Resolve links before containment checks so outside targets are refused.
    throw new Error(`Asset ${entry.id} has a relativePath that escapes the asset library.`);
  }
  return absolutePath;
}

function isAssetEntry(value: unknown): value is AssetEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    'bytes' in value &&
    typeof value.bytes === 'number' &&
    'displayName' in value &&
    typeof value.displayName === 'string' &&
    'relativePath' in value &&
    typeof value.relativePath === 'string'
  );
}

function printUnknownId(id: string, json: boolean): number {
  reportError('unknown_asset', `Unknown asset id: ${id}`, json);
  return 1;
}

export async function handleAssetsCommand(args: string[], flags: CliFlags): Promise<number> {
  const [action, id] = args;
  const json = flags.json;
  const libraryDirectory = resolveAssetLibraryDirectory(flags.library);
  if (!['list', 'show', 'path'].includes(action ?? '')) {
    reportError('usage_error', 'Usage: joy-media assets <list|show|path> [id] [options]', json);
    return 2;
  }

  if (
    action === 'list' &&
    flags.kind !== undefined &&
    !['image', 'audio', 'video'].includes(flags.kind)
  ) {
    reportError('usage_error', '--kind must be image, audio, or video.', json);
    return 2;
  }
  if (action !== 'list' && flags.kind !== undefined) {
    reportError('usage_error', '--kind is supported only by assets list.', json);
    return 2;
  }
  if (action !== 'list' && !id) {
    reportError('usage_error', `Usage: joy-media assets ${action} <id> [options]`, json);
    return 2;
  }

  let catalog: AssetCatalog | undefined;
  try {
    catalog = readCatalog(libraryDirectory);
  } catch (error) {
    reportError('invalid_catalog', error instanceof Error ? error.message : String(error), json);
    return 1;
  }

  const entries = (catalog?.assets ?? []).filter(isAssetEntry);
  if (action === 'list') {
    const matches = entries.filter(
      (entry) => flags.kind === undefined || entry.kind === flags.kind,
    );
    const safeEntries: Array<{ entry: AssetEntry; absolutePath: string }> = [];
    for (const entry of matches) {
      try {
        safeEntries.push({ entry, absolutePath: getAbsoluteAssetPath(libraryDirectory, entry) });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
    if (json) {
      console.log(
        JSON.stringify(
          safeEntries.map(({ entry, absolutePath }) => ({
            ...entry,
            absolutePath,
            fileExists: existsSync(absolutePath),
          })),
        ),
      );
    } else {
      for (const { entry } of safeEntries) {
        console.log(`${entry.id} ${entry.kind} ${entry.bytes} ${entry.displayName}`);
      }
    }
    return 0;
  }

  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) return printUnknownId(id!, json);

  let absolutePath: string;
  try {
    absolutePath = getAbsoluteAssetPath(libraryDirectory, entry);
  } catch (error) {
    reportError('invalid_asset_path', error instanceof Error ? error.message : String(error), json);
    return 1;
  }
  if (action === 'path') {
    console.log(absolutePath);
    return 0;
  }

  const shownEntry = { ...entry, absolutePath, fileExists: existsSync(absolutePath) };
  if (json) console.log(JSON.stringify(shownEntry));
  else {
    for (const [key, value] of Object.entries(shownEntry)) {
      console.log(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
    }
  }
  return 0;
}
