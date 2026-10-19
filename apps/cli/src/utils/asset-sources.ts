import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getJoyMediaDir } from './config.js';
import { withExclusiveLock, writeFileAtomic } from './project-loader.js';

/**
 * Where the media behind an asset lives on THIS machine.
 *
 * Project documents describe assets (id, kind, duration, size) but deliberately carry no file
 * paths, so a CLI render needs its own map from asset id to a file. It lives next to the other
 * CLI state in `~/.joy-media/cli-asset-sources.json` and is filled by
 * `timeline add-clip --asset <file>`.
 */
export type AssetSourceMap = Record<string, string>;

function sourcesPath(): string {
  return join(getJoyMediaDir(), 'cli-asset-sources.json');
}

export function loadAssetSources(): AssetSourceMap {
  const path = sourcesPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: AssetSourceMap = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function registerAssetSource(assetId: string, absolutePath: string): void {
  const path = sourcesPath();
  withExclusiveLock(path, () => {
    const map = loadAssetSources();
    if (map[assetId] === absolutePath) return;
    map[assetId] = absolutePath;
    writeFileAtomic(path, `${JSON.stringify(map, null, 2)}\n`);
  });
}

/** Stable id for a media file on this machine: same file path -> same asset id. */
export function deriveAssetId(absolutePath: string): string {
  const key = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
  return `asset-${createHash('sha1').update(key).digest('hex').slice(0, 10)}`;
}
