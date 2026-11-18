import { isDesktopHost, resolveDesktopAssetUrl } from './desktop-client.js';
import type { MissingMediaEntry } from './missing-media.js';

const LIBRARY_ASSET_ID = /^joylib-[a-f0-9]{64}$/;

/** The library folder a library asset id lives in (images, video or audio). */
function libraryFolder(kind: string): string {
  return kind === 'image' ? 'images' : kind;
}

export interface LibraryAvailabilityDeps {
  readonly isDesktop?: () => boolean;
  readonly fetchFile?: (url: string, init: { method: string }) => Promise<{ ok: boolean }>;
}

/**
 * A picture, clip or sound that came from the asset library is not copied into the project's local cache:
 * the desktop app streams it from the library folder. It is only missing when that file is really gone, so
 * entries the library can still serve are taken off the missing list (the Monitor would draw them blank).
 */
export async function withoutLibraryServedEntries(
  entries: readonly MissingMediaEntry[],
  deps: LibraryAvailabilityDeps = {},
): Promise<readonly MissingMediaEntry[]> {
  const isDesktop = deps.isDesktop ?? isDesktopHost;
  if (!isDesktop()) return entries;
  const fetchFile = deps.fetchFile ?? ((url, init) => fetch(url, init));
  const served = await Promise.all(
    entries.map(async ({ assetId, record }) => {
      if (!LIBRARY_ASSET_ID.test(assetId)) return false;
      try {
        const response = await fetchFile(
          resolveDesktopAssetUrl(`${libraryFolder(record.kind)}/${assetId}`),
          { method: 'HEAD' },
        );
        return response.ok;
      } catch {
        return false;
      }
    }),
  );
  return entries.filter((_, index) => !served[index]);
}
