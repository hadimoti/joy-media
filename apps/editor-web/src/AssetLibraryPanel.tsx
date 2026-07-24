import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { AuthorizedDerivativeResolver } from './asset-resolver.js';
import {
  BrowserControlPlaneClient,
  type BrowserAsset,
  type BrowserAssetRegistration,
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
import { openOpfsOriginalAssetCache } from './opfs-original-asset-cache.js';
import {
  CloseIcon,
  CloudIcon,
  ImageIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  AiEffectIcon,
  SearchIcon,
  FilterIcon,
  UploadIcon,
  CheckIcon,
  GridUiIcon,
  VideoIcon,
  AudioIcon,
} from './icons.js';
import { JOY_MEDIA_ASSET_DND } from './TimelinePanel.js';

const categories: readonly {
  readonly id: AssetCategory;
  readonly label: string;
  readonly Icon: ComponentType;
}[] = [
  { id: 'all', label: 'All assets', Icon: GridUiIcon },
  { id: 'video', label: 'Video', Icon: VideoIcon },
  { id: 'audio', label: 'Audio', Icon: AudioIcon },
  { id: 'image', label: 'Images', Icon: ImageIcon },
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
export function AssetLibraryPanel({
  projectId,
  onAddSticker,
}: {
  readonly projectId: string;
  readonly onAddSticker?: (asset: {
    readonly assetId: string;
    readonly displayName?: string;
    readonly blob?: Blob;
  }) => void;
}) {
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
  const originalAssetCache = useMemo(() => openOpfsOriginalAssetCache(), []);
  const previewRef = useRef<Preview | undefined>(undefined);
  const [items, setItems] = useState<readonly AssetLibraryItem[]>([]);
  const [category, setCategory] = useState<AssetCategory>('all');
  const [query, setQuery] = useState('');
  const [availability, setAvailability] = useState<AssetAvailability>('all');
  const [sort, setSort] = useState<AssetSort>('recent');
  const [status, setStatus] = useState('Loading asset catalog…');
  const [preview, setPreview] = useState<Preview | undefined>(undefined);
  const [assetId, setAssetId] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined);
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [comfyReady, setComfyReady] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const filterActive = availability !== 'all' || sort !== 'recent';
  const canImport = selectedFile !== undefined && assetId.trim().length > 0;

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
      if (assets.length === 0) setImportOpen(true);
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

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (!filterOpen && !searchOpen && !importOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = toolbarRef.current;
      if (root === null || root.contains(event.target as Node)) return;
      setFilterOpen(false);
      if (query.trim().length === 0) setSearchOpen(false);
      if (selectedFile === undefined && assetId.trim().length === 0) setImportOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setFilterOpen(false);
      setImportOpen(false);
      if (query.trim().length === 0) {
        setSearchOpen(false);
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [filterOpen, searchOpen, importOpen, query, selectedFile, assetId]);

  useEffect(() => {
    void client
      .workers()
      .then((workers) => {
        setComfyReady(
          workers.some(
            (worker) =>
              !worker.revoked &&
              worker.paired &&
              worker.capabilities.includes('image.comfy'),
          ),
        );
      })
      .catch(() => setComfyReady(false));
  }, [client, items]);

  const addAsSticker = useCallback(
    async (asset: BrowserAsset) => {
      if (onAddSticker === undefined) {
        setStatus('Sticker placement is unavailable in this session.');
        return;
      }
      try {
        const blob = await (await originalAssetCache).get(asset.id);
        if (blob === undefined) {
          setStatus('Open/register this image in this browser first so OPFS has the original bytes.');
          return;
        }
        onAddSticker({ assetId: asset.id, displayName: asset.displayName, blob });
        setStatus(`Added ${asset.displayName} as a sticker overlay.`);
      } catch (error) {
        setStatus(`Could not add sticker: ${message(error)}`);
      }
    },
    [onAddSticker, originalAssetCache],
  );

  const removeBackground = useCallback(
    async (asset: BrowserAsset) => {
      if (!comfyReady) {
        setStatus('Remove background needs a paired GPU Worker with image.comfy (ADR-0018).');
        return;
      }
      try {
        const job = await client.enqueueComfyRemoveBg(
          projectId,
          `rembg-${asset.id}-${Date.now()}`,
          asset.id,
        );
        setStatus(
          `Queued background removal job ${job.id} (Comfy RemBG). When the Worker completes, register the foreground PNG and Add as sticker.`,
        );
      } catch (error) {
        setStatus(`Could not queue remove-background: ${message(error)}`);
      }
    },
    [client, comfyReady, projectId],
  );

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
  const registerSelectedAsset = useCallback(async () => {
    if (selectedFile === undefined) {
      setStatus('Choose a media file to register.');
      return;
    }
    const normalizedId = assetId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalizedId)) {
      setStatus('Asset ID must use letters, numbers, dots, underscores, or hyphens.');
      return;
    }
    try {
      const kind = assetKind(selectedFile);
      const mimeType = normalizedMimeType(selectedFile, kind);
      setStatus(`Hashing and caching ${selectedFile.name} locally…`);
      const sha256 = hex(
        new Uint8Array(await crypto.subtle.digest('SHA-256', await selectedFile.arrayBuffer())),
      );
      const registration: BrowserAssetRegistration = {
        id: normalizedId,
        kind,
        displayName: selectedFile.name,
        sha256,
        bytes: selectedFile.size,
        descriptor: { mimeType },
        locations: [{ kind: 'opfs-cache', ref: `opfs-${sha256.slice(0, 32)}` }],
      };
      await (
        await originalAssetCache
      ).put(
        {
          assetId: registration.id,
          sha256: registration.sha256,
          bytes: registration.bytes,
          mimeType: registration.descriptor.mimeType,
        },
        selectedFile,
      );
      await client.registerAsset(projectId, registration);
      setSelectedFile(undefined);
      setAssetId('');
      if (fileInputRef.current !== null) fileInputRef.current.value = '';
      setImportOpen(false);
      setStatus(
        `Registered ${selectedFile.name}. Configure the same opaque ID on a local Worker before queuing a derivative.`,
      );
      await refresh();
    } catch (error) {
      setStatus(`Could not register asset: ${message(error)}`);
    }
  }, [assetId, client, originalAssetCache, projectId, refresh, selectedFile]);
  const enableSync = useCallback(async () => {
    try {
      const result = await client.setAssetSync(projectId, true);
      setSyncEnabled(result.assetSyncEnabled);
      setStatus('Private derivative backup is enabled for this project.');
    } catch (error) {
      setStatus(`Could not enable private backup: ${message(error)}`);
    }
  }, [client, projectId]);
  const queueThumbnail = useCallback(
    async (asset: BrowserAsset) => {
      try {
        await client.enqueueAssetThumbnail(projectId, `thumbnail-${crypto.randomUUID()}`, asset.id);
        setStatus(
          `Thumbnail queued for ${asset.displayName}. A Worker with this asset ID can claim it.`,
        );
        await refresh();
      } catch (error) {
        setStatus(`Could not queue thumbnail: ${message(error)}`);
      }
    },
    [client, projectId, refresh],
  );

  return (
    <section className="asset-library" aria-label="Asset library">
      <nav className="asset-categories" aria-label="Asset categories">
        {categories.map((entry) => {
          const count =
            entry.id === 'all'
              ? items.length
              : items.filter(({ asset }) => asset.kind === entry.id).length;
          const Icon = entry.Icon;
          return (
            <button
              key={entry.id}
              type="button"
              className={category === entry.id ? 'asset-category-tab active' : 'asset-category-tab'}
              aria-pressed={category === entry.id}
              aria-label={`${entry.label} (${count})`}
              title={`${entry.label} (${count})`}
              onClick={() => setCategory(entry.id)}
            >
              <Icon />
              <small>{count}</small>
            </button>
          );
        })}
      </nav>
      <div className="asset-library-content">
        <div className="asset-library-toolbar" ref={toolbarRef}>
          <div className="asset-toolbar-icons" role="toolbar" aria-label="Asset tools">
            {searchOpen ? (
              <label className="asset-search asset-search-expanded">
                <span className="sr-only">Search assets</span>
                <SearchIcon />
                <input
                  ref={searchInputRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onBlur={() => {
                    if (query.trim().length === 0) setSearchOpen(false);
                  }}
                  placeholder="Search assets"
                  aria-label="Search assets"
                />
                <button
                  type="button"
                  className="icon-button asset-search-close"
                  aria-label="Close search"
                  title="Close search"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setQuery('');
                    setSearchOpen(false);
                  }}
                >
                  <CloseIcon />
                </button>
              </label>
            ) : (
              <button
                type="button"
                className="icon-button"
                aria-label="Search assets"
                title="Search assets"
                aria-expanded={false}
                onClick={() => {
                  setFilterOpen(false);
                  setImportOpen(false);
                  setSearchOpen(true);
                }}
              >
                <SearchIcon />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="Import media"
              title="Import media"
              aria-expanded={importOpen}
              aria-pressed={importOpen}
              data-active={importOpen ? 'true' : undefined}
              onClick={() => {
                setFilterOpen(false);
                setSearchOpen(false);
                setImportOpen((open) => !open);
              }}
            >
              <UploadIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Filter and sort"
              title="Filter and sort"
              aria-expanded={filterOpen}
              aria-pressed={filterActive || filterOpen}
              data-active={filterActive || filterOpen ? 'true' : undefined}
              onClick={() => {
                setImportOpen(false);
                setFilterOpen((open) => !open);
              }}
            >
              <FilterIcon />
            </button>
            <button
              type="button"
              className="icon-button asset-refresh"
              onClick={() => void refresh()}
              aria-label="Refresh assets"
              title="Refresh assets"
            >
              <RefreshIcon />
            </button>
            <button
              type="button"
              className="icon-button asset-sync"
              disabled={syncEnabled}
              aria-pressed={syncEnabled}
              aria-label={
                syncEnabled
                  ? 'Private backup is enabled for this project'
                  : 'Enable private cloud backup for this project'
              }
              data-guide={syncEnabled ? 'Backup on' : 'Enable backup'}
              onClick={() => void enableSync()}
            >
              <CloudIcon />
            </button>
          </div>
          {importOpen && (
            <div className="asset-import-drawer" role="dialog" aria-label="Import media">
              <div className="asset-filter-drawer-head">
                <strong>Import media</strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close import"
                  title="Close import"
                  onClick={() => setImportOpen(false)}
                >
                  <CloseIcon />
                </button>
              </div>
              <p className="asset-import-hint">
                Hashed and cached in this browser. Use an opaque Asset ID that matches a Worker —
                paths stay local.
              </p>
              <div className="asset-import-row">
                <input
                  ref={fileInputRef}
                  className="sr-only"
                  type="file"
                  accept="video/*,audio/*,image/*"
                  onChange={(event) => setSelectedFile(event.currentTarget.files?.[0])}
                  aria-label="Media file"
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Choose media file"
                  title="Choose media file"
                  data-active={selectedFile !== undefined ? 'true' : undefined}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PlusIcon />
                </button>
                <span className="asset-import-file" title={selectedFile?.name}>
                  {selectedFile?.name ?? 'Choose file'}
                </span>
                <input
                  className="asset-import-id"
                  value={assetId}
                  onChange={(event) => setAssetId(event.target.value)}
                  placeholder="Asset ID"
                  aria-label="Asset ID"
                />
                <button
                  type="button"
                  className="icon-button"
                  disabled={!canImport}
                  aria-label="Confirm import"
                  title="Import media"
                  onClick={() => void registerSelectedAsset()}
                >
                  <CheckIcon />
                </button>
              </div>
            </div>
          )}
          {filterOpen && (
            <div className="asset-filter-drawer" role="dialog" aria-label="Asset filters">
              <div className="asset-filter-drawer-head">
                <strong>Filters</strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close filters"
                  title="Close filters"
                  onClick={() => setFilterOpen(false)}
                >
                  <CloseIcon />
                </button>
              </div>
              <label className="asset-filter-field">
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
              <label className="asset-filter-field">
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
              {filterActive && (
                <button
                  type="button"
                  className="asset-filter-reset"
                  onClick={() => {
                    setAvailability('all');
                    setSort('recent');
                  }}
                >
                  Reset filters
                </button>
              )}
            </div>
          )}
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
            <button
              type="button"
              className="icon-button"
              aria-label="Close preview"
              title="Close preview"
              onClick={clearPreview}
            >
              <CloseIcon />
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
          <div className="asset-library-empty">
            {status.includes('Initialize') ? (
              <>
                <p>This project is not initialized.</p>
                <p>Open the Jobs panel to initialize it, then import media here.</p>
              </>
            ) : (
              <>
                <p>No assets match the current filters.</p>
                <button
                  type="button"
                  className="icon-button icon-button-labeled"
                  onClick={() => setImportOpen(true)}
                  aria-label="Import media"
                  title="Import media"
                >
                  <UploadIcon />
                  Import
                </button>
              </>
            )}
          </div>
        ) : (
          <ul className="asset-grid" aria-label="Assets">
            {visible.map(({ asset, derivatives }) => {
              const derivative = preferredDerivative(derivatives);
              const status =
                derivative?.availability ??
                (derivatives.length === 0 ? 'none' : derivatives[0]!.availability);
              return (
                <li
                  key={asset.id}
                  className="asset-card"
                  draggable
                  title="Drag onto a timeline track"
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      JOY_MEDIA_ASSET_DND,
                      JSON.stringify({
                        assetId: asset.id,
                        kind: asset.kind,
                        displayName: asset.displayName,
                      }),
                    );
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                >
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
                  {derivatives.length === 0 && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Generate thumbnail for ${asset.displayName}`}
                      title="Generate thumbnail"
                      onClick={() => void queueThumbnail(asset)}
                    >
                      <ImageIcon />
                    </button>
                  )}
                  {derivative !== undefined && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Preview verified ${derivative.kind} for ${asset.displayName}`}
                      title={`Preview verified ${derivative.kind}`}
                      onClick={() => void openPreview(asset, derivative)}
                    >
                      <PlayIcon />
                    </button>
                  )}
                  {asset.kind === 'image' && (
                    <>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Add ${asset.displayName} as sticker`}
                        data-guide="Add as sticker"
                        onClick={() => void addAsSticker(asset)}
                      >
                        <PlusIcon />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove background from ${asset.displayName}`}
                        data-guide="Remove background"
                        disabled={!comfyReady}
                        onClick={() => void removeBackground(asset)}
                      >
                        <AiEffectIcon />
                      </button>
                    </>
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

function assetKind(file: File): BrowserAsset['kind'] {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  throw new Error('selected file must be video, audio, or an image');
}
function normalizedMimeType(file: File, kind: BrowserAsset['kind']): string {
  if (/^(video|audio|image)\/[a-z0-9.+-]+$/i.test(file.type)) return file.type;
  throw new Error(`${kind} file has no supported MIME type`);
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
