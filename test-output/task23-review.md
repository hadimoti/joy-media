# Review package: 4e62dfd..4500688

## Commits
4500688 feat(reference): analyze videos into bounded creative evidence

## Files changed
 apps/api/src/control-plane.ts                      |  34 +-
 apps/api/src/http-server.ts                        |  29 ++
 apps/api/src/postgres-control-plane.ts             |  43 +-
 apps/editor-web/src/App.tsx                        |   4 +
 apps/editor-web/src/AssetLibraryPanel.tsx          | 227 ++++++++-
 apps/editor-web/src/JobsPanel.tsx                  |   2 +-
 apps/editor-web/src/ProductionBoardPanel.tsx       |  44 +-
 apps/editor-web/src/control-plane-client.ts        |  46 +-
 apps/editor-web/src/production-board-model.ts      |  18 +-
 .../src/reference-analysis-model.test.ts           | 274 ++++++++++
 apps/editor-web/src/reference-analysis-model.ts    | 262 ++++++++++
 apps/worker/src/control-plane-client.ts            |  16 +-
 apps/worker/src/reference-analysis.test.ts         | 245 +++++++++
 apps/worker/src/reference-analysis.ts              | 552 +++++++++++++++++++++
 apps/worker/src/runtime.test.ts                    |   2 +
 apps/worker/src/runtime.ts                         |  86 +++-
 packages/job-protocol/src/index.ts                 |   9 +-
 packages/job-protocol/src/media-analysis-jobs.ts   | 381 +++++++++++++-
 packages/job-protocol/src/protocol.ts              |  65 ++-
 19 files changed, 2302 insertions(+), 37 deletions(-)

## Diff
diff --git a/apps/api/src/control-plane.ts b/apps/api/src/control-plane.ts
index f2edf18..ce1dc25 100644
--- a/apps/api/src/control-plane.ts
+++ b/apps/api/src/control-plane.ts
@@ -1,19 +1,19 @@
 import {
   isWorkerJobType,
   validateWorkerJobV1,
   validateWorkerReceiptForJob,
   workerCanRunJob,
   WorkerProtocolError,
   WORKER_PROTOCOL_VERSION,
 } from '@joy-media/job-protocol';
-import type { WorkerJobV1 } from '@joy-media/job-protocol';
+import type { VideoReferenceAnalyzeReceipt, WorkerJobV1 } from '@joy-media/job-protocol';
 
 export interface Actor {
   readonly id: string;
 }
 export interface ProjectMetadata {
   readonly id: string;
   readonly title: string;
   readonly revision: number;
   readonly ownerId: string;
   /** Explicit opt-in prerequisite for private object-storage synchronization. */
@@ -189,26 +189,28 @@ export interface MediaAiWorkerReceipt {
   readonly sha256: string;
   readonly bytes: number;
   readonly localRef: string;
   readonly descriptor: {
     readonly mimeType: string;
     readonly width?: number;
     readonly height?: number;
   };
   readonly model?: string;
 }
+export type ReferenceAnalysisWorkerReceipt = VideoReferenceAnalyzeReceipt;
 export type WorkerResultReceipt =
   | FixtureThumbnailReceipt
   | AssetThumbnailReceipt
   | LocalGpuWorkerReceipt
   | TextAiWorkerReceipt
   | MediaAiWorkerReceipt
+  | ReferenceAnalysisWorkerReceipt
   | RenderExportReceipt
   | RenderInspectReceipt;
 /**
  * Owner-visible derivative projection. All references are control-plane IDs;
  * it deliberately has no Worker path, bytes, pairing secret, or session token.
  */
 export type DerivativeRecord = WorkerResultReceipt & {
   readonly jobId: string;
   readonly workerRef: string;
   readonly resultRef: string;
@@ -1095,20 +1097,27 @@ function isMediaAiReceipt(value: WorkerResultReceipt | undefined): value is Medi
 }
 
 function isWorkerCompatible(worker: WorkerRecord, job: Job): boolean {
   if (job.type === 'asset.thumbnail') {
     return (
       job.assetId !== undefined &&
       worker.capabilities.includes('asset.thumbnail') &&
       worker.localAssetIds.includes(job.assetId)
     );
   }
+  if (job.type === 'video.reference-analyze') {
+    return (
+      job.assetId !== undefined &&
+      worker.capabilities.includes('video.reference-analyze') &&
+      worker.localAssetIds.includes(job.assetId)
+    );
+  }
   if (job.type === 'image.comfy') return worker.capabilities.includes('image.comfy');
   if (job.type === 'audio.ml-denoise') return worker.capabilities.includes('audio.ml-denoise');
   if (isWorkerJobType(job.type)) return workerCanRunJob(worker.capabilities, job.type);
   return job.type === 'fixture.thumbnail';
 }
 
 function legacyWorkerJob(
   id: string,
   projectId: string,
   type: string,
@@ -1124,20 +1133,43 @@ function legacyWorkerJob(
     return validateWorkerJobV1({
       protocolVersion: WORKER_PROTOCOL_VERSION,
       jobId: id,
       type,
       payload: { assetId, maxEdgePx: 720 },
       requirements: { capabilities: ['asset.thumbnail'], privacy: 'local-only' },
       idempotencyKey: id,
       maxAttempts: 3,
     });
   }
+  if (type === 'video.reference-analyze') {
+    if (assetId === undefined) {
+      throw new ControlPlaneError(
+        'ASSET_JOB_INVALID',
+        'reference analysis requires an opaque asset ID',
+      );
+    }
+    return validateWorkerJobV1({
+      protocolVersion: WORKER_PROTOCOL_VERSION,
+      jobId: id,
+      type,
+      payload: {
+        assetId,
+        maxDurationUs: 15 * 60 * 1_000_000,
+        maxBytes: 256 * 1_024 * 1_024,
+        sampleCount: 3,
+        maxAudioBeats: 6,
+      },
+      requirements: { capabilities: ['video.reference-analyze'], privacy: 'local-only' },
+      idempotencyKey: id,
+      maxAttempts: 3,
+    });
+  }
   if (type === 'render.export' || type === 'render.inspect') {
     return validateWorkerJobV1({
       protocolVersion: WORKER_PROTOCOL_VERSION,
       jobId: id,
       type,
       payload: {
         projectRef: projectId,
         compositionId: id,
         presetId: 'default',
         reportRef: `report-${id}`,
diff --git a/apps/api/src/http-server.ts b/apps/api/src/http-server.ts
index 44e7fc5..88cc707 100644
--- a/apps/api/src/http-server.ts
+++ b/apps/api/src/http-server.ts
@@ -1270,20 +1270,49 @@ function requiredWorkerResult(body: Record<string, unknown>): WorkerResultReceip
     (result.model === undefined || typeof result.model === 'string')
   ) {
     return {
       kind: result.kind,
       resultRef: result.resultRef,
       sha256: result.sha256,
       bytes: result.bytes,
       ...(result.model === undefined ? {} : { model: result.model }),
     };
   }
+  if (
+    result.kind === 'video.reference-analyze' &&
+    hasOnlyKeys(result, [
+      'kind',
+      'assetId',
+      'sha256',
+      'bytes',
+      'descriptor',
+      'summary',
+      'evidence',
+      'evidenceIds',
+      'findings',
+      'model',
+    ]) &&
+    typeof result.assetId === 'string' &&
+    isReceiptHashAndBytes(result) &&
+    result.descriptor !== null &&
+    typeof result.descriptor === 'object' &&
+    !Array.isArray(result.descriptor) &&
+    result.summary !== null &&
+    typeof result.summary === 'object' &&
+    !Array.isArray(result.summary) &&
+    Array.isArray(result.evidence) &&
+    Array.isArray(result.evidenceIds) &&
+    (result.findings === undefined || Array.isArray(result.findings)) &&
+    (result.model === undefined || typeof result.model === 'string')
+  ) {
+    return result as WorkerResultReceiptV1;
+  }
   const descriptor = result.descriptor;
   if (
     (result.kind === 'image.comfy' ||
       result.kind === 'audio.ml-denoise' ||
       result.kind === 'video.runway' ||
       result.kind === 'edit.higgsfield') &&
     hasOnlyKeys(result, [
       'kind',
       'assetId',
       'sha256',
diff --git a/apps/api/src/postgres-control-plane.ts b/apps/api/src/postgres-control-plane.ts
index d1ee408..22a0c3b 100644
--- a/apps/api/src/postgres-control-plane.ts
+++ b/apps/api/src/postgres-control-plane.ts
@@ -1,19 +1,23 @@
 import type { Pool, PoolClient } from 'pg';
 import {
   isWorkerJobType,
   validateWorkerJobV1,
   validateWorkerReceiptForJob,
   workerCanRunJob,
   WORKER_PROTOCOL_VERSION,
 } from '@joy-media/job-protocol';
-import type { WorkerJobV1 } from '@joy-media/job-protocol';
+import type {
+  VideoReferenceAnalyzeReceipt,
+  WorkerJobType,
+  WorkerJobV1,
+} from '@joy-media/job-protocol';
 import {
   ControlPlaneError,
   type AssetLocationRecord,
   type AssetRegistration,
   type Actor,
   type AssetThumbnailReceipt,
   type CloudDerivativeRegistration,
   type ControlPlane,
   type LocalDerivativeRegistration,
   type MediaAssetRecord,
@@ -823,21 +827,21 @@ export class PostgresControlPlane implements ControlPlane, ProductionRunStore {
              result_kind = $4, result_sha256 = $5, result_bytes = $6,
              result_ref = $7, result_worker_ref = $8, result_verified_at = $9,
              result_asset_id = $10, result_local_ref = $11, result_mime_type = $12,
              result_width = $13, result_height = $14, result_receipt = $15::jsonb
          WHERE id = $1 AND state = 'leased' AND lease_owner = $2 AND lease_expires_at > $3
            AND (type <> 'fixture.thumbnail' OR $4 = 'fixture.thumbnail')
            AND (type <> 'asset.thumbnail' OR ($4 = 'asset.thumbnail' AND asset_id = $10))
            AND (type <> 'image.comfy' OR $4 = 'image.comfy')
            AND (type <> 'audio.ml-denoise' OR $4 = 'audio.ml-denoise')
            AND (type NOT IN ('render.export', 'render.inspect', 'text.lm-studio', 'text.openrouter',
-                             'video.runway', 'edit.higgsfield') OR type = $4)
+                             'video.runway', 'edit.higgsfield', 'video.reference-analyze') OR type = $4)
          RETURNING *`,
         [
           jobId,
           workerId,
           new Date(now),
           receipt?.kind ?? null,
           storesHashAndBytes ? receipt.sha256 : null,
           storesHashAndBytes ? receipt.bytes : null,
           receipt === undefined ? null : `derivative:${jobId}`,
           receipt === undefined ? null : workerId,
@@ -1265,20 +1269,21 @@ function isFixtureReceipt(
   );
 }
 
 function isWorkerReceipt(value: WorkerResultReceipt): boolean {
   return (
     isFixtureReceipt(value) ||
     isAssetThumbnailReceipt(value) ||
     isLocalGpuReceipt(value) ||
     isTextAiReceipt(value) ||
     isMediaAiReceipt(value) ||
+    isReferenceAnalysisReceipt(value) ||
     isRenderReceipt(value)
   );
 }
 
 function isAssetThumbnailReceipt(value: WorkerResultReceipt): value is AssetThumbnailReceipt {
   return (
     value.kind === 'asset.thumbnail' &&
     /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId) &&
     /^[a-f0-9]{64}$/.test(value.sha256) &&
     Number.isSafeInteger(value.bytes) &&
@@ -1327,20 +1332,44 @@ function isMediaAiReceipt(
     /^[a-f0-9]{64}$/.test(value.sha256) &&
     Number.isSafeInteger(value.bytes) &&
     value.bytes > 0 &&
     /^ai-[A-Za-z0-9._-]{1,110}$/.test(value.localRef) &&
     typeof value.descriptor.mimeType === 'string' &&
     value.descriptor.mimeType.length > 0 &&
     (value.model === undefined || typeof value.model === 'string')
   );
 }
 
+function isReferenceAnalysisReceipt(
+  value: WorkerResultReceipt,
+): value is VideoReferenceAnalyzeReceipt {
+  return (
+    value.kind === 'video.reference-analyze' &&
+    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId) &&
+    /^[a-f0-9]{64}$/.test(value.sha256) &&
+    Number.isSafeInteger(value.bytes) &&
+    value.bytes > 0 &&
+    typeof value.descriptor.mimeType === 'string' &&
+    value.descriptor.mimeType.startsWith('video/') &&
+    Number.isSafeInteger(value.descriptor.width) &&
+    value.descriptor.width > 0 &&
+    Number.isSafeInteger(value.descriptor.height) &&
+    value.descriptor.height > 0 &&
+    Number.isSafeInteger(value.descriptor.durationUs) &&
+    value.descriptor.durationUs > 0 &&
+    Array.isArray(value.evidence) &&
+    Array.isArray(value.evidenceIds) &&
+    (value.findings === undefined || Array.isArray(value.findings)) &&
+    (value.model === undefined || typeof value.model === 'string')
+  );
+}
+
 function isRenderReceipt(value: WorkerResultReceipt): boolean {
   if (value.kind === 'render.export') {
     return (
       /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.reportRef) &&
       /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.outputRef) &&
       /^[a-f0-9]{64}$/.test(value.sha256) &&
       Number.isSafeInteger(value.bytes) &&
       value.bytes > 0
     );
   }
@@ -1414,32 +1443,36 @@ function legacyWorkerJob(
         projectRef: projectId,
         compositionId: id,
         presetId: 'default',
         reportRef: `report-${id}`,
       },
       requirements: { capabilities: [type], privacy: 'local-only' },
       idempotencyKey: id,
       maxAttempts: 3,
     });
   }
+  const aiType = type as Exclude<
+    WorkerJobType,
+    'asset.thumbnail' | 'video.reference-analyze' | 'render.export' | 'render.inspect'
+  >;
   return validateWorkerJobV1({
     protocolVersion: WORKER_PROTOCOL_VERSION,
     jobId: id,
-    type,
+    type: aiType,
     payload: {
       prompt: '',
       ...(assetId === undefined ? {} : { imageAssetId: assetId }),
     },
     requirements: {
-      capabilities: [type],
+      capabilities: [aiType],
       privacy:
-        type === 'text.openrouter' || type === 'video.runway' || type === 'edit.higgsfield'
+        aiType === 'text.openrouter' || aiType === 'video.runway' || aiType === 'edit.higgsfield'
           ? 'remote-api'
           : 'local-only',
     },
     idempotencyKey: id,
     maxAttempts: 3,
   });
 }
 
 function databaseError(error: unknown, duplicateCode: string, id: string): ControlPlaneError {
   if (isPostgresError(error) && error.code === '23505')
diff --git a/apps/editor-web/src/App.tsx b/apps/editor-web/src/App.tsx
index 601c8a0..cf0df98 100644
--- a/apps/editor-web/src/App.tsx
+++ b/apps/editor-web/src/App.tsx
@@ -2746,20 +2746,24 @@ function EditorWorkspace({
     if (api.id === 'media')
       return (
         <AssetLibraryPanel
           projectId={controlPlaneProject.controlPlaneProjectId}
           projectTitle={controlPlaneProject.title}
           onAddSticker={(asset) => void context.addStickerFromAsset(asset)}
           onEditWithAi={(asset) => {
             context.attachKiloCodeAsset(asset);
             context.activatePanel('agent');
           }}
+          {...(context.artifacts === undefined ? {} : { artifacts: context.artifacts })}
+          {...(context.dispatchArtifacts === undefined
+            ? {}
+            : { onDispatchArtifacts: context.dispatchArtifacts })}
         />
       );
     if (api.id === 'agent') {
       return (
         <AgentPanel
           project={context.timelineProject}
           selectedClipIds={state.selectedIds}
           playheadUs={state.playheadUs}
           agentContext={context.agentContext}
           onUndo={context.undo}
diff --git a/apps/editor-web/src/AssetLibraryPanel.tsx b/apps/editor-web/src/AssetLibraryPanel.tsx
index ac8524f..eec55fa 100644
--- a/apps/editor-web/src/AssetLibraryPanel.tsx
+++ b/apps/editor-web/src/AssetLibraryPanel.tsx
@@ -1,17 +1,19 @@
 import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
+import type { ArtifactStore, ArtifactTransaction } from '@joy-media/commands';
 import { AuthorizedDerivativeResolver } from './asset-resolver.js';
 import {
   BrowserControlPlaneClient,
   type BrowserAsset,
   type BrowserAssetRegistration,
   type BrowserDerivative,
+  type BrowserJob,
 } from './control-plane-client.js';
 import { getStoredMediaToken, MEDIA_SESSION_CHANGED_EVENT } from './media-session.js';
 import {
   assetCollectionId,
   assetCollectionLabel,
   assetCollectionsForCategory,
   filterAssetLibrary,
   preferredDerivative,
   type AssetAvailability,
   type AssetCategory,
@@ -37,20 +39,28 @@ import {
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
+import {
+  buildPersistReferenceAnalysisTransaction,
+  buildReferenceMarkerTransaction,
+  parseReferenceAnalysisArtifact,
+  referenceAnalysisArtifactId,
+  referenceAnalysisReceiptFromDerivative,
+  referenceStatusForAsset,
+} from './reference-analysis-model.js';
 
 const ASSET_RENDER_PAGE_SIZE = 120;
 
 const categories: readonly {
   readonly id: AssetCategory;
   readonly label: string;
 }[] = [
   { id: 'image', label: 'Images' },
   { id: 'video', label: 'Video' },
   { id: 'audio', label: 'Audio' },
@@ -66,71 +76,79 @@ interface Preview {
 
 /**
  * Asset discovery stays metadata-only. A preview is hydrated through the
  * authenticated API, verified, then cached in OPFS by AuthorizedDerivativeResolver.
  */
 export function AssetLibraryPanel({
   projectId,
   projectTitle = 'Editor project',
   onAddSticker,
   onEditWithAi,
+  artifacts,
+  onDispatchArtifacts,
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
+  readonly artifacts?: ArtifactStore;
+  readonly onDispatchArtifacts?: (transaction: ArtifactTransaction) => void;
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
   const [items, setItems] = useState<readonly AssetLibraryItem[]>([]);
+  const [jobs, setJobs] = useState<readonly BrowserJob[]>([]);
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
+  const [openReferenceAnalysisAssetId, setOpenReferenceAnalysisAssetId] = useState<
+    string | undefined
+  >(undefined);
   const fileInputRef = useRef<HTMLInputElement | null>(null);
   const toolbarRef = useRef<HTMLDivElement | null>(null);
   const filterActive = availability !== 'all' || sort !== 'name';
   const canImport =
     selectedFile !== undefined && assetId.trim().length > 0 && importProgress === undefined;
 
   const clearPreview = useCallback(() => {
     previewRef.current?.revoke();
     previewRef.current = undefined;
     setPreview(undefined);
@@ -143,23 +161,24 @@ export function AssetLibraryPanel({
       // LoginGate keeps the editor mounted under the blur; don't wipe a prior
       // catalog or treat "not signed in yet" as a hard failure.
       return;
     }
     try {
       // Catalog listing must not depend on ensureProject — a stale binding to
       // another account's project returns PROJECT_EXISTS/NOT_FOUND and used to
       // zero the whole Assets panel before cloud-assets could load.
       void client.ensureProject(projectId, projectTitle).catch(() => undefined);
 
-      const [ownedResult, sharedResult] = await Promise.allSettled([
+      const [ownedResult, sharedResult, jobsResult] = await Promise.allSettled([
         client.myAssets(),
         client.sharedCloudAssets(),
+        client.jobs(projectId),
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
@@ -188,20 +207,21 @@ export function AssetLibraryPanel({
             ] as const;
           } catch {
             return [asset.id, [] as readonly BrowserDerivative[]] as const;
           }
         }),
       );
       const byAsset = new Map(derivatives);
       if (requestId !== refreshSeqRef.current) return;
       setCloudAssetIds(new Set(sharedAssets.map((asset) => asset.id)));
       setItems(assets.map((asset) => ({ asset, derivatives: byAsset.get(asset.id) ?? [] })));
+      setJobs(jobsResult.status === 'fulfilled' ? jobsResult.value : []);
       if (sharedResult.status === 'rejected') {
         setStatus(
           `Cloud library unavailable (${message(sharedResult.reason)}). Showing ${assets.length} owned item(s).`,
         );
       } else {
         setStatus(
           assets.length === 0
             ? 'No media yet. Import an image to sync with the shared cloud library.'
             : undefined,
         );
@@ -225,20 +245,65 @@ export function AssetLibraryPanel({
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
+  useEffect(() => {
+    const activeReferenceJob = jobs.some(
+      (job) =>
+        job.type === 'video.reference-analyze' &&
+        (job.state === 'queued' || job.state === 'leased'),
+    );
+    if (!activeReferenceJob) return;
+    const timeout = window.setTimeout(() => void refresh(), 1_500);
+    return () => window.clearTimeout(timeout);
+  }, [jobs, refresh]);
+
+  useEffect(() => {
+    if (artifacts === undefined || onDispatchArtifacts === undefined) return;
+    for (const job of jobs) {
+      if (
+        job.type !== 'video.reference-analyze' ||
+        job.state !== 'completed' ||
+        job.assetId === undefined ||
+        job.derivative?.kind !== 'video.reference-analyze'
+      ) {
+        continue;
+      }
+      const receipt = referenceAnalysisReceiptFromDerivative(job.derivative);
+      if (receipt === undefined) continue;
+      const asset = items.find((entry) => entry.asset.id === job.assetId)?.asset;
+      if (asset === undefined) continue;
+      const existing = parseReferenceAnalysisArtifact(
+        artifacts.artifacts[referenceAnalysisArtifactId(asset.id)],
+      );
+      if (existing?.jobId === job.id) continue;
+      try {
+        onDispatchArtifacts(
+          buildPersistReferenceAnalysisTransaction({
+            asset,
+            receipt,
+            jobId: job.id,
+            now: new Date().toISOString(),
+            store: artifacts,
+          }),
+        );
+      } catch (error) {
+        setStatus(`Reference analysis could not be persisted: ${message(error)}`);
+      }
+    }
+  }, [artifacts, items, jobs, onDispatchArtifacts]);
 
   useEffect(() => {
     if (!filterOpen && !importOpen) return;
     const onPointerDown = (event: PointerEvent) => {
       const root = toolbarRef.current;
       if (root === null || root.contains(event.target as Node)) return;
       setFilterOpen(false);
       if (selectedFile === undefined && assetId.trim().length === 0) setImportOpen(false);
     };
     const onKeyDown = (event: KeyboardEvent) => {
@@ -281,20 +346,28 @@ export function AssetLibraryPanel({
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
+  const referenceAnalysisView = useMemo(() => {
+    if (artifacts === undefined || openReferenceAnalysisAssetId === undefined) return undefined;
+    const asset = items.find((entry) => entry.asset.id === openReferenceAnalysisAssetId)?.asset;
+    const analysis = parseReferenceAnalysisArtifact(
+      artifacts.artifacts[referenceAnalysisArtifactId(openReferenceAnalysisAssetId)],
+    );
+    return asset === undefined || analysis === undefined ? undefined : { asset, analysis };
+  }, [artifacts, items, openReferenceAnalysisAssetId]);
   useEffect(() => {
     setRenderLimit(ASSET_RENDER_PAGE_SIZE);
   }, [items, category, collection, deferredQuery, availability, sort]);
   const rendered = useMemo(() => visible.slice(0, renderLimit), [visible, renderLimit]);
   const registerSelectedAsset = useCallback(async () => {
     if (selectedFile === undefined) {
       setStatus('Choose a media file to register.');
       return;
     }
     const normalizedId = assetId.trim();
@@ -489,29 +562,85 @@ export function AssetLibraryPanel({
         setStatus(`Failed to delete media: ${message(error)}`);
       }
     },
     [client, projectId, refresh],
   );
 
   const addSticker = useCallback(
     async (asset: BrowserAsset) => {
       const added = await addAssetAsSticker({
         asset,
-        onAddSticker,
+        ...(onAddSticker === undefined ? {} : { onAddSticker }),
         loadOriginalBlob: async () => (await originalAssetCache).get(asset.id),
       });
       if (added) {
         setStatus(`${asset.displayName} added as a sticker.`);
       }
     },
     [onAddSticker, originalAssetCache],
   );
+  const markAsReference = useCallback(
+    (asset: BrowserAsset) => {
+      if (asset.kind !== 'video') {
+        setStatus('Only video assets can be marked as references.');
+        return;
+      }
+      if (onDispatchArtifacts === undefined) {
+        setStatus('Reference artifacts are unavailable in this session.');
+        return;
+      }
+      try {
+        onDispatchArtifacts(buildReferenceMarkerTransaction(asset, new Date().toISOString()));
+        setStatus(`${asset.displayName} marked as a reference source.`);
+      } catch (error) {
+        setStatus(`Failed to mark reference source: ${message(error)}`);
+      }
+    },
+    [onDispatchArtifacts],
+  );
+
+  const runReferenceAnalysis = useCallback(
+    async (asset: BrowserAsset) => {
+      if (asset.kind !== 'video') {
+        setStatus('Reference analysis supports video assets only.');
+        return;
+      }
+      if (artifacts === undefined || onDispatchArtifacts === undefined) {
+        setStatus('Reference analysis requires durable artifacts in this session.');
+        return;
+      }
+      const referenceState = referenceStatusForAsset({ asset, store: artifacts, jobs });
+      if (!referenceState.marked) {
+        setStatus('Mark the video as a reference first.');
+        return;
+      }
+      if (referenceState.running) {
+        setStatus(`${asset.displayName} is already being analyzed.`);
+        return;
+      }
+      const jobId = `reference-${asset.id}-${Date.now().toString(36)}`;
+      try {
+        await client.enqueueReferenceAnalysis(projectId, jobId, {
+          assetId: asset.id,
+          maxDurationUs: 15 * 60 * 1_000_000,
+          maxBytes: 256 * 1_024 * 1_024,
+          sampleCount: 3,
+          maxAudioBeats: 6,
+        });
+        setStatus(`Reference analysis queued for ${asset.displayName}.`);
+        await refresh();
+      } catch (error) {
+        setStatus(`Reference analysis failed to queue: ${message(error)}`);
+      }
+    },
+    [artifacts, client, jobs, onDispatchArtifacts, projectId, refresh],
+  );
 
   const bulkShare = useCallback(async () => {
     const targets = visible.filter(
       ({ asset }) =>
         selectedAssetIds.has(asset.id) && asset.kind === 'image' && !cloudAssetIds.has(asset.id),
     );
     if (targets.length === 0) {
       setStatus('No selected images are ready to share; an OPFS original is required.');
       return;
     }
@@ -911,20 +1040,65 @@ export function AssetLibraryPanel({
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
+          {referenceAnalysisView !== undefined && (
+            <section
+              className="asset-preview"
+              aria-label={`Reference analysis: ${referenceAnalysisView.asset.displayName}`}
+            >
+              <div>
+                <strong>{referenceAnalysisView.asset.displayName}</strong>
+                <span>
+                  {referenceAnalysisView.analysis.receipt.summary.shotCount} shot(s) ·{' '}
+                  {referenceAnalysisView.analysis.receipt.summary.audioBeatCount} beat cue(s)
+                </span>
+              </div>
+              <button
+                type="button"
+                className="icon-button"
+                aria-label="Close reference analysis"
+                title="Close reference analysis"
+                onClick={() => setOpenReferenceAnalysisAssetId(undefined)}
+              >
+                <CloseIcon />
+              </button>
+              <div className="asset-reference-analysis">
+                <p>
+                  Source hash {referenceAnalysisView.analysis.sourceSha256.slice(0, 12)}… ·{' '}
+                  {referenceAnalysisView.analysis.evidenceIds.length} evidence id(s)
+                </p>
+                <ul>
+                  {referenceAnalysisView.analysis.receipt.evidence.slice(0, 6).map((entry) => (
+                    <li key={entry.id}>
+                      <strong>{entry.kind}</strong> {entry.summary}
+                    </li>
+                  ))}
+                </ul>
+                {(referenceAnalysisView.analysis.receipt.findings ?? []).length > 0 && (
+                  <ul>
+                    {referenceAnalysisView.analysis.receipt.findings?.map((finding) => (
+                      <li key={finding.id}>
+                        <strong>{finding.title}</strong> {finding.summary}
+                      </li>
+                    ))}
+                  </ul>
+                )}
+              </div>
+            </section>
+          )}
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
@@ -1017,20 +1191,24 @@ export function AssetLibraryPanel({
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
+                  const referenceState =
+                    asset.kind === 'video' && artifacts !== undefined
+                      ? referenceStatusForAsset({ asset, store: artifacts, jobs })
+                      : undefined;
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
@@ -1101,20 +1279,65 @@ export function AssetLibraryPanel({
                             <PlusIcon />
                           </button>
                         )}
                         {asset.kind === 'image' && !cloudBacked && (
                           <AssetShareCloudButton
                             asset={asset}
                             originalCachePromise={originalAssetCache}
                             onShare={() => void shareToCloud(asset)}
                           />
                         )}
+                        {asset.kind === 'video' &&
+                          referenceState !== undefined &&
+                          !referenceState.marked && (
+                            <button
+                              type="button"
+                              className="icon-button"
+                              aria-label={`Mark ${asset.displayName} as reference`}
+                              title="Mark as Reference"
+                              data-guide="Mark as Reference"
+                              onClick={() => markAsReference(asset)}
+                            >
+                              <CheckIcon />
+                            </button>
+                          )}
+                        {asset.kind === 'video' &&
+                          referenceState !== undefined &&
+                          referenceState.marked && (
+                            <button
+                              type="button"
+                              className="icon-button"
+                              aria-label={`Run reference analysis for ${asset.displayName}`}
+                              title={
+                                referenceState.running
+                                  ? 'Reference analysis queued'
+                                  : 'Run Reference Analysis'
+                              }
+                              data-guide="Run Reference Analysis"
+                              disabled={!referenceState.canRun}
+                              onClick={() => void runReferenceAnalysis(asset)}
+                            >
+                              <RefreshIcon />
+                            </button>
+                          )}
+                        {asset.kind === 'video' && referenceState?.canView === true && (
+                          <button
+                            type="button"
+                            className="icon-button"
+                            aria-label={`View reference analysis for ${asset.displayName}`}
+                            title="View Reference Analysis"
+                            data-guide="View Reference Analysis"
+                            onClick={() => setOpenReferenceAnalysisAssetId(asset.id)}
+                          >
+                            <ListIcon />
+                          </button>
+                        )}
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
diff --git a/apps/editor-web/src/JobsPanel.tsx b/apps/editor-web/src/JobsPanel.tsx
index 1c3c31b..eefbeb8 100644
--- a/apps/editor-web/src/JobsPanel.tsx
+++ b/apps/editor-web/src/JobsPanel.tsx
@@ -271,21 +271,21 @@ export function JobsPanel({
                         </div>
                         {reportRef !== undefined && (
                           <p className="job-derivative">Report · {reportRef}</p>
                         )}
                         {job.derivative !== undefined && job.derivative.sha256 !== undefined && (
                           <p className="job-derivative">
                             Verified · {job.derivative.bytes ?? 0} B ·{' '}
                             {job.derivative.sha256.slice(0, 12)}…
                           </p>
                         )}
-                        {job.derivative?.findings !== undefined && (
+                        {typeof job.derivative?.findings === 'number' && (
                           <p className="job-derivative">{job.derivative.findings} findings</p>
                         )}
                         {job.error !== undefined && <p className="jobs-error">{job.error}</p>}
                       </div>
                       <div className="jobs-inline-actions">
                         {(job.state === 'queued' || job.state === 'leased') && (
                           <button
                             type="button"
                             className="icon-button"
                             aria-label={`Cancel job ${job.id}`}
diff --git a/apps/editor-web/src/ProductionBoardPanel.tsx b/apps/editor-web/src/ProductionBoardPanel.tsx
index e15eb29..3cfab69 100644
--- a/apps/editor-web/src/ProductionBoardPanel.tsx
+++ b/apps/editor-web/src/ProductionBoardPanel.tsx
@@ -153,29 +153,35 @@ export function ProductionBoardPanel({
   const retry = async (run: ProductionBoardRunProjection) => {
     if (onRetryRun === undefined) return;
     await onRetryRun(run);
     setStatus('Retry requested.');
     await refresh();
   };
 
   return (
     <ProductionBoardPanelView
       loadState={loadState.kind}
-      errorMessage={loadState.kind === 'error' ? loadState.message : undefined}
-      model={model}
-      status={status}
+      {...(loadState.kind === 'error' ? { errorMessage: loadState.message } : {})}
+      {...(model === undefined ? {} : { model })}
+      {...(status === undefined ? {} : { status })}
       onRefresh={() => void refresh()}
-      onApproval={(run, approval, decision) => void approve(run, approval, decision)}
-      onCancel={(run) => void cancel(run)}
-      onRetry={(run) => void retry(run)}
+      {...{
+        onApproval: (
+          run: ProductionBoardRunProjection,
+          approval: ProductionApprovalV1,
+          decision: ContactSheetApprovalDecision,
+        ) => void approve(run, approval, decision),
+        onCancel: (run: ProductionBoardRunProjection) => void cancel(run),
+        onRetry: (run: ProductionBoardRunProjection) => void retry(run),
+      }}
       retryAvailable={onRetryRun !== undefined}
-      onOpenLink={onOpenLink}
+      {...(onOpenLink === undefined ? {} : { onOpenLink })}
     />
   );
 }
 
 export async function loadProductionBoardRecords(
   store: ProductionBoardRunStore,
 ): Promise<readonly ProductionRunRecordV1[]> {
   const records: ProductionRunRecordV1[] = [];
   const seenCursors = new Set<string>();
   let cursor: string | undefined;
@@ -311,24 +317,24 @@ export function ProductionBoardPanelView({
                   ))}
                 </div>
               </section>
             ))}
           </div>
           {selectedRun !== undefined && (
             <RunDetails
               run={selectedRun}
               section={section}
               retryAvailable={retryAvailable}
-              onApproval={onApproval}
-              onCancel={onCancel}
-              onRetry={onRetry}
-              onOpenLink={onOpenLink}
+              {...(onApproval === undefined ? {} : { onApproval })}
+              {...(onCancel === undefined ? {} : { onCancel })}
+              {...(onRetry === undefined ? {} : { onRetry })}
+              {...(onOpenLink === undefined ? {} : { onOpenLink })}
             />
           )}
         </div>
       )}
     </PanelShell>
   );
 }
 
 function RunDetails({
   run,
@@ -394,23 +400,25 @@ function RunDetails({
       </div>
       <div className="production-board-section">
         <h4>{active.label}</h4>
         {section === 'approvals' &&
           run.pendingApprovals.map((approval) => (
             <ContactSheetApproval
               key={approval.approvalId}
               request={requestFromApproval(approval)}
               approvalId={approval.approvalId}
               initialResponse={approval.response}
-              initialRejectionReason={approval.rejectionReason}
+              {...(approval.rejectionReason === undefined
+                ? {}
+                : { initialRejectionReason: approval.rejectionReason })}
               storageKey={`${run.runId}:${approval.approvalId}`}
-              storage={typeof window === 'undefined' ? undefined : window.localStorage}
+              {...(typeof window === 'undefined' ? {} : { storage: window.localStorage })}
               onSubmit={(decision) => onApproval?.(run, approval, decision)}
             />
           ))}
         {active.items.length === 0 ? (
           <p className="production-board-empty">No {active.label.toLowerCase()} projection yet.</p>
         ) : (
           <ul>
             {active.items.map((item) => (
               <li key={item.id}>
                 <div className="production-board-item-main">
@@ -419,27 +427,28 @@ function RunDetails({
                     <span className="production-board-node-state">{item.state}</span>
                   )}
                 </div>
                 {item.detail.length > 0 && <p>{item.detail}</p>}
                 {item.links.length > 0 && (
                   <div className="production-board-links">
                     {item.links.map((link) => (
                       <a
                         key={`${link.kind}:${link.id}`}
                         href={link.href}
+                        title={link.label}
                         onClick={(event) => {
                           if (onOpenLink === undefined) return;
                           event.preventDefault();
                           onOpenLink(link.href);
                         }}
                       >
-                        {link.label}
+                        {displayBoardLinkLabel(link)}
                       </a>
                     ))}
                   </div>
                 )}
               </li>
             ))}
           </ul>
         )}
       </div>
     </section>
@@ -450,10 +459,17 @@ function requestFromApproval(approval: ProductionApprovalV1): HumanInputRequest
   return {
     kind: approval.kind,
     prompt: approval.prompt,
     ...(approval.requestPayload === undefined ? {} : { payload: approval.requestPayload }),
   };
 }
 
 function message(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
 }
+
+function displayBoardLinkLabel(link: { readonly kind: string; readonly label: string }): string {
+  if (link.kind === 'artifact' && link.label.startsWith('Reference analysis ')) {
+    return `View ${link.label.toLowerCase()}`;
+  }
+  return link.label;
+}
diff --git a/apps/editor-web/src/control-plane-client.ts b/apps/editor-web/src/control-plane-client.ts
index 41531db..2e97aa6 100644
--- a/apps/editor-web/src/control-plane-client.ts
+++ b/apps/editor-web/src/control-plane-client.ts
@@ -1,11 +1,15 @@
-import { WORKER_PROTOCOL_VERSION, type RenderJobPayload } from '@joy-media/job-protocol';
+import {
+  WORKER_PROTOCOL_VERSION,
+  type RenderJobPayload,
+  type VideoReferenceAnalyzePayload,
+} from '@joy-media/job-protocol';
 import type {
   ProductionRunAuthority,
   ProductionRunCheckpointUpdateResultV1,
   ProductionRunCheckpointUpdateV1,
   ProductionRunRecordV1,
   RecordProductionApprovalResponseInput,
   RecordProductionApprovalResponseResult,
 } from '@joy-media/workflow-engine';
 import { DerivativeAuthorityRevokedError } from './asset-resolver.js';
 import { getStoredMediaToken } from './media-session.js';
@@ -15,37 +19,57 @@ export interface BrowserWorker {
   readonly paired: boolean;
   readonly revoked: boolean;
   readonly capabilities: readonly string[];
   readonly lastSeenAt?: number;
 }
 
 export interface BrowserJob {
   readonly id: string;
   readonly projectId: string;
   readonly type: string;
-  readonly payload?: Partial<RenderJobPayload>;
+  readonly assetId?: string;
+  readonly payload?: Partial<RenderJobPayload> & Record<string, unknown>;
   readonly state: 'queued' | 'leased' | 'completed' | 'canceled' | 'failed';
   readonly progress: number;
   readonly cancelRequested: boolean;
   readonly error?: string;
   readonly derivative?: {
     readonly jobId: string;
     readonly kind: string;
+    readonly assetId?: string;
     readonly reportRef?: string;
     readonly outputRef?: string;
-    readonly findings?: number;
+    readonly findings?: number | readonly unknown[];
     readonly qualityReport?: BrowserRenderReport;
     readonly sha256?: string;
     readonly bytes?: number;
+    readonly descriptor?: {
+      readonly mimeType: string;
+      readonly width?: number;
+      readonly height?: number;
+      readonly durationUs?: number;
+    };
+    readonly summary?: {
+      readonly shotCount: number;
+      readonly cutCount: number;
+      readonly averageShotDurationUs: number;
+      readonly fastestShotDurationUs: number;
+      readonly sampleCount: number;
+      readonly transcriptSegmentCount: number;
+      readonly audioBeatCount: number;
+    };
+    readonly evidence?: readonly unknown[];
+    readonly evidenceIds?: readonly string[];
     readonly workerRef: string;
     readonly resultRef: string;
     readonly verifiedAt: number;
+    readonly model?: string;
   };
 }
 
 export interface BrowserRenderReport {
   readonly version?: number;
   readonly findings: readonly {
     readonly status: 'pass' | 'warn' | 'fail';
   }[];
   readonly artifact?: {
     readonly outputRef: string;
@@ -326,20 +350,36 @@ export class BrowserControlPlaneClient {
   ): Promise<BrowserJob> {
     return this.post(`/v1/projects/${encodeURIComponent(projectId)}/jobs`, {
       id,
       type,
       prompt,
       ...(options?.imageAssetId !== undefined ? { assetId: options.imageAssetId } : {}),
       ...(options?.model !== undefined ? { model: options.model } : {}),
       ...(options?.params !== undefined ? { params: options.params } : {}),
     });
   }
+  async enqueueReferenceAnalysis(
+    projectId: string,
+    id: string,
+    payload: VideoReferenceAnalyzePayload,
+  ): Promise<BrowserJob> {
+    return this.post(`/v1/projects/${encodeURIComponent(projectId)}/jobs`, {
+      id,
+      type: 'video.reference-analyze',
+      assetId: payload.assetId,
+      protocolVersion: WORKER_PROTOCOL_VERSION,
+      payload,
+      requirements: { capabilities: ['video.reference-analyze'], privacy: 'local-only' },
+      idempotencyKey: id,
+      maxAttempts: 2,
+    });
+  }
   async pairWorker(workerId: string, pairingCode: string): Promise<void> {
     await this.post(`/v1/workers/${encodeURIComponent(workerId)}/pair`, { pairingCode });
   }
   async revokeWorker(workerId: string): Promise<BrowserWorker> {
     return this.post(`/v1/workers/${encodeURIComponent(workerId)}/revoke`, {});
   }
   async cancel(projectId: string, jobId: string): Promise<BrowserJob> {
     return this.post(
       `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/cancel`,
       {},
diff --git a/apps/editor-web/src/production-board-model.ts b/apps/editor-web/src/production-board-model.ts
index 7fed522..475e48e 100644
--- a/apps/editor-web/src/production-board-model.ts
+++ b/apps/editor-web/src/production-board-model.ts
@@ -2,20 +2,21 @@ import type { ArtifactStore } from '@joy-media/commands';
 import type {
   ProductionApprovalV1,
   ProductionRunAuthority,
   ProductionRunEventV1,
   ProductionRunNodeProjectionV1,
   ProductionRunRecordV1,
   ProductionRunStateV1,
 } from '@joy-media/workflow-engine';
 import type { DataLane } from './data-lanes.js';
 import type { BrowserAsset } from './control-plane-client.js';
+import { parseReferenceAnalysisArtifact } from './reference-analysis-model.js';
 
 export type ProductionBoardSectionId =
   'brief' | 'scenes' | 'assets' | 'jobs' | 'approvals' | 'qa' | 'events';
 
 export interface ProductionBoardLink {
   readonly kind: 'asset' | 'artifact' | 'data-lane' | 'job' | 'provider' | 'report';
   readonly id: string;
   readonly label: string;
   readonly href: string;
 }
@@ -382,33 +383,48 @@ function artifactLinks(
       ? artifact.contentRef.assetId
       : input.assets?.some((asset) => asset.id === artifactId)
         ? artifactId
         : undefined;
   return [
     ...(assetId === undefined
       ? []
       : [link('asset', assetId, `Asset ${assetLabel(assetId, input.assets)}`)]),
     ...(artifact === undefined
       ? []
-      : [link('artifact', artifact.id, `Artifact ${artifact.label}`)]),
+      : [
+          link(
+            'artifact',
+            artifact.id,
+            referenceArtifactLabel(artifact, input.assets) ?? `Artifact ${artifact.label}`,
+          ),
+        ]),
     ...(lane === undefined ? [] : [link('data-lane', lane.item.id, `${lane.lane.label} lane`)]),
   ];
 }
 
 function link(kind: ProductionBoardLink['kind'], id: string, label: string): ProductionBoardLink {
   return { kind, id, label, href: `#${kind}:${encodeURIComponent(id)}` };
 }
 
 function assetLabel(assetId: string, assets: readonly BrowserAsset[] | undefined): string {
   return assets?.find((asset) => asset.id === assetId)?.displayName ?? assetId;
 }
 
+function referenceArtifactLabel(
+  artifact: NonNullable<ArtifactStore['artifacts'][string]>,
+  assets: readonly BrowserAsset[] | undefined,
+): string | undefined {
+  const analysis = parseReferenceAnalysisArtifact(artifact);
+  if (analysis === undefined) return undefined;
+  return `Reference analysis ${assetLabel(analysis.assetId, assets)}`;
+}
+
 function actionAvailability(
   record: ProductionRunRecordV1,
   staleRevisionConflict: boolean,
   pendingApprovals: readonly ProductionApprovalV1[],
 ): ProductionBoardActionAvailability {
   const disabledReason = staleRevisionConflict
     ? 'Project revision changed since this run parked.'
     : undefined;
   return {
     canApprove: pendingApprovals.length > 0 && !staleRevisionConflict,
diff --git a/apps/editor-web/src/reference-analysis-model.test.ts b/apps/editor-web/src/reference-analysis-model.test.ts
new file mode 100644
index 0000000..5a3ce8b
--- /dev/null
+++ b/apps/editor-web/src/reference-analysis-model.test.ts
@@ -0,0 +1,274 @@
+import { describe, expect, it } from 'vitest';
+import type { ArtifactStore, ArtifactTransaction } from '@joy-media/commands';
+import type { CreativeArtifactV2 } from '@joy-media/project-schema';
+import type { BrowserAsset } from './control-plane-client.js';
+import {
+  buildPersistReferenceAnalysisTransaction,
+  buildReferenceMarkerTransaction,
+  parseReferenceAnalysisArtifact,
+  referenceAnalysisArtifactId,
+  referenceMarkerArtifactId,
+  referenceStatusForAsset,
+} from './reference-analysis-model.js';
+import type { VideoReferenceAnalyzeReceipt } from '@joy-media/job-protocol';
+
+const VIDEO_ASSET: BrowserAsset = {
+  id: 'asset-intro',
+  projectId: 'project-1',
+  kind: 'video',
+  displayName: 'Intro reference',
+  sha256: 'b'.repeat(64),
+  bytes: 1_054_138,
+  descriptor: { mimeType: 'video/mp4', width: 320, height: 180, durationUs: 30_000_000 },
+  createdAt: 1,
+};
+
+const RECEIPT: VideoReferenceAnalyzeReceipt = {
+  kind: 'video.reference-analyze',
+  assetId: 'asset-intro',
+  sha256: VIDEO_ASSET.sha256,
+  bytes: VIDEO_ASSET.bytes,
+  descriptor: {
+    mimeType: 'video/mp4',
+    width: 320,
+    height: 180,
+    durationUs: 30_000_000,
+  },
+  summary: {
+    shotCount: 1,
+    cutCount: 0,
+    averageShotDurationUs: 30_000_000,
+    fastestShotDurationUs: 30_000_000,
+    sampleCount: 3,
+    transcriptSegmentCount: 0,
+    audioBeatCount: 2,
+  },
+  evidence: [
+    {
+      id: 'shot-00000000',
+      kind: 'shot',
+      label: 'Shot 1',
+      summary: 'Whole clip',
+      startUs: 0,
+      durationUs: 30_000_000,
+    },
+    {
+      id: 'text-safe-zone-00000000',
+      kind: 'text-safe-zone',
+      label: 'Text box',
+      summary: 'Burned-in timecode is tight to the edge',
+      safe: false,
+      boxes: [{ leftPct: 0, topPct: 0, widthPct: 0.25, heightPct: 0.16 }],
+    },
+  ],
+  evidenceIds: ['shot-00000000', 'text-safe-zone-00000000'],
+  findings: [
+    {
+      id: 'finding-1',
+      source: 'model',
+      title: 'Technical reference',
+      summary: 'Use for pacing only.',
+      evidenceIds: ['text-safe-zone-00000000'],
+    },
+  ],
+};
+
+describe('reference analysis model', () => {
+  it('builds a durable marker transaction for videos that are marked as references', () => {
+    const transaction = buildReferenceMarkerTransaction(VIDEO_ASSET, '2026-08-21T00:00:00.000Z');
+    expect(transaction).toMatchObject<ArtifactTransaction>({
+      label: 'Mark Intro reference as reference',
+      commands: [
+        {
+          type: 'artifact.create',
+          payload: {
+            artifact: expect.objectContaining({
+              id: referenceMarkerArtifactId(VIDEO_ASSET.id),
+              kind: 'metadata',
+            }),
+          },
+        },
+      ],
+    });
+  });
+
+  it('persists source hash, provenance, and evidence ids into a CreativeArtifactV2 payload', () => {
+    const transaction = buildPersistReferenceAnalysisTransaction({
+      asset: VIDEO_ASSET,
+      receipt: RECEIPT,
+      jobId: 'job-reference-1',
+      now: '2026-08-21T00:00:00.000Z',
+      store: { artifacts: {}, versions: {} },
+    });
+    const artifact = (
+      transaction.commands[0] as Extract<
+        ArtifactTransaction['commands'][number],
+        { readonly type: 'artifact.create' }
+      >
+    ).payload.artifact;
+
+    expect(artifact).toMatchObject({
+      id: referenceAnalysisArtifactId(VIDEO_ASSET.id),
+      kind: 'analysis',
+      label: 'Reference analysis · Intro reference',
+      provenance: {
+        sourceArtifactIds: [referenceMarkerArtifactId(VIDEO_ASSET.id)],
+        inputHashes: [VIDEO_ASSET.sha256],
+        createdBy: { type: 'agent', id: 'reference-analysis' },
+        jobId: 'job-reference-1',
+      },
+    });
+
+    expect(parseReferenceAnalysisArtifact(artifact)).toMatchObject({
+      assetId: VIDEO_ASSET.id,
+      sourceSha256: VIDEO_ASSET.sha256,
+      evidenceIds: RECEIPT.evidenceIds,
+      receipt: {
+        kind: 'video.reference-analyze',
+        findings: [
+          expect.objectContaining({
+            id: 'finding-1',
+            evidenceIds: ['text-safe-zone-00000000'],
+          }),
+        ],
+      },
+    });
+  });
+
+  it('updates an existing reference analysis artifact instead of duplicating it', () => {
+    const existing = buildExistingAnalysisArtifact();
+    const transaction = buildPersistReferenceAnalysisTransaction({
+      asset: VIDEO_ASSET,
+      receipt: RECEIPT,
+      jobId: 'job-reference-2',
+      now: '2026-08-21T00:01:00.000Z',
+      store: {
+        artifacts: { [existing.id]: existing },
+        versions: {},
+      },
+    });
+
+    expect(transaction.commands[0]).toMatchObject({
+      type: 'artifact.update',
+      payload: {
+        artifactId: existing.id,
+        updatedAt: '2026-08-21T00:01:00.000Z',
+      },
+    });
+  });
+
+  it('derives mark, run, and view affordances from assets, jobs, and artifacts', () => {
+    const store: ArtifactStore = {
+      artifacts: {
+        [referenceMarkerArtifactId(VIDEO_ASSET.id)]: buildMarkerArtifact(),
+        [referenceAnalysisArtifactId(VIDEO_ASSET.id)]: buildExistingAnalysisArtifact(),
+      },
+      versions: {},
+    };
+
+    expect(
+      referenceStatusForAsset({
+        asset: VIDEO_ASSET,
+        store,
+        jobs: [
+          {
+            id: 'job-reference-1',
+            type: 'video.reference-analyze',
+            assetId: VIDEO_ASSET.id,
+            state: 'queued',
+          },
+        ],
+      }),
+    ).toMatchObject({
+      marked: true,
+      canRun: false,
+      running: true,
+      canView: true,
+      analysisArtifactId: referenceAnalysisArtifactId(VIDEO_ASSET.id),
+    });
+  });
+
+  it('rejects model findings that are not backed by deterministic evidence', () => {
+    const invalidReceipt: VideoReferenceAnalyzeReceipt = {
+      ...RECEIPT,
+      findings: [
+        {
+          id: 'finding-bad',
+          source: 'model',
+          title: 'Invalid',
+          summary: 'Missing evidence',
+          evidenceIds: ['missing'],
+        },
+      ],
+    };
+
+    expect(() =>
+      buildPersistReferenceAnalysisTransaction({
+        asset: VIDEO_ASSET,
+        receipt: invalidReceipt,
+        jobId: 'job-reference-bad',
+        now: '2026-08-21T00:00:00.000Z',
+        store: { artifacts: {}, versions: {} },
+      }),
+    ).toThrow(/missing/i);
+  });
+});
+
+function buildMarkerArtifact(): CreativeArtifactV2 {
+  return {
+    id: referenceMarkerArtifactId(VIDEO_ASSET.id),
+    kind: 'metadata',
+    schemaVersion: 1,
+    revision: 0,
+    label: `Reference source · ${VIDEO_ASSET.displayName}`,
+    contentRef: {
+      type: 'inline',
+      value: JSON.stringify({
+        schemaVersion: 1,
+        type: 'reference-source',
+        assetId: VIDEO_ASSET.id,
+        sourceSha256: VIDEO_ASSET.sha256,
+      }),
+    },
+    binding: { type: 'none' },
+    provenance: {
+      sourceArtifactIds: [],
+      inputHashes: [VIDEO_ASSET.sha256],
+      createdBy: { type: 'human', id: 'editor' },
+    },
+    createdAt: '2026-08-21T00:00:00.000Z',
+    updatedAt: '2026-08-21T00:00:00.000Z',
+  };
+}
+
+function buildExistingAnalysisArtifact(): CreativeArtifactV2 {
+  return {
+    id: referenceAnalysisArtifactId(VIDEO_ASSET.id),
+    kind: 'analysis',
+    schemaVersion: 1,
+    revision: 1,
+    label: `Reference analysis · ${VIDEO_ASSET.displayName}`,
+    contentRef: {
+      type: 'inline',
+      value: JSON.stringify({
+        schemaVersion: 1,
+        type: 'reference-analysis',
+        assetId: VIDEO_ASSET.id,
+        sourceSha256: VIDEO_ASSET.sha256,
+        sourceBytes: VIDEO_ASSET.bytes,
+        evidenceIds: RECEIPT.evidenceIds,
+        jobId: 'job-reference-1',
+        receipt: RECEIPT,
+      }),
+    },
+    binding: { type: 'none' },
+    provenance: {
+      sourceArtifactIds: [referenceMarkerArtifactId(VIDEO_ASSET.id)],
+      inputHashes: [VIDEO_ASSET.sha256],
+      createdBy: { type: 'agent', id: 'reference-analysis' },
+      jobId: 'job-reference-1',
+    },
+    createdAt: '2026-08-21T00:00:00.000Z',
+    updatedAt: '2026-08-21T00:00:00.000Z',
+  };
+}
diff --git a/apps/editor-web/src/reference-analysis-model.ts b/apps/editor-web/src/reference-analysis-model.ts
new file mode 100644
index 0000000..09f84f7
--- /dev/null
+++ b/apps/editor-web/src/reference-analysis-model.ts
@@ -0,0 +1,262 @@
+import type { ArtifactStore, ArtifactTransaction } from '@joy-media/commands';
+import type { CreativeArtifactV2 } from '@joy-media/project-schema';
+import type {
+  ReferenceAnalysisFinding,
+  VideoReferenceAnalyzeReceipt,
+} from '@joy-media/job-protocol';
+import type { BrowserAsset, BrowserJob } from './control-plane-client.js';
+
+interface ReferenceMarkerDocument {
+  readonly schemaVersion: 1;
+  readonly type: 'reference-source';
+  readonly assetId: string;
+  readonly sourceSha256: string;
+  readonly sourceBytes: number;
+  readonly displayName: string;
+}
+
+export interface ReferenceAnalysisDocument {
+  readonly schemaVersion: 1;
+  readonly type: 'reference-analysis';
+  readonly assetId: string;
+  readonly sourceSha256: string;
+  readonly sourceBytes: number;
+  readonly evidenceIds: readonly string[];
+  readonly jobId: string;
+  readonly receipt: VideoReferenceAnalyzeReceipt;
+}
+
+export interface ReferenceAssetStatus {
+  readonly marked: boolean;
+  readonly running: boolean;
+  readonly canRun: boolean;
+  readonly canView: boolean;
+  readonly markerArtifactId?: string;
+  readonly analysisArtifactId?: string;
+}
+
+export function referenceMarkerArtifactId(assetId: string): string {
+  return `reference-source-${assetId}`;
+}
+
+export function referenceAnalysisArtifactId(assetId: string): string {
+  return `reference-analysis-${assetId}`;
+}
+
+export function buildReferenceMarkerTransaction(
+  asset: BrowserAsset,
+  now: string,
+): ArtifactTransaction {
+  return {
+    label: `Mark ${asset.displayName} as reference`,
+    commands: [
+      {
+        type: 'artifact.create',
+        payload: {
+          artifact: {
+            id: referenceMarkerArtifactId(asset.id),
+            kind: 'metadata',
+            schemaVersion: 1,
+            revision: 0,
+            label: `Reference source · ${asset.displayName}`,
+            contentRef: {
+              type: 'inline',
+              value: JSON.stringify({
+                schemaVersion: 1,
+                type: 'reference-source',
+                assetId: asset.id,
+                sourceSha256: asset.sha256,
+                sourceBytes: asset.bytes,
+                displayName: asset.displayName,
+              } satisfies ReferenceMarkerDocument),
+            },
+            binding: { type: 'none' },
+            provenance: {
+              sourceArtifactIds: [],
+              inputHashes: [asset.sha256],
+              createdBy: { type: 'human', id: 'editor' },
+            },
+            createdAt: now,
+            updatedAt: now,
+          },
+        },
+      },
+    ],
+  };
+}
+
+export function buildPersistReferenceAnalysisTransaction(input: {
+  readonly asset: BrowserAsset;
+  readonly receipt: VideoReferenceAnalyzeReceipt;
+  readonly jobId: string;
+  readonly now: string;
+  readonly store: ArtifactStore;
+}): ArtifactTransaction {
+  validateModelEvidence(input.receipt.findings, new Set(input.receipt.evidenceIds));
+  const artifactId = referenceAnalysisArtifactId(input.asset.id);
+  const markerId = referenceMarkerArtifactId(input.asset.id);
+  const contentRef = {
+    type: 'inline' as const,
+    value: JSON.stringify({
+      schemaVersion: 1,
+      type: 'reference-analysis',
+      assetId: input.asset.id,
+      sourceSha256: input.asset.sha256,
+      sourceBytes: input.asset.bytes,
+      evidenceIds: [...input.receipt.evidenceIds],
+      jobId: input.jobId,
+      receipt: input.receipt,
+    } satisfies ReferenceAnalysisDocument),
+  };
+  const existing = input.store.artifacts[artifactId];
+  if (existing !== undefined) {
+    return {
+      label: `Update reference analysis for ${input.asset.displayName}`,
+      commands: [
+        {
+          type: 'artifact.update',
+          payload: {
+            artifactId,
+            label: `Reference analysis · ${input.asset.displayName}`,
+            contentRef,
+            updatedAt: input.now,
+            versionId: `${artifactId}-v${input.now}`,
+          },
+        },
+      ],
+    };
+  }
+  return {
+    label: `Persist reference analysis for ${input.asset.displayName}`,
+    commands: [
+      {
+        type: 'artifact.create',
+        payload: {
+          artifact: {
+            id: artifactId,
+            kind: 'analysis',
+            schemaVersion: 1,
+            revision: 0,
+            label: `Reference analysis · ${input.asset.displayName}`,
+            contentRef,
+            binding: { type: 'none' },
+            provenance: {
+              sourceArtifactIds:
+                input.store.artifacts[markerId] === undefined ? [markerId] : [markerId],
+              inputHashes: [input.asset.sha256],
+              createdBy: { type: 'agent', id: 'reference-analysis' },
+              jobId: input.jobId,
+              ...(input.receipt.model === undefined ? {} : { modelId: input.receipt.model }),
+            },
+            createdAt: input.now,
+            updatedAt: input.now,
+          },
+        },
+      },
+    ],
+  };
+}
+
+export function parseReferenceAnalysisArtifact(
+  artifact: CreativeArtifactV2 | undefined,
+): ReferenceAnalysisDocument | undefined {
+  if (artifact?.kind !== 'analysis' || artifact.contentRef.type !== 'inline') return undefined;
+  try {
+    const parsed = JSON.parse(artifact.contentRef.value) as ReferenceAnalysisDocument;
+    if (
+      parsed?.schemaVersion !== 1 ||
+      parsed.type !== 'reference-analysis' ||
+      typeof parsed.assetId !== 'string' ||
+      typeof parsed.sourceSha256 !== 'string' ||
+      !Array.isArray(parsed.evidenceIds) ||
+      typeof parsed.jobId !== 'string' ||
+      parsed.receipt?.kind !== 'video.reference-analyze'
+    ) {
+      return undefined;
+    }
+    validateModelEvidence(parsed.receipt.findings, new Set(parsed.receipt.evidenceIds));
+    return parsed;
+  } catch {
+    return undefined;
+  }
+}
+
+export function referenceAnalysisReceiptFromDerivative(
+  derivative: BrowserJob['derivative'] | undefined,
+): VideoReferenceAnalyzeReceipt | undefined {
+  if (
+    derivative?.kind !== 'video.reference-analyze' ||
+    derivative.assetId === undefined ||
+    derivative.sha256 === undefined ||
+    derivative.bytes === undefined ||
+    derivative.descriptor === undefined ||
+    derivative.summary === undefined ||
+    derivative.evidence === undefined ||
+    derivative.evidenceIds === undefined
+  ) {
+    return undefined;
+  }
+  const findings = Array.isArray(derivative.findings)
+    ? (derivative.findings as VideoReferenceAnalyzeReceipt['findings'])
+    : undefined;
+  const receipt: VideoReferenceAnalyzeReceipt = {
+    kind: 'video.reference-analyze',
+    assetId: derivative.assetId,
+    sha256: derivative.sha256,
+    bytes: derivative.bytes,
+    descriptor: derivative.descriptor as VideoReferenceAnalyzeReceipt['descriptor'],
+    summary: derivative.summary,
+    evidence: derivative.evidence as VideoReferenceAnalyzeReceipt['evidence'],
+    evidenceIds: derivative.evidenceIds,
+    ...(findings === undefined ? {} : { findings }),
+    ...(derivative.model === undefined ? {} : { model: derivative.model }),
+  };
+  validateModelEvidence(receipt.findings, new Set(receipt.evidenceIds));
+  return receipt;
+}
+
+export function referenceStatusForAsset(input: {
+  readonly asset: BrowserAsset;
+  readonly store: ArtifactStore;
+  readonly jobs: readonly Pick<BrowserJob, 'id' | 'type' | 'assetId' | 'state'>[];
+}): ReferenceAssetStatus {
+  const markerArtifactId = referenceMarkerArtifactId(input.asset.id);
+  const analysisArtifactId = referenceAnalysisArtifactId(input.asset.id);
+  const marked =
+    input.store.artifacts[markerArtifactId] !== undefined ||
+    parseReferenceAnalysisArtifact(input.store.artifacts[analysisArtifactId]) !== undefined;
+  const running = input.jobs.some(
+    (job) =>
+      job.type === 'video.reference-analyze' &&
+      job.assetId === input.asset.id &&
+      (job.state === 'queued' || job.state === 'leased'),
+  );
+  const canView =
+    parseReferenceAnalysisArtifact(input.store.artifacts[analysisArtifactId]) !== undefined;
+  return {
+    marked,
+    running,
+    canRun: marked && !running,
+    canView,
+    ...(marked ? { markerArtifactId } : {}),
+    ...(canView ? { analysisArtifactId } : {}),
+  };
+}
+
+function validateModelEvidence(
+  findings: readonly ReferenceAnalysisFinding[] | undefined,
+  evidenceIds: ReadonlySet<string>,
+): void {
+  for (const finding of findings ?? []) {
+    if ((finding.evidenceIds ?? []).length === 0) {
+      throw new Error(`reference finding ${finding.id} must cite evidence`);
+    }
+    for (const evidenceId of finding.evidenceIds) {
+      if (!evidenceIds.has(evidenceId)) {
+        throw new Error(
+          `reference finding ${finding.id} references missing evidence ${evidenceId}`,
+        );
+      }
+    }
+  }
+}
diff --git a/apps/worker/src/control-plane-client.ts b/apps/worker/src/control-plane-client.ts
index ea348d9..9058945 100644
--- a/apps/worker/src/control-plane-client.ts
+++ b/apps/worker/src/control-plane-client.ts
@@ -1,11 +1,12 @@
 import { randomBytes } from 'node:crypto';
+import type { ReferenceAnalysisEvidence, ReferenceAnalysisFinding } from '@joy-media/job-protocol';
 import type { DeviceIdentity } from './runtime.js';
 
 export interface WorkerSessionStore {
   loadWorkerSession(): string | undefined;
   saveWorkerSession(sessionToken: string): void;
   clearWorkerSession(): void;
 }
 
 export interface LeasedJob {
   readonly id: string;
@@ -18,40 +19,53 @@ export interface LeasedJob {
     readonly privacy: string;
   };
   readonly idempotencyKey?: string;
   readonly maxAttempts?: number;
 }
 export interface WorkerJobResult {
   readonly kind:
     | 'asset.thumbnail'
     | 'image.comfy'
     | 'audio.ml-denoise'
+    | 'video.reference-analyze'
     | 'render.export'
     | 'render.inspect'
     | 'text.lm-studio'
     | 'text.openrouter'
     | 'video.runway'
     | 'edit.higgsfield';
   readonly assetId?: string;
   readonly sha256?: string;
   readonly bytes?: number;
   readonly localRef?: string;
   readonly resultRef?: string;
   readonly reportRef?: string;
   readonly outputRef?: string;
-  readonly findings?: number;
+  readonly findings?: number | readonly ReferenceAnalysisFinding[];
   readonly qualityReport?: unknown;
   readonly descriptor?: {
     readonly mimeType: string;
     readonly width?: number;
     readonly height?: number;
+    readonly durationUs?: number;
   };
+  readonly summary?: {
+    readonly shotCount: number;
+    readonly cutCount: number;
+    readonly averageShotDurationUs: number;
+    readonly fastestShotDurationUs: number;
+    readonly sampleCount: number;
+    readonly transcriptSegmentCount: number;
+    readonly audioBeatCount: number;
+  };
+  readonly evidence?: readonly ReferenceAnalysisEvidence[];
+  readonly evidenceIds?: readonly string[];
   readonly provider?: string;
   readonly text?: string;
   readonly model?: string;
 }
 
 export interface WorkerControlPlaneClientOptions {
   readonly apiUrl: string;
   readonly identity: DeviceIdentity;
   readonly sessionStore: WorkerSessionStore;
   readonly fetch?: typeof fetch;
diff --git a/apps/worker/src/reference-analysis.test.ts b/apps/worker/src/reference-analysis.test.ts
new file mode 100644
index 0000000..dfcc6e8
--- /dev/null
+++ b/apps/worker/src/reference-analysis.test.ts
@@ -0,0 +1,245 @@
+import { describe, expect, it } from 'vitest';
+import { join } from 'node:path';
+import {
+  analyzeReferenceVideo,
+  ReferenceAnalysisError,
+  validateReferenceAnalysisModelFindings,
+} from './reference-analysis.js';
+import type {
+  ReferenceAnalysisFinding,
+  VideoReferenceAnalyzeReceipt,
+} from '@joy-media/job-protocol';
+
+const SOURCE = join(
+  process.cwd(),
+  'apps',
+  'editor-web',
+  'public',
+  'media',
+  'reference',
+  'asset-intro.mp4',
+);
+
+describe('reference analysis', () => {
+  it('produces bounded deterministic evidence from the redistributable fixture', async () => {
+    const receipt = await analyzeReferenceVideo({
+      jobId: 'reference-job-1',
+      assetId: 'asset-intro',
+      sourcePath: SOURCE,
+      payload: {
+        assetId: 'asset-intro',
+        maxDurationUs: 30_000_000,
+        maxBytes: 2_000_000,
+        sampleCount: 3,
+        maxAudioBeats: 4,
+      },
+      cancelled: () => false,
+      progress: async () => undefined,
+    });
+
+    expect(receipt).toMatchObject({
+      kind: 'video.reference-analyze',
+      assetId: 'asset-intro',
+      bytes: 1_054_138,
+      descriptor: {
+        mimeType: 'video/mp4',
+        width: 320,
+        height: 180,
+        durationUs: 30_000_000,
+      },
+      summary: {
+        shotCount: 1,
+        cutCount: 0,
+        sampleCount: 3,
+        transcriptSegmentCount: 0,
+      },
+    });
+    expect(receipt.evidenceIds).toEqual(receipt.evidence.map((evidence) => evidence.id));
+    expect(receipt.evidence.filter((evidence) => evidence.kind === 'palette')).toHaveLength(3);
+    expect(receipt.evidence.filter((evidence) => evidence.kind === 'composition')).toHaveLength(3);
+    expect(receipt.evidence).toEqual(
+      expect.arrayContaining([
+        expect.objectContaining({
+          id: 'shot-00000000',
+          kind: 'shot',
+          startUs: 0,
+          durationUs: 30_000_000,
+        }),
+        expect.objectContaining({
+          id: 'text-safe-zone-00000000',
+          kind: 'text-safe-zone',
+          safe: false,
+        }),
+        expect.objectContaining({
+          id: 'transcript-00000000',
+          kind: 'transcript',
+          segments: [],
+        }),
+      ]),
+    );
+    expect(
+      receipt.evidence
+        .filter((evidence) => evidence.kind === 'audio-beat')
+        .map((evidence) => ({
+          startUs: evidence.startUs,
+          durationUs: evidence.durationUs,
+        })),
+    ).toEqual(
+      expect.arrayContaining([
+        expect.objectContaining({ startUs: expect.any(Number), durationUs: 500_000 }),
+      ]),
+    );
+  });
+
+  it('fails closed when the source is too large or too long', async () => {
+    await expect(
+      analyzeReferenceVideo({
+        jobId: 'reference-too-large',
+        assetId: 'asset-intro',
+        sourcePath: SOURCE,
+        payload: {
+          assetId: 'asset-intro',
+          maxDurationUs: 30_000_000,
+          maxBytes: 100,
+        },
+        cancelled: () => false,
+        progress: async () => undefined,
+      }),
+    ).rejects.toMatchObject({
+      code: 'REFERENCE_ANALYSIS_SOURCE_TOO_LARGE',
+    });
+
+    await expect(
+      analyzeReferenceVideo({
+        jobId: 'reference-too-long',
+        assetId: 'asset-intro',
+        sourcePath: SOURCE,
+        payload: {
+          assetId: 'asset-intro',
+          maxDurationUs: 5_000_000,
+          maxBytes: 2_000_000,
+        },
+        cancelled: () => false,
+        progress: async () => undefined,
+      }),
+    ).rejects.toMatchObject({
+      code: 'REFERENCE_ANALYSIS_SOURCE_TOO_LONG',
+    });
+  });
+
+  it('cooperatively cancels before finishing expensive steps', async () => {
+    let cancelled = false;
+    await expect(
+      analyzeReferenceVideo({
+        jobId: 'reference-cancelled',
+        assetId: 'asset-intro',
+        sourcePath: SOURCE,
+        payload: {
+          assetId: 'asset-intro',
+          maxDurationUs: 30_000_000,
+          maxBytes: 2_000_000,
+          sampleCount: 3,
+        },
+        cancelled: () => cancelled,
+        progress: async (progress) => {
+          if (progress >= 35) cancelled = true;
+        },
+      }),
+    ).rejects.toMatchObject({
+      code: 'REFERENCE_ANALYSIS_CANCELED',
+    });
+  });
+
+  it('rejects model findings that cite missing or empty evidence', () => {
+    const receipt: VideoReferenceAnalyzeReceipt = {
+      kind: 'video.reference-analyze',
+      assetId: 'asset-intro',
+      sha256: 'a'.repeat(64),
+      bytes: 1_054_138,
+      descriptor: {
+        mimeType: 'video/mp4',
+        width: 320,
+        height: 180,
+        durationUs: 30_000_000,
+      },
+      summary: {
+        shotCount: 1,
+        cutCount: 0,
+        averageShotDurationUs: 30_000_000,
+        fastestShotDurationUs: 30_000_000,
+        sampleCount: 1,
+        transcriptSegmentCount: 0,
+        audioBeatCount: 0,
+      },
+      evidence: [
+        {
+          id: 'shot-00000000',
+          kind: 'shot',
+          label: 'Shot 1',
+          summary: 'Whole clip',
+          startUs: 0,
+          durationUs: 30_000_000,
+        },
+      ],
+      evidenceIds: ['shot-00000000'],
+    };
+
+    expect(() =>
+      validateReferenceAnalysisModelFindings(receipt, [
+        {
+          id: 'finding-empty',
+          source: 'model',
+          title: 'Unsupported',
+          summary: 'No evidence attached',
+          evidenceIds: [],
+        },
+      ]),
+    ).toThrow(/evidence/i);
+
+    expect(() =>
+      validateReferenceAnalysisModelFindings(receipt, [
+        {
+          id: 'finding-missing',
+          source: 'model',
+          title: 'Unsupported',
+          summary: 'Unknown evidence id',
+          evidenceIds: ['missing-evidence'],
+        },
+      ]),
+    ).toThrow(/missing-evidence/i);
+  });
+
+  it('keeps optional model findings only when they are evidence-backed', async () => {
+    const receipt = await analyzeReferenceVideo({
+      jobId: 'reference-model-1',
+      assetId: 'asset-intro',
+      sourcePath: SOURCE,
+      payload: {
+        assetId: 'asset-intro',
+        maxDurationUs: 30_000_000,
+        maxBytes: 2_000_000,
+        sampleCount: 3,
+      },
+      cancelled: () => false,
+      progress: async () => undefined,
+      modelAnalyze: async (result): Promise<readonly ReferenceAnalysisFinding[]> => [
+        {
+          id: 'finding-1',
+          source: 'model',
+          title: 'Use as technical reference only',
+          summary:
+            'The burned-in timecode and edge-hugging title box make this a poor typography reference.',
+          evidenceIds: ['text-safe-zone-00000000', result.evidenceIds[0]!],
+        },
+      ],
+    });
+
+    expect(receipt.findings).toEqual([
+      expect.objectContaining({
+        id: 'finding-1',
+        source: 'model',
+        evidenceIds: expect.arrayContaining(['text-safe-zone-00000000']),
+      }),
+    ]);
+  });
+});
diff --git a/apps/worker/src/reference-analysis.ts b/apps/worker/src/reference-analysis.ts
new file mode 100644
index 0000000..a633732
--- /dev/null
+++ b/apps/worker/src/reference-analysis.ts
@@ -0,0 +1,552 @@
+import { createHash } from 'node:crypto';
+import { readFileSync, statSync } from 'node:fs';
+import { extname } from 'node:path';
+import { spawnSync } from 'node:child_process';
+import type {
+  ReferenceAnalysisEvidence,
+  ReferenceAnalysisFinding,
+  VideoReferenceAnalyzePayload,
+  VideoReferenceAnalyzeReceipt,
+} from '@joy-media/job-protocol';
+
+const FRAME_WIDTH = 64;
+const FRAME_HEIGHT = 36;
+const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT * 3;
+const AUDIO_SAMPLE_RATE = 8_000;
+const AUDIO_WINDOW_US = 500_000;
+
+export class ReferenceAnalysisError extends Error {
+  readonly code: string;
+
+  constructor(code: string, message: string) {
+    super(message);
+    this.name = 'ReferenceAnalysisError';
+    this.code = code;
+  }
+}
+
+export async function analyzeReferenceVideo(options: {
+  readonly jobId: string;
+  readonly assetId: string;
+  readonly sourcePath: string;
+  readonly payload: VideoReferenceAnalyzePayload;
+  readonly cancelled: () => boolean;
+  readonly progress: (progress: number) => Promise<void>;
+  readonly modelAnalyze?: (
+    receipt: VideoReferenceAnalyzeReceipt,
+  ) => Promise<readonly ReferenceAnalysisFinding[]>;
+}): Promise<VideoReferenceAnalyzeReceipt> {
+  assertNotCanceled(options.cancelled);
+  await options.progress(5);
+
+  const sourceStats = statSync(options.sourcePath);
+  if (sourceStats.size > options.payload.maxBytes) {
+    throw new ReferenceAnalysisError(
+      'REFERENCE_ANALYSIS_SOURCE_TOO_LARGE',
+      `reference source is ${sourceStats.size} bytes, above ${options.payload.maxBytes}`,
+    );
+  }
+
+  const descriptor = probeVideo(options.sourcePath);
+  if (descriptor.durationUs > options.payload.maxDurationUs) {
+    throw new ReferenceAnalysisError(
+      'REFERENCE_ANALYSIS_SOURCE_TOO_LONG',
+      `reference source is ${descriptor.durationUs}µs, above ${options.payload.maxDurationUs}`,
+    );
+  }
+  await options.progress(15);
+
+  assertNotCanceled(options.cancelled);
+  const sourceBytes = readFileSync(options.sourcePath);
+  const sha256 = createHash('sha256').update(sourceBytes).digest('hex');
+  await options.progress(25);
+
+  const sampleTimesUs = buildSampleTimes(descriptor.durationUs, options.payload.sampleCount ?? 3);
+  const sampledFrames = sampleTimesUs.map((timeUs, index) => {
+    assertNotCanceled(options.cancelled);
+    const rgb = sampleFrame(options.sourcePath, timeUs);
+    return { timeUs, rgb, index };
+  });
+  await options.progress(45);
+
+  assertNotCanceled(options.cancelled);
+  const shotEvidence = buildShotEvidence(sampledFrames, descriptor.durationUs);
+  const paletteEvidence = sampledFrames.map(({ timeUs, rgb }) => buildPaletteEvidence(timeUs, rgb));
+  const compositionEvidence = sampledFrames.map(({ timeUs, rgb }) =>
+    buildCompositionEvidence(timeUs, rgb),
+  );
+  const safeZoneEvidence = buildSafeZoneEvidence(sampledFrames[0]?.rgb);
+  const transcriptEvidence = buildTranscriptEvidence();
+  await options.progress(60);
+
+  assertNotCanceled(options.cancelled);
+  const audioBeatEvidence = buildAudioBeatEvidence(
+    decodeAudioPcm(options.sourcePath),
+    descriptor.durationUs,
+    options.payload.maxAudioBeats ?? 6,
+  );
+  await options.progress(80);
+
+  const cutRhythmEvidence = buildCutRhythmEvidence(shotEvidence);
+  const evidence: ReferenceAnalysisEvidence[] = [
+    ...shotEvidence,
+    cutRhythmEvidence,
+    ...paletteEvidence,
+    ...compositionEvidence,
+    safeZoneEvidence,
+    transcriptEvidence,
+    ...audioBeatEvidence,
+  ];
+  const baseReceipt: VideoReferenceAnalyzeReceipt = {
+    kind: 'video.reference-analyze',
+    assetId: options.assetId,
+    sha256,
+    bytes: sourceStats.size,
+    descriptor,
+    summary: {
+      shotCount: shotEvidence.length,
+      cutCount: Math.max(0, shotEvidence.length - 1),
+      averageShotDurationUs: cutRhythmEvidence.averageShotDurationUs,
+      fastestShotDurationUs: cutRhythmEvidence.fastestShotDurationUs,
+      sampleCount: sampledFrames.length,
+      transcriptSegmentCount: transcriptEvidence.segments.length,
+      audioBeatCount: audioBeatEvidence.length,
+    },
+    evidence,
+    evidenceIds: evidence.map((entry) => entry.id),
+  };
+
+  let findings: readonly ReferenceAnalysisFinding[] | undefined;
+  if (options.modelAnalyze !== undefined) {
+    assertNotCanceled(options.cancelled);
+    const nextFindings = await options.modelAnalyze(baseReceipt);
+    findings = validateReferenceAnalysisModelFindings(baseReceipt, nextFindings);
+  }
+  await options.progress(100);
+  return findings === undefined ? baseReceipt : { ...baseReceipt, findings };
+}
+
+export function validateReferenceAnalysisModelFindings(
+  receipt: VideoReferenceAnalyzeReceipt,
+  findings: readonly ReferenceAnalysisFinding[],
+): readonly ReferenceAnalysisFinding[] {
+  const evidenceIds = new Set(receipt.evidenceIds);
+  return findings.map((finding, index) => {
+    if (finding.source !== 'model' && finding.source !== 'deterministic') {
+      throw new ReferenceAnalysisError(
+        'REFERENCE_ANALYSIS_FINDING_INVALID',
+        `finding ${index} has an invalid source`,
+      );
+    }
+    if (finding.evidenceIds.length === 0) {
+      throw new ReferenceAnalysisError(
+        'REFERENCE_ANALYSIS_FINDING_INVALID',
+        `finding ${finding.id} must cite at least one evidence id`,
+      );
+    }
+    for (const evidenceId of finding.evidenceIds) {
+      if (!evidenceIds.has(evidenceId)) {
+        throw new ReferenceAnalysisError(
+          'REFERENCE_ANALYSIS_FINDING_INVALID',
+          `finding ${finding.id} references unknown evidence ${evidenceId}`,
+        );
+      }
+    }
+    return { ...finding, evidenceIds: [...finding.evidenceIds] };
+  });
+}
+
+function assertNotCanceled(cancelled: () => boolean): void {
+  if (cancelled()) {
+    throw new ReferenceAnalysisError(
+      'REFERENCE_ANALYSIS_CANCELED',
+      'reference analysis was canceled',
+    );
+  }
+}
+
+function probeVideo(sourcePath: string): VideoReferenceAnalyzeReceipt['descriptor'] {
+  const probe = spawnSync(
+    'ffprobe',
+    [
+      '-v',
+      'error',
+      '-select_streams',
+      'v:0',
+      '-show_entries',
+      'stream=width,height,duration:format=format_name',
+      '-of',
+      'json',
+      sourcePath,
+    ],
+    { shell: false, encoding: 'utf8' },
+  );
+  if (probe.status !== 0) {
+    throw new ReferenceAnalysisError(
+      'REFERENCE_ANALYSIS_PROBE_FAILED',
+      'ffprobe could not inspect the source video',
+    );
+  }
+  const parsed = JSON.parse(probe.stdout) as {
+    readonly streams?: ReadonlyArray<{
+      readonly width?: number;
+      readonly height?: number;
+      readonly duration?: string;
+    }>;
+    readonly format?: { readonly format_name?: string };
+  };
+  const stream = parsed.streams?.[0];
+  if (
+    stream === undefined ||
+    !Number.isSafeInteger(stream.width) ||
+    !Number.isSafeInteger(stream.height) ||
+    typeof stream.duration !== 'string'
+  ) {
+    throw new ReferenceAnalysisError(
+      'REFERENCE_ANALYSIS_PROBE_FAILED',
+      'video descriptor is incomplete',
+    );
+  }
+  const durationUs = Math.round(Number(stream.duration) * 1_000_000);
+  if (!Number.isSafeInteger(durationUs) || durationUs < 1) {
+    throw new ReferenceAnalysisError(
+      'REFERENCE_ANALYSIS_PROBE_FAILED',
+      'video duration is invalid',
+    );
+  }
+  return {
+    mimeType: mimeTypeFromFormat(parsed.format?.format_name, sourcePath),
+    width: Number(stream.width),
+    height: Number(stream.height),
+    durationUs,
+  };
+}
+
+function sampleFrame(sourcePath: string, timeUs: number): Uint8Array {
+  const seconds = (timeUs / 1_000_000).toFixed(6);
+  const ffmpeg = spawnSync(
+    'ffmpeg',
+    [
+      '-v',
+      'error',
+      '-ss',
+      seconds,
+      '-i',
+      sourcePath,
+      '-frames:v',
+      '1',
+      '-vf',
+      `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}`,
+      '-f',
+      'rawvideo',
+      '-pix_fmt',
+      'rgb24',
+      '-',
+    ],
+    { shell: false, encoding: 'buffer', maxBuffer: FRAME_BYTES * 4 },
+  );
+  if (ffmpeg.status !== 0 || ffmpeg.stdout.length < FRAME_BYTES) {
+    throw new ReferenceAnalysisError(
+      'REFERENCE_ANALYSIS_FRAME_FAILED',
+      `ffmpeg could not sample the frame at ${seconds}s`,
+    );
+  }
+  return new Uint8Array(ffmpeg.stdout.subarray(0, FRAME_BYTES));
+}
+
+function buildSampleTimes(durationUs: number, requestedSamples: number): readonly number[] {
+  const sampleCount = Math.max(1, Math.min(6, requestedSamples));
+  if (sampleCount === 1) return [0];
+  const stepUs = Math.floor(durationUs / sampleCount);
+  const result: number[] = [];
+  for (let index = 0; index < sampleCount; index++) {
+    result.push(Math.min(durationUs - 1, stepUs * index));
+  }
+  return [...new Set(result)];
+}
+
+function buildShotEvidence(
+  samples: readonly { readonly timeUs: number; readonly rgb: Uint8Array }[],
+  durationUs: number,
+): readonly Extract<ReferenceAnalysisEvidence, { readonly kind: 'shot' }>[] {
+  const cutTimesUs: number[] = [];
+  for (let index = 1; index < samples.length; index++) {
+    const previous = samples[index - 1];
+    const current = samples[index];
+    if (previous === undefined || current === undefined) continue;
+    const delta = frameDelta(previous.rgb, current.rgb);
+    if (delta >= 0.2) cutTimesUs.push(current.timeUs);
+  }
+  const boundaries = [0, ...cutTimesUs, durationUs];
+  const shots: Extract<ReferenceAnalysisEvidence, { readonly kind: 'shot' }>[] = [];
+  for (let index = 0; index < boundaries.length - 1; index++) {
+    const startUs = boundaries[index] ?? 0;
+    const endUs = boundaries[index + 1] ?? durationUs;
+    shots.push({
+      id: `shot-${String(startUs).padStart(8, '0')}`,
+      kind: 'shot',
+      label: `Shot ${index + 1}`,
+      summary:
+        cutTimesUs.length === 0
+          ? 'No deterministic cut boundary exceeded the threshold; the clip reads as one shot.'
+          : `Shot from ${(startUs / 1_000_000).toFixed(1)}s to ${(endUs / 1_000_000).toFixed(1)}s.`,
+      startUs,
+      durationUs: endUs - startUs,
+    });
+  }
+  return shots;
+}
+
+function buildCutRhythmEvidence(
+  shots: readonly Extract<ReferenceAnalysisEvidence, { readonly kind: 'shot' }>[],
+): Extract<ReferenceAnalysisEvidence, { readonly kind: 'cut-rhythm' }> {
+  const durations = shots.map((shot) => shot.durationUs);
+  const totalDurationUs = durations.reduce((total, value) => total + value, 0);
+  const averageShotDurationUs = Math.round(totalDurationUs / Math.max(1, durations.length));
+  const fastestShotDurationUs = Math.min(...durations);
+  const cutCount = Math.max(0, shots.length - 1);
+  return {
+    id: 'cut-rhythm-00000000',
+    kind: 'cut-rhythm',
+    label: 'Cut rhythm',
+    summary:
+      cutCount === 0
+        ? 'No cut boundary exceeded the deterministic threshold.'
+        : `${cutCount} deterministic cut(s) across ${shots.length} shots.`,
+    cutCount,
+    averageShotDurationUs,
+    fastestShotDurationUs,
+  };
+}
+
+function buildPaletteEvidence(
+  timeUs: number,
+  rgb: Uint8Array,
+): Extract<ReferenceAnalysisEvidence, { readonly kind: 'palette' }> {
+  const counts = new Map<string, number>();
+  for (let offset = 0; offset < rgb.length; offset += 9) {
+    const color = quantizeColor(rgb[offset] ?? 0, rgb[offset + 1] ?? 0, rgb[offset + 2] ?? 0);
+    counts.set(color, (counts.get(color) ?? 0) + 1);
+  }
+  const swatches = [...counts.entries()]
+    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
+    .slice(0, 5)
+    .map(([color]) => color);
+  return {
+    id: `palette-${String(timeUs).padStart(8, '0')}`,
+    kind: 'palette',
+    label: `Palette ${(timeUs / 1_000_000).toFixed(1)}s`,
+    summary: `Dominant swatches sampled at ${(timeUs / 1_000_000).toFixed(1)}s.`,
+    startUs: timeUs,
+    swatches,
+  };
+}
+
+function buildCompositionEvidence(
+  timeUs: number,
+  rgb: Uint8Array,
+): Extract<ReferenceAnalysisEvidence, { readonly kind: 'composition' }> {
+  let totalWeight = 0;
+  let weightedX = 0;
+  let weightedY = 0;
+  let brightestTopRow = 0;
+  for (let y = 0; y < FRAME_HEIGHT; y++) {
+    let rowWeight = 0;
+    for (let x = 0; x < FRAME_WIDTH; x++) {
+      const offset = (y * FRAME_WIDTH + x) * 3;
+      const weight = luminance(rgb[offset] ?? 0, rgb[offset + 1] ?? 0, rgb[offset + 2] ?? 0) + 1;
+      totalWeight += weight;
+      rowWeight += weight;
+      weightedX += weight * x;
+      weightedY += weight * y;
+    }
+    if (rowWeight > brightestTopRow && y < FRAME_HEIGHT / 3) brightestTopRow = rowWeight;
+  }
+  const xPct = totalWeight === 0 ? 0.5 : weightedX / totalWeight / (FRAME_WIDTH - 1);
+  const yPct = totalWeight === 0 ? 0.5 : weightedY / totalWeight / (FRAME_HEIGHT - 1);
+  return {
+    id: `composition-${String(timeUs).padStart(8, '0')}`,
+    kind: 'composition',
+    label: `Composition ${(timeUs / 1_000_000).toFixed(1)}s`,
+    summary: `Weighted focal point near ${(xPct * 100).toFixed(0)}% × ${(yPct * 100).toFixed(0)}%.`,
+    startUs: timeUs,
+    focalPoint: { xPct, yPct },
+    balance: xPct < 0.4 ? 'left' : xPct > 0.6 ? 'right' : 'center',
+    headroomPct: Math.max(0, Math.min(1, brightestTopRow / (FRAME_WIDTH * 256))),
+  };
+}
+
+function buildSafeZoneEvidence(
+  rgb: Uint8Array | undefined,
+): Extract<ReferenceAnalysisEvidence, { readonly kind: 'text-safe-zone' }> {
+  const boxes: { leftPct: number; topPct: number; widthPct: number; heightPct: number }[] = [];
+  if (rgb !== undefined) {
+    let minX = FRAME_WIDTH;
+    let minY = FRAME_HEIGHT;
+    let maxX = -1;
+    let maxY = -1;
+    for (let y = 0; y < Math.ceil(FRAME_HEIGHT * 0.3); y++) {
+      for (let x = 0; x < Math.ceil(FRAME_WIDTH * 0.4); x++) {
+        const offset = (y * FRAME_WIDTH + x) * 3;
+        if (luminance(rgb[offset] ?? 0, rgb[offset + 1] ?? 0, rgb[offset + 2] ?? 0) < 18) {
+          minX = Math.min(minX, x);
+          minY = Math.min(minY, y);
+          maxX = Math.max(maxX, x);
+          maxY = Math.max(maxY, y);
+        }
+      }
+    }
+    if (maxX >= minX && maxY >= minY) {
+      boxes.push({
+        leftPct: minX / FRAME_WIDTH,
+        topPct: minY / FRAME_HEIGHT,
+        widthPct: (maxX - minX + 1) / FRAME_WIDTH,
+        heightPct: (maxY - minY + 1) / FRAME_HEIGHT,
+      });
+    }
+  }
+  const safe = boxes.every(
+    (box) =>
+      box.leftPct >= 0.1 &&
+      box.topPct >= 0.1 &&
+      box.leftPct + box.widthPct <= 0.9 &&
+      box.topPct + box.heightPct <= 0.9,
+  );
+  return {
+    id: 'text-safe-zone-00000000',
+    kind: 'text-safe-zone',
+    label: 'Text safe zone',
+    summary:
+      boxes.length === 0
+        ? 'No deterministic text-like dark box was detected in the sampled frame.'
+        : safe
+          ? 'Detected text region stays within the title-safe zone.'
+          : 'Detected text region touches the frame edge and falls outside the title-safe zone.',
+    safe,
+    boxes,
+  };
+}
+
+function buildTranscriptEvidence(): Extract<
+  ReferenceAnalysisEvidence,
+  { readonly kind: 'transcript' }
+> {
+  return {
+    id: 'transcript-00000000',
+    kind: 'transcript',
+    label: 'Transcript',
+    summary:
+      'Deterministic analysis does not infer speech text; no transcript segments were produced.',
+    segments: [],
+  };
+}
+
+function decodeAudioPcm(sourcePath: string): Int16Array {
+  const ffmpeg = spawnSync(
+    'ffmpeg',
+    [
+      '-v',
+      'error',
+      '-i',
+      sourcePath,
+      '-ac',
+      '1',
+      '-ar',
+      String(AUDIO_SAMPLE_RATE),
+      '-f',
+      's16le',
+      '-',
+    ],
+    { shell: false, encoding: 'buffer', maxBuffer: 8_000_000 },
+  );
+  if (ffmpeg.status !== 0 || ffmpeg.stdout.length === 0) {
+    throw new ReferenceAnalysisError(
+      'REFERENCE_ANALYSIS_AUDIO_FAILED',
+      'ffmpeg could not decode the audio track',
+    );
+  }
+  const buffer = ffmpeg.stdout;
+  return new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
+}
+
+function buildAudioBeatEvidence(
+  pcm: Int16Array,
+  durationUs: number,
+  maxAudioBeats: number,
+): readonly Extract<ReferenceAnalysisEvidence, { readonly kind: 'audio-beat' }>[] {
+  if (pcm.length === 0 || maxAudioBeats === 0) return [];
+  const samplesPerWindow = Math.max(
+    1,
+    Math.round((AUDIO_SAMPLE_RATE * AUDIO_WINDOW_US) / 1_000_000),
+  );
+  const windows = Math.ceil(pcm.length / samplesPerWindow);
+  const energies: number[] = [];
+  for (let windowIndex = 0; windowIndex < windows; windowIndex++) {
+    let energy = 0;
+    let count = 0;
+    const start = windowIndex * samplesPerWindow;
+    const end = Math.min(pcm.length, start + samplesPerWindow);
+    for (let index = start; index < end; index++) {
+      const sample = pcm[index] ?? 0;
+      energy += sample * sample;
+      count++;
+    }
+    energies.push(count === 0 ? 0 : Math.sqrt(energy / count));
+  }
+  const averageEnergy = energies.reduce((total, value) => total + value, 0) / energies.length;
+  const candidates = energies
+    .map((energy, index) => ({ energy, index }))
+    .filter(({ energy, index }) => {
+      const previous = energies[index - 1] ?? -Infinity;
+      const next = energies[index + 1] ?? -Infinity;
+      return energy >= previous && energy >= next && energy >= averageEnergy * 1.05;
+    })
+    .sort((left, right) => right.energy - left.energy || left.index - right.index)
+    .slice(0, maxAudioBeats)
+    .sort((left, right) => left.index - right.index);
+  if (candidates.length === 0) {
+    const strongest = energies
+      .map((energy, index) => ({ energy, index }))
+      .sort((left, right) => right.energy - left.energy || left.index - right.index)
+      .slice(0, Math.min(1, maxAudioBeats));
+    candidates.push(...strongest);
+  }
+  return candidates.map(({ energy, index }) => {
+    const startUs = Math.min(durationUs - 1, index * AUDIO_WINDOW_US);
+    return {
+      id: `audio-beat-${String(startUs).padStart(8, '0')}`,
+      kind: 'audio-beat',
+      label: `Audio beat ${(startUs / 1_000_000).toFixed(1)}s`,
+      summary: `Energy peak sampled in the ${(AUDIO_WINDOW_US / 1_000_000).toFixed(1)}s analysis window.`,
+      startUs,
+      durationUs: AUDIO_WINDOW_US,
+      strength: Number((energy / 32_768).toFixed(4)),
+    };
+  });
+}
+
+function frameDelta(left: Uint8Array, right: Uint8Array): number {
+  let total = 0;
+  const length = Math.min(left.length, right.length);
+  for (let index = 0; index < length; index++)
+    total += Math.abs((left[index] ?? 0) - (right[index] ?? 0));
+  return total / Math.max(1, length) / 255;
+}
+
+function quantizeColor(red: number, green: number, blue: number): string {
+  const quantize = (value: number) => Math.round(value / 51) * 51;
+  return `#${[quantize(red), quantize(green), quantize(blue)]
+    .map((value) => value.toString(16).padStart(2, '0'))
+    .join('')}`;
+}
+
+function luminance(red: number, green: number, blue: number): number {
+  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
+}
+
+function mimeTypeFromFormat(formatName: string | undefined, sourcePath: string): string {
+  if (formatName?.includes('mp4') === true || extname(sourcePath).toLowerCase() === '.mp4') {
+    return 'video/mp4';
+  }
+  return 'video/quicktime';
+}
diff --git a/apps/worker/src/runtime.test.ts b/apps/worker/src/runtime.test.ts
index 2adab88..c206645 100644
--- a/apps/worker/src/runtime.test.ts
+++ b/apps/worker/src/runtime.test.ts
@@ -23,20 +23,21 @@ describe('Worker runtime', () => {
     };
     const first = getDeviceIdentity(store, new Date('2026-01-01'));
     expect(getDeviceIdentity(store)).toEqual(first);
     const runtime = new WorkerRuntime(
       first,
       detectMediaTools((tool) => tool === 'ffmpeg' || tool === 'ffprobe'),
     );
     expect(runtime.hello('win32', 'x64').capabilities).toEqual([
       'asset.thumbnail',
       'render.export',
+      'video.reference-analyze',
     ]);
   });
   it('bounds logs and cooperatively cancels jobs', async () => {
     const log = new BoundedLog(2);
     log.write('a');
     log.write('b');
     log.write('c');
     expect(log.lines()).toEqual(['b', 'c']);
     const runtime = new WorkerRuntime(
       { workerId: 'w', createdAt: 'now' },
@@ -213,20 +214,21 @@ describe('Worker runtime', () => {
   });
 
   it('advertises GPU capabilities only when local env is set', () => {
     const runtime = new WorkerRuntime(
       { workerId: 'w', createdAt: 'now' },
       { ffmpeg: true, ffprobe: true, comfy: true, mlDenoise: true, aiProviders: [] },
     );
     expect(runtime.hello('linux', 'x64').capabilities).toEqual([
       'asset.thumbnail',
       'render.export',
+      'video.reference-analyze',
       'image.comfy',
       'audio.ml-denoise',
     ]);
   });
 
   it('fails image.comfy honestly until a non-fixture workflow is wired', async () => {
     const runtime = new WorkerRuntime(
       { workerId: 'worker-comfy', createdAt: '2026-08-21T00:00:00.000Z' },
       { ffmpeg: true, ffprobe: true, comfy: true, mlDenoise: false, aiProviders: [] },
     );
diff --git a/apps/worker/src/runtime.ts b/apps/worker/src/runtime.ts
index 3737782..a0ba84d 100644
--- a/apps/worker/src/runtime.ts
+++ b/apps/worker/src/runtime.ts
@@ -5,38 +5,44 @@ import {
   readFileSync,
   renameSync,
   writeFileSync,
   mkdtempSync,
 } from 'node:fs';
 import { homedir, tmpdir } from 'node:os';
 import { dirname, join } from 'node:path';
 import { spawn, spawnSync } from 'node:child_process';
 import { createHash, randomUUID } from 'node:crypto';
 import { setTimeout as sleep } from 'node:timers/promises';
-import type { WorkerCapability, WorkerHello } from '@joy-media/job-protocol';
+import type {
+  VideoReferenceAnalyzePayload,
+  VideoReferenceAnalyzeReceipt,
+  WorkerCapability,
+  WorkerHello,
+} from '@joy-media/job-protocol';
 import { WORKER_PROTOCOL_VERSION } from '@joy-media/job-protocol';
 import type { RenderBundleV1 } from '@joy-media/render-planner';
 import {
   readGpuDerivative,
   runAudioMlDenoiseJob,
   runImageComfyJob,
   type LocalGpuReceipt,
 } from './local-gpu.js';
 import {
   loadAiProviderConfigs,
   runAiJob,
   getConfiguredProviders,
   type LocalAiReceipt,
   type AiProvider,
 } from './local-ai.js';
 import { executeLeasedExport, type RenderExportReceiptV1 } from './export-job.js';
 import { mediaResolverFromAssetSourceRegistry } from './worker-media-resolver.js';
+import { analyzeReferenceVideo, type ReferenceAnalysisError } from './reference-analysis.js';
 
 export interface DeviceIdentity {
   readonly workerId: string;
   readonly createdAt: string;
 }
 export interface IdentityStore {
   load(): DeviceIdentity | undefined;
   save(identity: DeviceIdentity): void;
 }
 export interface PersistentWorkerStore extends IdentityStore {
@@ -239,21 +245,21 @@ export class WorkerRuntime {
     readonly identity: DeviceIdentity,
     readonly tools: ToolAvailability,
     private readonly options: {
       readonly sources?: LocalAssetSourceRegistry;
       readonly derivativeDirectory?: string;
     } = {},
   ) {}
   hello(platform: string, architecture: string): WorkerHello {
     const capabilities: WorkerCapability[] = [];
     if (this.tools.ffmpeg && this.tools.ffprobe) {
-      capabilities.push('asset.thumbnail', 'render.export');
+      capabilities.push('asset.thumbnail', 'render.export', 'video.reference-analyze');
     }
     if (this.tools.comfy) capabilities.push('image.comfy');
     if (this.tools.mlDenoise) capabilities.push('audio.ml-denoise');
     if (this.tools.aiProviders.includes('lm-studio')) capabilities.push('text.lm-studio');
     if (this.tools.aiProviders.includes('openrouter')) capabilities.push('text.openrouter');
     if (this.tools.aiProviders.includes('runway')) capabilities.push('video.runway');
     if (this.tools.aiProviders.includes('higgsfield')) capabilities.push('edit.higgsfield');
     return {
       protocolVersion: WORKER_PROTOCOL_VERSION,
       workerId: this.identity.workerId,
@@ -272,20 +278,26 @@ export class WorkerRuntime {
       readonly assetId?: string;
       readonly payload?: {
         readonly bundle?: RenderBundleV1;
         readonly frameLimit?: number;
         readonly reportRef?: string;
         readonly prompt?: string;
         readonly model?: string;
         readonly negativePrompt?: string;
         readonly imageAssetId?: string;
         readonly params?: Record<string, unknown>;
+        readonly assetId?: string;
+        readonly maxDurationUs?: number;
+        readonly maxBytes?: number;
+        readonly sampleCount?: number;
+        readonly maxAudioBeats?: number;
+        readonly includeModelAnalysis?: boolean;
       };
     },
     options: {
       readonly cancelled: () => boolean;
       readonly progress: (progress: number) => Promise<void>;
     },
   ): Promise<
     | {
         readonly state: 'completed';
         readonly result: WorkerDerivativeReceipt;
@@ -339,24 +351,84 @@ export class WorkerRuntime {
         this.log.write(`job ${job.id} completed`);
         return { state: 'completed', result };
       } catch (error) {
         if (error instanceof Error && error.message === 'canceled') {
           this.log.write(`job ${job.id} canceled`);
           return { state: 'canceled' };
         }
         throw error;
       }
     }
+    if (job.type === 'video.reference-analyze') {
+      if (!this.tools.ffmpeg || !this.tools.ffprobe) {
+        throw new Error('FFmpeg and FFprobe are required');
+      }
+      if (options.cancelled()) return { state: 'canceled' };
+      const payload = job.payload as
+        | (Partial<VideoReferenceAnalyzePayload> & {
+            readonly model?: string;
+          })
+        | undefined;
+      const sourceAssetId = typeof payload?.assetId === 'string' ? payload.assetId : job.assetId;
+      if (sourceAssetId === undefined) {
+        throw new Error('video.reference-analyze requires an assetId');
+      }
+      const sourcePath = this.options.sources?.resolve(sourceAssetId);
+      if (sourcePath === undefined) {
+        throw new Error(`asset ${sourceAssetId} is not available on this Worker`);
+      }
+      this.log.write(`job ${job.id} started (video.reference-analyze)`);
+      try {
+        const result = await analyzeReferenceVideo({
+          jobId: job.id,
+          assetId: sourceAssetId,
+          sourcePath,
+          payload: {
+            assetId: sourceAssetId,
+            maxDurationUs:
+              typeof payload?.maxDurationUs === 'number'
+                ? payload.maxDurationUs
+                : 15 * 60 * 1_000_000,
+            maxBytes:
+              typeof payload?.maxBytes === 'number' ? payload.maxBytes : 256 * 1_024 * 1_024,
+            ...(typeof payload?.sampleCount === 'number'
+              ? { sampleCount: payload.sampleCount }
+              : {}),
+            ...(typeof payload?.maxAudioBeats === 'number'
+              ? { maxAudioBeats: payload.maxAudioBeats }
+              : {}),
+            ...(typeof payload?.includeModelAnalysis === 'boolean'
+              ? { includeModelAnalysis: payload.includeModelAnalysis }
+              : {}),
+            ...(typeof payload?.model === 'string' ? { model: payload.model } : {}),
+          },
+          cancelled: options.cancelled,
+          progress: options.progress,
+        });
+        this.log.write(`job ${job.id} completed`);
+        return { state: 'completed', result };
+      } catch (error) {
+        if (
+          error instanceof Error &&
+          'code' in error &&
+          (error as ReferenceAnalysisError).code === 'REFERENCE_ANALYSIS_CANCELED'
+        ) {
+          this.log.write(`job ${job.id} canceled`);
+          return { state: 'canceled' };
+        }
+        throw error;
+      }
+    }
     // AI provider jobs (LM Studio, OpenRouter, Runway, Higgsfield)
     if (
       job.type.startsWith('text.') ||
-      job.type.startsWith('video.') ||
+      (job.type.startsWith('video.') && job.type !== 'video.reference-analyze') ||
       job.type.startsWith('edit.')
     ) {
       const provider = job.type.replace(/^(text\.|video\.|edit\.)/, '') as AiProvider;
       const derivativeDirectory =
         this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
       this.log.write(`job ${job.id} started (${job.type})`);
       try {
         const result = await runAiJob({
           jobId: job.id,
           provider,
@@ -535,21 +607,25 @@ function retainedAiDerivativeExtension(
   }
   if (result.descriptor.mimeType !== 'image/png') {
     throw new Error(
       `unsupported retained AI derivative mime type for ${result.kind}: ${result.descriptor.mimeType}`,
     );
   }
   return 'png';
 }
 
 export type WorkerDerivativeReceipt =
-  RealThumbnailReceipt | LocalGpuReceipt | ProtocolAiReceipt | RenderExportReceiptV1;
+  | RealThumbnailReceipt
+  | LocalGpuReceipt
+  | ProtocolAiReceipt
+  | ReferenceAnalysisReceipt
+  | RenderExportReceiptV1;
 
 export type ProtocolAiReceipt =
   | {
       readonly kind: 'text.lm-studio' | 'text.openrouter';
       readonly resultRef: string;
       readonly sha256: string;
       readonly bytes: number;
       readonly model?: string;
     }
   | {
@@ -572,20 +648,22 @@ export interface RealThumbnailReceipt {
   readonly sha256: string;
   readonly bytes: number;
   readonly localRef: string;
   readonly descriptor: {
     readonly mimeType: 'image/jpeg';
     readonly width: number;
     readonly height: number;
   };
 }
 
+export type ReferenceAnalysisReceipt = VideoReferenceAnalyzeReceipt;
+
 export function workerReceiptFromAiResult(
   job: { readonly id: string; readonly type: string },
   result: LocalAiReceipt,
 ): ProtocolAiReceipt {
   if (job.type === 'text.lm-studio' || job.type === 'text.openrouter') {
     if (result.kind !== 'text') {
       throw new Error(`AI_OUTPUT_UNAVAILABLE: ${job.type} only supports text outputs`);
     }
     const text = result.text ?? '';
     const bytes = Buffer.from(text, 'utf8');
diff --git a/packages/job-protocol/src/index.ts b/packages/job-protocol/src/index.ts
index 39ccb6f..df1929e 100644
--- a/packages/job-protocol/src/index.ts
+++ b/packages/job-protocol/src/index.ts
@@ -42,18 +42,25 @@ export type {
   RenderCapability,
   RenderExportJob,
   RenderExportReceipt,
   RenderInspectJob,
   RenderInspectReceipt,
   RenderJob,
   RenderJobPayload,
   RenderJobType,
   RenderReceipt,
 } from './render-jobs.js';
-export type { MediaAnalysisJob } from './media-analysis-jobs.js';
+export type {
+  MediaAnalysisJob,
+  ReferenceAnalysisEvidence,
+  ReferenceAnalysisFinding,
+  VideoReferenceAnalyzeJob,
+  VideoReferenceAnalyzePayload,
+  VideoReferenceAnalyzeReceipt,
+} from './media-analysis-jobs.js';
 export type {
   AgentJobState,
   AgentJobRequest,
   AgentJobResult,
   AgentJobSnapshot,
   AgentJobClient,
 } from './agent-jobs.js';
diff --git a/packages/job-protocol/src/media-analysis-jobs.ts b/packages/job-protocol/src/media-analysis-jobs.ts
index 473ccd3..0460056 100644
--- a/packages/job-protocol/src/media-analysis-jobs.ts
+++ b/packages/job-protocol/src/media-analysis-jobs.ts
@@ -1,3 +1,380 @@
-import type { AiJob, ThumbnailJob } from './protocol.js';
+export type ReferenceAnalysisEvidenceKind =
+  | 'shot'
+  | 'cut-rhythm'
+  | 'palette'
+  | 'composition'
+  | 'text-safe-zone'
+  | 'transcript'
+  | 'audio-beat';
 
-export type MediaAnalysisJob = ThumbnailJob | AiJob;
+export interface ReferenceAnalysisBox {
+  readonly leftPct: number;
+  readonly topPct: number;
+  readonly widthPct: number;
+  readonly heightPct: number;
+}
+
+export interface ReferenceTranscriptSegment {
+  readonly startUs: number;
+  readonly endUs: number;
+  readonly text: string;
+}
+
+export type ReferenceAnalysisEvidence =
+  | {
+      readonly id: string;
+      readonly kind: 'shot';
+      readonly label: string;
+      readonly summary: string;
+      readonly startUs: number;
+      readonly durationUs: number;
+    }
+  | {
+      readonly id: string;
+      readonly kind: 'cut-rhythm';
+      readonly label: string;
+      readonly summary: string;
+      readonly cutCount: number;
+      readonly averageShotDurationUs: number;
+      readonly fastestShotDurationUs: number;
+    }
+  | {
+      readonly id: string;
+      readonly kind: 'palette';
+      readonly label: string;
+      readonly summary: string;
+      readonly startUs: number;
+      readonly swatches: readonly string[];
+    }
+  | {
+      readonly id: string;
+      readonly kind: 'composition';
+      readonly label: string;
+      readonly summary: string;
+      readonly startUs: number;
+      readonly focalPoint: { readonly xPct: number; readonly yPct: number };
+      readonly balance: 'left' | 'center' | 'right';
+      readonly headroomPct: number;
+    }
+  | {
+      readonly id: string;
+      readonly kind: 'text-safe-zone';
+      readonly label: string;
+      readonly summary: string;
+      readonly safe: boolean;
+      readonly boxes: readonly ReferenceAnalysisBox[];
+    }
+  | {
+      readonly id: string;
+      readonly kind: 'transcript';
+      readonly label: string;
+      readonly summary: string;
+      readonly segments: readonly ReferenceTranscriptSegment[];
+    }
+  | {
+      readonly id: string;
+      readonly kind: 'audio-beat';
+      readonly label: string;
+      readonly summary: string;
+      readonly startUs: number;
+      readonly durationUs: number;
+      readonly strength: number;
+    };
+
+export interface ReferenceAnalysisFinding {
+  readonly id: string;
+  readonly source: 'deterministic' | 'model';
+  readonly title: string;
+  readonly summary: string;
+  readonly evidenceIds: readonly string[];
+}
+
+export interface VideoReferenceAnalyzePayload {
+  readonly assetId: string;
+  readonly maxDurationUs: number;
+  readonly maxBytes: number;
+  readonly sampleCount?: number;
+  readonly maxAudioBeats?: number;
+  readonly includeModelAnalysis?: boolean;
+  readonly model?: string;
+}
+
+export interface VideoReferenceAnalyzeJob {
+  readonly protocolVersion: 1;
+  readonly jobId: string;
+  readonly type: 'video.reference-analyze';
+  readonly payload: VideoReferenceAnalyzePayload;
+  readonly requirements: {
+    readonly capabilities: readonly string[];
+    readonly privacy: 'local-only' | 'remote-api';
+  };
+  readonly idempotencyKey: string;
+  readonly maxAttempts: number;
+}
+
+export interface VideoReferenceAnalyzeReceipt {
+  /**
+   * For deterministic reference analysis this hash/byte pair always refers to
+   * the analyzed source asset, not to an output blob.
+   */
+  readonly kind: 'video.reference-analyze';
+  readonly assetId: string;
+  readonly sha256: string;
+  readonly bytes: number;
+  readonly descriptor: {
+    readonly mimeType: string;
+    readonly width: number;
+    readonly height: number;
+    readonly durationUs: number;
+  };
+  readonly summary: {
+    readonly shotCount: number;
+    readonly cutCount: number;
+    readonly averageShotDurationUs: number;
+    readonly fastestShotDurationUs: number;
+    readonly sampleCount: number;
+    readonly transcriptSegmentCount: number;
+    readonly audioBeatCount: number;
+  };
+  readonly evidence: readonly ReferenceAnalysisEvidence[];
+  readonly evidenceIds: readonly string[];
+  readonly findings?: readonly ReferenceAnalysisFinding[];
+  readonly model?: string;
+}
+
+export type MediaAnalysisJob = VideoReferenceAnalyzeJob;
+
+export function assertValidVideoReferenceAnalyzePayload(
+  payload: unknown,
+  label = 'payload',
+): asserts payload is VideoReferenceAnalyzePayload {
+  const value = requireRecord(payload, label);
+  requireOpaqueId(value.assetId, `${label}.assetId`);
+  requirePositiveInteger(value.maxDurationUs, `${label}.maxDurationUs`);
+  requirePositiveInteger(value.maxBytes, `${label}.maxBytes`);
+  if (value.sampleCount !== undefined)
+    requireIntegerInRange(value.sampleCount, 1, 12, `${label}.sampleCount`);
+  if (value.maxAudioBeats !== undefined)
+    requireIntegerInRange(value.maxAudioBeats, 0, 32, `${label}.maxAudioBeats`);
+  if (value.includeModelAnalysis !== undefined && typeof value.includeModelAnalysis !== 'boolean') {
+    throw new Error(`${label}.includeModelAnalysis must be a boolean`);
+  }
+  if (value.model !== undefined && typeof value.model !== 'string') {
+    throw new Error(`${label}.model must be a string`);
+  }
+}
+
+export function assertValidVideoReferenceAnalyzeReceipt(
+  receipt: unknown,
+  label = 'receipt',
+): asserts receipt is VideoReferenceAnalyzeReceipt {
+  const value = requireRecord(receipt, label);
+  requireOpaqueId(value.assetId, `${label}.assetId`);
+  requireHash(value.sha256, `${label}.sha256`);
+  requirePositiveInteger(value.bytes, `${label}.bytes`);
+  const descriptor = requireRecord(value.descriptor, `${label}.descriptor`);
+  if (typeof descriptor.mimeType !== 'string' || !descriptor.mimeType.startsWith('video/')) {
+    throw new Error(`${label}.descriptor.mimeType must be a video MIME type`);
+  }
+  requirePositiveInteger(descriptor.width, `${label}.descriptor.width`);
+  requirePositiveInteger(descriptor.height, `${label}.descriptor.height`);
+  requirePositiveInteger(descriptor.durationUs, `${label}.descriptor.durationUs`);
+  const summary = requireRecord(value.summary, `${label}.summary`);
+  requireNonNegativeInteger(summary.shotCount, `${label}.summary.shotCount`);
+  requireNonNegativeInteger(summary.cutCount, `${label}.summary.cutCount`);
+  requirePositiveInteger(summary.averageShotDurationUs, `${label}.summary.averageShotDurationUs`);
+  requirePositiveInteger(summary.fastestShotDurationUs, `${label}.summary.fastestShotDurationUs`);
+  requirePositiveInteger(summary.sampleCount, `${label}.summary.sampleCount`);
+  requireNonNegativeInteger(
+    summary.transcriptSegmentCount,
+    `${label}.summary.transcriptSegmentCount`,
+  );
+  requireNonNegativeInteger(summary.audioBeatCount, `${label}.summary.audioBeatCount`);
+  const evidence = requireArray(value.evidence, `${label}.evidence`);
+  if (evidence.length === 0 || evidence.length > 200) {
+    throw new Error(`${label}.evidence must contain 1-200 entries`);
+  }
+  evidence.forEach((entry, index) =>
+    assertValidReferenceAnalysisEvidence(entry, `${label}.evidence[${index}]`),
+  );
+  const evidenceIds = requireArray(value.evidenceIds, `${label}.evidenceIds`);
+  const derivedEvidenceIds = evidence.map((entry) => (entry as ReferenceAnalysisEvidence).id);
+  if (
+    evidenceIds.length !== derivedEvidenceIds.length ||
+    evidenceIds.some((entry, index) => entry !== derivedEvidenceIds[index])
+  ) {
+    throw new Error(`${label}.evidenceIds must match evidence order exactly`);
+  }
+  if (value.findings !== undefined) {
+    const findings = requireArray(value.findings, `${label}.findings`);
+    if (findings.length > 100)
+      throw new Error(`${label}.findings must contain at most 100 entries`);
+    findings.forEach((entry, index) =>
+      assertValidReferenceAnalysisFinding(
+        entry,
+        new Set(derivedEvidenceIds),
+        `${label}.findings[${index}]`,
+      ),
+    );
+  }
+  if (value.model !== undefined && typeof value.model !== 'string') {
+    throw new Error(`${label}.model must be a string`);
+  }
+}
+
+function assertValidReferenceAnalysisEvidence(
+  evidence: unknown,
+  label: string,
+): asserts evidence is ReferenceAnalysisEvidence {
+  const value = requireRecord(evidence, label);
+  requireOpaqueId(value.id, `${label}.id`);
+  if (typeof value.label !== 'string' || value.label.length === 0) {
+    throw new Error(`${label}.label must be a non-empty string`);
+  }
+  if (typeof value.summary !== 'string' || value.summary.length === 0) {
+    throw new Error(`${label}.summary must be a non-empty string`);
+  }
+  switch (value.kind) {
+    case 'shot':
+      requirePositiveInteger(value.startUs, `${label}.startUs`, true);
+      requirePositiveInteger(value.durationUs, `${label}.durationUs`);
+      return;
+    case 'cut-rhythm':
+      requireNonNegativeInteger(value.cutCount, `${label}.cutCount`);
+      requirePositiveInteger(value.averageShotDurationUs, `${label}.averageShotDurationUs`);
+      requirePositiveInteger(value.fastestShotDurationUs, `${label}.fastestShotDurationUs`);
+      return;
+    case 'palette':
+      requirePositiveInteger(value.startUs, `${label}.startUs`, true);
+      requireArrayOfHexColors(value.swatches, `${label}.swatches`);
+      return;
+    case 'composition': {
+      requirePositiveInteger(value.startUs, `${label}.startUs`, true);
+      const focalPoint = requireRecord(value.focalPoint, `${label}.focalPoint`);
+      requireUnitNumber(focalPoint.xPct, `${label}.focalPoint.xPct`);
+      requireUnitNumber(focalPoint.yPct, `${label}.focalPoint.yPct`);
+      if (value.balance !== 'left' && value.balance !== 'center' && value.balance !== 'right') {
+        throw new Error(`${label}.balance must be left, center, or right`);
+      }
+      requireUnitNumber(value.headroomPct, `${label}.headroomPct`);
+      return;
+    }
+    case 'text-safe-zone':
+      if (typeof value.safe !== 'boolean') throw new Error(`${label}.safe must be a boolean`);
+      requireArray(value.boxes, `${label}.boxes`).forEach((entry, index) => {
+        const box = requireRecord(entry, `${label}.boxes[${index}]`);
+        requireUnitNumber(box.leftPct, `${label}.boxes[${index}].leftPct`);
+        requireUnitNumber(box.topPct, `${label}.boxes[${index}].topPct`);
+        requireUnitNumber(box.widthPct, `${label}.boxes[${index}].widthPct`);
+        requireUnitNumber(box.heightPct, `${label}.boxes[${index}].heightPct`);
+      });
+      return;
+    case 'transcript':
+      requireArray(value.segments, `${label}.segments`).forEach((entry, index) => {
+        const segment = requireRecord(entry, `${label}.segments[${index}]`);
+        requirePositiveInteger(segment.startUs, `${label}.segments[${index}].startUs`, true);
+        requirePositiveInteger(segment.endUs, `${label}.segments[${index}].endUs`);
+        if (typeof segment.text !== 'string') {
+          throw new Error(`${label}.segments[${index}].text must be a string`);
+        }
+      });
+      return;
+    case 'audio-beat':
+      requirePositiveInteger(value.startUs, `${label}.startUs`, true);
+      requirePositiveInteger(value.durationUs, `${label}.durationUs`);
+      if (
+        typeof value.strength !== 'number' ||
+        !Number.isFinite(value.strength) ||
+        value.strength < 0
+      ) {
+        throw new Error(`${label}.strength must be a non-negative finite number`);
+      }
+      return;
+    default:
+      throw new Error(`${label}.kind is invalid`);
+  }
+}
+
+function assertValidReferenceAnalysisFinding(
+  finding: unknown,
+  evidenceIds: ReadonlySet<string>,
+  label: string,
+): asserts finding is ReferenceAnalysisFinding {
+  const value = requireRecord(finding, label);
+  requireOpaqueId(value.id, `${label}.id`);
+  if (value.source !== 'deterministic' && value.source !== 'model') {
+    throw new Error(`${label}.source must be deterministic or model`);
+  }
+  if (typeof value.title !== 'string' || value.title.length === 0) {
+    throw new Error(`${label}.title must be a non-empty string`);
+  }
+  if (typeof value.summary !== 'string' || value.summary.length === 0) {
+    throw new Error(`${label}.summary must be a non-empty string`);
+  }
+  const ids = requireArray(value.evidenceIds, `${label}.evidenceIds`);
+  if (ids.length === 0) throw new Error(`${label}.evidenceIds must not be empty`);
+  ids.forEach((entry, index) => {
+    if (typeof entry !== 'string' || entry.length === 0) {
+      throw new Error(`${label}.evidenceIds[${index}] must be a non-empty string`);
+    }
+    if (!evidenceIds.has(entry)) {
+      throw new Error(`${label}.evidenceIds[${index}] references unknown evidence ${entry}`);
+    }
+  });
+}
+
+function requireRecord(value: unknown, label: string): Record<string, unknown> {
+  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
+    throw new Error(`${label} must be an object`);
+  }
+  return value as Record<string, unknown>;
+}
+
+function requireArray(value: unknown, label: string): readonly unknown[] {
+  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
+  return value;
+}
+
+function requireArrayOfHexColors(value: unknown, label: string): void {
+  const items = requireArray(value, label);
+  if (items.length === 0 || items.length > 8) throw new Error(`${label} must contain 1-8 swatches`);
+  items.forEach((entry, index) => {
+    if (typeof entry !== 'string' || !/^#[0-9a-f]{6}$/i.test(entry)) {
+      throw new Error(`${label}[${index}] must be a hex color`);
+    }
+  });
+}
+
+function requireOpaqueId(value: unknown, label: string): void {
+  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
+    throw new Error(`${label} must be an opaque identifier`);
+  }
+}
+
+function requireHash(value: unknown, label: string): void {
+  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
+    throw new Error(`${label} must be a SHA-256 hex digest`);
+  }
+}
+
+function requirePositiveInteger(value: unknown, label: string, zeroAllowed = false): void {
+  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zeroAllowed ? 0 : 1)) {
+    throw new Error(`${label} must be a ${zeroAllowed ? 'non-negative' : 'positive'} integer`);
+  }
+}
+
+function requireNonNegativeInteger(value: unknown, label: string): void {
+  requirePositiveInteger(value, label, true);
+}
+
+function requireIntegerInRange(value: unknown, min: number, max: number, label: string): void {
+  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
+    throw new Error(`${label} must be an integer between ${min} and ${max}`);
+  }
+}
+
+function requireUnitNumber(value: unknown, label: string): void {
+  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
+    throw new Error(`${label} must be a finite number between 0 and 1`);
+  }
+}
diff --git a/packages/job-protocol/src/protocol.ts b/packages/job-protocol/src/protocol.ts
index d96a5f1..65c18ff 100644
--- a/packages/job-protocol/src/protocol.ts
+++ b/packages/job-protocol/src/protocol.ts
@@ -1,20 +1,32 @@
 /** P00.5 Worker protocol spike: outbound pairing, capability snapshots, and local-only thumbnails. */
 
 import type { RenderJob, RenderReceipt } from './render-jobs.js';
+import type {
+  MediaAnalysisJob,
+  ReferenceAnalysisEvidence,
+  ReferenceAnalysisFinding,
+  VideoReferenceAnalyzeJob,
+  VideoReferenceAnalyzeReceipt,
+} from './media-analysis-jobs.js';
+import {
+  assertValidVideoReferenceAnalyzePayload,
+  assertValidVideoReferenceAnalyzeReceipt,
+} from './media-analysis-jobs.js';
 
 export const WORKER_PROTOCOL_VERSION = 1 as const;
 
 export type WorkerCapability =
   | 'asset.thumbnail'
   | 'render.export'
   | 'render.inspect'
+  | 'video.reference-analyze'
   | 'image.comfy'
   | 'audio.ml-denoise'
   | 'text.lm-studio'
   | 'text.openrouter'
   | 'video.runway'
   | 'edit.higgsfield';
 
 export type SpecializedJobType =
   | 'image.comfy'
   | 'audio.ml-denoise'
@@ -23,25 +35,27 @@ export type SpecializedJobType =
   | 'video.runway'
   | 'edit.higgsfield';
 export const SPECIALIZED_JOB_TYPES: readonly WorkerCapability[] = [
   'image.comfy',
   'audio.ml-denoise',
   'text.lm-studio',
   'text.openrouter',
   'video.runway',
   'edit.higgsfield',
 ] as const;
-export type WorkerJobType = 'asset.thumbnail' | SpecializedJobType | RenderJob['type'];
+export type WorkerJobType =
+  'asset.thumbnail' | SpecializedJobType | MediaAnalysisJob['type'] | RenderJob['type'];
 export const WORKER_JOB_TYPES: readonly WorkerJobType[] = [
   'asset.thumbnail',
   'render.export',
   'render.inspect',
+  'video.reference-analyze',
   ...SPECIALIZED_JOB_TYPES,
 ] as const;
 
 /** @deprecated Use SpecializedJobType */
 export type LocalGpuWorkerJobType = SpecializedJobType;
 /** @deprecated Use SPECIALIZED_JOB_TYPES */
 export const LOCAL_GPU_WORKER_CAPABILITIES: readonly WorkerCapability[] = SPECIALIZED_JOB_TYPES;
 export type ThumbnailJobState =
   'queued' | 'assigned' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'canceled';
 
@@ -102,21 +116,21 @@ export interface AiJob {
     readonly params?: Record<string, unknown>;
   };
   readonly requirements: {
     readonly capabilities: readonly WorkerCapability[];
     readonly privacy: 'local-only' | 'remote-api';
   };
   readonly idempotencyKey: string;
   readonly maxAttempts: number;
 }
 
-export type WorkerJobV1 = ThumbnailJob | AiJob | RenderJob;
+export type WorkerJobV1 = ThumbnailJob | AiJob | MediaAnalysisJob | RenderJob;
 
 export interface ThumbnailAssignment {
   readonly job: ThumbnailJob;
   readonly attempt: number;
 }
 
 export interface ThumbnailJobSnapshot {
   readonly job: ThumbnailJob;
   readonly state: ThumbnailJobState;
   readonly attempts: number;
@@ -280,20 +294,45 @@ export type WorkerResultReceiptV1 =
       readonly sha256: string;
       readonly bytes: number;
       readonly localRef: string;
       readonly descriptor: {
         readonly mimeType: string;
         readonly width?: number;
         readonly height?: number;
       };
       readonly model?: string;
     }
+  | {
+      readonly kind: 'video.reference-analyze';
+      readonly assetId: string;
+      readonly sha256: string;
+      readonly bytes: number;
+      readonly descriptor: {
+        readonly mimeType: string;
+        readonly width: number;
+        readonly height: number;
+        readonly durationUs: number;
+      };
+      readonly summary: {
+        readonly shotCount: number;
+        readonly cutCount: number;
+        readonly averageShotDurationUs: number;
+        readonly fastestShotDurationUs: number;
+        readonly sampleCount: number;
+        readonly transcriptSegmentCount: number;
+        readonly audioBeatCount: number;
+      };
+      readonly evidence: readonly ReferenceAnalysisEvidence[];
+      readonly evidenceIds: readonly string[];
+      readonly findings?: readonly ReferenceAnalysisFinding[];
+      readonly model?: string;
+    }
   | RenderReceipt;
 
 interface WorkerSession {
   readonly workerId: string;
   readonly token: string;
   hello?: WorkerCapabilitySnapshot;
 }
 
 interface MutableJob {
   readonly job: ThumbnailJob;
@@ -612,20 +651,30 @@ function validateWorkerJobPayload(job: WorkerJobV1): void {
       assertOpaqueIds(
         [
           job.payload.projectRef,
           job.payload.compositionId,
           job.payload.presetId,
           job.payload.reportRef,
         ],
         'payload references',
       );
       return;
+    case 'video.reference-analyze':
+      try {
+        assertValidVideoReferenceAnalyzePayload(job.payload, 'payload');
+      } catch (error) {
+        throw new WorkerProtocolError(
+          'WORKER_JOB_INVALID',
+          error instanceof Error ? error.message : 'payload is invalid',
+        );
+      }
+      return;
     default:
       assertObjectKeys(
         job.payload,
         ['prompt'],
         ['negativePrompt', 'imageAssetId', 'model', 'params'],
         'payload',
       );
       if (typeof job.payload.prompt !== 'string') {
         throw new WorkerProtocolError('WORKER_JOB_INVALID', 'payload prompt is invalid');
       }
@@ -657,20 +706,21 @@ function validateWorkerJobRequirements(
     !Array.isArray(requirements.capabilities) ||
     requirements.capabilities.some((capability) => !isWorkerCapability(capability))
   ) {
     throw new WorkerProtocolError('WORKER_JOB_INVALID', 'requirements capabilities are invalid');
   }
   if (requirements.privacy !== 'local-only' && requirements.privacy !== 'remote-api') {
     throw new WorkerProtocolError('WORKER_JOB_INVALID', 'requirements privacy is invalid');
   }
   if (
     (jobType === 'asset.thumbnail' ||
+      jobType === 'video.reference-analyze' ||
       jobType === 'render.export' ||
       jobType === 'render.inspect') &&
     requirements.privacy !== 'local-only'
   ) {
     throw new WorkerProtocolError('WORKER_JOB_INVALID', 'job privacy requirement mismatch');
   }
 }
 
 function validateWorkerReceiptShape(jobType: WorkerJobType, receipt: WorkerResultReceiptV1): void {
   switch (jobType) {
@@ -708,20 +758,31 @@ function validateWorkerReceiptShape(jobType: WorkerJobType, receipt: WorkerResul
     }
     case 'render.inspect': {
       const value = receipt as Extract<WorkerResultReceiptV1, { readonly kind: 'render.inspect' }>;
       assertObjectKeys(value, ['kind', 'reportRef', 'findings'], [], 'receipt');
       assertOpaqueIds([value.reportRef], 'receipt references');
       if (!Number.isSafeInteger(value.findings) || value.findings < 0) {
         throw new WorkerProtocolError('WORKER_RECEIPT_INVALID', 'receipt findings are invalid');
       }
       return;
     }
+    case 'video.reference-analyze': {
+      try {
+        assertValidVideoReferenceAnalyzeReceipt(receipt, 'receipt');
+      } catch (error) {
+        throw new WorkerProtocolError(
+          'WORKER_RECEIPT_INVALID',
+          error instanceof Error ? error.message : 'receipt is invalid',
+        );
+      }
+      return;
+    }
     default: {
       if (jobType === 'text.lm-studio' || jobType === 'text.openrouter') {
         const value = receipt as Extract<
           WorkerResultReceiptV1,
           { readonly kind: 'text.lm-studio' | 'text.openrouter' }
         >;
         assertObjectKeys(value, ['kind', 'resultRef', 'sha256', 'bytes'], ['model'], 'receipt');
         assertOpaqueIds([value.resultRef], 'receipt references');
         if ('model' in value && value.model !== undefined && typeof value.model !== 'string') {
           throw new WorkerProtocolError('WORKER_RECEIPT_INVALID', 'receipt model is invalid');
