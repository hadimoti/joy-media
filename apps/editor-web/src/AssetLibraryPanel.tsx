import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactStore, ArtifactTransaction } from '@joy-media/commands';
import type {
  MediaSemanticIndexEvidence,
  VideoReferenceAnalyzeReceipt,
} from '@joy-media/job-protocol';
import type {
  SemanticBrollAssetV1,
  SemanticBrollSearchIndexV1,
  SemanticBrollTimeRangeV1,
} from '@joy-media/project-schema';
import type { BrollSearchResult } from '@joy-media/agent-tools';
import { AuthorizedDerivativeResolver } from './asset-resolver.js';
import {
  type BrowserAsset,
  type BrowserAssetRegistration,
  type BrowserDerivative,
  type BrowserJob,
} from './control-plane-client.js';
import { createDeferredControlPlaneClient } from './deferred-control-plane-client.js';
import { getStoredMediaToken, MEDIA_SESSION_CHANGED_EVENT } from './media-session.js';
import {
  assetCollectionId,
  assetCollectionLabel,
  assetLibraryPageCount,
  assetCollectionsForCategory,
  filterAssetLibrary,
  preferredDerivative,
  ASSET_RENDER_MAX,
  ASSET_RENDER_PAGE_SIZE,
  nextAssetRenderLimit,
  renderAssetLibraryItems,
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
import {
  buildPersistReferenceAnalysisTransaction,
  buildReferenceMarkerTransaction,
  parseReferenceAnalysisArtifact,
  referenceAnalysisArtifactId,
  referenceAnalysisReceiptFromDerivative,
  referenceStatusForAsset,
} from './reference-analysis-model.js';
import { useAccessibleDialog } from './dialog-a11y.js';
import {
  importAssetLocallyByDefault,
  readAuthoritativeAssetSync,
  type LocalFirstAssetImportResult,
} from './asset-import-privacy.js';

const categories: readonly {
  readonly id: AssetCategory;
  readonly label: string;
}[] = [
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'model', label: '3D Models' },
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
  onAddSticker,
  onEditWithAi,
  artifacts,
  onDispatchArtifacts,
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
  readonly artifacts?: ArtifactStore;
  readonly onDispatchArtifacts?: (transaction: ArtifactTransaction) => void;
}) {
  const client = useMemo(() => createDeferredControlPlaneClient(), []);
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
  const [items, setItems] = useState<readonly AssetLibraryItem[]>([]);
  const [jobs, setJobs] = useState<readonly BrowserJob[]>([]);
  const [cloudAssetIds, setCloudAssetIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedAssetIds, setSelectedAssetIds] = useState<ReadonlySet<string>>(() => new Set());
  const [category, setCategory] = useState<AssetCategory>('image');
  const [collection, setCollection] = useState<AssetCollectionId>('browse');
  const [query, setQuery] = useState('');
  const [brollQuery, setBrollQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const deferredBrollQuery = useDeferredValue(brollQuery);
  const [availability, setAvailability] = useState<AssetAvailability>('all');
  const [sort, setSort] = useState<AssetSort>('name');
  const [viewMode, setViewMode] = useState<AssetViewMode>(() => readAssetViewMode());
  const [renderLimit, setRenderLimit] = useState(ASSET_RENDER_PAGE_SIZE);
  const [renderPage, setRenderPage] = useState(0);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<Preview | undefined>(undefined);
  const [assetId, setAssetId] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined);
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importProgress, setImportProgress] = useState<number | undefined>(undefined);
  const [openReferenceAnalysisAssetId, setOpenReferenceAnalysisAssetId] = useState<
    string | undefined
  >(undefined);
  const [brollSearchView, setBrollSearchView] = useState<
    | {
        readonly rangeCount: number;
        readonly results: readonly BrollSearchResult[];
      }
    | undefined
  >(undefined);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const importDialogRef = useRef<HTMLDivElement | null>(null);
  const filterDialogRef = useRef<HTMLDivElement | null>(null);
  const filterActive = availability !== 'all' || sort !== 'name';
  const canImport =
    selectedFile !== undefined && assetId.trim().length > 0 && importProgress === undefined;

  useAccessibleDialog({
    open: importOpen,
    containerRef: importDialogRef,
    onClose: () => setImportOpen(false),
    initialFocusSelector:
      'button[aria-label="Choose media file"]:not([disabled]), button[aria-label="Close import"]',
  });
  useAccessibleDialog({
    open: filterOpen,
    containerRef: filterDialogRef,
    onClose: () => setFilterOpen(false),
    initialFocusSelector: 'select, button:not([disabled])',
  });

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
      setSyncEnabled(false);
      return;
    }
    try {
      // Catalog listing remains independent from project binding, while the
      // sync toggle is refreshed from the authoritative project response.
      const [projectResult, ownedResult, sharedResult, jobsResult] = await Promise.allSettled([
        client.ensureProject(projectId, projectTitle),
        client.myAssets(),
        client.sharedCloudAssets(),
        client.jobs(projectId),
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
      if (requestId !== refreshSeqRef.current) return;
      setSyncEnabled(
        projectResult.status === 'fulfilled' ? projectResult.value.assetSyncEnabled : false,
      );
      setCloudAssetIds(new Set(sharedAssets.map((asset) => asset.id)));
      setItems(assets.map((asset) => ({ asset, derivatives: byAsset.get(asset.id) ?? [] })));
      setJobs(jobsResult.status === 'fulfilled' ? jobsResult.value : []);
      if (projectResult.status === 'rejected') {
        setStatus(
          'Assets loaded. Private backup status could not be verified, so uploads are disabled.',
        );
      } else if (sharedResult.status === 'rejected') {
        setStatus(
          `Private cloud library is unavailable (${message(sharedResult.reason)}). Showing ${assets.length} locally registered assets.`,
        );
      } else {
        setStatus(
          assets.length === 0
            ? 'No media yet. Imports stay in this browser unless private backup is enabled.'
            : undefined,
        );
      }
      if (assets.length === 0) setImportOpen(true);
    } catch (error) {
      if (requestId !== refreshSeqRef.current) return;
      const detail = message(error);
      setSyncEnabled(false);
      setItems([]);
      setStatus(`Could not load the media catalog: ${detail}`);
    }
  }, [client, projectId, projectTitle]);
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
    const activeReferenceJob = jobs.some(
      (job) =>
        job.type === 'video.reference-analyze' &&
        (job.state === 'queued' || job.state === 'leased'),
    );
    if (!activeReferenceJob) return;
    const timeout = window.setTimeout(() => void refresh(), 1_500);
    return () => window.clearTimeout(timeout);
  }, [jobs, refresh]);

  useEffect(() => {
    if (artifacts === undefined || onDispatchArtifacts === undefined) return;
    for (const job of jobs) {
      if (
        job.type !== 'video.reference-analyze' ||
        job.state !== 'completed' ||
        job.assetId === undefined ||
        job.derivative?.kind !== 'video.reference-analyze'
      ) {
        continue;
      }
      const receipt = referenceAnalysisReceiptFromDerivative(job.derivative);
      if (receipt === undefined) continue;
      const asset = items.find((entry) => entry.asset.id === job.assetId)?.asset;
      if (asset === undefined) continue;
      const existing = parseReferenceAnalysisArtifact(
        artifacts.artifacts[referenceAnalysisArtifactId(asset.id)],
      );
      if (existing?.jobId === job.id) continue;
      try {
        onDispatchArtifacts(
          buildPersistReferenceAnalysisTransaction({
            asset,
            receipt,
            jobId: job.id,
            now: new Date().toISOString(),
            store: artifacts,
          }),
        );
      } catch (error) {
        setStatus(`Could not save the Reference analysis: ${message(error)}`);
      }
    }
  }, [artifacts, items, jobs, onDispatchArtifacts]);

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
        setStatus('AI editing is supported for images and video only.');
        return;
      }
      if (onEditWithAi === undefined) {
        setStatus('Media handoff to Joy Code is unavailable in this session.');
        return;
      }
      onEditWithAi({
        assetId: asset.id,
        kind: asset.kind,
        displayName: asset.displayName,
      });
      setStatus(
        `${asset.displayName} is ready for Joy Code. Drag it to the timeline or use an approved action.`,
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
  const referenceAnalysisView = useMemo(() => {
    if (artifacts === undefined || openReferenceAnalysisAssetId === undefined) return undefined;
    const asset = items.find((entry) => entry.asset.id === openReferenceAnalysisAssetId)?.asset;
    const analysis = parseReferenceAnalysisArtifact(
      artifacts.artifacts[referenceAnalysisArtifactId(openReferenceAnalysisAssetId)],
    );
    return asset === undefined || analysis === undefined ? undefined : { asset, analysis };
  }, [artifacts, items, openReferenceAnalysisAssetId]);
  useEffect(() => {
    if (artifacts === undefined) {
      setBrollSearchView(undefined);
      return;
    }
    let active = true;
    const index = buildPanelSemanticBrollIndex(projectId, items, artifacts);
    const normalizedQuery = deferredBrollQuery.trim();
    const rangeCount = index.assets.reduce((count, asset) => count + asset.ranges.length, 0);
    if (normalizedQuery.length === 0) {
      setBrollSearchView({ rangeCount, results: [] });
      return;
    }
    setBrollSearchView({ rangeCount, results: [] });
    void import('@joy-media/agent-tools')
      .then(({ searchBroll }) => searchBroll(index, { query: normalizedQuery, maxResults: 6 }))
      .then((result) => {
        if (active) setBrollSearchView({ rangeCount, results: [...result.results] });
      })
      .catch(() => {
        if (active) setBrollSearchView({ rangeCount, results: [] });
      });
    return () => {
      active = false;
    };
  }, [artifacts, deferredBrollQuery, items, projectId]);
  useEffect(() => {
    setRenderLimit(ASSET_RENDER_PAGE_SIZE);
    setRenderPage(0);
  }, [items, category, collection, deferredQuery, availability, sort]);
  const rendered = useMemo(
    () => renderAssetLibraryItems(visible, renderLimit, renderPage),
    [visible, renderLimit, renderPage],
  );
  const pageCount = assetLibraryPageCount(visible.length);
  const pageStart = renderPage * ASSET_RENDER_MAX;
  const pageItems = Math.min(ASSET_RENDER_MAX, Math.max(0, visible.length - pageStart));
  const registerSelectedAsset = useCallback(async () => {
    if (selectedFile === undefined) {
      setStatus('Choose a media file to import.');
      return;
    }
    const normalizedId = assetId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalizedId)) {
      setStatus('Asset ID may contain only letters, numbers, dots, underscores, or hyphens.');
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
      const imported = await importAssetLocallyByDefault({
        client,
        cache: await originalAssetCache,
        projectId,
        registration,
        file: selectedFile,
        onAuthoritativeSyncState: setSyncEnabled,
        onStage: (stage) => {
          if (stage === 'cache-local') {
            setImportProgress(0.62);
            setStatus(`Saving ${selectedFile.name} in this browser…`);
          } else if (stage === 'register') {
            setImportProgress(0.88);
            setStatus(`Registering ${selectedFile.name}…`);
          } else if (stage === 'check-sync') {
            setImportProgress(0.9);
            setStatus('Checking this project’s private backup setting…');
          } else {
            setImportProgress(0.92);
            setStatus(`Backing up ${selectedFile.name} privately…`);
          }
        },
        onUploadProgress: (ratio) => setImportProgress(0.92 + 0.06 * ratio),
      });
      const operationStatus = assetImportOperationStatus(selectedFile.name, kind, imported);
      setImportProgress(1);
      setSelectedFile(undefined);
      setAssetId('');
      if (fileInputRef.current !== null) fileInputRef.current.value = '';
      setImportOpen(false);
      await refreshCatalogThenReport(refresh, setStatus, operationStatus);
      window.setTimeout(() => setImportProgress(undefined), 350);
    } catch (error) {
      setImportProgress(undefined);
      setStatus(`Media import failed: ${message(error)}`);
    }
  }, [assetId, client, originalAssetCache, projectId, refresh, selectedFile]);
  const enableSync = useCallback(async () => {
    try {
      const result = await client.setAssetSync(projectId, true);
      setSyncEnabled(result.assetSyncEnabled);
      setStatus(
        'Private backup is enabled. New image imports can now be backed up after verification.',
      );
    } catch (error) {
      setSyncEnabled(false);
      setStatus(`Could not enable private backup: ${message(error)}`);
    }
  }, [client, projectId]);
  const fetchCloudOriginal = useCallback(
    (id: string) => cloudPreviewQueue.load(id, () => client.sharedCloudOriginalBytes(id)),
    [client, cloudPreviewQueue],
  );

  const openPreview = useCallback(
    async (asset: BrowserAsset, assetDerivatives: readonly BrowserDerivative[]) => {
      const requestId = ++previewSeqRef.current;
      clearPreview();
      const sourceKind =
        asset.kind === 'video'
          ? 'video'
          : asset.kind === 'audio'
            ? 'audio'
            : asset.kind === 'model'
              ? '3D model'
              : 'image';
      setStatus(`Opening verified ${sourceKind} preview…`);
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
          setStatus(`Preview is unavailable: ${outcome.source}`);
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
            ? `Previewing ${asset.displayName} from this browser’s verified local cache.`
            : outcome.source === 'cloud'
              ? `Previewing ${asset.displayName} from private backup storage.`
              : `Previewing ${asset.displayName} from this browser’s local original.`,
        );
      } catch (error) {
        if (requestId !== previewSeqRef.current) return;
        setStatus(`Could not open the preview: ${message(error)}`);
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

  const verifyPrivateBackup = useCallback(
    async (targetProjectId: string): Promise<boolean> => {
      const enabled = await readAuthoritativeAssetSync(client, targetProjectId);
      if (targetProjectId === projectId) setSyncEnabled(enabled);
      return enabled;
    },
    [client, projectId],
  );

  const shareToCloud = useCallback(
    async (asset: BrowserAsset) => {
      if (asset.kind !== 'image') {
        setStatus('Private backup is available for images only in v1.');
        return;
      }
      if (cloudAssetIds.has(asset.id)) {
        setStatus(`${asset.displayName} is already backed up privately.`);
        return;
      }
      const targetProjectId = asset.projectId || projectId;
      try {
        if (!(await verifyPrivateBackup(targetProjectId))) {
          setStatus('Enable private backup before sharing an image. No upload was attempted.');
          return;
        }
      } catch (error) {
        if (targetProjectId === projectId) setSyncEnabled(false);
        setStatus(
          `Backup status could not be verified. No upload was attempted: ${message(error)}`,
        );
        return;
      }
      try {
        const blob = await (await originalAssetCache).get(asset.id);
        if (blob === undefined) {
          setStatus('The local original is missing. Re-import this image in the current browser.');
          return;
        }
        setStatus(`Backing up ${asset.displayName} privately…`);
        await client.uploadAssetOriginal(targetProjectId, asset, blob);
        await refreshCatalogThenReport(
          refresh,
          setStatus,
          `${asset.displayName} was backed up privately.`,
        );
      } catch (error) {
        setStatus(`Private backup failed: ${message(error)}`);
      }
    },
    [client, cloudAssetIds, originalAssetCache, projectId, refresh, verifyPrivateBackup],
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
        setStatus(`${asset.displayName} was removed from the catalog.`);
        await refresh();
      } catch (error) {
        setStatus(`Could not remove the media: ${message(error)}`);
      }
    },
    [client, projectId, refresh],
  );

  const addSticker = useCallback(
    async (asset: BrowserAsset) => {
      const added = await addAssetAsSticker({
        asset,
        ...(onAddSticker === undefined ? {} : { onAddSticker }),
        loadOriginalBlob: async () => (await originalAssetCache).get(asset.id),
      });
      if (added) {
        setStatus(`${asset.displayName} was added as a sticker.`);
      }
    },
    [onAddSticker, originalAssetCache],
  );
  const markAsReference = useCallback(
    (asset: BrowserAsset) => {
      if (asset.kind !== 'video') {
        setStatus('Only video assets can be marked as a Reference.');
        return;
      }
      if (onDispatchArtifacts === undefined) {
        setStatus('Reference artifacts are unavailable in this session.');
        return;
      }
      try {
        onDispatchArtifacts(buildReferenceMarkerTransaction(asset, new Date().toISOString()));
        setStatus(`${asset.displayName} is marked as a Reference source.`);
      } catch (error) {
        setStatus(`Could not mark the Reference source: ${message(error)}`);
      }
    },
    [onDispatchArtifacts],
  );

  const runReferenceAnalysis = useCallback(
    async (asset: BrowserAsset) => {
      if (asset.kind !== 'video') {
        setStatus('Reference analysis is supported for video assets only.');
        return;
      }
      if (artifacts === undefined || onDispatchArtifacts === undefined) {
        setStatus('Reference analysis needs a durable artifact in this session.');
        return;
      }
      const referenceState = referenceStatusForAsset({ asset, store: artifacts, jobs });
      if (!referenceState.marked) {
        setStatus('Mark this video as a Reference before starting analysis.');
        return;
      }
      if (referenceState.running) {
        setStatus(`Analysis for ${asset.displayName} is already running.`);
        return;
      }
      const jobId = `reference-${asset.id}-${Date.now().toString(36)}`;
      try {
        await client.enqueueReferenceAnalysis(projectId, jobId, {
          assetId: asset.id,
          maxDurationUs: 15 * 60 * 1_000_000,
          maxBytes: 256 * 1_024 * 1_024,
          sampleCount: 3,
          maxAudioBeats: 6,
        });
        setStatus(`Reference analysis for ${asset.displayName} is queued.`);
        await refresh();
      } catch (error) {
        setStatus(`Could not queue Reference analysis: ${message(error)}`);
      }
    },
    [artifacts, client, jobs, onDispatchArtifacts, projectId, refresh],
  );

  const bulkShare = useCallback(async () => {
    if (!syncEnabled) {
      setStatus('Enable private backup before sharing selected images.');
      return;
    }
    const targets = visible.filter(
      ({ asset }) =>
        selectedAssetIds.has(asset.id) && asset.kind === 'image' && !cloudAssetIds.has(asset.id),
    );
    if (targets.length === 0) {
      setStatus('No selected image has a local original ready for private backup.');
      return;
    }
    let shared = 0;
    let blocked = 0;
    for (const { asset } of targets) {
      try {
        const targetProjectId = asset.projectId || projectId;
        if (!(await verifyPrivateBackup(targetProjectId))) {
          blocked += 1;
          continue;
        }
        const blob = await (await originalAssetCache).get(asset.id);
        if (blob === undefined) continue;
        await client.uploadAssetOriginal(targetProjectId, asset, blob);
        shared += 1;
      } catch {
        blocked += 1;
      }
    }
    const operationStatus = privateBackupBatchStatus(shared, targets.length, blocked);
    await refreshCatalogThenReport(refresh, setStatus, operationStatus);
  }, [
    client,
    cloudAssetIds,
    originalAssetCache,
    projectId,
    refresh,
    selectedAssetIds,
    syncEnabled,
    verifyPrivateBackup,
    visible,
  ]);

  const bulkEditWithAi = useCallback(() => {
    if (onEditWithAi === undefined) {
      setStatus('Media handoff to Joy Code is unavailable in this session.');
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
        ? 'No selected image or video is ready for Joy Code.'
        : `${attached} media item(s) are ready for Joy Code.`,
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
    setStatus(`${deleted} of ${targets.length} selected media item(s) were removed.`);
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
                : 'Enable private backup for this project'
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
              aria-label="Asset import progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(importProgress * 100)}
            >
              <span style={{ width: `${Math.min(100, importProgress * 100).toFixed(1)}%` }} />
            </div>
          )}
          {importOpen && (
            <div
              ref={importDialogRef}
              className="asset-import-drawer"
              role="dialog"
              aria-label="Import media"
              aria-modal="true"
              tabIndex={-1}
            >
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
                Files are hashed, registered, and kept in this browser by default. When private
                backup is already enabled, image imports are also backed up. Video, audio, and 3D
                originals remain local in v1.
              </p>
              <div className="asset-import-row">
                <input
                  ref={fileInputRef}
                  className="sr-only"
                  type="file"
                  accept="video/*,audio/*,image/*,.glb,.gltf,model/gltf-binary,model/gltf+json"
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
                  {selectedFile?.name ?? 'Choose a media file'}
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
                  aria-label="Asset import progress"
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
            <div
              ref={filterDialogRef}
              className="asset-filter-drawer"
              role="dialog"
              aria-label="Asset filters"
              aria-modal="true"
              tabIndex={-1}
            >
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
                  <option value="available-cloud">Ready in private backup</option>
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
          {referenceAnalysisView !== undefined && (
            <section
              className="asset-preview"
              aria-label={`Reference analysis: ${referenceAnalysisView.asset.displayName}`}
            >
              <div>
                <strong>{referenceAnalysisView.asset.displayName}</strong>
                <span>
                  {referenceAnalysisView.analysis.receipt.summary.shotCount} shot(s) ·{' '}
                  {referenceAnalysisView.analysis.receipt.summary.audioBeatCount} beat cue(s)
                </span>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close reference analysis"
                title="Close reference analysis"
                onClick={() => setOpenReferenceAnalysisAssetId(undefined)}
              >
                <CloseIcon />
              </button>
              <div className="asset-reference-analysis">
                <p>
                  Source hash {referenceAnalysisView.analysis.sourceSha256.slice(0, 12)}… ·{' '}
                  {referenceAnalysisView.analysis.evidenceIds.length} evidence id(s)
                </p>
                <ul>
                  {referenceAnalysisView.analysis.receipt.evidence.slice(0, 6).map((entry) => (
                    <li key={entry.id}>
                      <strong>{entry.kind}</strong> {entry.summary}
                    </li>
                  ))}
                </ul>
                {(referenceAnalysisView.analysis.receipt.findings ?? []).length > 0 && (
                  <ul>
                    {referenceAnalysisView.analysis.receipt.findings?.map((finding) => (
                      <li key={finding.id}>
                        <strong>{finding.title}</strong> {finding.summary}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}
          {brollSearchView !== undefined && brollSearchView.rangeCount > 0 && (
            <section className="asset-preview" aria-label="Semantic B-roll search">
              <div>
                <strong>Semantic B-roll</strong>
                <span>{brollSearchView.rangeCount} evidence-linked range(s)</span>
              </div>
              <label className="asset-search-field">
                <span className="sr-only">Search semantic B-roll</span>
                <input
                  type="search"
                  value={brollQuery}
                  onChange={(event) => setBrollQuery(event.target.value)}
                  placeholder="Search B-roll evidence"
                />
              </label>
              {brollSearchView.results.length > 0 && (
                <ul className="asset-reference-analysis">
                  {brollSearchView.results.map((result) => (
                    <li key={result.resultId}>
                      <strong>{result.displayName}</strong> {formatSeconds(result.range.startUs)}-
                      {formatSeconds(result.range.startUs + result.range.durationUs)} ·{' '}
                      {result.evidenceIds.length} evidence id(s)
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {selectedCount > 0 && (
            <div className="asset-bulk-bar" role="toolbar" aria-label="Bulk asset actions">
              <span className="asset-bulk-count">{selectedCount}</span>
              <button
                type="button"
                className="icon-button"
                disabled={!syncEnabled}
                aria-label="Back up selected images privately"
                title={
                  syncEnabled ? 'Back up selected images privately' : 'Enable private backup first'
                }
                data-guide="Private backup"
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
                    cloudBacked ? 'Private backup' : availabilityLabel(avail),
                  ].join(' · ');
                  const referenceState =
                    asset.kind === 'video' && artifacts !== undefined
                      ? referenceStatusForAsset({ asset, store: artifacts, jobs })
                      : undefined;
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
                        {asset.kind === 'image' && onAddSticker !== undefined && (
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Add ${asset.displayName} as sticker`}
                            title="Add as sticker"
                            data-guide="Add as sticker"
                            onClick={() => void addSticker(asset)}
                          >
                            <PlusIcon />
                          </button>
                        )}
                        {asset.kind === 'image' && !cloudBacked && (
                          <AssetShareCloudButton
                            asset={asset}
                            syncEnabled={syncEnabled}
                            originalCachePromise={originalAssetCache}
                            onShare={() => void shareToCloud(asset)}
                          />
                        )}
                        {asset.kind === 'video' &&
                          referenceState !== undefined &&
                          !referenceState.marked && (
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Mark ${asset.displayName} as reference`}
                              title="Mark as Reference"
                              data-guide="Mark as Reference"
                              onClick={() => markAsReference(asset)}
                            >
                              <CheckIcon />
                            </button>
                          )}
                        {asset.kind === 'video' &&
                          referenceState !== undefined &&
                          referenceState.marked && (
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Run reference analysis for ${asset.displayName}`}
                              title={
                                referenceState.running
                                  ? 'Reference analysis queued'
                                  : 'Run Reference Analysis'
                              }
                              data-guide="Run Reference Analysis"
                              disabled={!referenceState.canRun}
                              onClick={() => void runReferenceAnalysis(asset)}
                            >
                              <RefreshIcon />
                            </button>
                          )}
                        {asset.kind === 'video' && referenceState?.canView === true && (
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`View reference analysis for ${asset.displayName}`}
                            title="View Reference Analysis"
                            data-guide="View Reference Analysis"
                            onClick={() => setOpenReferenceAnalysisAssetId(asset.id)}
                          >
                            <ListIcon />
                          </button>
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
              {rendered.length < pageItems && (
                <button
                  type="button"
                  className="asset-library-load-more"
                  onClick={() =>
                    setRenderLimit((current) => nextAssetRenderLimit(current, pageItems))
                  }
                >
                  Load{' '}
                  {Math.min(
                    ASSET_RENDER_PAGE_SIZE,
                    ASSET_RENDER_MAX - rendered.length,
                    visible.length - rendered.length,
                  )}{' '}
                  more
                </button>
              )}
              {pageCount > 1 && (
                <nav className="asset-library-pagination" aria-label="Asset pages">
                  <button
                    type="button"
                    className="asset-library-load-more"
                    disabled={renderPage === 0}
                    onClick={() => {
                      setRenderPage((page) => Math.max(0, page - 1));
                      setRenderLimit(ASSET_RENDER_PAGE_SIZE);
                    }}
                  >
                    Previous assets
                  </button>
                  <span aria-live="polite">
                    Showing {pageStart + 1}–{pageStart + rendered.length} of {visible.length}
                    {' · '}page {renderPage + 1} of {pageCount}
                  </span>
                  <button
                    type="button"
                    className="asset-library-load-more"
                    disabled={renderPage >= pageCount - 1 || rendered.length < pageItems}
                    title={
                      rendered.length < pageItems ? 'Load the rest of this page first' : undefined
                    }
                    onClick={() => {
                      setRenderPage((page) => Math.min(pageCount - 1, page + 1));
                      setRenderLimit(ASSET_RENDER_PAGE_SIZE);
                    }}
                  >
                    Next assets
                  </button>
                </nav>
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
      return 'Ready in private backup';
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

export function assetImportOperationStatus(
  fileName: string,
  kind: BrowserAsset['kind'],
  imported: Pick<LocalFirstAssetImportResult, 'backupState' | 'backupError'>,
): string {
  if (imported.backupState === 'uploaded')
    return `${fileName} is stored locally and backed up privately.`;
  if (imported.backupState === 'upload-failed')
    return `${fileName} is stored locally. Private backup failed: ${message(imported.backupError)}`;
  if (imported.backupState === 'sync-state-unavailable')
    return `${fileName} is stored locally. Backup status could not be verified, so no upload was attempted.`;
  if (imported.backupState === 'disabled')
    return `${fileName} is stored locally. Private backup is off for this project.`;
  return `${fileName} is stored locally. ${kind === 'model' ? '3D model' : 'Video and audio'} originals remain local in v1.`;
}

export function privateBackupBatchStatus(shared: number, total: number, blocked: number): string {
  return `${shared} of ${total} selected images were backed up privately.${blocked > 0 ? ` ${blocked} were blocked or failed.` : ''}`;
}

export async function refreshCatalogThenReport(
  refresh: () => Promise<void>,
  report: (status: string) => void,
  operationStatus: string,
): Promise<void> {
  try {
    await refresh();
    report(operationStatus);
  } catch (error) {
    report(
      `${operationStatus} The catalog could not be refreshed: ${message(error)}. Use Refresh to reload the asset list.`,
    );
  }
}

export async function addAssetAsSticker({
  asset,
  onAddSticker,
  loadOriginalBlob,
}: {
  readonly asset: Pick<BrowserAsset, 'id' | 'kind' | 'displayName'>;
  readonly onAddSticker?: (asset: {
    readonly assetId: string;
    readonly displayName?: string;
    readonly blob?: Blob;
  }) => void;
  readonly loadOriginalBlob: () => Promise<Blob | undefined>;
}): Promise<boolean> {
  if (asset.kind !== 'image' || onAddSticker === undefined) return false;
  const blob = await loadOriginalBlob();
  onAddSticker({
    assetId: asset.id,
    displayName: asset.displayName,
    ...(blob === undefined ? {} : { blob }),
  });
  return true;
}

function AssetShareCloudButton({
  asset,
  syncEnabled,
  originalCachePromise,
  onShare,
}: {
  readonly asset: BrowserAsset;
  readonly syncEnabled: boolean;
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
  if (!syncEnabled || !hasLocal) return null;
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={`Back up ${asset.displayName} privately`}
      title="Back up privately"
      data-guide="Private backup"
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
        // Image cards may hydrate their visible thumbnails through the shared
        // queue; audio keeps the lightweight equalizer fallback until the user
        // explicitly opens Preview, so the 1,805-track library stays cheap.
        allowCloudFallback: asset.kind === 'image',
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
      ) : asset.kind === 'audio' ? (
        <span className="asset-card-audio-equalizer" aria-hidden="true">
          {[34, 58, 82, 46, 70, 94, 54, 76, 42, 64, 88, 50, 72, 38, 60, 84].map((height, index) => (
            <span key={index} style={{ height: `${height}%` }} />
          ))}
        </span>
      ) : (
        <span className="asset-card-placeholder" aria-hidden>
          {asset.kind === 'video' ? '▶' : '▣'}
        </span>
      )}
    </button>
  );
}

function buildPanelSemanticBrollIndex(
  projectId: string,
  items: readonly AssetLibraryItem[],
  artifacts: ArtifactStore,
): SemanticBrollSearchIndexV1 {
  const evidenceIndex = new Map<string, MediaSemanticIndexEvidence>();
  const assets: SemanticBrollAssetV1[] = [];

  for (const { asset } of items) {
    if (asset.kind !== 'video') continue;
    const analysis = parseReferenceAnalysisArtifact(
      artifacts.artifacts[referenceAnalysisArtifactId(asset.id)],
    );
    if (analysis === undefined) continue;
    const converted = panelSemanticAssetFromReceipt(asset, analysis.receipt);
    for (const evidence of converted.evidence) evidenceIndex.set(evidence.id, evidence);
    assets.push(converted.asset);
  }

  return {
    schemaVersion: 1,
    projectId,
    createdAt: new Date(0).toISOString(),
    evidenceIndex,
    assets,
  };
}

function panelSemanticAssetFromReceipt(
  asset: BrowserAsset,
  receipt: VideoReferenceAnalyzeReceipt,
): {
  readonly asset: SemanticBrollAssetV1;
  readonly evidence: readonly MediaSemanticIndexEvidence[];
} {
  const evidence: MediaSemanticIndexEvidence[] = [];

  for (const entry of receipt.evidence) {
    if (entry.kind === 'shot') {
      evidence.push({
        id: panelSemanticEvidenceId(asset.id, entry.id),
        kind: 'asset-shot',
        label: entry.label,
        summary: entry.summary,
        sourceEntityId: asset.id,
        sourceEntityRevision: 1,
        assetId: asset.id,
        startUs: entry.startUs,
        durationUs: entry.durationUs,
        tags: tagsFromPanelText(`${entry.label} ${entry.summary}`),
      });
      continue;
    }
    if (entry.kind === 'transcript') {
      for (const segment of entry.segments) {
        evidence.push({
          id: panelSemanticEvidenceId(
            asset.id,
            `caption-${String(segment.startUs).padStart(8, '0')}`,
          ),
          kind: 'asset-caption',
          label: `${entry.label} ${formatSeconds(segment.startUs)}`,
          summary: segment.text,
          sourceEntityId: asset.id,
          sourceEntityRevision: 1,
          assetId: asset.id,
          startUs: segment.startUs,
          durationUs: Math.max(1, segment.endUs - segment.startUs),
          text: segment.text,
          language: 'und',
        });
      }
      continue;
    }
    if (entry.kind === 'audio-beat') {
      evidence.push({
        id: panelSemanticEvidenceId(asset.id, entry.id),
        kind: 'asset-audio',
        label: entry.label,
        summary: entry.summary,
        sourceEntityId: asset.id,
        sourceEntityRevision: 1,
        assetId: asset.id,
        startUs: entry.startUs,
        durationUs: entry.durationUs,
        audioKind: 'music',
      });
    }
  }

  const ranges = panelSemanticRanges(asset.id, evidence);
  return {
    evidence,
    asset: {
      assetId: asset.id,
      displayName: asset.displayName,
      assetType: 'video',
      ...(receipt.descriptor.durationUs === undefined
        ? {}
        : { durationUs: receipt.descriptor.durationUs }),
      usedInTimeline: false,
      tags: tagsFromPanelText(`${asset.displayName} ${(asset.tags ?? []).join(' ')}`),
      ranges,
    },
  };
}

function panelSemanticRanges(
  assetId: string,
  evidence: readonly MediaSemanticIndexEvidence[],
): readonly SemanticBrollTimeRangeV1[] {
  const shots = evidence.filter((entry) => entry.kind === 'asset-shot');
  const sourceRanges = shots.length > 0 ? shots : evidence;
  return sourceRanges.map((source, index) => {
    const overlapping = evidence.filter((entry) =>
      panelRangesOverlap(source.startUs, source.durationUs, entry.startUs, entry.durationUs),
    );
    return {
      rangeId: `${assetId}.range-${String(index + 1).padStart(4, '0')}`,
      assetId,
      startUs: source.startUs,
      durationUs: source.durationUs,
      label: source.label,
      text: overlapping
        .map((entry) =>
          entry.kind === 'asset-caption' ? entry.text : (entry.summary ?? entry.label),
        )
        .join(' '),
      evidenceIds: overlapping.map((entry) => entry.id),
    };
  });
}

function panelSemanticEvidenceId(assetId: string, evidenceId: string): string {
  return `${assetId}.${evidenceId}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
}

function panelRangesOverlap(
  leftStartUs: number,
  leftDurationUs: number,
  rightStartUs: number,
  rightDurationUs: number,
): boolean {
  const leftEndUs = leftStartUs + leftDurationUs;
  const rightEndUs = rightStartUs + rightDurationUs;
  return leftStartUs < rightEndUs && rightStartUs < leftEndUs;
}

function tagsFromPanelText(text: string): readonly string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
    .filter((token) => token.length > 2)
    .slice(0, 12);
}

function formatSeconds(valueUs: number): string {
  return `${(valueUs / 1_000_000).toFixed(1)}s`;
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
  if (
    file.type === 'model/gltf-binary' ||
    file.type === 'model/gltf+json' ||
    /\.(glb|gltf)$/i.test(file.name)
  )
    return 'model';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  throw new Error('selected file must be video, audio, image, or GLB/GLTF');
}
function normalizedMimeType(file: File, kind: BrowserAsset['kind']): string {
  if (kind === 'model' && (file.type === 'model/gltf-binary' || file.type === 'model/gltf+json'))
    return file.type;
  if (kind === 'model' && /\.glb$/i.test(file.name)) return 'model/gltf-binary';
  if (kind === 'model' && /\.gltf$/i.test(file.name)) return 'model/gltf+json';
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
