export const PEXELS_SYSTEMD_CREDENTIAL_ID = 'joy-media-pexels-api-key' as const;
export const PIXABAY_SYSTEMD_CREDENTIAL_ID = 'joy-media-pixabay-api-key' as const;
export const STOCK_VIDEO_SECRET_REFS = {
  pexels: 'joy-media/stock-video/pexels/v1',
  pixabay: 'joy-media/stock-video/pixabay/v1',
} as const;
export const DEFAULT_STOCK_VIDEO_CREDENTIAL_DIRECTORY = '/run/credentials/joy-media@api.service';
export type ReadStockVideoCredential = (path: string, encoding: 'utf8') => string;

/** Reads each code-owned credential once at startup; callers cannot supply paths. */
export function createStockVideoCredentialSource(
  readFile: ReadStockVideoCredential,
  directory = DEFAULT_STOCK_VIDEO_CREDENTIAL_DIRECTORY,
): (reference: string) => string | undefined {
  const values: Record<string, string | undefined> = {};
  for (const [reference, id] of Object.entries({
    [STOCK_VIDEO_SECRET_REFS.pexels]: PEXELS_SYSTEMD_CREDENTIAL_ID,
    [STOCK_VIDEO_SECRET_REFS.pixabay]: PIXABAY_SYSTEMD_CREDENTIAL_ID,
  })) {
    try {
      const value = readFile(`${directory}/${id}`, 'utf8').replace(/\r?\n$/, '');
      values[reference] = value.trim() === '' ? undefined : value;
    } catch {
      values[reference] = undefined;
    }
  }
  return (reference: string) => values[reference];
}
