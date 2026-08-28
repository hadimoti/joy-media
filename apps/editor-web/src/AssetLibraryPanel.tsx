import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AuthorizedDerivativeResolver } from './asset-resolver.js';
import {
  BrowserControlPlaneClient,
  type BrowserAsset,
  type BrowserDerivative,
} from './control-plane-client.js';
import { describeMedia, importMediaFile } from './media-import.js';
import { getStoredMediaToken, MEDIA_SESSION_CHANGED_EVENT } from './media-session.js';
import {
  assetCollectionId,
  assetCollectionLabel,
  assetCollectionsForCategory,
  ASSET_RENDER_PAGE_SIZE,
  filterAssetLibrary,
  includeOwnedAsset,
  importedAssetRevealState,
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
import { verifyOriginalRecoveryCandidate } from './asset-original-recovery.js';
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
import { loadEditorUiPreferences, saveEditorUiPreferences } from './ui-preferences.js';

type AssetSource = 'cloud' | 'user';

const categories: readonly {
  readonly id: AssetCategory;
  readonly label: string;
}[] = [
  { id: 'all', label: 'All' },
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
  onAddToTimeline,
  onEditWithAi,
}: {
  readonly projectId: string;
  readonly projectTitle?: string;
  readonly onAddSticker?: (asset: {
    readonly assetId: string;
    readonly displayName?: string;
    readonly blob?: Blob;
  }) => void;
  readonly onAddToTimeline?: (asset: {
    readonly assetId: string;
    readonly kind: 'image' | 'video' | 'audio';
    readonly displayName: string;
    readonly descriptor: BrowserAsset['descriptor'];
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
  const refreshSeqRef = useRef(0);
  const previewSeqRef = useRef(0);
  const initialUiPreferences = useRef(loadEditorUiPreferences(window.localStorage));
  const [items, setItems] = useState<readonly AssetLibraryItem[]>([]);
  const [cloudAssetIds, setCloudAssetIds] = useState<ReadonlySet<string>>(() => new Set());
  const [ownedAssetIds, setOwnedAssetIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedAssetIds, setSelectedAssetIds] = useState<ReadonlySet<string>>(() => new Set());
  const [category, setCategory] = useState<AssetCategory>(
    initialUiPreferences.current.assetLibrary.category,
  );
  const [collection, setCollection] = useState<AssetCollectionId>('browse');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [availability, setAvailability] = useState<AssetAvailability>('all');
  const [sort, setSort] = useState<AssetSort>('name');
  const [viewMode, setViewMode] = useState<AssetViewMode>(
    initialUiPreferences.current.assetLibrary.view,
  );
  const [renderLimit, setRenderLimit] = useState(ASSET_RENDER_PAGE_SIZE);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<Preview | undefined>(undefined);
  const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined);
  const [assetSource, setAssetSource] = useState<AssetSource>(
    initialUiPreferences.current.assetLibrary.source,
  );
  const [filterOpen, setFilterOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importProgress, setImportProgress] = useState<number | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const filterActive = availability !== 'all' || sort !== 'name';
  const canImport = selectedFile !== undefined && importProgress === undefined;

  useEffect(() => {
    const current = loadEditorUiPreferences(window.localStorage);
    saveEditorUiPreferences(window.localStorage, {
      ...current,
      assetLibrary: {
        ...current.assetLibrary,
        source: assetSource,
        category,
        view: viewMode,
        sort,
        collectionByCategory: {
          ...current.assetLibrary.collectionByCategory,
          [category]: collection,
        },
      },
    });
  }, [assetSource, category, collection, sort, viewMode]);

  const clearPreview = useCallback(() => {
    previewRef.current?.revoke();
    previewRef.current = undefined;
    setPreview(undefined);
  }, []);
  useEffect(() => () => previewRef.current?.revoke(), []);

  const refresh = useCallback(async () => {
    const requestId = ++refreshSeqRef.current;
    if (getStoredMediaToken(window.localStorage) === undefined) {
      // LoginGate keeps the editor mounted under the blur; don't wipe a prior
      // catalog or treat "not signed in yet" as a hard failure.
      return;
    }
    try {
      // Catalog listing must not create or reconcile a control-plane project.
      // My Media is the signed-in account library; importing still owns the
      // ensure-before-register transaction, so this remains read-only while
      // the active project binding is settling.
      const ownedResultPromise = client.myAssets();
      const [ownedResult, sharedResult] = await Promise.allSettled([
        ownedResultPromise,
        client.sharedCloudAssets(),
      ]);
      const ownedAssets =
        ownedResult.status === 'fulfilled' ? ownedResult.value : ([] as readonly BrowserAsset[]);
      const sharedAssets =
        sharedResult.status === 'fulfilled' ? sharedResult.value : ([] as readonly BrowserAsset[]);
      if (ownedResult.status === 'rejected' && sharedResult.status === 'rejected') {
        throw ownedResult.reason instanceof Error
          ? ownedResult.reason
          : new Error('Failed to load media catalog');
      }
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
      if (requestId !== refreshSeqRef.current) return;
      setCloudAssetIds(new Set(sharedAssets.map((asset) => asset.id)));
      setOwnedAssetIds(new Set(ownedAssets.map((asset) => asset.id)));
      // Render catalog metadata immediately. Derivatives only improve add-to-
      // timeline behavior and must not make the libraries appear empty while
      // their requests settle.
      setItems(assets.map((asset) => ({ asset, derivatives: [] })));
      if (sharedResult.status === 'rejected') {
        setStatus(
          `Cloud library unavailable (${message(sharedResult.reason)}). Showing ${assets.length} owned item(s).`,
        );
      } else {
        setStatus(undefined);
      }
      if (assets.length === 0) setImportOpen(true);

      void Promise.all(
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
      ).then((derivatives) => {
        if (requestId !== refreshSeqRef.current) return;
        const byAsset = new Map(derivatives);
        setItems((current) =>
          current.map((item) => ({
            ...item,
            derivatives: byAsset.get(item.asset.id) ?? item.derivatives,
          })),
        );
      });
    } catch (error) {
      if (requestId !== refreshSeqRef.current) return;
      const detail = message(error);
      setItems([]);
      setCloudAssetIds(new Set());
      setOwnedAssetIds(new Set());
      setStatus(`Failed to load media catalog: ${detail}`);
    }
  }, [client, projectId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const onSession = (): void => {
      void refresh();
    };
    window.addEventListener(MEDIA_SESSION_CHANGED_EVENT, onSession);
    return () => window.removeEventListener(MEDIA_SESSION_CHANGED_EVENT, onSession);
  }, [refresh]);
  useEffect(() => {
    return () => {
      refreshSeqRef.current += 1;
      previewSeqRef.current += 1;
      previewRef.current?.revoke();
      previewRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (!filterOpen && !importOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = toolbarRef.current;
      if (root === null || root.contains(event.target as Node)) return;
      setFilterOpen(false);
      if (selectedFile === undefined) setImportOpen(false);
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
  }, [filterOpen, importOpen, selectedFile]);

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

  const sourceItems = useMemo(
    () =>
      items.filter(({ asset }) =>
        assetSource === 'cloud' ? cloudAssetIds.has(asset.id) : ownedAssetIds.has(asset.id),
      ),
    [assetSource, cloudAssetIds, items, ownedAssetIds],
  );
  const collections = useMemo(
    () => assetCollectionsForCategory(sourceItems, category),
    [sourceItems, category],
  );
  useEffect(() => {
    if (collections.some((entry) => entry.id === collection)) return;
    setCollection('browse');
  }, [collection, collections]);
  const visible = useMemo(
    () => filterAssetLibrary(sourceItems, category, collection, deferredQuery, availability, sort),
    [sourceItems, category, collection, deferredQuery, availability, sort],
  );
  useEffect(() => {
    setRenderLimit(ASSET_RENDER_PAGE_SIZE);
  }, [sourceItems, category, collection, deferredQuery, availability, sort]);
  useEffect(() => {
    setSelectedAssetIds(new Set());
  }, [assetSource]);
  const rendered = useMemo(() => visible.slice(0, renderLimit), [visible, renderLimit]);
  const registerSelectedAsset = useCallback(async () => {
    if (selectedFile === undefined) {
      setStatus('Choose a media file to register.');
      return;
    }
    try {
      const imported = await importMediaFile({
        projectId,
        projectTitle,
        file: selectedFile,
        client,
        originalAssetCache,
        onProgress: ({ ratio, message: progressMessage }) => {
          setImportProgress(ratio);
          setStatus(progressMessage);
        },
      });
      setItems((current) => includeOwnedAsset(current, new Set(), imported).items);
      setOwnedAssetIds((current) => includeOwnedAsset([], current, imported).ownedAssetIds);
      const reveal = importedAssetRevealState(imported);
      setAssetSource(reveal.assetSource);
      setCategory(reveal.category);
      setCollection(reveal.collection);
      setQuery(reveal.query);
      setAvailability(reveal.availability);
      setSort(reveal.sort);
      setRenderLimit(reveal.renderLimit);
      setStatus(
        `${selectedFile.name} backed up to the cloud. Agent tags applied; catalog refreshing.`,
      );
      setImportProgress(1);
      setSelectedFile(undefined);
      if (fileInputRef.current !== null) fileInputRef.current.value = '';
      setImportOpen(false);
      await refresh();
      window.setTimeout(() => setImportProgress(undefined), 350);
    } catch (error) {
      setImportProgress(undefined);
      setStatus(`Failed to register media: ${message(error)}`);
    }
  }, [client, originalAssetCache, projectId, projectTitle, refresh, selectedFile]);
  const fetchCloudOriginal = useCallback(
    (id: string) => {
      const asset = items.find((candidate) => candidate.asset.id === id)?.asset;
      if (asset === undefined)
        return Promise.reject(new Error('The catalog asset is no longer listed.'));
      if (!asset.cloudBacked)
        return Promise.reject(new Error('This asset has no cloud original yet.'));
      // My Media entries can belong to any project under this owner. They must
      // use their owning project endpoint; the shared-library endpoint is only
      // for a curated cloud entry and otherwise replies with a noisy 409.
      if (!cloudAssetIds.has(id)) return client.originalBytes(asset.projectId || projectId, id);
      return cloudPreviewQueue.load(id, () => client.sharedCloudOriginalBytes(id));
    },
    [client, cloudAssetIds, cloudPreviewQueue, items, projectId],
  );
  const addAssetToTimeline = useCallback(
    async (asset: {
      readonly assetId: string;
      readonly kind: 'image' | 'video' | 'audio';
      readonly displayName: string;
      readonly descriptor: BrowserAsset['descriptor'];
    }) => {
      try {
        let descriptor = asset.descriptor;
        if (
          (asset.kind === 'video' || asset.kind === 'audio') &&
          descriptor.durationUs === undefined
        ) {
          setStatus(`Reading ${asset.displayName} duration…`);
          try {
            const cache = await originalAssetCache;
            let blob = await cache.get(asset.assetId);
            if (blob === undefined) {
              try {
                blob = await client.originalBytes(projectId, asset.assetId);
              } catch {
                blob = await client.sharedCloudOriginalBytes(asset.assetId);
              }
            }
            const file = new File([blob], asset.displayName, { type: descriptor.mimeType });
            descriptor = await describeMedia(file, asset.kind, descriptor.mimeType);
          } catch {
            setStatus(
              `Could not read ${asset.displayName} duration; using the default timeline segment.`,
            );
          }
        }
        const catalogAsset = items.find((candidate) => candidate.asset.id === asset.assetId)?.asset;
        let scopedAsset = asset;
        if (catalogAsset !== undefined && catalogAsset.projectId !== projectId) {
          setStatus(`Preparing ${asset.displayName} for this project…`);
          const associated = await client.associateAsset(projectId, catalogAsset.id);
          scopedAsset = {
            ...asset,
            assetId: associated.id,
            kind: associated.kind,
            displayName: associated.displayName,
            descriptor: associated.descriptor,
          };
        }
        onAddToTimeline?.({ ...scopedAsset, descriptor });
      } catch (error) {
        setStatus(`Could not add ${asset.displayName} to this project: ${message(error)}`);
      }
    },
    [client, items, onAddToTimeline, originalAssetCache, projectId],
  );

  const openPreview = useCallback(
    async (asset: BrowserAsset, assetDerivatives: readonly BrowserDerivative[]) => {
      const requestId = ++previewSeqRef.current;
      clearPreview();
      const sourceKind =
        asset.kind === 'video' ? 'video' : asset.kind === 'audio' ? 'audio' : 'image';
      setStatus(`Opening ${sourceKind} (verified)…`);
      try {
        const [resolverInstance, originalCache] = await Promise.all([resolver, originalAssetCache]);
        const outcome = await resolveAssetThumb({
          asset,
          derivatives: assetDerivatives,
          projectId,
          resolver: resolverInstance,
          originalCache,
          fetchCloudOriginal,
        });
        if (requestId !== previewSeqRef.current) {
          outcome.revoke();
          return;
        }
        if (outcome.url === undefined) {
          setStatus(`Preview unavailable: ${outcome.source}`);
          return;
        }
        const nextPreview: Preview = {
          derivativeId: asset.id,
          displayName: asset.displayName,
          mimeType: outcome.mimeType ?? asset.descriptor.mimeType,
          url: outcome.url,
          revoke: outcome.revoke,
        };
        previewRef.current = nextPreview;
        setPreview(nextPreview);
        setStatus(
          outcome.source === 'derivative'
            ? `Preview for ${asset.displayName} is shown from this browser’s verified local cache.`
            : outcome.source === 'cloud'
              ? `Preview for ${asset.displayName} is shown from the shared cloud library.`
              : `Preview for ${asset.displayName} is shown from this browser’s local copy.`,
        );
      } catch (error) {
        if (requestId !== previewSeqRef.current) return;
        setStatus(`Failed to open preview: ${message(error)}`);
      }
    },
    [clearPreview, fetchCloudOriginal, originalAssetCache, projectId, resolver],
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
      if (asset.cloudBacked) {
        setStatus(`${asset.displayName} is already backed up to private cloud storage.`);
        return;
      }
      try {
        const blob = await (await originalAssetCache).get(asset.id);
        if (blob === undefined) {
          setStatus(
            'The OPFS original is missing in this browser. Re-import the media here first.',
          );
          return;
        }
        setStatus(`Uploading ${asset.displayName} to private cloud storage…`);
        await client.uploadAssetOriginal(asset.projectId || projectId, asset, blob);
        await refresh();
        setStatus(`${asset.displayName} backed up to private cloud storage.`);
      } catch (error) {
        setStatus(`Cloud backup failed: ${message(error)}`);
      }
    },
    [client, originalAssetCache, projectId, refresh],
  );

  const recoverOriginal = useCallback(
    async (asset: BrowserAsset, file: File) => {
      if (asset.cloudBacked || asset.kind !== 'video' || !ownedAssetIds.has(asset.id)) return;
      try {
        setStatus(`Verifying ${asset.displayName} before recovery…`);
        await verifyOriginalRecoveryCandidate(asset, file);
        setStatus(`Uploading the verified original for ${asset.displayName}…`);
        await client.uploadAssetOriginal(asset.projectId || projectId, asset, file);
        await refresh();
        setStatus(`${asset.displayName} is backed up to private cloud storage.`);
      } catch (error) {
        setStatus(`Original recovery stopped: ${message(error)}`);
      }
    },
    [client, ownedAssetIds, projectId, refresh],
  );

  const deleteAsset = useCallback(
    async (asset: BrowserAsset) => {
      const ok = window.confirm(`Delete “${asset.displayName}” from the catalog?`);
      if (!ok) return;
      try {
        const deleted = await client.deleteAsset(asset.projectId || projectId, asset.id);
        setSelectedAssetIds((current) => {
          if (!current.has(asset.id)) return current;
          const next = new Set(current);
          next.delete(asset.id);
          return next;
        });
        await refresh();
        setStatus(
          deleted.cloudObjectPurgeFailures === 0
            ? `${asset.displayName} deleted.`
            : `${asset.displayName} deleted; cloud cleanup will need an operational retry.`,
        );
      } catch (error) {
        setStatus(`Failed to delete media: ${message(error)}`);
      }
    },
    [client, projectId, refresh],
  );

  const bulkShare = useCallback(async () => {
    const targets = visible.filter(
      ({ asset }) => selectedAssetIds.has(asset.id) && !asset.cloudBacked,
    );
    if (targets.length === 0) {
      setStatus('No selected media needs backup; an OPFS original is required.');
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
    await refresh();
    setStatus(`Backed up ${shared} of ${targets.length} selected media item(s) to the cloud.`);
  }, [client, originalAssetCache, projectId, refresh, selectedAssetIds, visible]);

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
    let cloudObjectPurgeFailures = 0;
    for (const { asset } of targets) {
      try {
        const result = await client.deleteAsset(asset.projectId || projectId, asset.id);
        deleted += 1;
        cloudObjectPurgeFailures += result.cloudObjectPurgeFailures;
      } catch {
        /* continue remaining */
      }
    }
    setSelectedAssetIds(new Set());
    await refresh();
    setStatus(
      `Deleted ${deleted} of ${targets.length} selected media items.${
        cloudObjectPurgeFailures > 0 ? ' Some cloud objects need an operational cleanup retry.' : ''
      }`,
    );
  }, [client, projectId, refresh, selectedAssetIds, visible]);

  const visibleIds = useMemo(() => rendered.map(({ asset }) => asset.id), [rendered]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedAssetIds.has(id));
  const selectedCount = selectedAssetIds.size;

  // The top level is intentionally media-specific. Collections below it are
  // driven by category-* tags, so future videos and audio inherit the same UI.
  const categoryTabs: readonly PanelTabSpec[] = categories.map((entry) => {
    const count =
      entry.id === 'all'
        ? sourceItems.length
        : sourceItems.filter(({ asset }) => asset.kind === entry.id).length;
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
          <div className="asset-source-switch" role="group" aria-label="Asset source">
            <button
              type="button"
              aria-pressed={assetSource === 'user'}
              aria-label="My media — Showing user assets; switch to cloud bucket assets"
              onClick={() => setAssetSource('user')}
            >
              My media
            </button>
            <button
              type="button"
              aria-pressed={assetSource === 'cloud'}
              aria-label="Cloud library — Showing cloud assets; switch to user assets"
              onClick={() => setAssetSource('cloud')}
            >
              Cloud library
            </button>
          </div>
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
            {filterActive && <span className="asset-filter-count">1</span>}
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
                The file is verified, stored in this browser, and backed up to private cloud
                storage. JOY generates the opaque asset ID automatically.
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
                  aria-hidden="true"
                  tabIndex={-1}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Choose media"
                  title="Choose media"
                  disabled={importProgress !== undefined}
                  data-active={selectedFile !== undefined ? 'true' : undefined}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PlusIcon />
                </button>
                <span className="asset-import-file" title={selectedFile?.name}>
                  {selectedFile?.name ?? 'Choose file'}
                </span>
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
          {filterActive && (
            <div className="asset-filter-summary" aria-label="Active asset filters">
              <span>Active filters</span>
              {availability !== 'all' && <span className="asset-filter-chip">{availability}</span>}
              {sort !== 'name' && <span className="asset-filter-chip">Sort: {sort}</span>}
              <button
                type="button"
                className="asset-filter-summary-clear"
                onClick={() => {
                  setAvailability('all');
                  setSort('name');
                }}
              >
                Clear all
              </button>
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
                aria-label="Share selected media to cloud"
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
                  <p>
                    {assetSource === 'cloud'
                      ? 'No cloud assets match the current filters.'
                      : 'No user assets match the current filters.'}
                  </p>
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
                  const cloudBacked = asset.cloudBacked;
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
                      data-asset-id={asset.id}
                      className={`asset-card${selected ? ' is-selected' : ''}`}
                      draggable
                      title={`${asset.displayName} — ${detailHint}. Drag onto a timeline track`}
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest('button, input, label') !== null)
                          return;
                        if (
                          asset.kind === 'image' ||
                          asset.kind === 'video' ||
                          asset.kind === 'audio'
                        ) {
                          void openPreview(asset, derivatives);
                        }
                      }}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(
                          JOY_MEDIA_ASSET_DND,
                          JSON.stringify({
                            assetId: asset.id,
                            kind: asset.kind,
                            displayName: asset.displayName,
                            descriptor: asset.descriptor,
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
                          {...(asset.kind === 'image' ||
                          asset.kind === 'video' ||
                          asset.kind === 'audio'
                            ? { onOpenDerivative: () => void openPreview(asset, derivatives) }
                            : {})}
                        />
                      </div>
                      <strong className="asset-card-name" title={asset.displayName}>
                        {asset.displayName}
                      </strong>
                      <span className="asset-card-collection" title={assetCollection}>
                        {assetCollection}
                      </span>
                      <span className="asset-card-meta">
                        {formatBytes(asset.bytes)}
                        {asset.descriptor.animation !== undefined ? ' · Animated' : ''}
                      </span>
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
                        {!cloudBacked && (
                          <AssetShareCloudButton
                            asset={asset}
                            originalCachePromise={originalAssetCache}
                            onShare={() => void shareToCloud(asset)}
                          />
                        )}
                        {onAddToTimeline !== undefined && (
                          <button
                            type="button"
                            className="icon-button asset-card-add"
                            aria-label={`Add ${asset.displayName} to timeline`}
                            title="Add to timeline"
                            data-guide="Add to timeline"
                            onClick={(event) => {
                              event.stopPropagation();
                              addAssetToTimeline({
                                assetId: asset.id,
                                kind: asset.kind,
                                displayName: asset.displayName,
                                descriptor: asset.descriptor,
                              });
                            }}
                          >
                            <PlusIcon />
                          </button>
                        )}
                        {assetSource === 'user' &&
                          !cloudBacked &&
                          asset.kind === 'video' &&
                          ownedAssetIds.has(asset.id) && (
                            <AssetLocateOriginalButton
                              asset={asset}
                              originalCachePromise={originalAssetCache}
                              onRecover={(file) => void recoverOriginal(asset, file)}
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

function AssetLocateOriginalButton({
  asset,
  originalCachePromise,
  onRecover,
}: {
  readonly asset: BrowserAsset;
  readonly originalCachePromise: Promise<OpfsOriginalAssetCache>;
  readonly onRecover: (file: File) => void;
}) {
  const [hasLocal, setHasLocal] = useState(true);
  const inputRef = useRef<HTMLInputElement | null>(null);
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
  if (hasLocal) return null;
  return (
    <>
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        accept="video/*"
        aria-label={`Locate original for ${asset.displayName}`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) onRecover(file);
        }}
      />
      <button
        type="button"
        className="icon-button"
        aria-label={`Locate original for ${asset.displayName}`}
        title="Locate original"
        onClick={() => inputRef.current?.click()}
      >
        <UploadIcon />
      </button>
    </>
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
      ) : url !== undefined && mimeType?.startsWith('image/') ? (
        <img src={url} alt="" loading="lazy" decoding="async" />
      ) : (
        <span className="asset-card-placeholder" aria-hidden>
          {asset.kind === 'video' ? '▶' : asset.kind === 'audio' ? '♪' : '▣'}
        </span>
      )}
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ASSET_VIEW_KEY = 'joy-media.asset-view.v1';

function writeAssetViewMode(mode: AssetViewMode): void {
  try {
    localStorage.setItem(ASSET_VIEW_KEY, mode);
  } catch {
    /* ignore */
  }
}
