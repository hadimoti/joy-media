import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthorizedDerivativeResolver } from './asset-resolver.js';
import {
  BrowserControlPlaneClient,
  type BrowserAsset,
  type BrowserDerivative,
} from './control-plane-client.js';
import {
  filterAssetLibrary,
  preferredDerivative,
  type AssetAvailability,
  type AssetCategory,
  type AssetLibraryItem,
  type AssetSort,
} from './asset-library-state.js';
import { openOpfsDerivativeCache } from './opfs-asset-cache.js';

const categories: readonly { readonly id: AssetCategory; readonly label: string }[] = [
  { id: 'all', label: 'All assets' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'image', label: 'Images' },
];

interface Preview {
  readonly derivativeId: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly url: string;
  readonly revoke: () => void;
}

/**
 * Asset discovery stays metadata-only. A preview is hydrated through the
 * authenticated API, verified, then cached in OPFS by AuthorizedDerivativeResolver.
 */
export function AssetLibraryPanel({ projectId }: { readonly projectId: string }) {
  const client = useMemo(() => new BrowserControlPlaneClient(), []);
  const resolver = useMemo(
    () =>
      openOpfsDerivativeCache().then(
        (cache) =>
          new AuthorizedDerivativeResolver(cache, {
            fetch: ({ projectId: requestedProjectId, assetId, derivative }) =>
              client.derivativeBytes(requestedProjectId, assetId, derivative.derivativeId),
          }),
      ),
    [client],
  );
  const previewRef = useRef<Preview | undefined>(undefined);
  const [items, setItems] = useState<readonly AssetLibraryItem[]>([]);
  const [category, setCategory] = useState<AssetCategory>('all');
  const [query, setQuery] = useState('');
  const [availability, setAvailability] = useState<AssetAvailability>('all');
  const [sort, setSort] = useState<AssetSort>('recent');
  const [status, setStatus] = useState('Loading asset catalog…');
  const [preview, setPreview] = useState<Preview | undefined>(undefined);

  const clearPreview = useCallback(() => {
    previewRef.current?.revoke();
    previewRef.current = undefined;
    setPreview(undefined);
  }, []);
  useEffect(() => () => previewRef.current?.revoke(), []);

  const refresh = useCallback(async () => {
    try {
      const assets = await client.assets(projectId);
      const derivatives = await Promise.all(
        assets.map(
          async (asset) => [asset.id, await client.derivatives(projectId, asset.id)] as const,
        ),
      );
      const byAsset = new Map(derivatives);
      setItems(assets.map((asset) => ({ asset, derivatives: byAsset.get(asset.id) ?? [] })));
      setStatus(
        assets.length === 0
          ? 'No media has been registered for this project yet.'
          : 'Catalog ready.',
      );
    } catch (error) {
      const detail = message(error);
      if (detail.includes('PROJECT_NOT_FOUND')) {
        setItems([]);
        setStatus('Initialize this project in Jobs before registering media.');
        return;
      }
      setStatus(`Could not load the asset catalog: ${detail}`);
    }
  }, [client, projectId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = useMemo(
    () => filterAssetLibrary(items, category, query, availability, sort),
    [items, category, query, availability, sort],
  );
  const openPreview = useCallback(
    async (asset: BrowserAsset, derivative: BrowserDerivative) => {
      clearPreview();
      setStatus(`Opening verified ${derivative.kind}…`);
      try {
        const outcome = await (
          await resolver
        ).resolve({
          projectId,
          assetId: asset.id,
          derivative: {
            derivativeId: derivative.id,
            sha256: derivative.sha256,
            byteLength: derivative.bytes,
            mimeType: derivative.descriptor.mimeType,
          },
        });
        if (outcome.state !== 'available-local') {
          setStatus(previewStatus(outcome.state));
          return;
        }
        const nextPreview: Preview = {
          derivativeId: derivative.id,
          displayName: asset.displayName,
          mimeType: derivative.descriptor.mimeType,
          url: outcome.url,
          revoke: outcome.revoke,
        };
        previewRef.current = nextPreview;
        setPreview(nextPreview);
        setStatus(`Previewing ${asset.displayName} from this browser's verified local cache.`);
      } catch (error) {
        setStatus(`Could not open preview: ${message(error)}`);
      }
    },
    [clearPreview, projectId, resolver],
  );

  return (
    <section className="asset-library" aria-label="Asset library">
      <nav className="asset-categories" aria-label="Asset categories">
        <h2>Assets</h2>
        {categories.map((entry) => {
          const count =
            entry.id === 'all'
              ? items.length
              : items.filter(({ asset }) => asset.kind === entry.id).length;
          return (
            <button
              key={entry.id}
              type="button"
              className={category === entry.id ? 'asset-category-tab active' : 'asset-category-tab'}
              aria-pressed={category === entry.id}
              onClick={() => setCategory(entry.id)}
            >
              <span>{entry.label}</span>
              <small>{count}</small>
            </button>
          );
        })}
      </nav>
      <div className="asset-library-content">
        <div className="asset-library-toolbar" role="search">
          <label className="asset-search">
            <span className="sr-only">Search assets</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search assets"
              aria-label="Search assets"
            />
          </label>
          <label className="asset-filter">
            <span>Availability</span>
            <select
              value={availability}
              onChange={(event) => setAvailability(event.target.value as AssetAvailability)}
              aria-label="Filter by availability"
            >
              <option value="all">Any status</option>
              <option value="available-cloud">Ready in cloud</option>
              <option value="available-local">Cached locally</option>
              <option value="pending">Processing</option>
              <option value="evicted">Cache evicted</option>
              <option value="invalid">Needs repair</option>
              <option value="none">No derivative</option>
            </select>
          </label>
          <label className="asset-filter">
            <span>Sort</span>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as AssetSort)}
              aria-label="Sort assets"
            >
              <option value="recent">Newest</option>
              <option value="name">Name</option>
              <option value="size">Largest file</option>
            </select>
          </label>
          <button
            type="button"
            className="asset-refresh"
            onClick={() => void refresh()}
            aria-label="Refresh assets"
          >
            Refresh
          </button>
        </div>
        <p className="asset-library-status" aria-live="polite">
          {status}
        </p>
        {preview !== undefined && (
          <section className="asset-preview" aria-label={`Preview: ${preview.displayName}`}>
            <div>
              <strong>{preview.displayName}</strong>
              <span>Verified private derivative</span>
            </div>
            <button type="button" onClick={clearPreview}>
              Close preview
            </button>
            {preview.mimeType.startsWith('video/') ? (
              <video key={preview.derivativeId} src={preview.url} controls autoPlay />
            ) : preview.mimeType.startsWith('audio/') ? (
              <audio key={preview.derivativeId} src={preview.url} controls autoPlay />
            ) : (
              <img
                src={preview.url}
                alt={`Verified derivative preview for ${preview.displayName}`}
              />
            )}
          </section>
        )}
        {visible.length === 0 ? (
          <p className="asset-library-empty">No assets match the current category and filters.</p>
        ) : (
          <ul className="asset-grid" aria-label="Assets">
            {visible.map(({ asset, derivatives }) => {
              const derivative = preferredDerivative(derivatives);
              const status =
                derivative?.availability ??
                (derivatives.length === 0 ? 'none' : derivatives[0]!.availability);
              return (
                <li key={asset.id} className="asset-card">
                  <div className="asset-card-heading">
                    <strong title={asset.id}>{asset.displayName}</strong>
                    <span className={`asset-kind asset-kind-${asset.kind}`}>{asset.kind}</span>
                  </div>
                  <p>
                    {asset.descriptor.mimeType} · {formatBytes(asset.bytes)}
                  </p>
                  <p className={`asset-availability asset-availability-${status}`}>
                    {availabilityLabel(status)}
                  </p>
                  {derivative !== undefined && (
                    <button type="button" onClick={() => void openPreview(asset, derivative)}>
                      Preview verified {derivative.kind}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function availabilityLabel(status: AssetAvailability): string {
  switch (status) {
    case 'available-cloud':
      return 'Ready in private cloud';
    case 'available-local':
      return 'Available in local cache';
    case 'pending':
      return 'Derivative processing';
    case 'evicted':
      return 'Local cache evicted';
    case 'invalid':
      return 'Derivative needs repair';
    case 'none':
      return 'No derivative yet';
    default:
      return 'Unknown status';
  }
}
function previewStatus(
  state: 'missing' | 'invalid' | 'unsupported' | 'unavailable' | 'revoked',
): string {
  switch (state) {
    case 'missing':
      return 'The local cache entry is missing and no cloud copy is available.';
    case 'invalid':
      return 'The local cache entry failed integrity checks and was removed.';
    case 'unsupported':
      return 'This browser does not support OPFS local media caching.';
    case 'revoked':
      return 'Your access to this private derivative has been revoked.';
    case 'unavailable':
      return 'The private derivative is unavailable right now.';
  }
}
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
