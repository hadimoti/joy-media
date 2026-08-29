/**
 * Resolves the relative resources referenced by a .gltf file to files selected
 * in the same file picker operation. A .gltf is a JSON manifest and commonly
 * has a sibling .bin or texture; treating the manifest as an isolated blob
 * makes those otherwise valid models fail to load (and can accidentally make
 * the loader request an arbitrary network URL).
 */
export interface ThreeDResourceResolver {
  readonly resolve: (url: string) => string;
  readonly revokeAll: () => void;
}

type CreateObjectUrl = (file: Blob) => string;
type RevokeObjectUrl = (url: string) => void;

export function createThreeDResourceResolver(
  files: readonly File[],
  createObjectUrl: CreateObjectUrl = (file) => URL.createObjectURL(file),
  revokeObjectUrl: RevokeObjectUrl = (url) => URL.revokeObjectURL(url),
): ThreeDResourceResolver {
  const byPath = new Map<string, File>();
  const byBasename = new Map<string, File | null>();
  for (const file of files) {
    const path = normalizeResourcePath(file.name);
    if (path.length > 0) byPath.set(path, file);
    const basename = resourceBasename(path);
    if (basename.length === 0) continue;
    const existing = byBasename.get(basename);
    byBasename.set(basename, existing === undefined ? file : null);
  }

  const urls = new Map<File, string>();
  return {
    resolve(url: string): string {
      // Embedded buffers/images and already-materialized URLs are self-contained.
      if (/^(?:data|blob):/i.test(url)) return url;
      const normalized = normalizeResourcePath(url);
      const file = byPath.get(normalized) ?? byBasename.get(resourceBasename(normalized));
      if (file === undefined || file === null) {
        throw new Error(
          `3D model references missing resource "${url}"; select that file with the model`,
        );
      }
      const existing = urls.get(file);
      if (existing !== undefined) return existing;
      // The resolver is intentionally typed around File-like objects so it is
      // straightforward to unit-test without creating browser File objects.
      const objectUrl = createObjectUrl(file);
      urls.set(file, objectUrl);
      return objectUrl;
    },
    revokeAll(): void {
      for (const url of urls.values()) revokeObjectUrl(url);
      urls.clear();
    },
  };
}

export function normalizeResourcePath(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Keep the original URL so the error names the malformed resource.
  }
  const withoutQuery = decoded.split(/[?#]/, 1)[0] ?? decoded;
  const withoutOrigin = withoutQuery.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+/i, '');
  return withoutOrigin.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function resourceBasename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase();
}
