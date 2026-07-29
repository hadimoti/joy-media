import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AuthorizedDerivativeResolver } from './asset-resolver.js';
import {
  BrowserControlPlaneClient,
  type BrowserAsset,
  type BrowserAssetRegistration,
  type BrowserDerivative,
} from './control-plane-client.js';
import {
  assetCollectionId,
  assetCollectionLabel,
  assetCollectionsForCategory,
  filterAssetLibrary,
  preferredDerivative,
  type AssetAvailability,
  type AssetCategory,
  type AssetCollectionId,
  type AssetLibraryItem,
  type AssetSort,
  type AssetViewMode,
} from './asset-library-state.js';
import { openOpfsDerivativeCache } from './opfs-asset-cache.js';
import {
  openOpfsOriginalAssetCache,
  type OpfsOriginalAssetCache,
} from './opfs-original-asset-cache.js';
import { CloudPreviewQueue } from './cloud-preview-queue.js';
import { resolveAssetThumb, type AssetThumbSource } from './asset-card-preview.js';
import {
  CloseIcon,
  CloudIcon,
  PlusIcon,
  RefreshIcon,
  AiEffectIcon,
  FilterIcon,
  UploadIcon,
  CheckIcon,
  GridUiIcon,
  ListIcon,
  TrashIcon,
} from './icons.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import { ASSET_CATEGORY_ICONS, assetCollectionIconUrl } from './asset-library-icons.js';
import { JOY_MEDIA_ASSET_DND } from './TimelinePanel.js';

const ASSET_RENDER_PAGE_SIZE = 120;

const categories: readonly {
  readonly id: AssetCategory;
  readonly label: string;
}[] = [
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
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
  projectTitle = 'Editor project',
  onAddSticker: _onAddSticker,
  onEditWithAi,
}: {
  readonly projectId: string;
  readonly projectTitle?: string;
  readonly onAddSticker?: (asset: {
    readonly assetId: string;
    readonly displayName?: string;
    readonly blob?: Blob;
  }) => void;
  /** Attach image/video to KiloCode for further editing automations. */
  readonly onEditWithAi?: (asset: {
    readonly assetId: string;
    readonly kind: 'image' | 'video';
    readonly displayName: string;
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
  const cloudPreviewQueue = useMemo(() => new CloudPreviewQueue(), []);
  const previewRef = useRef<Preview | undefined>(undefined);
  const [items, setItems] = useState<readonly AssetLibraryItem[]>([]);
  const [cloudAssetIds, setCloudAssetIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedAssetIds, setSelectedAssetIds] = useState<ReadonlySet<string>>(() => new Set());
  const [category, setCategory] = useState<AssetCategory>('image');
  const [collection, setCollection] = useState<AssetCollectionId>('browse');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [availability, setAvailability] = useState<AssetAvailability>('all');
  const [sort, setSort] = useState<AssetSort>('name');
  const [viewMode, setViewMode] = useState<AssetViewMode>(() => readAssetViewMode());
  const [renderLimit, setRenderLimit] = useState(ASSET_RENDER_PAGE_SIZE);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<Preview | undefined>(undefined);
  const [assetId, setAssetId] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined);
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importProgress, setImportProgress] = useState<number | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const filterActive = availability !== 'all' || sort !== 'name';
  const canImport =
    selectedFile !== undefined && assetId.trim().length > 0 && importProgress === undefined;

  const clearPreview = useCallback(() => {
    previewRef.current?.revoke();
    previewRef.current = undefined;
    setPreview(undefined);
  }, []);
  useEffect(() => () => previewRef.current?.revoke(), []);

  const refresh = useCallback(async () => {
    try {
      // Auto-create control-plane project so Assets never depends on Jobs → Initialize.
      await client.ensureProject(projectId, projectTitle);
      const [ownedAssets, sharedAssets] = await Promise.all([
        client.myAssets(),
        client.sharedCloudAssets().catch(() => [] as readonly BrowserAsset[]),
      ]);
      const byId = new Map<string, BrowserAsset>();
      for (const asset of ownedAssets) byId.set(asset.id, asset);
      for (const asset of sharedAssets) {
        const existing = byId.get(asset.id);
        if (existing === undefined) {
          byId.set(asset.id, asset);
          continue;
        }
        byId.set(asset.id, {
          ...existing,
          ...(asset.tags !== undefined ? { tags: asset.tags } : {}),
          ...(asset.sortName !== undefined ? { sortName: asset.sortName } : {}),
        });
      }
      const assets = [...byId.values()];
      const derivatives = await Promise.all(
        ownedAssets.map(async (asset) => {
          try {
            return [
              asset.id,
              await client.derivatives(asset.projectId || projectId, asset.id),
            ] as const;
          } catch {
            return [asset.id, [] as readonly BrowserDerivative[]] as const;
          }
        }),
      );
      const byAsset = new Map(derivatives);
      setCloudAssetIds(new Set(sharedAssets.map((asset) => asset.id)));
      setItems(assets.map((asset) => ({ asset, derivatives: byAsset.get(asset.id) ?? [] })));
      setStatus(
        assets.length === 0
          ? 'No media yet. Import an image to sync with the shared cloud library.'
          : undefined,
      );
      if (assets.length === 0) setImportOpen(true);
    } catch (error) {
      const detail = message(error);
      setItems([]);
      setStatus(`Failed to load media catalog: ${detail}`);
    }
  }, [client, projectId, projectTitle]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!filterOpen && !importOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = toolbarRef.current;
      if (root === null || root.contains(event.target as Node)) return;
      setFilterOpen(false);
      if (selectedFile === undefined && assetId.trim().length === 0) setImportOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setFilterOpen(false);
      setImportOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [filterOpen, importOpen, selectedFile, assetId]);

  const editWithAi = useCallback(
    (asset: BrowserAsset) => {
      if (asset.kind !== 'image' && asset.kind !== 'video') {
        setStatus('AI editing supports images and video only.');
        return;
      }
      if (onEditWithAi === undefined) {
        setStatus('Attaching media to KiloCode is not available in this session.');
        return;
      }
      onEditWithAi({
        assetId: asset.id,
        kind: asset.kind,
        displayName: asset.displayName,
      });
      setStatus(
        `${asset.displayName} attached to KiloCode. Drag it onto the timeline or automate it from Agent.`,
      );
    },
    [onEditWithAi],
  );

  const collections = useMemo(
    () => assetCollectionsForCategory(items, category),
    [items, category],
  );
  useEffect(() => {
    if (collections.some((entry) => entry.id === collection)) return;
    setCollection('browse');
  }, [collection, collections]);
  const visible = useMemo(
    () => filterAssetLibrary(items, category, collection, deferredQuery, availability, sort),
    [items, category, collection, deferredQuery, availability, sort],
  );
  useEffect(() => {
    setRenderLimit(ASSET_RENDER_PAGE_SIZE);
  }, [items, category, collection, deferredQuery, availability, sort]);
  const rendered = useMemo(() => visible.slice(0, renderLimit), [visible, renderLimit]);
  const openPreview = useCallback(
    async (asset: BrowserAsset, derivative: BrowserDerivative) => {
      clearPreview();
      setStatus(`Opening ${derivative.kind} (verified)…`);
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
        setStatus(
          `Preview for ${asset.displayName} is shown from this browser’s verified local cache.`,
        );
      } catch (error) {
        setStatus(`Failed to open preview: ${message(error)}`);
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
      setStatus('Asset ID may only contain Latin letters, digits, dots, underscores, or hyphens.');
      return;
    }
    try {
      const kind = assetKind(selectedFile);
      const mimeType = normalizedMimeType(selectedFile, kind);
      setImportProgress(0.02);
      setStatus(`Reading ${selectedFile.name}…`);
      const buffer = await readFileWithProgress(selectedFile, (ratio) => {
        setImportProgress(0.02 + 0.38 * ratio);
      });
      setImportProgress(0.42);
      setStatus(`Hashing ${selectedFile.name}…`);
      const sha256 = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)));
      setImportProgress(0.55);
      const registration: BrowserAssetRegistration = {
        id: normalizedId,
        kind,
        displayName: selectedFile.name,
        sha256,
        bytes: selectedFile.size,
        descriptor: { mimeType },
        locations: [{ kind: 'opfs-cache', ref: `opfs-${sha256.slice(0, 32)}` }],
      };
      setStatus(`Saving ${selectedFile.name} locally…`);
      setImportProgress(0.62);
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
      setImportProgress(0.88);
      setStatus(`Registering ${selectedFile.name}…`);
      const registered = await client.registerAsset(projectId, registration);
      if (kind === 'image') {
        setImportProgress(0.9);
        setStatus(`Uploading ${selectedFile.name} to private cloud storage…`);
        await client.uploadAssetOriginal(projectId, registered, selectedFile, (ratio) =>
          setImportProgress(0.9 + 0.08 * ratio),
        );
        setStatus(
          `${selectedFile.name} backed up to the cloud. Agent tags applied; catalog refreshing.`,
        );
      } else {
        try {
          await client.retagAsset(projectId, registered.id);
        } catch {
          /* heuristic retag is best-effort for video/audio */
        }
        setStatus(
          `${selectedFile.name} registered locally. Cloud backup for video and audio is lower priority in v1.`,
        );
      }
      setImportProgress(1);
      setSelectedFile(undefined);
      setAssetId('');
      if (fileInputRef.current !== null) fileInputRef.current.value = '';
      setImportOpen(false);
      await refresh();
      window.setTimeout(() => setImportProgress(undefined), 350);
    } catch (error) {
      setImportProgress(undefined);
      setStatus(`Failed to register media: ${message(error)}`);
    }
  }, [assetId, client, originalAssetCache, projectId, refresh, selectedFile]);
  const enableSync = useCallback(async () => {
    try {
      const result = await client.setAssetSync(projectId, true);
      setSyncEnabled(result.assetSyncEnabled);
      setStatus('Private derivative backup is enabled for this project.');
    } catch (error) {
      setStatus(`Failed to enable private backup: ${message(error)}`);
    }
  }, [client, projectId]);
  const fetchCloudOriginal = useCallback(
    (id: string) => cloudPreviewQueue.load(id, () => client.sharedCloudOriginalBytes(id)),
    [client, cloudPreviewQueue],
  );

  const toggleSelected = useCallback((assetId: string) => {
    setSelectedAssetIds((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }, []);

  const shareToCloud = useCallback(
    async (asset: BrowserAsset) => {
      if (asset.kind !== 'image') {
        setStatus('Cloud sharing is available for images only in v1.');
        return;
      }
      if (cloudAssetIds.has(asset.id)) {
        setStatus(`${asset.displayName} is already in the shared cloud library.`);
        return;
      }
      try {
        const blob = await (await originalAssetCache).get(asset.id);
        if (blob === undefined) {
          setStatus(
            'The OPFS original is missing in this browser. Re-import the image here first.',
          );
          return;
        }
        setStatus(`Uploading ${asset.displayName} to private cloud storage…`);
        await client.uploadAssetOriginal(asset.projectId || projectId, asset, blob);
        setStatus(`${asset.displayName} shared to cloud storage.`);
        await refresh();
      } catch (error) {
        setStatus(`Cloud share failed: ${message(error)}`);
      }
    },
    [client, cloudAssetIds, originalAssetCache, projectId, refresh],
  );

  const deleteAsset = useCallback(
    async (asset: BrowserAsset) => {
      const ok = window.confirm(`Delete “${asset.displayName}” from the catalog?`);
      if (!ok) return;
      try {
        await client.deleteAsset(asset.projectId || projectId, asset.id);
        setSelectedAssetIds((current) => {
          if (!current.has(asset.id)) return current;
          const next = new Set(current);
          next.delete(asset.id);
          return next;
        });
        setStatus(`${asset.displayName} deleted.`);
        await refresh();
      } catch (error) {
        setStatus(`Failed to delete media: ${message(error)}`);
      }
    },
    [client, projectId, refresh],
  );

  const bulkShare = useCallback(async () => {
    const targets = visible.filter(
      ({ asset }) =>
        selectedAssetIds.has(asset.id) && asset.kind === 'image' && !cloudAssetIds.has(asset.id),
    );
    if (targets.length === 0) {
      setStatus('No selected images are ready to share; an OPFS original is required.');
      return;
    }
    let shared = 0;
    for (const { asset } of targets) {
      try {
        const blob = await (await originalAssetCache).get(asset.id);
        if (blob === undefined) continue;
        await client.uploadAssetOriginal(asset.projectId || projectId, asset, blob);
        shared += 1;
      } catch {
        /* continue remaining */
      }
    }
    setStatus(`Shared ${shared} of ${targets.length} selected images to the cloud.`);
    await refresh();
  }, [client, cloudAssetIds, originalAssetCache, projectId, refresh, selectedAssetIds, visible]);

  const bulkEditWithAi = useCallback(() => {
    if (onEditWithAi === undefined) {
      setStatus('Attaching media to KiloCode is not available in this session.');
      return;
    }
    let attached = 0;
    for (const { asset } of visible) {
      if (!selectedAssetIds.has(asset.id)) continue;
      if (asset.kind !== 'image' && asset.kind !== 'video') continue;
      onEditWithAi({
        assetId: asset.id,
        kind: asset.kind,
        displayName: asset.displayName,
      });
      attached += 1;
    }
    setStatus(
      attached === 0
        ? 'No selected images or videos to attach.'
        : `${attached} media item(s) attached to KiloCode.`,
    );
  }, [onEditWithAi, selectedAssetIds, visible]);

  const bulkDelete = useCallback(async () => {
    const targets = visible.filter(({ asset }) => selectedAssetIds.has(asset.id));
    if (targets.length === 0) return;
    const ok = window.confirm(`Delete ${targets.length} selected media item(s) from the catalog?`);
    if (!ok) return;
    let deleted = 0;
    for (const { asset } of targets) {
      try {
        await client.deleteAsset(asset.projectId || projectId, asset.id);
        deleted += 1;
      } catch {
        /* continue remaining */
      }
    }
    setSelectedAssetIds(new Set());
    setStatus(`Deleted ${deleted} of ${targets.length} selected media items.`);
    await refresh();
  }, [client, projectId, refresh, selectedAssetIds, visible]);

  const visibleIds = useMemo(() => rendered.map(({ asset }) => asset.id), [rendered]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedAssetIds.has(id));
  const selectedCount = selectedAssetIds.size;

  // The top level is intentionally media-specific. Collections below it are
  // driven by category-* tags, so future videos and audio inherit the same UI.
  const categoryTabs: readonly PanelTabSpec[] = categories.map((entry) => {
    const count = items.filter(({ asset }) => asset.kind === entry.id).length;
    return {
      id: entry.id,
      label: `${entry.label} ${count}`,
      iconUrl: ASSET_CATEGORY_ICONS[entry.id],
    };
  });

  return (
    <PanelShell
      title="Assets"
      iconUrl={panelTabIconUrl('media')}
      className="asset-library"
      tabs={categoryTabs}
      activeTab={category}
      onTabChange={(id) => {
        setCategory(id as AssetCategory);
        setCollection('browse');
      }}
      search={{ value: query, onChange: setQuery, placeholder: 'Search media…' }}
      note={status}
      leadingActions={
        <>
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
        </>
      }
      actions={
        <>
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
          <div className="asset-view-switch" role="group" aria-label="Asset view">
            <button
              type="button"
              className="icon-button"
              aria-label="Large previews"
              title="Large previews"
              aria-pressed={viewMode === 'large'}
              data-active={viewMode === 'large' ? 'true' : undefined}
              onClick={() => {
                setViewMode('large');
                writeAssetViewMode('large');
              }}
            >
              <span className="asset-view-glyph asset-view-glyph--large" aria-hidden>
                ▦
              </span>
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Compact grid"
              title="Compact grid"
              aria-pressed={viewMode === 'medium'}
              data-active={viewMode === 'medium' ? 'true' : undefined}
              onClick={() => {
                setViewMode('medium');
                writeAssetViewMode('medium');
              }}
            >
              <GridUiIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="List view"
              title="List view"
              aria-pressed={viewMode === 'list'}
              data-active={viewMode === 'list' ? 'true' : undefined}
              onClick={() => {
                setViewMode('list');
                writeAssetViewMode('list');
              }}
            >
              <ListIcon />
            </button>
          </div>
        </>
      }
    >
      <div className="asset-library-content" ref={toolbarRef}>
        <aside className="asset-library-sidebar" aria-label={`${category} collections`}>
          <span className="asset-library-sidebar-title">Collections</span>
          <div
            className="asset-library-collections"
            role="tablist"
            aria-label={`${category} collections`}
          >
            {collections.map((entry) => {
              const collectionIcon = assetCollectionIconUrl(entry.id);
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  className="asset-library-collection-tab"
                  aria-label={`${entry.label} (${entry.count})`}
                  title={`${entry.label} (${entry.count})`}
                  aria-selected={collection === entry.id}
                  onClick={() => setCollection(entry.id)}
                >
                  {collectionIcon !== undefined && (
                    <span
                      className="asset-library-collection-tab-icon"
                      style={{
                        maskImage: `url(${collectionIcon})`,
                        WebkitMaskImage: `url(${collectionIcon})`,
                      }}
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </aside>
        <div className="asset-library-main">
          {importProgress !== undefined && (
            <div
              className="asset-upload-progress"
              role="progressbar"
              aria-label="Asset upload progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(importProgress * 100)}
            >
              <span style={{ width: `${Math.min(100, importProgress * 100).toFixed(1)}%` }} />
            </div>
          )}
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
                The file is hashed and stored in this browser. Use an opaque Asset ID aligned with
                the Worker; paths stay local.
              </p>
              <div className="asset-import-row">
                <input
                  ref={fileInputRef}
                  className="sr-only"
                  type="file"
                  accept="video/*,audio/*,image/*"
                  disabled={importProgress !== undefined}
                  onChange={(event) => setSelectedFile(event.currentTarget.files?.[0])}
                  aria-label="Media file"
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Choose media file"
                  title="Choose media file"
                  disabled={importProgress !== undefined}
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
                  disabled={importProgress !== undefined}
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
              {importProgress !== undefined && (
                <div
                  className="asset-upload-progress asset-upload-progress--inline"
                  role="progressbar"
                  aria-label="Asset upload progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(importProgress * 100)}
                >
                  <span style={{ width: `${Math.min(100, importProgress * 100).toFixed(1)}%` }} />
                </div>
              )}
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
                  <option value="tags">Tags</option>
                  <option value="size">Largest file</option>
                </select>
              </label>
              {filterActive && (
                <button
                  type="button"
                  className="asset-filter-reset"
                  onClick={() => {
                    setAvailability('all');
                    setSort('name');
                  }}
                >
                  Reset filters
                </button>
              )}
            </div>
          )}
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
          {selectedCount > 0 && (
            <div className="asset-bulk-bar" role="toolbar" aria-label="Bulk asset actions">
              <span className="asset-bulk-count">{selectedCount}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="Share selected images to cloud"
                title="Share to cloud"
                data-guide="Share to cloud"
                onClick={() => void bulkShare()}
              >
                <CloudIcon />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Edit selected with AI"
                title="Edit with AI"
                data-guide="Edit with AI"
                onClick={bulkEditWithAi}
              >
                <AiEffectIcon />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Delete selected assets"
                title="Delete"
                data-guide="Delete"
                onClick={() => void bulkDelete()}
              >
                <TrashIcon />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Clear selection"
                title="Clear selection"
                data-guide="Clear"
                onClick={() => setSelectedAssetIds(new Set())}
              >
                <CloseIcon />
              </button>
            </div>
          )}
          {visible.length === 0 ? (
            <div className="asset-library-empty">
              {status?.includes('Failed to load media catalog') ? (
                // The status line is the shell's note now — do not print it twice.
                <p>Failed to load media catalog.</p>
              ) : (
                <>
                  <p>No media matches the current filters.</p>
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
            <>
              {viewMode === 'list' && (
                <div className="asset-list-header" aria-hidden={false}>
                  <label className="asset-card-tick">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      aria-label={allVisibleSelected ? 'Clear selection' : 'Select all visible'}
                      onChange={() => {
                        setSelectedAssetIds(() => {
                          if (allVisibleSelected) return new Set();
                          return new Set(visibleIds);
                        });
                      }}
                    />
                  </label>
                  <span className="asset-list-header-thumb" />
                  <span className="asset-list-header-name">Name</span>
                  <span className="asset-list-header-collection">Collection</span>
                  <span className="asset-list-header-size">Size</span>
                  <span className="asset-list-header-actions">Actions</span>
                </div>
              )}
              <ul className={`asset-grid asset-grid--${viewMode}`} aria-label="Assets">
                {rendered.map(({ asset, derivatives }) => {
                  const derivative = preferredDerivative(derivatives);
                  const avail =
                    derivative?.availability ??
                    (derivatives.length === 0 ? 'none' : derivatives[0]!.availability);
                  const cloudBacked = cloudAssetIds.has(asset.id);
                  const selected = selectedAssetIds.has(asset.id);
                  const assetCollection = assetCollectionLabel(assetCollectionId(asset));
                  const detailHint = [
                    asset.kind,
                    assetCollection,
                    asset.descriptor.mimeType,
                    formatBytes(asset.bytes),
                    cloudBacked ? 'Cloud original' : availabilityLabel(avail),
                  ].join(' · ');
                  return (
                    <li
                      key={asset.id}
                      className={`asset-card${selected ? ' is-selected' : ''}`}
                      draggable
                      title={`${asset.displayName} — ${detailHint}. Drag onto a timeline track`}
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
                      <label
                        className="asset-card-tick"
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          aria-label={`Select ${asset.displayName}`}
                          onChange={() => toggleSelected(asset.id)}
                        />
                      </label>
                      <div className="asset-card-media-wrap">
                        <AssetCardMedia
                          asset={asset}
                          derivatives={derivatives}
                          projectId={projectId}
                          resolverPromise={resolver}
                          originalCachePromise={originalAssetCache}
                          fetchCloudOriginal={fetchCloudOriginal}
                          {...(derivative !== undefined
                            ? { onOpenDerivative: () => void openPreview(asset, derivative) }
                            : {})}
                        />
                      </div>
                      <strong className="asset-card-name" title={asset.displayName}>
                        {asset.displayName}
                      </strong>
                      <span className="asset-card-collection" title={assetCollection}>
                        {assetCollection}
                      </span>
                      <span className="asset-card-meta">{formatBytes(asset.bytes)}</span>
                      <div className="asset-card-actions">
                        {(asset.kind === 'image' || asset.kind === 'video') && (
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Edit ${asset.displayName} with AI`}
                            title="Edit with AI"
                            data-guide="Edit with AI"
                            onClick={() => editWithAi(asset)}
                          >
                            <AiEffectIcon />
                          </button>
                        )}
                        {asset.kind === 'image' && !cloudBacked && (
                          <AssetShareCloudButton
                            asset={asset}
                            originalCachePromise={originalAssetCache}
                            onShare={() => void shareToCloud(asset)}
                          />
                        )}
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Delete ${asset.displayName}`}
                          title="Delete"
                          data-guide="Delete"
                          onClick={() => void deleteAsset(asset)}
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {rendered.length < visible.length && (
                <button
                  type="button"
                  className="asset-library-load-more"
                  onClick={() =>
                    setRenderLimit((current) =>
                      Math.min(visible.length, current + ASSET_RENDER_PAGE_SIZE),
                    )
                  }
                >
                  Load {Math.min(ASSET_RENDER_PAGE_SIZE, visible.length - rendered.length)} more
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </PanelShell>
  );
}

function availabilityLabel(status: AssetAvailability): string {
  switch (status) {
    case 'available-cloud':
      return 'Ready in private cloud storage';
    case 'available-local':
      return 'Available in local cache';
    case 'pending':
      return 'Derivative is processing';
    case 'evicted':
      return 'Local cache was cleared';
    case 'invalid':
      return 'Derivative needs repair';
    case 'none':
      return 'No derivative yet';
    default:
      return 'Unknown status';
  }
}

function AssetShareCloudButton({
  asset,
  originalCachePromise,
  onShare,
}: {
  readonly asset: BrowserAsset;
  readonly originalCachePromise: Promise<OpfsOriginalAssetCache>;
  readonly onShare: () => void;
}) {
  const [hasLocal, setHasLocal] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void originalCachePromise.then((cache) =>
      cache.get(asset.id).then((blob) => {
        if (!cancelled) setHasLocal(blob !== undefined);
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [asset.id, originalCachePromise]);
  if (!hasLocal) return null;
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={`Share ${asset.displayName} to cloud`}
      title="Share to cloud"
      data-guide="Share to cloud"
      onClick={onShare}
    >
      <CloudIcon />
    </button>
  );
}

function AssetCardMedia({
  asset,
  derivatives,
  projectId,
  resolverPromise,
  originalCachePromise,
  fetchCloudOriginal,
  onOpenDerivative,
}: {
  readonly asset: BrowserAsset;
  readonly derivatives: readonly BrowserDerivative[];
  readonly projectId: string;
  readonly resolverPromise: Promise<AuthorizedDerivativeResolver>;
  readonly originalCachePromise: Promise<OpfsOriginalAssetCache>;
  readonly fetchCloudOriginal: (assetId: string) => Promise<Blob>;
  readonly onOpenDerivative?: () => void;
}) {
  const mediaRef = useRef<HTMLButtonElement | null>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [mimeType, setMimeType] = useState<string | undefined>(undefined);
  const [source, setSource] = useState<AssetThumbSource>('none');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const element = mediaRef.current;
    if (element === null) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: '240px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!nearViewport) return;
    let cancelled = false;
    let revoke: () => void = () => undefined;
    setLoading(true);
    setUrl(undefined);
    setMimeType(undefined);
    setSource('none');
    void (async () => {
      const [resolver, originalCache] = await Promise.all([resolverPromise, originalCachePromise]);
      const result = await resolveAssetThumb({
        asset,
        derivatives,
        projectId,
        resolver,
        originalCache,
        fetchCloudOriginal,
      });
      if (cancelled) {
        result.revoke();
        return;
      }
      revoke = result.revoke;
      setUrl(result.url);
      setMimeType(result.mimeType);
      setSource(result.source);
      setLoading(false);
    })().catch(() => {
      if (!cancelled) {
        setUrl(undefined);
        setSource('none');
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
      revoke();
    };
  }, [
    asset,
    derivatives,
    projectId,
    resolverPromise,
    originalCachePromise,
    fetchCloudOriginal,
    nearViewport,
  ]);

  const interactive = onOpenDerivative !== undefined;
  return (
    <button
      ref={mediaRef}
      type="button"
      className={`asset-card-media asset-card-media--${asset.kind}${loading ? ' is-loading' : ''}`}
      aria-label={
        interactive
          ? `Preview ${asset.displayName}`
          : `${asset.kind} preview for ${asset.displayName}`
      }
      disabled={!interactive}
      onClick={() => onOpenDerivative?.()}
      data-source={source}
    >
      {url !== undefined && mimeType?.startsWith('video/') ? (
        <video src={url} muted playsInline preload="metadata" />
      ) : url !== undefined ? (
        <img src={url} alt="" loading="lazy" decoding="async" />
      ) : (
        <span className="asset-card-placeholder" aria-hidden>
          {asset.kind === 'video' ? '▶' : asset.kind === 'audio' ? '♪' : '▣'}
        </span>
      )}
    </button>
  );
}

function previewStatus(
  state: 'missing' | 'invalid' | 'unsupported' | 'unavailable' | 'revoked',
): string {
  switch (state) {
    case 'missing':
      return 'Local cache entry is missing and no cloud copy is available.';
    case 'invalid':
      return 'Local cache entry failed verification and was removed.';
    case 'unsupported':
      return 'This browser does not support local media storage via OPFS.';
    case 'revoked':
      return 'Your access to this private derivative was revoked.';
    case 'unavailable':
      return 'This private derivative is not available right now.';
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

const ASSET_VIEW_KEY = 'joy-media.asset-view.v1';

function readAssetViewMode(): AssetViewMode {
  try {
    const raw = localStorage.getItem(ASSET_VIEW_KEY);
    if (raw === 'large' || raw === 'medium' || raw === 'list') return raw;
  } catch {
    /* ignore */
  }
  return 'medium';
}

function writeAssetViewMode(mode: AssetViewMode): void {
  try {
    localStorage.setItem(ASSET_VIEW_KEY, mode);
  } catch {
    /* ignore */
  }
}

/** Stream a File into memory while reporting 0–1 read progress (falls back to arrayBuffer). */
async function readFileWithProgress(
  file: File,
  onProgress: (ratio: number) => void,
): Promise<ArrayBuffer> {
  if (typeof file.stream !== 'function' || file.size <= 0) {
    onProgress(1);
    return file.arrayBuffer();
  }
  const reader = file.stream().getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      chunks.push(value);
      received += value.byteLength;
      onProgress(Math.min(1, received / file.size));
    }
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress(1);
  return merged.buffer;
}
