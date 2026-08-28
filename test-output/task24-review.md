# Review package: abf18e3..56a6577

## Commits
56a6577 feat(agent): search B-roll with evidence-linked ranges

## Files changed
 apps/api/src/control-plane.ts                      |  36 ++-
 apps/api/src/http-server.ts                        |  25 ++
 apps/api/src/postgres-control-plane.ts             |  32 ++-
 apps/editor-web/src/AssetLibraryPanel.tsx          | 213 ++++++++++++++
 apps/worker/src/control-plane-client.ts            |  36 ++-
 apps/worker/src/runtime.test.ts                    |   2 +
 apps/worker/src/runtime.ts                         |  31 ++
 apps/worker/src/semantic-index.test.ts             | 116 ++++++++
 apps/worker/src/semantic-index.ts                  | 268 +++++++++++++++++
 packages/agent-tools/src/broll-search.test.ts      | 231 +++++++++++++++
 packages/agent-tools/src/broll-search.ts           | 316 +++++++++++++++++++++
 packages/agent-tools/src/index.ts                  |  11 +
 packages/job-protocol/src/index.ts                 |   8 +
 packages/job-protocol/src/media-analysis-jobs.ts   | 236 ++++++++++++++-
 packages/job-protocol/src/protocol.ts              |  28 ++
 packages/project-schema/src/index.ts               |   7 +
 .../src/semantic-intelligence.test.ts              | 256 ++++++++++-------
 .../project-schema/src/semantic-intelligence.ts    | 266 ++++++++++++++---
 packages/project-schema/src/semantic-snapshot.ts   | 145 +++++++---
 19 files changed, 2061 insertions(+), 202 deletions(-)

## Diff
diff --git a/apps/api/src/control-plane.ts b/apps/api/src/control-plane.ts
index ce1dc25..a0a8a0b 100644
--- a/apps/api/src/control-plane.ts
+++ b/apps/api/src/control-plane.ts
@@ -1,19 +1,23 @@
 import {
   isWorkerJobType,
   validateWorkerJobV1,
   validateWorkerReceiptForJob,
   workerCanRunJob,
   WorkerProtocolError,
   WORKER_PROTOCOL_VERSION,
 } from '@joy-media/job-protocol';
-import type { VideoReferenceAnalyzeReceipt, WorkerJobV1 } from '@joy-media/job-protocol';
+import type {
+  MediaSemanticIndexReceipt,
+  VideoReferenceAnalyzeReceipt,
+  WorkerJobV1,
+} from '@joy-media/job-protocol';
 
 export interface Actor {
   readonly id: string;
 }
 export interface ProjectMetadata {
   readonly id: string;
   readonly title: string;
   readonly revision: number;
   readonly ownerId: string;
   /** Explicit opt-in prerequisite for private object-storage synchronization. */
@@ -190,27 +194,29 @@ export interface MediaAiWorkerReceipt {
   readonly bytes: number;
   readonly localRef: string;
   readonly descriptor: {
     readonly mimeType: string;
     readonly width?: number;
     readonly height?: number;
   };
   readonly model?: string;
 }
 export type ReferenceAnalysisWorkerReceipt = VideoReferenceAnalyzeReceipt;
+export type SemanticIndexWorkerReceipt = MediaSemanticIndexReceipt;
 export type WorkerResultReceipt =
   | FixtureThumbnailReceipt
   | AssetThumbnailReceipt
   | LocalGpuWorkerReceipt
   | TextAiWorkerReceipt
   | MediaAiWorkerReceipt
   | ReferenceAnalysisWorkerReceipt
+  | SemanticIndexWorkerReceipt
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
@@ -895,20 +901,22 @@ export class LocalControlPlane implements ControlPlane {
     if (
       job.type === 'asset.thumbnail' &&
       (!isAssetThumbnailReceipt(receipt) || receipt.assetId !== job.assetId)
     )
       throw new ControlPlaneError('RESULT_INVALID', jobId);
     if (
       (job.type === 'image.comfy' || job.type === 'audio.ml-denoise') &&
       (!isLocalGpuReceipt(receipt) || receipt.kind !== job.type)
     )
       throw new ControlPlaneError('RESULT_INVALID', jobId);
+    if (job.type === 'media.semantic-index' && !isSemanticIndexReceipt(receipt))
+      throw new ControlPlaneError('RESULT_INVALID', jobId);
     const derivative =
       receipt === undefined ? undefined : derivativeOf(jobId, workerId, receipt, now);
     const done: Job = {
       ...job,
       state: 'completed',
       progress: 100,
       cancelRequested: false,
       ...(derivative === undefined ? {} : { derivative }),
     };
     this.#jobs.set(jobId, done);
@@ -1089,20 +1097,32 @@ function isMediaAiReceipt(value: WorkerResultReceipt | undefined): value is Medi
     /^[a-f0-9]{64}$/.test(value.sha256) &&
     Number.isSafeInteger(value.bytes) &&
     value.bytes > 0 &&
     /^ai-[A-Za-z0-9._-]{1,110}$/.test(value.localRef) &&
     typeof value.descriptor.mimeType === 'string' &&
     value.descriptor.mimeType.length > 0 &&
     (value.model === undefined || typeof value.model === 'string')
   );
 }
 
+function isSemanticIndexReceipt(
+  value: WorkerResultReceipt | undefined,
+): value is SemanticIndexWorkerReceipt {
+  if (value?.kind !== 'media.semantic-index') return false;
+  try {
+    validateWorkerReceiptForJob('media.semantic-index', value);
+    return true;
+  } catch {
+    return false;
+  }
+}
+
 function isWorkerCompatible(worker: WorkerRecord, job: Job): boolean {
   if (job.type === 'asset.thumbnail') {
     return (
       job.assetId !== undefined &&
       worker.capabilities.includes('asset.thumbnail') &&
       worker.localAssetIds.includes(job.assetId)
     );
   }
   if (job.type === 'video.reference-analyze') {
     return (
@@ -1156,20 +1176,34 @@ function legacyWorkerJob(
         maxDurationUs: 15 * 60 * 1_000_000,
         maxBytes: 256 * 1_024 * 1_024,
         sampleCount: 3,
         maxAudioBeats: 6,
       },
       requirements: { capabilities: ['video.reference-analyze'], privacy: 'local-only' },
       idempotencyKey: id,
       maxAttempts: 3,
     });
   }
+  if (type === 'media.semantic-index') {
+    return validateWorkerJobV1({
+      protocolVersion: WORKER_PROTOCOL_VERSION,
+      jobId: id,
+      type,
+      payload: {
+        projectId,
+        receipts: [],
+      },
+      requirements: { capabilities: ['media.semantic-index'], privacy: 'local-only' },
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
index 88cc707..41519e0 100644
--- a/apps/api/src/http-server.ts
+++ b/apps/api/src/http-server.ts
@@ -1299,20 +1299,45 @@ function requiredWorkerResult(body: Record<string, unknown>): WorkerResultReceip
     result.summary !== null &&
     typeof result.summary === 'object' &&
     !Array.isArray(result.summary) &&
     Array.isArray(result.evidence) &&
     Array.isArray(result.evidenceIds) &&
     (result.findings === undefined || Array.isArray(result.findings)) &&
     (result.model === undefined || typeof result.model === 'string')
   ) {
     return result as WorkerResultReceiptV1;
   }
+  if (
+    result.kind === 'media.semantic-index' &&
+    hasOnlyKeys(result, [
+      'kind',
+      'projectId',
+      'sha256',
+      'bytes',
+      'summary',
+      'evidence',
+      'evidenceIds',
+      'assets',
+      'model',
+    ]) &&
+    typeof result.projectId === 'string' &&
+    isReceiptHashAndBytes(result) &&
+    result.summary !== null &&
+    typeof result.summary === 'object' &&
+    !Array.isArray(result.summary) &&
+    Array.isArray(result.evidence) &&
+    Array.isArray(result.evidenceIds) &&
+    Array.isArray(result.assets) &&
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
index 22a0c3b..0f25b68 100644
--- a/apps/api/src/postgres-control-plane.ts
+++ b/apps/api/src/postgres-control-plane.ts
@@ -20,20 +20,21 @@ import {
   type CloudDerivativeRegistration,
   type ControlPlane,
   type LocalDerivativeRegistration,
   type MediaAssetRecord,
   type MediaDerivativeRecord,
   type Job,
   type JobEvent,
   type LocalGpuWorkerReceipt,
   type WorkerResultReceipt,
   type ProjectMetadata,
+  type SemanticIndexWorkerReceipt,
   type WorkerPairingOffer,
   type WorkerRecord,
   type WorkerSession,
   validateAssetRegistration,
   validateAssetTags,
   validateCloudDerivativeRegistration,
   validateLocalDerivativeRegistration,
   validateSortName,
 } from './control-plane.js';
 import { POSTGRES_SCHEMA } from './postgres-schema.js';
@@ -1270,20 +1271,21 @@ function isFixtureReceipt(
 }
 
 function isWorkerReceipt(value: WorkerResultReceipt): boolean {
   return (
     isFixtureReceipt(value) ||
     isAssetThumbnailReceipt(value) ||
     isLocalGpuReceipt(value) ||
     isTextAiReceipt(value) ||
     isMediaAiReceipt(value) ||
     isReferenceAnalysisReceipt(value) ||
+    isSemanticIndexReceipt(value) ||
     isRenderReceipt(value)
   );
 }
 
 function isAssetThumbnailReceipt(value: WorkerResultReceipt): value is AssetThumbnailReceipt {
   return (
     value.kind === 'asset.thumbnail' &&
     /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId) &&
     /^[a-f0-9]{64}$/.test(value.sha256) &&
     Number.isSafeInteger(value.bytes) &&
@@ -1356,20 +1358,30 @@ function isReferenceAnalysisReceipt(
     value.descriptor.height > 0 &&
     Number.isSafeInteger(value.descriptor.durationUs) &&
     value.descriptor.durationUs > 0 &&
     Array.isArray(value.evidence) &&
     Array.isArray(value.evidenceIds) &&
     (value.findings === undefined || Array.isArray(value.findings)) &&
     (value.model === undefined || typeof value.model === 'string')
   );
 }
 
+function isSemanticIndexReceipt(value: WorkerResultReceipt): value is SemanticIndexWorkerReceipt {
+  if (value.kind !== 'media.semantic-index') return false;
+  try {
+    validateWorkerReceiptForJob('media.semantic-index', value);
+    return true;
+  } catch {
+    return false;
+  }
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
@@ -1443,23 +1455,41 @@ function legacyWorkerJob(
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
+  if (type === 'media.semantic-index') {
+    return validateWorkerJobV1({
+      protocolVersion: WORKER_PROTOCOL_VERSION,
+      jobId: id,
+      type,
+      payload: {
+        projectId,
+        receipts: [],
+      },
+      requirements: { capabilities: ['media.semantic-index'], privacy: 'local-only' },
+      idempotencyKey: id,
+      maxAttempts: 3,
+    });
+  }
   const aiType = type as Exclude<
     WorkerJobType,
-    'asset.thumbnail' | 'video.reference-analyze' | 'render.export' | 'render.inspect'
+    | 'asset.thumbnail'
+    | 'video.reference-analyze'
+    | 'media.semantic-index'
+    | 'render.export'
+    | 'render.inspect'
   >;
   return validateWorkerJobV1({
     protocolVersion: WORKER_PROTOCOL_VERSION,
     jobId: id,
     type: aiType,
     payload: {
       prompt: '',
       ...(assetId === undefined ? {} : { imageAssetId: assetId }),
     },
     requirements: {
diff --git a/apps/editor-web/src/AssetLibraryPanel.tsx b/apps/editor-web/src/AssetLibraryPanel.tsx
index eec55fa..36d4347 100644
--- a/apps/editor-web/src/AssetLibraryPanel.tsx
+++ b/apps/editor-web/src/AssetLibraryPanel.tsx
@@ -1,12 +1,22 @@
 import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
 import type { ArtifactStore, ArtifactTransaction } from '@joy-media/commands';
+import type {
+  MediaSemanticIndexEvidence,
+  VideoReferenceAnalyzeReceipt,
+} from '@joy-media/job-protocol';
+import type {
+  SemanticBrollAssetV1,
+  SemanticBrollSearchIndexV1,
+  SemanticBrollTimeRangeV1,
+} from '@joy-media/project-schema';
+import { searchBroll, type BrollSearchResult } from '@joy-media/agent-tools';
 import { AuthorizedDerivativeResolver } from './asset-resolver.js';
 import {
   BrowserControlPlaneClient,
   type BrowserAsset,
   type BrowserAssetRegistration,
   type BrowserDerivative,
   type BrowserJob,
 } from './control-plane-client.js';
 import { getStoredMediaToken, MEDIA_SESSION_CHANGED_EVENT } from './media-session.js';
 import {
@@ -119,21 +129,23 @@ export function AssetLibraryPanel({
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
+  const [brollQuery, setBrollQuery] = useState('');
   const deferredQuery = useDeferredValue(query);
+  const deferredBrollQuery = useDeferredValue(brollQuery);
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
@@ -354,20 +366,35 @@ export function AssetLibraryPanel({
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
+  const brollSearchView = useMemo(() => {
+    if (artifacts === undefined) return undefined;
+    const index = buildPanelSemanticBrollIndex(projectId, items, artifacts);
+    const normalizedQuery = deferredBrollQuery.trim();
+    const rangeCount = index.assets.reduce((count, asset) => count + asset.ranges.length, 0);
+    if (normalizedQuery.length === 0) return { rangeCount, results: [] as BrollSearchResult[] };
+    try {
+      return {
+        rangeCount,
+        results: [...searchBroll(index, { query: normalizedQuery, maxResults: 6 }).results],
+      };
+    } catch {
+      return { rangeCount, results: [] as BrollSearchResult[] };
+    }
+  }, [artifacts, deferredBrollQuery, items, projectId]);
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
@@ -1085,20 +1112,48 @@ export function AssetLibraryPanel({
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
+          {brollSearchView !== undefined && brollSearchView.rangeCount > 0 && (
+            <section className="asset-preview" aria-label="Semantic B-roll search">
+              <div>
+                <strong>Semantic B-roll</strong>
+                <span>{brollSearchView.rangeCount} evidence-linked range(s)</span>
+              </div>
+              <label className="asset-search-field">
+                <span className="sr-only">Search semantic B-roll</span>
+                <input
+                  type="search"
+                  value={brollQuery}
+                  onChange={(event) => setBrollQuery(event.target.value)}
+                  placeholder="Search B-roll evidence"
+                />
+              </label>
+              {brollSearchView.results.length > 0 && (
+                <ul className="asset-reference-analysis">
+                  {brollSearchView.results.map((result) => (
+                    <li key={result.resultId}>
+                      <strong>{result.displayName}</strong> {formatSeconds(result.range.startUs)}-
+                      {formatSeconds(result.range.startUs + result.range.durationUs)} ·{' '}
+                      {result.evidenceIds.length} evidence id(s)
+                    </li>
+                  ))}
+                </ul>
+              )}
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
@@ -1557,20 +1612,178 @@ function AssetCardMedia({
         <img src={url} alt="" loading="lazy" decoding="async" />
       ) : (
         <span className="asset-card-placeholder" aria-hidden>
           {asset.kind === 'video' ? '▶' : asset.kind === 'audio' ? '♪' : '▣'}
         </span>
       )}
     </button>
   );
 }
 
+function buildPanelSemanticBrollIndex(
+  projectId: string,
+  items: readonly AssetLibraryItem[],
+  artifacts: ArtifactStore,
+): SemanticBrollSearchIndexV1 {
+  const evidenceIndex = new Map<string, MediaSemanticIndexEvidence>();
+  const assets: SemanticBrollAssetV1[] = [];
+
+  for (const { asset } of items) {
+    if (asset.kind !== 'video') continue;
+    const analysis = parseReferenceAnalysisArtifact(
+      artifacts.artifacts[referenceAnalysisArtifactId(asset.id)],
+    );
+    if (analysis === undefined) continue;
+    const converted = panelSemanticAssetFromReceipt(asset, analysis.receipt);
+    for (const evidence of converted.evidence) evidenceIndex.set(evidence.id, evidence);
+    assets.push(converted.asset);
+  }
+
+  return {
+    schemaVersion: 1,
+    projectId,
+    createdAt: new Date(0).toISOString(),
+    evidenceIndex,
+    assets,
+  };
+}
+
+function panelSemanticAssetFromReceipt(
+  asset: BrowserAsset,
+  receipt: VideoReferenceAnalyzeReceipt,
+): {
+  readonly asset: SemanticBrollAssetV1;
+  readonly evidence: readonly MediaSemanticIndexEvidence[];
+} {
+  const evidence: MediaSemanticIndexEvidence[] = [];
+
+  for (const entry of receipt.evidence) {
+    if (entry.kind === 'shot') {
+      evidence.push({
+        id: panelSemanticEvidenceId(asset.id, entry.id),
+        kind: 'asset-shot',
+        label: entry.label,
+        summary: entry.summary,
+        sourceEntityId: asset.id,
+        sourceEntityRevision: 1,
+        assetId: asset.id,
+        startUs: entry.startUs,
+        durationUs: entry.durationUs,
+        tags: tagsFromPanelText(`${entry.label} ${entry.summary}`),
+      });
+      continue;
+    }
+    if (entry.kind === 'transcript') {
+      for (const segment of entry.segments) {
+        evidence.push({
+          id: panelSemanticEvidenceId(
+            asset.id,
+            `caption-${String(segment.startUs).padStart(8, '0')}`,
+          ),
+          kind: 'asset-caption',
+          label: `${entry.label} ${formatSeconds(segment.startUs)}`,
+          summary: segment.text,
+          sourceEntityId: asset.id,
+          sourceEntityRevision: 1,
+          assetId: asset.id,
+          startUs: segment.startUs,
+          durationUs: Math.max(1, segment.endUs - segment.startUs),
+          text: segment.text,
+          language: 'und',
+        });
+      }
+      continue;
+    }
+    if (entry.kind === 'audio-beat') {
+      evidence.push({
+        id: panelSemanticEvidenceId(asset.id, entry.id),
+        kind: 'asset-audio',
+        label: entry.label,
+        summary: entry.summary,
+        sourceEntityId: asset.id,
+        sourceEntityRevision: 1,
+        assetId: asset.id,
+        startUs: entry.startUs,
+        durationUs: entry.durationUs,
+        audioKind: 'music',
+      });
+    }
+  }
+
+  const ranges = panelSemanticRanges(asset.id, evidence);
+  return {
+    evidence,
+    asset: {
+      assetId: asset.id,
+      displayName: asset.displayName,
+      assetType: 'video',
+      ...(receipt.descriptor.durationUs === undefined
+        ? {}
+        : { durationUs: receipt.descriptor.durationUs }),
+      usedInTimeline: false,
+      tags: tagsFromPanelText(`${asset.displayName} ${(asset.tags ?? []).join(' ')}`),
+      ranges,
+    },
+  };
+}
+
+function panelSemanticRanges(
+  assetId: string,
+  evidence: readonly MediaSemanticIndexEvidence[],
+): readonly SemanticBrollTimeRangeV1[] {
+  const shots = evidence.filter((entry) => entry.kind === 'asset-shot');
+  const sourceRanges = shots.length > 0 ? shots : evidence;
+  return sourceRanges.map((source, index) => {
+    const overlapping = evidence.filter((entry) =>
+      panelRangesOverlap(source.startUs, source.durationUs, entry.startUs, entry.durationUs),
+    );
+    return {
+      rangeId: `${assetId}.range-${String(index + 1).padStart(4, '0')}`,
+      assetId,
+      startUs: source.startUs,
+      durationUs: source.durationUs,
+      label: source.label,
+      text: overlapping
+        .map((entry) =>
+          entry.kind === 'asset-caption' ? entry.text : (entry.summary ?? entry.label),
+        )
+        .join(' '),
+      evidenceIds: overlapping.map((entry) => entry.id),
+    };
+  });
+}
+
+function panelSemanticEvidenceId(assetId: string, evidenceId: string): string {
+  return `${assetId}.${evidenceId}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
+}
+
+function panelRangesOverlap(
+  leftStartUs: number,
+  leftDurationUs: number,
+  rightStartUs: number,
+  rightDurationUs: number,
+): boolean {
+  const leftEndUs = leftStartUs + leftDurationUs;
+  const rightEndUs = rightStartUs + rightDurationUs;
+  return leftStartUs < rightEndUs && rightStartUs < leftEndUs;
+}
+
+function tagsFromPanelText(text: string): readonly string[] {
+  return [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
+    .filter((token) => token.length > 2)
+    .slice(0, 12);
+}
+
+function formatSeconds(valueUs: number): string {
+  return `${(valueUs / 1_000_000).toFixed(1)}s`;
+}
+
 function formatBytes(bytes: number): string {
   if (bytes < 1024) return `${bytes} B`;
   if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
   return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
 }
 function message(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
 }
 
 function assetKind(file: File): BrowserAsset['kind'] {
diff --git a/apps/worker/src/control-plane-client.ts b/apps/worker/src/control-plane-client.ts
index 9058945..5b35dab 100644
--- a/apps/worker/src/control-plane-client.ts
+++ b/apps/worker/src/control-plane-client.ts
@@ -1,12 +1,16 @@
 import { randomBytes } from 'node:crypto';
-import type { ReferenceAnalysisEvidence, ReferenceAnalysisFinding } from '@joy-media/job-protocol';
+import type {
+  MediaSemanticIndexEvidence,
+  ReferenceAnalysisEvidence,
+  ReferenceAnalysisFinding,
+} from '@joy-media/job-protocol';
 import type { DeviceIdentity } from './runtime.js';
 
 export interface WorkerSessionStore {
   loadWorkerSession(): string | undefined;
   saveWorkerSession(sessionToken: string): void;
   clearWorkerSession(): void;
 }
 
 export interface LeasedJob {
   readonly id: string;
@@ -20,20 +24,21 @@ export interface LeasedJob {
   };
   readonly idempotencyKey?: string;
   readonly maxAttempts?: number;
 }
 export interface WorkerJobResult {
   readonly kind:
     | 'asset.thumbnail'
     | 'image.comfy'
     | 'audio.ml-denoise'
     | 'video.reference-analyze'
+    | 'media.semantic-index'
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
@@ -41,31 +46,40 @@ export interface WorkerJobResult {
   readonly reportRef?: string;
   readonly outputRef?: string;
   readonly findings?: number | readonly ReferenceAnalysisFinding[];
   readonly qualityReport?: unknown;
   readonly descriptor?: {
     readonly mimeType: string;
     readonly width?: number;
     readonly height?: number;
     readonly durationUs?: number;
   };
-  readonly summary?: {
-    readonly shotCount: number;
-    readonly cutCount: number;
-    readonly averageShotDurationUs: number;
-    readonly fastestShotDurationUs: number;
-    readonly sampleCount: number;
-    readonly transcriptSegmentCount: number;
-    readonly audioBeatCount: number;
-  };
-  readonly evidence?: readonly ReferenceAnalysisEvidence[];
+  readonly summary?:
+    | {
+        readonly shotCount: number;
+        readonly cutCount: number;
+        readonly averageShotDurationUs: number;
+        readonly fastestShotDurationUs: number;
+        readonly sampleCount: number;
+        readonly transcriptSegmentCount: number;
+        readonly audioBeatCount: number;
+      }
+    | {
+        readonly assetCount: number;
+        readonly rangeCount: number;
+        readonly evidenceCount: number;
+        readonly embeddedRangeCount: number;
+        readonly reranked: boolean;
+      };
+  readonly evidence?: readonly (ReferenceAnalysisEvidence | MediaSemanticIndexEvidence)[];
   readonly evidenceIds?: readonly string[];
+  readonly assets?: readonly unknown[];
   readonly provider?: string;
   readonly text?: string;
   readonly model?: string;
 }
 
 export interface WorkerControlPlaneClientOptions {
   readonly apiUrl: string;
   readonly identity: DeviceIdentity;
   readonly sessionStore: WorkerSessionStore;
   readonly fetch?: typeof fetch;
diff --git a/apps/worker/src/runtime.test.ts b/apps/worker/src/runtime.test.ts
index c206645..7d8209a 100644
--- a/apps/worker/src/runtime.test.ts
+++ b/apps/worker/src/runtime.test.ts
@@ -21,20 +21,21 @@ describe('Worker runtime', () => {
         saved = value;
       },
     };
     const first = getDeviceIdentity(store, new Date('2026-01-01'));
     expect(getDeviceIdentity(store)).toEqual(first);
     const runtime = new WorkerRuntime(
       first,
       detectMediaTools((tool) => tool === 'ffmpeg' || tool === 'ffprobe'),
     );
     expect(runtime.hello('win32', 'x64').capabilities).toEqual([
+      'media.semantic-index',
       'asset.thumbnail',
       'render.export',
       'video.reference-analyze',
     ]);
   });
   it('bounds logs and cooperatively cancels jobs', async () => {
     const log = new BoundedLog(2);
     log.write('a');
     log.write('b');
     log.write('c');
@@ -212,20 +213,21 @@ describe('Worker runtime', () => {
       else process.env.JOY_MEDIA_RNNOISE_MODEL = previousModel;
     }
   });
 
   it('advertises GPU capabilities only when local env is set', () => {
     const runtime = new WorkerRuntime(
       { workerId: 'w', createdAt: 'now' },
       { ffmpeg: true, ffprobe: true, comfy: true, mlDenoise: true, aiProviders: [] },
     );
     expect(runtime.hello('linux', 'x64').capabilities).toEqual([
+      'media.semantic-index',
       'asset.thumbnail',
       'render.export',
       'video.reference-analyze',
       'image.comfy',
       'audio.ml-denoise',
     ]);
   });
 
   it('fails image.comfy honestly until a non-fixture workflow is wired', async () => {
     const runtime = new WorkerRuntime(
diff --git a/apps/worker/src/runtime.ts b/apps/worker/src/runtime.ts
index a0ba84d..7b72f1f 100644
--- a/apps/worker/src/runtime.ts
+++ b/apps/worker/src/runtime.ts
@@ -6,20 +6,22 @@ import {
   renameSync,
   writeFileSync,
   mkdtempSync,
 } from 'node:fs';
 import { homedir, tmpdir } from 'node:os';
 import { dirname, join } from 'node:path';
 import { spawn, spawnSync } from 'node:child_process';
 import { createHash, randomUUID } from 'node:crypto';
 import { setTimeout as sleep } from 'node:timers/promises';
 import type {
+  MediaSemanticIndexPayload,
+  MediaSemanticIndexReceipt,
   VideoReferenceAnalyzePayload,
   VideoReferenceAnalyzeReceipt,
   WorkerCapability,
   WorkerHello,
 } from '@joy-media/job-protocol';
 import { WORKER_PROTOCOL_VERSION } from '@joy-media/job-protocol';
 import type { RenderBundleV1 } from '@joy-media/render-planner';
 import {
   readGpuDerivative,
   runAudioMlDenoiseJob,
@@ -29,20 +31,21 @@ import {
 import {
   loadAiProviderConfigs,
   runAiJob,
   getConfiguredProviders,
   type LocalAiReceipt,
   type AiProvider,
 } from './local-ai.js';
 import { executeLeasedExport, type RenderExportReceiptV1 } from './export-job.js';
 import { mediaResolverFromAssetSourceRegistry } from './worker-media-resolver.js';
 import { analyzeReferenceVideo, type ReferenceAnalysisError } from './reference-analysis.js';
+import { buildSemanticBrollIndex, createMediaSemanticIndexReceipt } from './semantic-index.js';
 
 export interface DeviceIdentity {
   readonly workerId: string;
   readonly createdAt: string;
 }
 export interface IdentityStore {
   load(): DeviceIdentity | undefined;
   save(identity: DeviceIdentity): void;
 }
 export interface PersistentWorkerStore extends IdentityStore {
@@ -244,20 +247,21 @@ export class WorkerRuntime {
   constructor(
     readonly identity: DeviceIdentity,
     readonly tools: ToolAvailability,
     private readonly options: {
       readonly sources?: LocalAssetSourceRegistry;
       readonly derivativeDirectory?: string;
     } = {},
   ) {}
   hello(platform: string, architecture: string): WorkerHello {
     const capabilities: WorkerCapability[] = [];
+    capabilities.push('media.semantic-index');
     if (this.tools.ffmpeg && this.tools.ffprobe) {
       capabilities.push('asset.thumbnail', 'render.export', 'video.reference-analyze');
     }
     if (this.tools.comfy) capabilities.push('image.comfy');
     if (this.tools.mlDenoise) capabilities.push('audio.ml-denoise');
     if (this.tools.aiProviders.includes('lm-studio')) capabilities.push('text.lm-studio');
     if (this.tools.aiProviders.includes('openrouter')) capabilities.push('text.openrouter');
     if (this.tools.aiProviders.includes('runway')) capabilities.push('video.runway');
     if (this.tools.aiProviders.includes('higgsfield')) capabilities.push('edit.higgsfield');
     return {
@@ -284,20 +288,25 @@ export class WorkerRuntime {
         readonly model?: string;
         readonly negativePrompt?: string;
         readonly imageAssetId?: string;
         readonly params?: Record<string, unknown>;
         readonly assetId?: string;
         readonly maxDurationUs?: number;
         readonly maxBytes?: number;
         readonly sampleCount?: number;
         readonly maxAudioBeats?: number;
         readonly includeModelAnalysis?: boolean;
+        readonly receipts?: MediaSemanticIndexPayload['receipts'];
+        readonly usedAssetIds?: readonly string[];
+        readonly maxAssets?: number;
+        readonly includeEmbeddings?: boolean;
+        readonly includeRemoteRerank?: boolean;
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
@@ -411,20 +420,41 @@ export class WorkerRuntime {
           error instanceof Error &&
           'code' in error &&
           (error as ReferenceAnalysisError).code === 'REFERENCE_ANALYSIS_CANCELED'
         ) {
           this.log.write(`job ${job.id} canceled`);
           return { state: 'canceled' };
         }
         throw error;
       }
     }
+    if (job.type === 'media.semantic-index') {
+      const payload = job.payload as Partial<MediaSemanticIndexPayload> | undefined;
+      if (payload?.projectId === undefined || payload.receipts === undefined) {
+        throw new Error('media.semantic-index requires projectId and receipts');
+      }
+      this.log.write(`job ${job.id} started (media.semantic-index)`);
+      await options.progress(10);
+      const usedAssetIds = new Set(payload.usedAssetIds ?? []);
+      const receipts =
+        typeof payload.maxAssets === 'number'
+          ? payload.receipts.slice(0, payload.maxAssets)
+          : payload.receipts;
+      const index = buildSemanticBrollIndex({
+        projectId: payload.projectId,
+        receipts,
+        usedAssetIds,
+      });
+      await options.progress(100);
+      this.log.write(`job ${job.id} completed`);
+      return { state: 'completed', result: createMediaSemanticIndexReceipt(index) };
+    }
     // AI provider jobs (LM Studio, OpenRouter, Runway, Higgsfield)
     if (
       job.type.startsWith('text.') ||
       (job.type.startsWith('video.') && job.type !== 'video.reference-analyze') ||
       job.type.startsWith('edit.')
     ) {
       const provider = job.type.replace(/^(text\.|video\.|edit\.)/, '') as AiProvider;
       const derivativeDirectory =
         this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
       this.log.write(`job ${job.id} started (${job.type})`);
@@ -611,20 +641,21 @@ function retainedAiDerivativeExtension(
     );
   }
   return 'png';
 }
 
 export type WorkerDerivativeReceipt =
   | RealThumbnailReceipt
   | LocalGpuReceipt
   | ProtocolAiReceipt
   | ReferenceAnalysisReceipt
+  | MediaSemanticIndexReceipt
   | RenderExportReceiptV1;
 
 export type ProtocolAiReceipt =
   | {
       readonly kind: 'text.lm-studio' | 'text.openrouter';
       readonly resultRef: string;
       readonly sha256: string;
       readonly bytes: number;
       readonly model?: string;
     }
diff --git a/apps/worker/src/semantic-index.test.ts b/apps/worker/src/semantic-index.test.ts
new file mode 100644
index 0000000..7f3ce38
--- /dev/null
+++ b/apps/worker/src/semantic-index.test.ts
@@ -0,0 +1,116 @@
+import { describe, expect, it } from 'vitest';
+
+import type { VideoReferenceAnalyzeReceipt } from '@joy-media/job-protocol';
+import { buildSemanticBrollIndex, SemanticIndexError } from './semantic-index.js';
+
+const receipt: VideoReferenceAnalyzeReceipt = {
+  kind: 'video.reference-analyze',
+  assetId: 'asset-broll',
+  sha256: 'a'.repeat(64),
+  bytes: 100,
+  descriptor: {
+    mimeType: 'video/mp4',
+    width: 1920,
+    height: 1080,
+    durationUs: 12_000_000,
+  },
+  summary: {
+    shotCount: 1,
+    cutCount: 0,
+    averageShotDurationUs: 3_000_000,
+    fastestShotDurationUs: 3_000_000,
+    sampleCount: 1,
+    transcriptSegmentCount: 1,
+    audioBeatCount: 1,
+  },
+  evidence: [
+    {
+      id: 'shot-00000000',
+      kind: 'shot',
+      label: 'Shot 1',
+      summary: 'Product closeup with hands entering frame.',
+      startUs: 4_000_000,
+      durationUs: 3_000_000,
+    },
+    {
+      id: 'transcript-00000000',
+      kind: 'transcript',
+      label: 'Transcript',
+      summary: 'Human transcript',
+      segments: [
+        {
+          startUs: 4_200_000,
+          endUs: 5_400_000,
+          text: 'show the handmade product detail',
+        },
+      ],
+    },
+    {
+      id: 'audio-beat-04000000',
+      kind: 'audio-beat',
+      label: 'Audio beat 4.0s',
+      summary: 'Energy peak sampled in the analysis window.',
+      startUs: 4_000_000,
+      durationUs: 500_000,
+      strength: 0.7,
+    },
+  ],
+  evidenceIds: ['shot-00000000', 'transcript-00000000', 'audio-beat-04000000'],
+};
+
+describe('buildSemanticBrollIndex', () => {
+  it('converts reference receipts into asset shot, caption, and audio evidence', () => {
+    const index = buildSemanticBrollIndex({
+      projectId: 'project-semantic',
+      receipts: [receipt],
+      assetLabels: new Map([['asset-broll', 'Handmade detail.mp4']]),
+      usedAssetIds: new Set(),
+      now: new Date('2026-08-22T01:00:00.000Z'),
+    });
+
+    expect(index.projectId).toBe('project-semantic');
+    expect(index.assets).toHaveLength(1);
+    expect(index.assets[0]).toMatchObject({
+      assetId: 'asset-broll',
+      displayName: 'Handmade detail.mp4',
+      usedInTimeline: false,
+    });
+    expect(index.assets[0]?.ranges[0]).toMatchObject({
+      startUs: 4_000_000,
+      durationUs: 3_000_000,
+      evidenceIds: [
+        'asset-broll.shot-00000000',
+        'asset-broll.caption-04200000',
+        'asset-broll.audio-beat-04000000',
+      ],
+    });
+    expect(index.evidenceIndex.get('asset-broll.shot-00000000')).toMatchObject({
+      kind: 'asset-shot',
+      assetId: 'asset-broll',
+    });
+    expect(index.evidenceIndex.get('asset-broll.caption-04200000')).toMatchObject({
+      kind: 'asset-caption',
+      text: 'show the handmade product detail',
+    });
+    expect(index.evidenceIndex.get('asset-broll.audio-beat-04000000')).toMatchObject({
+      kind: 'asset-audio',
+      audioKind: 'music',
+    });
+  });
+
+  it('rejects receipts that cannot produce evidence-linked ranges', () => {
+    const broken: VideoReferenceAnalyzeReceipt = {
+      ...receipt,
+      evidence: [],
+      evidenceIds: [],
+    };
+
+    expect(() =>
+      buildSemanticBrollIndex({
+        projectId: 'project-semantic',
+        receipts: [broken],
+        now: new Date('2026-08-22T01:00:00.000Z'),
+      }),
+    ).toThrow(SemanticIndexError);
+  });
+});
diff --git a/apps/worker/src/semantic-index.ts b/apps/worker/src/semantic-index.ts
new file mode 100644
index 0000000..f46eba8
--- /dev/null
+++ b/apps/worker/src/semantic-index.ts
@@ -0,0 +1,268 @@
+import { createHash } from 'node:crypto';
+import type {
+  MediaSemanticIndexEvidence,
+  MediaSemanticIndexReceipt,
+  VideoReferenceAnalyzeReceipt,
+} from '@joy-media/job-protocol';
+import type {
+  AssetAudioEvidenceV1,
+  AssetCaptionEvidenceV1,
+  AssetShotEvidenceV1,
+  SemanticBrollAssetV1,
+  SemanticBrollSearchIndexV1,
+  SemanticBrollTimeRangeV1,
+} from '@joy-media/project-schema';
+import { validateSemanticBrollSearchIndexV1 } from '@joy-media/project-schema';
+
+export class SemanticIndexError extends Error {
+  readonly code: string;
+
+  constructor(code: string, message: string) {
+    super(message);
+    this.name = 'SemanticIndexError';
+    this.code = code;
+  }
+}
+
+export interface BuildSemanticBrollIndexOptions {
+  readonly projectId: string;
+  readonly receipts: readonly VideoReferenceAnalyzeReceipt[];
+  readonly assetLabels?: ReadonlyMap<string, string>;
+  readonly usedAssetIds?: ReadonlySet<string>;
+  readonly now?: Date;
+}
+
+export function buildSemanticBrollIndex(
+  options: BuildSemanticBrollIndexOptions,
+): SemanticBrollSearchIndexV1 {
+  const evidenceIndex = new Map<string, MediaSemanticIndexEvidence>();
+  const assets: SemanticBrollAssetV1[] = [];
+
+  for (const receipt of options.receipts) {
+    const converted = semanticAssetFromReceipt(receipt, {
+      usedInTimeline: options.usedAssetIds?.has(receipt.assetId) ?? false,
+      ...(options.assetLabels?.get(receipt.assetId) === undefined
+        ? {}
+        : { label: options.assetLabels.get(receipt.assetId)! }),
+    });
+    for (const evidence of converted.evidence) evidenceIndex.set(evidence.id, evidence);
+    assets.push(converted.asset);
+  }
+
+  const index: SemanticBrollSearchIndexV1 = {
+    schemaVersion: 1,
+    projectId: options.projectId,
+    createdAt: (options.now ?? new Date()).toISOString(),
+    evidenceIndex,
+    assets: assets.sort((left, right) => left.assetId.localeCompare(right.assetId)),
+  };
+
+  const errors = validateSemanticBrollSearchIndexV1(index);
+  if (errors.length > 0) {
+    throw new SemanticIndexError('SEMANTIC_INDEX_INVALID', errors.join('; '));
+  }
+
+  return index;
+}
+
+export function createMediaSemanticIndexReceipt(
+  index: SemanticBrollSearchIndexV1,
+): MediaSemanticIndexReceipt {
+  const evidence = [...index.evidenceIndex.values()].filter(
+    (entry): entry is MediaSemanticIndexEvidence =>
+      entry.kind === 'asset-shot' || entry.kind === 'asset-caption' || entry.kind === 'asset-audio',
+  );
+  const rangeCount = index.assets.reduce((count, asset) => count + asset.ranges.length, 0);
+  const content = {
+    projectId: index.projectId,
+    evidence,
+    evidenceIds: evidence.map((entry) => entry.id),
+    assets: index.assets,
+  };
+  const bytes = Buffer.from(JSON.stringify(content), 'utf8');
+  return {
+    kind: 'media.semantic-index',
+    projectId: index.projectId,
+    sha256: createHash('sha256').update(bytes).digest('hex'),
+    bytes: bytes.byteLength,
+    summary: {
+      assetCount: index.assets.length,
+      rangeCount,
+      evidenceCount: evidence.length,
+      embeddedRangeCount: 0,
+      reranked: false,
+    },
+    evidence: content.evidence,
+    evidenceIds: content.evidenceIds,
+    assets: content.assets,
+  };
+}
+
+function semanticAssetFromReceipt(
+  receipt: VideoReferenceAnalyzeReceipt,
+  options: { readonly label?: string; readonly usedInTimeline: boolean },
+): {
+  readonly asset: SemanticBrollAssetV1;
+  readonly evidence: readonly MediaSemanticIndexEvidence[];
+} {
+  const shotEvidence: AssetShotEvidenceV1[] = [];
+  const captionEvidence: AssetCaptionEvidenceV1[] = [];
+  const audioEvidence: AssetAudioEvidenceV1[] = [];
+
+  for (const entry of receipt.evidence) {
+    if (entry.kind === 'shot') {
+      shotEvidence.push({
+        id: semanticEvidenceId(receipt.assetId, entry.id),
+        kind: 'asset-shot',
+        label: entry.label,
+        summary: entry.summary,
+        sourceEntityId: receipt.assetId,
+        sourceEntityRevision: 1,
+        assetId: receipt.assetId,
+        startUs: entry.startUs,
+        durationUs: entry.durationUs,
+        tags: tagsFromText(`${entry.label} ${entry.summary}`),
+      });
+      continue;
+    }
+    if (entry.kind === 'transcript') {
+      for (const segment of entry.segments) {
+        captionEvidence.push({
+          id: semanticEvidenceId(
+            receipt.assetId,
+            `caption-${String(segment.startUs).padStart(8, '0')}`,
+          ),
+          kind: 'asset-caption',
+          label: `${entry.label} ${(segment.startUs / 1_000_000).toFixed(1)}s`,
+          summary: segment.text,
+          sourceEntityId: receipt.assetId,
+          sourceEntityRevision: 1,
+          assetId: receipt.assetId,
+          startUs: segment.startUs,
+          durationUs: Math.max(1, segment.endUs - segment.startUs),
+          text: segment.text,
+          language: 'und',
+        });
+      }
+      continue;
+    }
+    if (entry.kind === 'audio-beat') {
+      audioEvidence.push({
+        id: semanticEvidenceId(receipt.assetId, entry.id),
+        kind: 'asset-audio',
+        label: entry.label,
+        summary: entry.summary,
+        sourceEntityId: receipt.assetId,
+        sourceEntityRevision: 1,
+        assetId: receipt.assetId,
+        startUs: entry.startUs,
+        durationUs: entry.durationUs,
+        audioKind: 'music',
+      });
+    }
+  }
+
+  const evidence = [...shotEvidence, ...captionEvidence, ...audioEvidence];
+  if (evidence.length === 0) {
+    throw new SemanticIndexError(
+      'SEMANTIC_INDEX_MISSING_EVIDENCE',
+      `asset ${receipt.assetId} produced no searchable evidence`,
+    );
+  }
+
+  const ranges = buildRanges(receipt.assetId, shotEvidence, captionEvidence, audioEvidence);
+  if (ranges.length === 0) {
+    throw new SemanticIndexError(
+      'SEMANTIC_INDEX_MISSING_RANGE',
+      `asset ${receipt.assetId} produced no evidence-linked ranges`,
+    );
+  }
+
+  return {
+    evidence,
+    asset: {
+      assetId: receipt.assetId,
+      displayName: options.label ?? receipt.assetId,
+      assetType: receipt.descriptor.mimeType.startsWith('video/')
+        ? 'video'
+        : receipt.descriptor.mimeType.startsWith('audio/')
+          ? 'audio'
+          : 'other',
+      durationUs: receipt.descriptor.durationUs,
+      usedInTimeline: options.usedInTimeline,
+      tags: [
+        ...new Set(
+          evidence.flatMap((entry) => tagsFromText(`${entry.label} ${entry.summary ?? ''}`)),
+        ),
+      ],
+      ranges,
+    },
+  };
+}
+
+function buildRanges(
+  assetId: string,
+  shots: readonly AssetShotEvidenceV1[],
+  captions: readonly AssetCaptionEvidenceV1[],
+  audio: readonly AssetAudioEvidenceV1[],
+): readonly SemanticBrollTimeRangeV1[] {
+  const sourceRanges =
+    shots.length > 0
+      ? shots
+      : [...captions, ...audio].sort((left, right) => left.startUs - right.startUs);
+
+  return sourceRanges.map((source, index) => {
+    const startUs = source.startUs;
+    const durationUs = source.durationUs;
+    const overlapping = [source, ...captions, ...audio]
+      .filter(
+        (entry, entryIndex, entries) =>
+          entries.findIndex((candidate) => candidate.id === entry.id) === entryIndex,
+      )
+      .filter((entry) => rangesOverlap(startUs, durationUs, entry.startUs, entry.durationUs));
+    const evidenceIds = overlapping.map((entry) => entry.id);
+    if (evidenceIds.length === 0) {
+      throw new SemanticIndexError(
+        'SEMANTIC_INDEX_MISSING_EVIDENCE',
+        `range ${assetId}.${index} has no evidence`,
+      );
+    }
+    const text = overlapping
+      .map((entry) =>
+        entry.kind === 'asset-caption' ? entry.text : `${entry.label} ${entry.summary ?? ''}`,
+      )
+      .join(' ')
+      .trim();
+    return {
+      rangeId: `${assetId}.range-${String(index + 1).padStart(4, '0')}`,
+      assetId,
+      startUs,
+      durationUs,
+      label: source.label,
+      text,
+      evidenceIds,
+    };
+  });
+}
+
+function semanticEvidenceId(assetId: string, sourceEvidenceId: string): string {
+  return `${assetId}.${sourceEvidenceId}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
+}
+
+function rangesOverlap(
+  leftStartUs: number,
+  leftDurationUs: number,
+  rightStartUs: number,
+  rightDurationUs: number,
+): boolean {
+  const leftEndUs = leftStartUs + leftDurationUs;
+  const rightEndUs = rightStartUs + rightDurationUs;
+  return leftStartUs < rightEndUs && rightStartUs < leftEndUs;
+}
+
+function tagsFromText(text: string): readonly string[] {
+  const stop = new Set(['the', 'and', 'with', 'from', 'into', 'shot', 'audio']);
+  return [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
+    .filter((token) => token.length > 2 && !stop.has(token))
+    .slice(0, 12);
+}
diff --git a/packages/agent-tools/src/broll-search.test.ts b/packages/agent-tools/src/broll-search.test.ts
new file mode 100644
index 0000000..ea8a318
--- /dev/null
+++ b/packages/agent-tools/src/broll-search.test.ts
@@ -0,0 +1,231 @@
+import { describe, expect, it, vi } from 'vitest';
+
+import type { SemanticBrollSearchIndexV1 } from '@joy-media/project-schema';
+import {
+  createBrollInsertionProposal,
+  searchBroll,
+  type BrollSearchRequest,
+} from './broll-search.js';
+
+const baseIndex: SemanticBrollSearchIndexV1 = {
+  schemaVersion: 1,
+  projectId: 'project-broll',
+  createdAt: '2026-08-22T00:00:00.000Z',
+  evidenceIndex: new Map([
+    [
+      'shot-hero',
+      {
+        id: 'shot-hero',
+        kind: 'asset-shot',
+        label: 'Hero product shot',
+        summary: 'Close macro pour with warm highlights',
+        sourceEntityId: 'asset-used',
+        sourceEntityRevision: 1,
+        assetId: 'asset-used',
+        startUs: 1_000_000,
+        durationUs: 2_000_000,
+        tags: ['product', 'pour'],
+      },
+    ],
+    [
+      'caption-hero',
+      {
+        id: 'caption-hero',
+        kind: 'asset-caption',
+        label: 'Hero caption',
+        summary: 'Caption says warm launch moment',
+        sourceEntityId: 'asset-used',
+        sourceEntityRevision: 1,
+        assetId: 'asset-used',
+        startUs: 1_200_000,
+        durationUs: 1_200_000,
+        text: 'warm launch moment',
+        language: 'en',
+      },
+    ],
+    [
+      'shot-unused',
+      {
+        id: 'shot-unused',
+        kind: 'asset-shot',
+        label: 'Unused product closeup',
+        summary: 'Unused closeup of product texture',
+        sourceEntityId: 'asset-unused',
+        sourceEntityRevision: 1,
+        assetId: 'asset-unused',
+        startUs: 6_000_000,
+        durationUs: 2_500_000,
+        tags: ['product', 'texture'],
+      },
+    ],
+    [
+      'audio-unused',
+      {
+        id: 'audio-unused',
+        kind: 'asset-audio',
+        label: 'Unused audio swell',
+        summary: 'Soft ambient swell under the product shot',
+        sourceEntityId: 'asset-unused',
+        sourceEntityRevision: 1,
+        assetId: 'asset-unused',
+        startUs: 6_200_000,
+        durationUs: 1_000_000,
+        audioKind: 'ambient',
+      },
+    ],
+  ]),
+  assets: [
+    {
+      assetId: 'asset-used',
+      displayName: 'Launch hero.mp4',
+      assetType: 'video',
+      durationUs: 12_000_000,
+      usedInTimeline: true,
+      tags: ['product'],
+      ranges: [
+        {
+          rangeId: 'range-used',
+          assetId: 'asset-used',
+          startUs: 1_000_000,
+          durationUs: 2_500_000,
+          label: 'Hero pour',
+          text: 'warm launch product pour',
+          evidenceIds: ['shot-hero', 'caption-hero'],
+        },
+      ],
+    },
+    {
+      assetId: 'asset-unused',
+      displayName: 'Texture spare.mp4',
+      assetType: 'video',
+      durationUs: 10_000_000,
+      usedInTimeline: false,
+      tags: ['product', 'texture'],
+      ranges: [
+        {
+          rangeId: 'range-unused',
+          assetId: 'asset-unused',
+          startUs: 6_000_000,
+          durationUs: 2_500_000,
+          label: 'Texture closeup',
+          text: 'unused product texture with ambient swell',
+          evidenceIds: ['shot-unused', 'audio-unused'],
+        },
+      ],
+    },
+  ],
+};
+
+describe('searchBroll', () => {
+  it('returns deterministic evidence-linked time ranges and ranks unused assets first', () => {
+    const first = searchBroll(baseIndex, { query: 'product', maxResults: 5 });
+    const second = searchBroll(baseIndex, { query: 'product', maxResults: 5 });
+
+    expect(second).toEqual(first);
+    expect(first.results.map((result) => result.assetId)).toEqual(['asset-unused', 'asset-used']);
+    expect(first.results[0]).toMatchObject({
+      assetId: 'asset-unused',
+      range: { startUs: 6_000_000, durationUs: 2_500_000 },
+      evidenceIds: ['shot-unused', 'audio-unused'],
+      usedInTimeline: false,
+    });
+    expect(first.results[0]?.explanations.join(' ')).toContain('unused');
+  });
+
+  it('applies deterministic filters before optional reranking', () => {
+    const results = searchBroll(baseIndex, {
+      query: 'product',
+      timeRange: { startUs: 5_500_000, endUs: 9_000_000 },
+      unusedOnly: true,
+    });
+
+    expect(results.results).toHaveLength(1);
+    expect(results.results[0]?.assetId).toBe('asset-unused');
+  });
+
+  it('requires explicit privacy approval before reranking can run', () => {
+    const reranker = vi.fn();
+    const request: BrollSearchRequest = {
+      query: 'product',
+      rerank: { enabled: true, privacyApproved: false },
+    };
+
+    const results = searchBroll(baseIndex, request, { reranker });
+
+    expect(reranker).not.toHaveBeenCalled();
+    expect(results.privacy.dataLeavesDevice).toBe(false);
+    expect(results.results[0]?.assetId).toBe('asset-unused');
+  });
+
+  it('allows approved reranking while preserving base evidence and explanations', () => {
+    const results = searchBroll(
+      baseIndex,
+      {
+        query: 'product',
+        rerank: { enabled: true, privacyApproved: true, providerId: 'private-reranker' },
+      },
+      {
+        reranker: ({ candidates }) =>
+          candidates.map((candidate) => ({
+            resultId: candidate.resultId,
+            score: candidate.assetId === 'asset-used' ? 10 : 1,
+            reason: `reranked ${candidate.assetId}`,
+          })),
+      },
+    );
+
+    expect(results.results.map((result) => result.assetId)).toEqual(['asset-used', 'asset-unused']);
+    expect(results.results[0]?.evidenceIds).toEqual(['shot-hero', 'caption-hero']);
+    expect(results.results[0]?.explanations.some((entry) => entry.includes('Base score'))).toBe(
+      true,
+    );
+    expect(results.privacy).toMatchObject({
+      dataLeavesDevice: true,
+      providerId: 'private-reranker',
+    });
+  });
+
+  it('rejects ranges that cite missing evidence', () => {
+    const broken: SemanticBrollSearchIndexV1 = {
+      ...baseIndex,
+      assets: [
+        {
+          ...baseIndex.assets[0]!,
+          ranges: [
+            {
+              ...baseIndex.assets[0]!.ranges[0]!,
+              evidenceIds: ['missing-evidence'],
+            },
+          ],
+        },
+      ],
+    };
+
+    expect(() => searchBroll(broken, { query: 'product' })).toThrow(/missing evidence/i);
+  });
+});
+
+describe('createBrollInsertionProposal', () => {
+  it('creates a dry-run pending-approval insertion plan without dispatching commands', () => {
+    const dispatch = vi.fn();
+    const result = searchBroll(baseIndex, { query: 'texture' }).results[0]!;
+
+    const plan = createBrollInsertionProposal(result, {
+      compositionId: 'comp-1',
+      trackId: 'track-broll',
+      insertAtUs: 9_000_000,
+      clipId: 'clip-broll-1',
+      dispatch,
+    });
+
+    expect(dispatch).not.toHaveBeenCalled();
+    expect(plan.status).toBe('pending-approval');
+    expect(plan.steps).toHaveLength(1);
+    expect(plan.steps[0]).toMatchObject({
+      mode: 'command',
+      tool: 'insertClip',
+      requiresConfirmation: true,
+    });
+    expect(JSON.stringify(plan.steps[0]?.arguments)).toContain('asset-unused');
+  });
+});
diff --git a/packages/agent-tools/src/broll-search.ts b/packages/agent-tools/src/broll-search.ts
new file mode 100644
index 0000000..061d8a1
--- /dev/null
+++ b/packages/agent-tools/src/broll-search.ts
@@ -0,0 +1,316 @@
+import type {
+  SemanticBrollAssetV1,
+  SemanticBrollSearchIndexV1,
+  SemanticBrollTimeRangeV1,
+} from '@joy-media/project-schema';
+import { validateSemanticBrollSearchIndexV1 } from '@joy-media/project-schema';
+import type { AgentEditPlan } from './plan.js';
+import { createPlan } from './plan.js';
+
+export interface BrollSearchRequest {
+  readonly query: string;
+  readonly maxResults?: number;
+  readonly assetTypes?: readonly SemanticBrollAssetV1['assetType'][];
+  readonly timeRange?: {
+    readonly startUs: number;
+    readonly endUs: number;
+  };
+  readonly unusedOnly?: boolean;
+  readonly rerank?: {
+    readonly enabled: boolean;
+    readonly privacyApproved: boolean;
+    readonly providerId?: string;
+  };
+}
+
+export interface BrollSearchResult {
+  readonly resultId: string;
+  readonly assetId: string;
+  readonly displayName: string;
+  readonly assetType: SemanticBrollAssetV1['assetType'];
+  readonly usedInTimeline: boolean;
+  readonly range: {
+    readonly startUs: number;
+    readonly durationUs: number;
+  };
+  readonly evidenceIds: readonly string[];
+  readonly score: number;
+  readonly explanations: readonly string[];
+}
+
+export interface BrollSearchResponse {
+  readonly query: string;
+  readonly results: readonly BrollSearchResult[];
+  readonly privacy: {
+    readonly dataLeavesDevice: boolean;
+    readonly providerId?: string;
+  };
+  readonly warnings: readonly string[];
+}
+
+export interface BrollRerankCandidate extends BrollSearchResult {
+  readonly baseScore: number;
+}
+
+export interface BrollRerankResult {
+  readonly resultId: string;
+  readonly score: number;
+  readonly reason?: string;
+}
+
+export interface BrollSearchServices {
+  readonly reranker?: (input: {
+    readonly query: string;
+    readonly candidates: readonly BrollRerankCandidate[];
+  }) => readonly BrollRerankResult[];
+}
+
+export interface BrollInsertionProposalOptions {
+  readonly compositionId: string;
+  readonly trackId: string;
+  readonly insertAtUs: number;
+  readonly clipId: string;
+  readonly dispatch?: (plan: AgentEditPlan) => void;
+}
+
+export class BrollSearchError extends Error {
+  readonly code: string;
+
+  constructor(code: string, message: string) {
+    super(message);
+    this.name = 'BrollSearchError';
+    this.code = code;
+  }
+}
+
+export function searchBroll(
+  index: SemanticBrollSearchIndexV1,
+  request: BrollSearchRequest,
+  services: BrollSearchServices = {},
+): BrollSearchResponse {
+  const errors = validateSemanticBrollSearchIndexV1(index);
+  if (errors.length > 0) {
+    throw new BrollSearchError('BROLL_INDEX_INVALID', errors.join('; '));
+  }
+
+  const queryTokens = tokenize(request.query);
+  const candidates = index.assets
+    .filter((asset) => assetMatchesRequest(asset, request))
+    .flatMap((asset) =>
+      asset.ranges
+        .filter((range) => rangeMatchesRequest(range, request))
+        .map((range) => scoreRange(index, asset, range, queryTokens))
+        .filter((result) => result.score > 0 || queryTokens.length === 0),
+    )
+    .sort(compareBaseResults);
+
+  const maxResults = Math.max(1, Math.min(100, request.maxResults ?? 10));
+  const warnings: string[] = [];
+  const rerankRequested = request.rerank?.enabled === true;
+  const rerankAllowed = rerankRequested && request.rerank?.privacyApproved === true;
+  const canRerank = rerankAllowed && services.reranker !== undefined;
+
+  let results: readonly BrollSearchResult[] = candidates;
+  if (rerankRequested && !rerankAllowed) {
+    warnings.push('Rerank skipped because privacy approval was not granted.');
+  } else if (canRerank) {
+    const reranked = services.reranker({
+      query: request.query,
+      candidates: candidates.map((candidate) => ({ ...candidate, baseScore: candidate.score })),
+    });
+    results = applyRerank(candidates, reranked);
+  }
+
+  return {
+    query: request.query,
+    results: results.slice(0, maxResults),
+    privacy: {
+      dataLeavesDevice: canRerank,
+      ...(canRerank && request.rerank?.providerId !== undefined
+        ? { providerId: request.rerank.providerId }
+        : {}),
+    },
+    warnings,
+  };
+}
+
+export function createBrollInsertionProposal(
+  result: BrollSearchResult,
+  options: BrollInsertionProposalOptions,
+): AgentEditPlan {
+  void options.dispatch;
+  return createPlan(
+    `Insert B-roll from ${result.displayName}`,
+    [
+      {
+        id: 'insert-broll-1',
+        description: `Insert evidence-linked B-roll range ${result.range.startUs}-${result.range.startUs + result.range.durationUs}us from ${result.displayName}`,
+        mode: 'command',
+        tool: 'insertClip',
+        arguments: {
+          compositionId: options.compositionId,
+          trackId: options.trackId,
+          clip: {
+            id: options.clipId,
+            kind: 'video',
+            assetId: result.assetId,
+            startUs: options.insertAtUs,
+            durationUs: result.range.durationUs,
+            sourceStartUs: result.range.startUs,
+            metadata: {
+              dryRunOnly: true,
+              evidenceIds: [...result.evidenceIds],
+              brollSearchResultId: result.resultId,
+            },
+          },
+        },
+        dependsOn: [],
+        expectedChange: `Would insert ${result.displayName} as B-roll after approval.`,
+        preconditions: [
+          {
+            type: 'track-exists',
+            entityId: options.trackId,
+            message: `Track ${options.trackId} must exist`,
+          },
+          {
+            type: 'time-range-valid',
+            message: 'Insertion time range must be valid',
+          },
+        ],
+        requiresConfirmation: true,
+      },
+    ],
+    {
+      status: 'pending-approval',
+      requiredApprovals: [
+        {
+          id: 'approval-insert-broll-1',
+          stepId: 'insert-broll-1',
+          reason: 'project-edit',
+          description: 'Insert B-roll clip into the timeline.',
+          privacyImpact: { dataLeavesDevice: false, dataTypes: [] },
+          isReversible: true,
+          status: 'pending',
+        },
+      ],
+    },
+  );
+}
+
+function scoreRange(
+  index: SemanticBrollSearchIndexV1,
+  asset: SemanticBrollAssetV1,
+  range: SemanticBrollTimeRangeV1,
+  queryTokens: readonly string[],
+): BrollSearchResult {
+  if (range.evidenceIds.length === 0) {
+    throw new BrollSearchError(
+      'BROLL_RESULT_MISSING_EVIDENCE',
+      `range ${range.rangeId} has no evidence`,
+    );
+  }
+  for (const evidenceId of range.evidenceIds) {
+    if (!index.evidenceIndex.has(evidenceId)) {
+      throw new BrollSearchError(
+        'BROLL_RESULT_MISSING_EVIDENCE',
+        `range ${range.rangeId} cites missing evidence ${evidenceId}`,
+      );
+    }
+  }
+
+  const searchableText = [
+    asset.displayName,
+    asset.tags?.join(' ') ?? '',
+    range.label,
+    range.text,
+    ...range.evidenceIds.map((evidenceId) => {
+      const evidence = index.evidenceIndex.get(evidenceId);
+      return `${evidence?.label ?? ''} ${evidence?.summary ?? ''}`;
+    }),
+  ]
+    .join(' ')
+    .toLowerCase();
+  const matches = queryTokens.filter((token) => searchableText.includes(token));
+  const unusedBoost = asset.usedInTimeline ? 0 : 2;
+  const evidenceBoost = Math.min(2, range.evidenceIds.length * 0.25);
+  const score = matches.length * 3 + unusedBoost + evidenceBoost;
+  const explanations = [
+    `Base score ${score.toFixed(2)} from ${matches.length} query match(es) and ${range.evidenceIds.length} evidence link(s).`,
+    asset.usedInTimeline
+      ? 'Asset is already used in the timeline.'
+      : 'Asset is unused in the timeline, so it is ranked ahead of otherwise similar clips.',
+  ];
+
+  return {
+    resultId: `${asset.assetId}:${range.rangeId}`,
+    assetId: asset.assetId,
+    displayName: asset.displayName,
+    assetType: asset.assetType,
+    usedInTimeline: asset.usedInTimeline,
+    range: {
+      startUs: range.startUs,
+      durationUs: range.durationUs,
+    },
+    evidenceIds: [...range.evidenceIds],
+    score,
+    explanations,
+  };
+}
+
+function applyRerank(
+  candidates: readonly BrollSearchResult[],
+  reranked: readonly BrollRerankResult[],
+): readonly BrollSearchResult[] {
+  const byId = new Map(candidates.map((candidate) => [candidate.resultId, candidate]));
+  const consumed = new Set<string>();
+  const output: BrollSearchResult[] = [];
+  for (const item of [...reranked].sort(
+    (left, right) => right.score - left.score || left.resultId.localeCompare(right.resultId),
+  )) {
+    const candidate = byId.get(item.resultId);
+    if (candidate === undefined) continue;
+    consumed.add(candidate.resultId);
+    output.push({
+      ...candidate,
+      score: item.score,
+      explanations: [
+        ...candidate.explanations,
+        `Reranked score ${item.score.toFixed(2)}${item.reason === undefined ? '' : `: ${item.reason}`}.`,
+      ],
+    });
+  }
+  output.push(...candidates.filter((candidate) => !consumed.has(candidate.resultId)));
+  return output;
+}
+
+function assetMatchesRequest(asset: SemanticBrollAssetV1, request: BrollSearchRequest): boolean {
+  if (request.unusedOnly === true && asset.usedInTimeline) return false;
+  if (request.assetTypes !== undefined && !request.assetTypes.includes(asset.assetType)) {
+    return false;
+  }
+  return true;
+}
+
+function rangeMatchesRequest(
+  range: SemanticBrollTimeRangeV1,
+  request: BrollSearchRequest,
+): boolean {
+  if (request.timeRange === undefined) return true;
+  const rangeEndUs = range.startUs + range.durationUs;
+  return range.startUs < request.timeRange.endUs && request.timeRange.startUs < rangeEndUs;
+}
+
+function compareBaseResults(left: BrollSearchResult, right: BrollSearchResult): number {
+  if (left.usedInTimeline !== right.usedInTimeline) return left.usedInTimeline ? 1 : -1;
+  return (
+    right.score - left.score ||
+    left.assetId.localeCompare(right.assetId) ||
+    left.range.startUs - right.range.startUs
+  );
+}
+
+function tokenize(query: string): readonly string[] {
+  return [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(
+    (token) => token.length > 1,
+  );
+}
diff --git a/packages/agent-tools/src/index.ts b/packages/agent-tools/src/index.ts
index 94e4e52..a7e2a99 100644
--- a/packages/agent-tools/src/index.ts
+++ b/packages/agent-tools/src/index.ts
@@ -211,20 +211,31 @@ export { revertAgentRun, findAgentTransactions, canRevertAgentRun } from './reve
 
 export type { AuditEntry, AuditAction } from './audit.js';
 export { AuditTrail, createAuditTrail } from './audit.js';
 
 export type { AgentMemory, AgentPreference } from './memory.js';
 export { AgentMemoryManager, createAgentMemoryManager } from './memory.js';
 
 export type { KiloCodeHostOptions } from './kilocode-host.js';
 export { KILOCODE_AGENT_HOST_ID, createKiloCodeAgentHostManifest } from './kilocode-host.js';
 
+export type {
+  BrollInsertionProposalOptions,
+  BrollRerankCandidate,
+  BrollRerankResult,
+  BrollSearchRequest,
+  BrollSearchResponse,
+  BrollSearchResult,
+  BrollSearchServices,
+} from './broll-search.js';
+export { BrollSearchError, createBrollInsertionProposal, searchBroll } from './broll-search.js';
+
 export type {
   CreativeBriefDomainV1,
   CreativeFocusAreaV1,
   ConfidenceLevelV1,
   RiskClassificationV1,
   CreativeRecommendationKindV1,
   CreativeTimeRangeV1,
   CreativeBriefScopeV1,
   CreativeConstraintV1,
   ReferenceMaterialV1,
diff --git a/packages/job-protocol/src/index.ts b/packages/job-protocol/src/index.ts
index df1929e..aed8a92 100644
--- a/packages/job-protocol/src/index.ts
+++ b/packages/job-protocol/src/index.ts
@@ -44,23 +44,31 @@ export type {
   RenderExportReceipt,
   RenderInspectJob,
   RenderInspectReceipt,
   RenderJob,
   RenderJobPayload,
   RenderJobType,
   RenderReceipt,
 } from './render-jobs.js';
 export type {
   MediaAnalysisJob,
+  MediaSemanticIndexEvidence,
+  MediaSemanticIndexJob,
+  MediaSemanticIndexPayload,
+  MediaSemanticIndexReceipt,
   ReferenceAnalysisEvidence,
   ReferenceAnalysisFinding,
   VideoReferenceAnalyzeJob,
   VideoReferenceAnalyzePayload,
   VideoReferenceAnalyzeReceipt,
 } from './media-analysis-jobs.js';
+export {
+  assertValidMediaSemanticIndexPayload,
+  assertValidMediaSemanticIndexReceipt,
+} from './media-analysis-jobs.js';
 export type {
   AgentJobState,
   AgentJobRequest,
   AgentJobResult,
   AgentJobSnapshot,
   AgentJobClient,
 } from './agent-jobs.js';
diff --git a/packages/job-protocol/src/media-analysis-jobs.ts b/packages/job-protocol/src/media-analysis-jobs.ts
index 0460056..3e0fc4a 100644
--- a/packages/job-protocol/src/media-analysis-jobs.ts
+++ b/packages/job-protocol/src/media-analysis-jobs.ts
@@ -1,10 +1,17 @@
+import type {
+  AssetAudioEvidenceV1,
+  AssetCaptionEvidenceV1,
+  AssetShotEvidenceV1,
+  SemanticBrollAssetV1,
+} from '@joy-media/project-schema';
+
 export type ReferenceAnalysisEvidenceKind =
   | 'shot'
   | 'cut-rhythm'
   | 'palette'
   | 'composition'
   | 'text-safe-zone'
   | 'transcript'
   | 'audio-beat';
 
 export interface ReferenceAnalysisBox {
@@ -135,21 +142,64 @@ export interface VideoReferenceAnalyzeReceipt {
     readonly sampleCount: number;
     readonly transcriptSegmentCount: number;
     readonly audioBeatCount: number;
   };
   readonly evidence: readonly ReferenceAnalysisEvidence[];
   readonly evidenceIds: readonly string[];
   readonly findings?: readonly ReferenceAnalysisFinding[];
   readonly model?: string;
 }
 
-export type MediaAnalysisJob = VideoReferenceAnalyzeJob;
+export type MediaSemanticIndexEvidence =
+  AssetShotEvidenceV1 | AssetCaptionEvidenceV1 | AssetAudioEvidenceV1;
+
+export interface MediaSemanticIndexPayload {
+  readonly projectId: string;
+  readonly receipts: readonly VideoReferenceAnalyzeReceipt[];
+  readonly usedAssetIds?: readonly string[];
+  readonly maxAssets?: number;
+  readonly includeEmbeddings?: boolean;
+  readonly includeRemoteRerank?: boolean;
+}
+
+export interface MediaSemanticIndexJob {
+  readonly protocolVersion: 1;
+  readonly jobId: string;
+  readonly type: 'media.semantic-index';
+  readonly payload: MediaSemanticIndexPayload;
+  readonly requirements: {
+    readonly capabilities: readonly string[];
+    readonly privacy: 'local-only' | 'remote-api';
+  };
+  readonly idempotencyKey: string;
+  readonly maxAttempts: number;
+}
+
+export interface MediaSemanticIndexReceipt {
+  readonly kind: 'media.semantic-index';
+  readonly projectId: string;
+  readonly sha256: string;
+  readonly bytes: number;
+  readonly summary: {
+    readonly assetCount: number;
+    readonly rangeCount: number;
+    readonly evidenceCount: number;
+    readonly embeddedRangeCount: number;
+    readonly reranked: boolean;
+  };
+  readonly evidence: readonly MediaSemanticIndexEvidence[];
+  readonly evidenceIds: readonly string[];
+  readonly assets: readonly SemanticBrollAssetV1[];
+  readonly model?: string;
+}
+
+export type MediaAnalysisJob = VideoReferenceAnalyzeJob | MediaSemanticIndexJob;
 
 export function assertValidVideoReferenceAnalyzePayload(
   payload: unknown,
   label = 'payload',
 ): asserts payload is VideoReferenceAnalyzePayload {
   const value = requireRecord(payload, label);
   requireOpaqueId(value.assetId, `${label}.assetId`);
   requirePositiveInteger(value.maxDurationUs, `${label}.maxDurationUs`);
   requirePositiveInteger(value.maxBytes, `${label}.maxBytes`);
   if (value.sampleCount !== undefined)
@@ -215,20 +265,154 @@ export function assertValidVideoReferenceAnalyzeReceipt(
         new Set(derivedEvidenceIds),
         `${label}.findings[${index}]`,
       ),
     );
   }
   if (value.model !== undefined && typeof value.model !== 'string') {
     throw new Error(`${label}.model must be a string`);
   }
 }
 
+export function assertValidMediaSemanticIndexPayload(
+  payload: unknown,
+  label = 'payload',
+): asserts payload is MediaSemanticIndexPayload {
+  const value = requireRecord(payload, label);
+  requireOpaqueId(value.projectId, `${label}.projectId`);
+  const receipts = requireArray(value.receipts, `${label}.receipts`);
+  if (receipts.length > 1_000)
+    throw new Error(`${label}.receipts must contain at most 1000 entries`);
+  receipts.forEach((receipt, index) =>
+    assertValidVideoReferenceAnalyzeReceipt(receipt, `${label}.receipts[${index}]`),
+  );
+  if (value.usedAssetIds !== undefined) {
+    requireArray(value.usedAssetIds, `${label}.usedAssetIds`).forEach((assetId, index) =>
+      requireOpaqueId(assetId, `${label}.usedAssetIds[${index}]`),
+    );
+  }
+  if (value.maxAssets !== undefined) {
+    requireIntegerInRange(value.maxAssets, 1, 1_000, `${label}.maxAssets`);
+  }
+  if (value.includeEmbeddings !== undefined && typeof value.includeEmbeddings !== 'boolean') {
+    throw new Error(`${label}.includeEmbeddings must be a boolean`);
+  }
+  if (value.includeRemoteRerank !== undefined && typeof value.includeRemoteRerank !== 'boolean') {
+    throw new Error(`${label}.includeRemoteRerank must be a boolean`);
+  }
+}
+
+export function assertValidMediaSemanticIndexReceipt(
+  receipt: unknown,
+  label = 'receipt',
+): asserts receipt is MediaSemanticIndexReceipt {
+  const value = requireRecord(receipt, label);
+  if (value.kind !== 'media.semantic-index') throw new Error(`${label}.kind is invalid`);
+  requireOpaqueId(value.projectId, `${label}.projectId`);
+  requireHash(value.sha256, `${label}.sha256`);
+  requirePositiveInteger(value.bytes, `${label}.bytes`);
+  const summary = requireRecord(value.summary, `${label}.summary`);
+  requireNonNegativeInteger(summary.assetCount, `${label}.summary.assetCount`);
+  requireNonNegativeInteger(summary.rangeCount, `${label}.summary.rangeCount`);
+  requireNonNegativeInteger(summary.evidenceCount, `${label}.summary.evidenceCount`);
+  requireNonNegativeInteger(summary.embeddedRangeCount, `${label}.summary.embeddedRangeCount`);
+  if (typeof summary.reranked !== 'boolean') {
+    throw new Error(`${label}.summary.reranked must be a boolean`);
+  }
+  const evidence = requireArray(value.evidence, `${label}.evidence`);
+  if (evidence.length > 5_000)
+    throw new Error(`${label}.evidence must contain at most 5000 entries`);
+  evidence.forEach((entry, index) =>
+    assertValidSemanticIndexEvidence(entry, `${label}.evidence[${index}]`),
+  );
+  const evidenceIds = requireArray(value.evidenceIds, `${label}.evidenceIds`);
+  const derivedEvidenceIds = evidence.map((entry) => (entry as MediaSemanticIndexEvidence).id);
+  if (
+    evidenceIds.length !== derivedEvidenceIds.length ||
+    evidenceIds.some((entry, index) => entry !== derivedEvidenceIds[index])
+  ) {
+    throw new Error(`${label}.evidenceIds must match evidence order exactly`);
+  }
+  const knownEvidence = new Set(derivedEvidenceIds);
+  requireArray(value.assets, `${label}.assets`).forEach((asset, assetIndex) => {
+    const assetValue = requireRecord(asset, `${label}.assets[${assetIndex}]`);
+    requireOpaqueId(assetValue.assetId, `${label}.assets[${assetIndex}].assetId`);
+    if (typeof assetValue.displayName !== 'string' || assetValue.displayName.length === 0) {
+      throw new Error(`${label}.assets[${assetIndex}].displayName must be a non-empty string`);
+    }
+    if (
+      assetValue.assetType !== 'video' &&
+      assetValue.assetType !== 'audio' &&
+      assetValue.assetType !== 'image' &&
+      assetValue.assetType !== 'other'
+    ) {
+      throw new Error(`${label}.assets[${assetIndex}].assetType is invalid`);
+    }
+    if (typeof assetValue.usedInTimeline !== 'boolean') {
+      throw new Error(`${label}.assets[${assetIndex}].usedInTimeline must be a boolean`);
+    }
+    requireArray(assetValue.ranges, `${label}.assets[${assetIndex}].ranges`).forEach(
+      (range, rangeIndex) => {
+        const rangeValue = requireRecord(
+          range,
+          `${label}.assets[${assetIndex}].ranges[${rangeIndex}]`,
+        );
+        requireOpaqueId(
+          rangeValue.rangeId,
+          `${label}.assets[${assetIndex}].ranges[${rangeIndex}].rangeId`,
+        );
+        if (rangeValue.assetId !== assetValue.assetId) {
+          throw new Error(
+            `${label}.assets[${assetIndex}].ranges[${rangeIndex}].assetId must match assetId`,
+          );
+        }
+        requirePositiveInteger(
+          rangeValue.startUs,
+          `${label}.assets[${assetIndex}].ranges[${rangeIndex}].startUs`,
+          true,
+        );
+        requirePositiveInteger(
+          rangeValue.durationUs,
+          `${label}.assets[${assetIndex}].ranges[${rangeIndex}].durationUs`,
+        );
+        if (typeof rangeValue.label !== 'string' || rangeValue.label.length === 0) {
+          throw new Error(
+            `${label}.assets[${assetIndex}].ranges[${rangeIndex}].label must be non-empty`,
+          );
+        }
+        if (typeof rangeValue.text !== 'string') {
+          throw new Error(
+            `${label}.assets[${assetIndex}].ranges[${rangeIndex}].text must be a string`,
+          );
+        }
+        const ids = requireArray(
+          rangeValue.evidenceIds,
+          `${label}.assets[${assetIndex}].ranges[${rangeIndex}].evidenceIds`,
+        );
+        if (ids.length === 0)
+          throw new Error(
+            `${label}.assets[${assetIndex}].ranges[${rangeIndex}].evidenceIds must not be empty`,
+          );
+        ids.forEach((entry, index) => {
+          if (typeof entry !== 'string' || !knownEvidence.has(entry)) {
+            throw new Error(
+              `${label}.assets[${assetIndex}].ranges[${rangeIndex}].evidenceIds[${index}] references unknown evidence`,
+            );
+          }
+        });
+      },
+    );
+  });
+  if (value.model !== undefined && typeof value.model !== 'string') {
+    throw new Error(`${label}.model must be a string`);
+  }
+}
+
 function assertValidReferenceAnalysisEvidence(
   evidence: unknown,
   label: string,
 ): asserts evidence is ReferenceAnalysisEvidence {
   const value = requireRecord(evidence, label);
   requireOpaqueId(value.id, `${label}.id`);
   if (typeof value.label !== 'string' || value.label.length === 0) {
     throw new Error(`${label}.label must be a non-empty string`);
   }
   if (typeof value.summary !== 'string' || value.summary.length === 0) {
@@ -288,20 +472,70 @@ function assertValidReferenceAnalysisEvidence(
         value.strength < 0
       ) {
         throw new Error(`${label}.strength must be a non-negative finite number`);
       }
       return;
     default:
       throw new Error(`${label}.kind is invalid`);
   }
 }
 
+function assertValidSemanticIndexEvidence(
+  evidence: unknown,
+  label: string,
+): asserts evidence is MediaSemanticIndexEvidence {
+  const value = requireRecord(evidence, label);
+  requireOpaqueId(value.id, `${label}.id`);
+  requireOpaqueId(value.assetId, `${label}.assetId`);
+  if (typeof value.label !== 'string' || value.label.length === 0) {
+    throw new Error(`${label}.label must be a non-empty string`);
+  }
+  if (value.summary !== undefined && typeof value.summary !== 'string') {
+    throw new Error(`${label}.summary must be a string`);
+  }
+  requireOpaqueId(value.sourceEntityId, `${label}.sourceEntityId`);
+  requireNonNegativeInteger(value.sourceEntityRevision, `${label}.sourceEntityRevision`);
+  switch (value.kind) {
+    case 'asset-shot':
+      requirePositiveInteger(value.startUs, `${label}.startUs`, true);
+      requirePositiveInteger(value.durationUs, `${label}.durationUs`);
+      if (value.tags !== undefined) requireArray(value.tags, `${label}.tags`);
+      return;
+    case 'asset-caption':
+      requirePositiveInteger(value.startUs, `${label}.startUs`, true);
+      requirePositiveInteger(value.durationUs, `${label}.durationUs`);
+      if (typeof value.text !== 'string') throw new Error(`${label}.text must be a string`);
+      if (value.language !== undefined && typeof value.language !== 'string') {
+        throw new Error(`${label}.language must be a string`);
+      }
+      return;
+    case 'asset-audio':
+      requirePositiveInteger(value.startUs, `${label}.startUs`, true);
+      requirePositiveInteger(value.durationUs, `${label}.durationUs`);
+      if (
+        value.audioKind !== 'dialogue' &&
+        value.audioKind !== 'music' &&
+        value.audioKind !== 'sfx' &&
+        value.audioKind !== 'ambient' &&
+        value.audioKind !== 'unknown'
+      ) {
+        throw new Error(`${label}.audioKind is invalid`);
+      }
+      if (value.transcript !== undefined && typeof value.transcript !== 'string') {
+        throw new Error(`${label}.transcript must be a string`);
+      }
+      return;
+    default:
+      throw new Error(`${label}.kind is invalid`);
+  }
+}
+
 function assertValidReferenceAnalysisFinding(
   finding: unknown,
   evidenceIds: ReadonlySet<string>,
   label: string,
 ): asserts finding is ReferenceAnalysisFinding {
   const value = requireRecord(finding, label);
   requireOpaqueId(value.id, `${label}.id`);
   if (value.source !== 'deterministic' && value.source !== 'model') {
     throw new Error(`${label}.source must be deterministic or model`);
   }
diff --git a/packages/job-protocol/src/protocol.ts b/packages/job-protocol/src/protocol.ts
index 65c18ff..be710e1 100644
--- a/packages/job-protocol/src/protocol.ts
+++ b/packages/job-protocol/src/protocol.ts
@@ -1,32 +1,36 @@
 /** P00.5 Worker protocol spike: outbound pairing, capability snapshots, and local-only thumbnails. */
 
 import type { RenderJob, RenderReceipt } from './render-jobs.js';
 import type {
   MediaAnalysisJob,
+  MediaSemanticIndexReceipt,
   ReferenceAnalysisEvidence,
   ReferenceAnalysisFinding,
   VideoReferenceAnalyzeJob,
   VideoReferenceAnalyzeReceipt,
 } from './media-analysis-jobs.js';
 import {
+  assertValidMediaSemanticIndexPayload,
+  assertValidMediaSemanticIndexReceipt,
   assertValidVideoReferenceAnalyzePayload,
   assertValidVideoReferenceAnalyzeReceipt,
 } from './media-analysis-jobs.js';
 
 export const WORKER_PROTOCOL_VERSION = 1 as const;
 
 export type WorkerCapability =
   | 'asset.thumbnail'
   | 'render.export'
   | 'render.inspect'
   | 'video.reference-analyze'
+  | 'media.semantic-index'
   | 'image.comfy'
   | 'audio.ml-denoise'
   | 'text.lm-studio'
   | 'text.openrouter'
   | 'video.runway'
   | 'edit.higgsfield';
 
 export type SpecializedJobType =
   | 'image.comfy'
   | 'audio.ml-denoise'
@@ -42,20 +46,21 @@ export const SPECIALIZED_JOB_TYPES: readonly WorkerCapability[] = [
   'video.runway',
   'edit.higgsfield',
 ] as const;
 export type WorkerJobType =
   'asset.thumbnail' | SpecializedJobType | MediaAnalysisJob['type'] | RenderJob['type'];
 export const WORKER_JOB_TYPES: readonly WorkerJobType[] = [
   'asset.thumbnail',
   'render.export',
   'render.inspect',
   'video.reference-analyze',
+  'media.semantic-index',
   ...SPECIALIZED_JOB_TYPES,
 ] as const;
 
 /** @deprecated Use SpecializedJobType */
 export type LocalGpuWorkerJobType = SpecializedJobType;
 /** @deprecated Use SPECIALIZED_JOB_TYPES */
 export const LOCAL_GPU_WORKER_CAPABILITIES: readonly WorkerCapability[] = SPECIALIZED_JOB_TYPES;
 export type ThumbnailJobState =
   'queued' | 'assigned' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'canceled';
 
@@ -319,20 +324,21 @@ export type WorkerResultReceiptV1 =
         readonly fastestShotDurationUs: number;
         readonly sampleCount: number;
         readonly transcriptSegmentCount: number;
         readonly audioBeatCount: number;
       };
       readonly evidence: readonly ReferenceAnalysisEvidence[];
       readonly evidenceIds: readonly string[];
       readonly findings?: readonly ReferenceAnalysisFinding[];
       readonly model?: string;
     }
+  | MediaSemanticIndexReceipt
   | RenderReceipt;
 
 interface WorkerSession {
   readonly workerId: string;
   readonly token: string;
   hello?: WorkerCapabilitySnapshot;
 }
 
 interface MutableJob {
   readonly job: ThumbnailJob;
@@ -661,20 +667,30 @@ function validateWorkerJobPayload(job: WorkerJobV1): void {
     case 'video.reference-analyze':
       try {
         assertValidVideoReferenceAnalyzePayload(job.payload, 'payload');
       } catch (error) {
         throw new WorkerProtocolError(
           'WORKER_JOB_INVALID',
           error instanceof Error ? error.message : 'payload is invalid',
         );
       }
       return;
+    case 'media.semantic-index':
+      try {
+        assertValidMediaSemanticIndexPayload(job.payload, 'payload');
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
@@ -707,20 +723,21 @@ function validateWorkerJobRequirements(
     requirements.capabilities.some((capability) => !isWorkerCapability(capability))
   ) {
     throw new WorkerProtocolError('WORKER_JOB_INVALID', 'requirements capabilities are invalid');
   }
   if (requirements.privacy !== 'local-only' && requirements.privacy !== 'remote-api') {
     throw new WorkerProtocolError('WORKER_JOB_INVALID', 'requirements privacy is invalid');
   }
   if (
     (jobType === 'asset.thumbnail' ||
       jobType === 'video.reference-analyze' ||
+      jobType === 'media.semantic-index' ||
       jobType === 'render.export' ||
       jobType === 'render.inspect') &&
     requirements.privacy !== 'local-only'
   ) {
     throw new WorkerProtocolError('WORKER_JOB_INVALID', 'job privacy requirement mismatch');
   }
 }
 
 function validateWorkerReceiptShape(jobType: WorkerJobType, receipt: WorkerResultReceiptV1): void {
   switch (jobType) {
@@ -769,20 +786,31 @@ function validateWorkerReceiptShape(jobType: WorkerJobType, receipt: WorkerResul
       try {
         assertValidVideoReferenceAnalyzeReceipt(receipt, 'receipt');
       } catch (error) {
         throw new WorkerProtocolError(
           'WORKER_RECEIPT_INVALID',
           error instanceof Error ? error.message : 'receipt is invalid',
         );
       }
       return;
     }
+    case 'media.semantic-index': {
+      try {
+        assertValidMediaSemanticIndexReceipt(receipt, 'receipt');
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
diff --git a/packages/project-schema/src/index.ts b/packages/project-schema/src/index.ts
index c9557b6..4f5d075 100644
--- a/packages/project-schema/src/index.ts
+++ b/packages/project-schema/src/index.ts
@@ -148,20 +148,23 @@ export type {
 
 export type {
   SnapshotId,
   SnapshotRevision,
   EvidenceId,
   ISO8601 as SnapshotISO8601,
   SnapshotMetadataV1,
   EvidenceKindV1,
   SnapshotEvidenceV1,
   AssetEvidenceV1,
+  AssetShotEvidenceV1,
+  AssetCaptionEvidenceV1,
+  AssetAudioEvidenceV1,
   ClipEvidenceV1,
   CaptionDocumentEvidenceV1,
   MarkerEvidenceV1,
   CompositionEvidenceV1,
   TrackEvidenceV1,
   VisualObjectEvidenceV1,
   EffectEvidenceV1,
   TransitionEvidenceV1,
   AudioRegionEvidenceV1,
   WorkflowArtifactEvidenceV1,
@@ -187,30 +190,34 @@ export {
 
 export type {
   IntelligenceId,
   IntelligenceRevision,
   ISO8601 as IntelligenceISO8601,
   IntelligenceMetadataV1,
   FindingSeverityV1,
   FindingCategoryV1,
   IntelligenceFindingV1,
   IntelligenceRuleV1,
+  SemanticBrollTimeRangeV1,
+  SemanticBrollAssetV1,
+  SemanticBrollSearchIndexV1,
   IntelligenceStatisticsV1,
   SemanticIntelligenceV1,
   IntelligenceValidationResultV1,
   BuildIntelligenceOptionsV1,
 } from './semantic-intelligence.js';
 export {
   FINDING_SEVERITIES_V1,
   FINDING_CATEGORIES_V1,
   validateIntelligenceFinding,
   validateIntelligenceRule,
+  validateSemanticBrollSearchIndexV1,
   createSemanticIntelligenceV1,
   validateSemanticIntelligenceV1,
   hasFinding,
   getFinding,
   getFindingsByCategory,
   getFindingsBySeverity,
   getFindingsByEvidence,
   isSemanticIntelligenceV1,
   isIntelligenceFindingV1,
   isIntelligenceRuleV1,
diff --git a/packages/project-schema/src/semantic-intelligence.test.ts b/packages/project-schema/src/semantic-intelligence.test.ts
index 335eb35..15f5474 100644
--- a/packages/project-schema/src/semantic-intelligence.test.ts
+++ b/packages/project-schema/src/semantic-intelligence.test.ts
@@ -1,41 +1,39 @@
 /**
  * S2: Semantic Intelligence Tests
- * 
+ *
  * Tests for semantic-intelligence.ts types and validation
  */
 
-import {
-  describe,
-  expect,
-  it,
-} from 'vitest';
+import { describe, expect, it } from 'vitest';
 
 import {
   BUILT_IN_RULES_V1,
   createSemanticIntelligenceV1,
   FINDING_CATEGORIES_V1,
   FINDING_SEVERITIES_V1,
   getBuiltInRuleV1,
   getBuiltInRulesV1,
   getFinding,
   getFindingsByCategory,
   getFindingsByEvidence,
   getFindingsBySeverity,
   hasFinding,
   isIntelligenceFindingV1,
   isIntelligenceRuleV1,
   isSemanticIntelligenceV1,
   type IntelligenceFindingV1,
   type IntelligenceRuleV1,
+  type SemanticBrollSearchIndexV1,
   validateIntelligenceFinding,
   validateIntelligenceRule,
+  validateSemanticBrollSearchIndexV1,
   validateSemanticIntelligenceV1,
 } from './semantic-intelligence.js';
 import { createSemanticIntelligenceV1 as createSemanticIntelligencePublic } from './index.js';
 
 // ============================================================================
 // Fixtures
 // ============================================================================
 
 const validFinding: IntelligenceFindingV1 = {
   id: 'finding-001',
@@ -102,57 +100,57 @@ describe('validateIntelligenceFinding', () => {
     const errors = validateIntelligenceFinding('not an object');
     expect(errors).toContain('Finding must be an object');
   });
 
   it('should reject finding with empty id', () => {
     const finding: IntelligenceFindingV1 = {
       ...validFinding,
       id: '',
     };
     const errors = validateIntelligenceFinding(finding);
-    expect(errors.some(e => e.includes('id'))).toBe(true);
+    expect(errors.some((e) => e.includes('id'))).toBe(true);
   });
 
   it('should reject finding with invalid category', () => {
     const finding: IntelligenceFindingV1 = {
       ...validFinding,
       category: 'invalid-category' as any,
     };
     const errors = validateIntelligenceFinding(finding);
-    expect(errors.some(e => e.includes('category'))).toBe(true);
+    expect(errors.some((e) => e.includes('category'))).toBe(true);
   });
 
   it('should reject finding with invalid severity', () => {
     const finding: IntelligenceFindingV1 = {
       ...validFinding,
       severity: 'invalid-severity' as any,
     };
     const errors = validateIntelligenceFinding(finding);
-    expect(errors.some(e => e.includes('severity'))).toBe(true);
+    expect(errors.some((e) => e.includes('severity'))).toBe(true);
   });
 
   it('should reject finding with empty title', () => {
     const finding: IntelligenceFindingV1 = {
       ...validFinding,
       title: '',
     };
     const errors = validateIntelligenceFinding(finding);
-    expect(errors.some(e => e.includes('title'))).toBe(true);
+    expect(errors.some((e) => e.includes('title'))).toBe(true);
   });
 
   it('should reject finding with empty description', () => {
     const finding: IntelligenceFindingV1 = {
       ...validFinding,
       description: '',
     };
     const errors = validateIntelligenceFinding(finding);
-    expect(errors.some(e => e.includes('description'))).toBe(true);
+    expect(errors.some((e) => e.includes('description'))).toBe(true);
   });
 
   it('should reject finding with empty evidenceIds array', () => {
     const finding: IntelligenceFindingV1 = {
       ...validFinding,
       evidenceIds: [],
     };
     // Empty array is still an array, so this should pass
     // EvidenceIds can be empty (finding applies to whole project)
     const errors = validateIntelligenceFinding(finding);
@@ -223,75 +221,75 @@ describe('validateIntelligenceRule', () => {
     const errors = validateIntelligenceRule('not an object');
     expect(errors).toContain('Rule must be an object');
   });
 
   it('should reject rule with empty id', () => {
     const rule: IntelligenceRuleV1 = {
       ...validRule,
       id: '',
     };
     const errors = validateIntelligenceRule(rule);
-    expect(errors.some(e => e.includes('id'))).toBe(true);
+    expect(errors.some((e) => e.includes('id'))).toBe(true);
   });
 
   it('should reject rule with empty name', () => {
     const rule: IntelligenceRuleV1 = {
       ...validRule,
       name: '',
     };
     const errors = validateIntelligenceRule(rule);
-    expect(errors.some(e => e.includes('name'))).toBe(true);
+    expect(errors.some((e) => e.includes('name'))).toBe(true);
   });
 
   it('should reject rule with empty description', () => {
     const rule: IntelligenceRuleV1 = {
       ...validRule,
       description: '',
     };
     const errors = validateIntelligenceRule(rule);
-    expect(errors.some(e => e.includes('description'))).toBe(true);
+    expect(errors.some((e) => e.includes('description'))).toBe(true);
   });
 
   it('should reject rule with invalid category', () => {
     const rule: IntelligenceRuleV1 = {
       ...validRule,
       category: 'invalid-category' as any,
     };
     const errors = validateIntelligenceRule(rule);
-    expect(errors.some(e => e.includes('category'))).toBe(true);
+    expect(errors.some((e) => e.includes('category'))).toBe(true);
   });
 
   it('should reject rule with invalid severity', () => {
     const rule: IntelligenceRuleV1 = {
       ...validRule,
       defaultSeverity: 'invalid-severity' as any,
     };
     const errors = validateIntelligenceRule(rule);
-    expect(errors.some(e => e.includes('defaultSeverity'))).toBe(true);
+    expect(errors.some((e) => e.includes('defaultSeverity'))).toBe(true);
   });
 
   it('should reject rule with enabled not boolean', () => {
     const rule: IntelligenceRuleV1 = {
       ...validRule,
       enabled: 'yes' as any,
     };
     const errors = validateIntelligenceRule(rule);
-    expect(errors.some(e => e.includes('enabled'))).toBe(true);
+    expect(errors.some((e) => e.includes('enabled'))).toBe(true);
   });
 
   it('should reject rule with invalid appliesTo', () => {
     const rule: IntelligenceRuleV1 = {
       ...validRule,
       appliesTo: 'not an array' as any,
     };
     const errors = validateIntelligenceRule(rule);
-    expect(errors.some(e => e.includes('appliesTo'))).toBe(true);
+    expect(errors.some((e) => e.includes('appliesTo'))).toBe(true);
   });
 
   it('should reject rule with unknown evidence kinds in appliesTo', () => {
     const rule: IntelligenceRuleV1 = {
       ...validRule,
       appliesTo: ['clip', 'not-a-kind' as any],
     };
 
     const errors = validateIntelligenceRule(rule);
     expect(errors.some((error) => error.includes('appliesTo'))).toBe(true);
@@ -344,30 +342,26 @@ describe('createSemanticIntelligenceV1', () => {
     expect(intelligence.statistics.totalFindings).toBe(3);
     expect(intelligence.statistics.findingsBySeverity.error).toBe(1);
     expect(intelligence.statistics.findingsBySeverity.warning).toBe(1);
     expect(intelligence.statistics.findingsBySeverity.info).toBe(1);
     expect(intelligence.statistics.findingsBySeverity.notice).toBe(0);
     expect(intelligence.statistics.findingsByCategory.completeness).toBe(2);
     expect(intelligence.statistics.findingsByCategory.structure).toBe(1);
   });
 
   it('should handle empty findings', () => {
-    const intelligence = createSemanticIntelligenceV1(
-      [],
-      [validRule],
-      {
-        projectId: 'project-001',
-        snapshotRevision: 1,
-        createdBy: 'test-user',
-        contentHash: 'abc123',
-      },
-    );
+    const intelligence = createSemanticIntelligenceV1([], [validRule], {
+      projectId: 'project-001',
+      snapshotRevision: 1,
+      createdBy: 'test-user',
+      contentHash: 'abc123',
+    });
 
     expect(intelligence.findings).toHaveLength(0);
     expect(intelligence.findingIndex.size).toBe(0);
     expect(intelligence.findingIds).toHaveLength(0);
     expect(intelligence.statistics.totalFindings).toBe(0);
   });
 
   it('should round-trip through JSON and remain valid after rebuilding derived indexes', () => {
     const intelligence = createSemanticIntelligenceV1(
       [
@@ -382,132 +376,119 @@ describe('createSemanticIntelligenceV1', () => {
       ],
       [validRule],
       {
         projectId: 'project-001',
         snapshotRevision: 1,
         createdBy: 'test-user',
         contentHash: 'abc123',
       },
     );
 
-    const parsed = JSON.parse(JSON.stringify(intelligence)) as Omit<typeof intelligence, 'findingIndex'> & {
+    const parsed = JSON.parse(JSON.stringify(intelligence)) as Omit<
+      typeof intelligence,
+      'findingIndex'
+    > & {
       findingIndex?: unknown;
     };
 
     const rebuilt = createSemanticIntelligencePublic(parsed.findings, parsed.rules, {
       projectId: parsed.metadata.projectId,
       snapshotRevision: parsed.snapshotRevision,
       createdBy: parsed.metadata.createdBy,
       contentHash: parsed.metadata.contentHash,
     });
 
     const result = validateSemanticIntelligenceV1(rebuilt, projectDerivedEvidenceIds);
     expect(result.valid).toBe(true);
     expect(result.warnings).toEqual([]);
     expect(rebuilt.findingIds).toEqual(intelligence.findingIds);
   });
 
   it('should produce the same metadata id for identical inputs', () => {
     const originalNow = Date.now;
     try {
       Date.now = () => 1000;
-      const first = createSemanticIntelligenceV1(
-        [validFinding],
-        [validRule],
-        {
-          projectId: 'project-001',
-          snapshotRevision: 1,
-          createdBy: 'test-user',
-          contentHash: 'abc123',
-        },
-      );
+      const first = createSemanticIntelligenceV1([validFinding], [validRule], {
+        projectId: 'project-001',
+        snapshotRevision: 1,
+        createdBy: 'test-user',
+        contentHash: 'abc123',
+      });
 
       Date.now = () => 2000;
-      const second = createSemanticIntelligenceV1(
-        [validFinding],
-        [validRule],
-        {
-          projectId: 'project-001',
-          snapshotRevision: 1,
-          createdBy: 'test-user',
-          contentHash: 'abc123',
-        },
-      );
+      const second = createSemanticIntelligenceV1([validFinding], [validRule], {
+        projectId: 'project-001',
+        snapshotRevision: 1,
+        createdBy: 'test-user',
+        contentHash: 'abc123',
+      });
 
       expect(second.metadata.id).toBe(first.metadata.id);
     } finally {
       Date.now = originalNow;
     }
   });
 });
 
 // ============================================================================
 // Intelligence Validation Tests
 // ============================================================================
 
 describe('validateSemanticIntelligenceV1', () => {
   it('should validate valid intelligence', () => {
-    const intelligence = createSemanticIntelligenceV1(
-      [validFinding],
-      [validRule],
-      {
-        projectId: 'project-001',
-        snapshotRevision: 1,
-        createdBy: 'test-user',
-        contentHash: 'abc123',
-      },
-    );
+    const intelligence = createSemanticIntelligenceV1([validFinding], [validRule], {
+      projectId: 'project-001',
+      snapshotRevision: 1,
+      createdBy: 'test-user',
+      contentHash: 'abc123',
+    });
 
     const result = validateSemanticIntelligenceV1(intelligence);
     expect(result.valid).toBe(true);
     expect(result.errors).toEqual([]);
   });
 
   it('should reject null intelligence', () => {
     const result = validateSemanticIntelligenceV1(null);
     expect(result.valid).toBe(false);
     expect(result.errors).toContain('Intelligence must be an object');
   });
 
   it('should reject invalid schema version', () => {
-    const intelligence = createSemanticIntelligenceV1(
-      [validFinding],
-      [validRule],
-      {
-        projectId: 'project-001',
-        snapshotRevision: 1,
-        createdBy: 'test-user',
-        contentHash: 'abc123',
-      },
-    );
+    const intelligence = createSemanticIntelligenceV1([validFinding], [validRule], {
+      projectId: 'project-001',
+      snapshotRevision: 1,
+      createdBy: 'test-user',
+      contentHash: 'abc123',
+    });
     (intelligence as any).schemaVersion = 2;
 
     const result = validateSemanticIntelligenceV1(intelligence);
     expect(result.valid).toBe(false);
-    expect(result.errors.some(e => e.includes('schema version'))).toBe(true);
+    expect(result.errors.some((e) => e.includes('schema version'))).toBe(true);
   });
 
   it('should reject missing metadata', () => {
     const intelligence = {
       schemaVersion: 1,
       snapshotRevision: 1,
       findings: [],
       rules: [],
       statistics: {},
       findingIndex: new Map(),
       findingIds: [],
       // Missing metadata
     };
 
     const result = validateSemanticIntelligenceV1(intelligence);
     expect(result.valid).toBe(false);
-    expect(result.errors.some(e => e.includes('metadata'))).toBe(true);
+    expect(result.errors.some((e) => e.includes('metadata'))).toBe(true);
   });
 
   it('should reject invalid findings array', () => {
     const intelligence = {
       schemaVersion: 1,
       metadata: {
         id: 'intel-1',
         revision: 1,
         snapshotRevision: 1,
         projectId: 'project-001',
@@ -518,47 +499,43 @@ describe('validateSemanticIntelligenceV1', () => {
       snapshotRevision: 1,
       findings: 'not an array',
       rules: [],
       statistics: {},
       findingIndex: new Map(),
       findingIds: [],
     };
 
     const result = validateSemanticIntelligenceV1(intelligence);
     expect(result.valid).toBe(false);
-    expect(result.errors.some(e => e.includes('Findings'))).toBe(true);
+    expect(result.errors.some((e) => e.includes('Findings'))).toBe(true);
   });
 
   it('should warn about unknown evidence references', () => {
     const findingWithUnknownEvidence: IntelligenceFindingV1 = {
       ...validFinding,
       evidenceIds: ['unknown-evidence-001'],
     };
 
-    const intelligence = createSemanticIntelligenceV1(
-      [findingWithUnknownEvidence],
-      [validRule],
-      {
-        projectId: 'project-001',
-        snapshotRevision: 1,
-        createdBy: 'test-user',
-        contentHash: 'abc123',
-      },
-    );
+    const intelligence = createSemanticIntelligenceV1([findingWithUnknownEvidence], [validRule], {
+      projectId: 'project-001',
+      snapshotRevision: 1,
+      createdBy: 'test-user',
+      contentHash: 'abc123',
+    });
 
     const result = validateSemanticIntelligenceV1(
       intelligence,
-      ['clip-001', 'clip-002'] // known evidence IDs
+      ['clip-001', 'clip-002'], // known evidence IDs
     );
 
     expect(result.warnings.length).toBeGreaterThan(0);
-    expect(result.warnings.some(w => w.includes('unknown evidence'))).toBe(true);
+    expect(result.warnings.some((w) => w.includes('unknown evidence'))).toBe(true);
   });
 });
 
 // ============================================================================
 // Type Guard Tests
 // ============================================================================
 
 describe('type guards', () => {
   it('isIntelligenceFindingV1 should identify valid findings', () => {
     expect(isIntelligenceFindingV1(validFinding)).toBe(true);
@@ -566,30 +543,26 @@ describe('type guards', () => {
     expect(isIntelligenceFindingV1({})).toBe(false);
   });
 
   it('isIntelligenceRuleV1 should identify valid rules', () => {
     expect(isIntelligenceRuleV1(validRule)).toBe(true);
     expect(isIntelligenceRuleV1(null)).toBe(false);
     expect(isIntelligenceRuleV1({})).toBe(false);
   });
 
   it('isSemanticIntelligenceV1 should identify valid intelligence', () => {
-    const intelligence = createSemanticIntelligenceV1(
-      [validFinding],
-      [validRule],
-      {
-        projectId: 'project-001',
-        snapshotRevision: 1,
-        createdBy: 'test-user',
-        contentHash: 'abc123',
-      },
-    );
+    const intelligence = createSemanticIntelligenceV1([validFinding], [validRule], {
+      projectId: 'project-001',
+      snapshotRevision: 1,
+      createdBy: 'test-user',
+      contentHash: 'abc123',
+    });
 
     expect(isSemanticIntelligenceV1(intelligence)).toBe(true);
     expect(isSemanticIntelligenceV1(null)).toBe(false);
     expect(isSemanticIntelligenceV1({})).toBe(false);
   });
 });
 
 // ============================================================================
 // Finding Query Tests
 // ============================================================================
@@ -743,30 +716,26 @@ describe('Persian/RTL preservation', () => {
   it('should preserve Persian text through intelligence creation', () => {
     const finding: IntelligenceFindingV1 = {
       id: 'persian-finding',
       category: 'structure',
       severity: 'notice',
       title: persianText,
       description: rtlText,
       evidenceIds: ['clip-001'],
     };
 
-    const intelligence = createSemanticIntelligenceV1(
-      [finding],
-      [validRule],
-      {
-        projectId: 'project-001',
-        snapshotRevision: 1,
-        createdBy: 'test-user',
-        contentHash: 'abc123',
-      },
-    );
+    const intelligence = createSemanticIntelligenceV1([finding], [validRule], {
+      projectId: 'project-001',
+      snapshotRevision: 1,
+      createdBy: 'test-user',
+      contentHash: 'abc123',
+    });
 
     const retrieved = getFinding(intelligence, 'persian-finding');
     expect(retrieved?.title).toBe(persianText);
     expect(retrieved?.description).toBe(rtlText);
   });
 
   it('should preserve Persian text in rule description', () => {
     const rule: IntelligenceRuleV1 = {
       id: 'persian-rule',
       name: persianText,
@@ -782,10 +751,89 @@ describe('Persian/RTL preservation', () => {
     expect(rule.name).toBe(persianText);
     expect(rule.description).toBe(rtlText);
   });
 });
 
 describe('public exports', () => {
   it('re-exports the semantic intelligence builder from the package entrypoint', () => {
     expect(createSemanticIntelligencePublic).toBe(createSemanticIntelligenceV1);
   });
 });
+
+describe('SemanticBrollSearchIndexV1', () => {
+  it('validates evidence-backed search ranges', () => {
+    const index: SemanticBrollSearchIndexV1 = {
+      schemaVersion: 1,
+      projectId: 'project-broll',
+      createdAt: '2026-08-22T00:00:00.000Z',
+      evidenceIndex: new Map([
+        [
+          'asset-1.shot-1',
+          {
+            id: 'asset-1.shot-1',
+            kind: 'asset-shot',
+            label: 'Shot 1',
+            summary: 'Close product detail',
+            sourceEntityId: 'asset-1',
+            sourceEntityRevision: 1,
+            assetId: 'asset-1',
+            startUs: 1_000_000,
+            durationUs: 2_000_000,
+            tags: ['product'],
+          },
+        ],
+      ]),
+      assets: [
+        {
+          assetId: 'asset-1',
+          displayName: 'Product closeup.mp4',
+          assetType: 'video',
+          durationUs: 10_000_000,
+          usedInTimeline: false,
+          ranges: [
+            {
+              rangeId: 'asset-1.range-1',
+              assetId: 'asset-1',
+              startUs: 1_000_000,
+              durationUs: 2_000_000,
+              label: 'Close product detail',
+              text: 'Close product detail',
+              evidenceIds: ['asset-1.shot-1'],
+            },
+          ],
+        },
+      ],
+    };
+
+    expect(validateSemanticBrollSearchIndexV1(index)).toEqual([]);
+  });
+
+  it('rejects ranges without canonical evidence', () => {
+    const index: SemanticBrollSearchIndexV1 = {
+      schemaVersion: 1,
+      projectId: 'project-broll',
+      createdAt: '2026-08-22T00:00:00.000Z',
+      evidenceIndex: new Map(),
+      assets: [
+        {
+          assetId: 'asset-1',
+          displayName: 'Product closeup.mp4',
+          assetType: 'video',
+          usedInTimeline: false,
+          ranges: [
+            {
+              rangeId: 'asset-1.range-1',
+              assetId: 'asset-1',
+              startUs: 1_000_000,
+              durationUs: 2_000_000,
+              label: 'Close product detail',
+              text: 'Close product detail',
+              evidenceIds: ['missing-evidence'],
+            },
+          ],
+        },
+      ],
+    };
+
+    expect(validateSemanticBrollSearchIndexV1(index).join(' ')).toContain('missing evidence');
+  });
+});
diff --git a/packages/project-schema/src/semantic-intelligence.ts b/packages/project-schema/src/semantic-intelligence.ts
index 3a929f1..62c475d 100644
--- a/packages/project-schema/src/semantic-intelligence.ts
+++ b/packages/project-schema/src/semantic-intelligence.ts
@@ -1,23 +1,24 @@
 /**
  * S2: Semantic Intelligence Types
- * 
+ *
  * Deterministic project analysis derived from S1 semantic snapshots.
  * These types provide analytic findings about project state that are
  * verifiable and reproducible from the snapshot data.
- * 
+ *
  * Dependency: S1 (semantic-snapshot.ts)
  */
 
 import type {
   EvidenceId,
   EvidenceKindV1,
+  SnapshotEvidenceV1,
   SnapshotRevision,
 } from './semantic-snapshot.js';
 import { EVIDENCE_KINDS_V1 } from './semantic-snapshot.js';
 
 // ============================================================================
 // Core Types
 // ============================================================================
 
 /** Unique identifier for a semantic intelligence report */
 export type IntelligenceId = string;
@@ -99,34 +100,34 @@ export interface IntelligenceMetadataV1 {
   /** Hash of the intelligence content for integrity verification */
   readonly contentHash: string;
   /** Entity that generated this intelligence (user, agent, system) */
   readonly createdBy: string;
 }
 
 // ============================================================================
 // Finding Types
 // ============================================================================
 
-/** 
+/**
  * Severity level for intelligence findings.
  * Findings are **deterministic facts** derived from the snapshot.
  */
 export type FindingSeverityV1 = 'info' | 'notice' | 'warning' | 'error';
 
 export const FINDING_SEVERITIES_V1: readonly FindingSeverityV1[] = [
   'info',
   'notice',
   'warning',
   'error',
 ];
 
-/** 
+/**
  * Category of intelligence finding.
  * These categorize the domain of analysis.
  */
 export type FindingCategoryV1 =
   | 'structure'
   | 'content'
   | 'timing'
   | 'quality'
   | 'accessibility'
   | 'completeness'
@@ -141,51 +142,51 @@ export const FINDING_CATEGORIES_V1: readonly FindingCategoryV1[] = [
   'quality',
   'accessibility',
   'completeness',
   'consistency',
   'performance',
   'metadata',
 ];
 
 /**
  * A single deterministic finding from semantic analysis.
- * 
+ *
  * Key invariant: Findings are **FACTS** derived from the snapshot.
  * They are NOT inferences, suggestions, or opinions.
  * S3 will distinguish these from model inferences.
  */
 export interface IntelligenceFindingV1 {
   readonly id: string;
   readonly category: FindingCategoryV1;
   readonly severity: FindingSeverityV1;
   readonly title: string;
   readonly description: string;
-  /** 
+  /**
    * Evidence IDs from S1 that support this finding.
    * Must reference valid canonical evidence.
    */
   readonly evidenceIds: readonly EvidenceId[];
-  /** 
+  /**
    * The kind of evidence this finding relates to.
    * Optional but recommended for filtering.
    */
   readonly evidenceKind?: EvidenceKindV1;
-  /** 
+  /**
    * Computed metric or count where applicable.
    * For example: gap duration, missing asset count, etc.
    */
   readonly metric?: {
     readonly name: string;
     readonly value: number;
     readonly unit?: string;
   };
-  /** 
+  /**
    * Location information for findings that have a specific position.
    */
   readonly location?: {
     readonly evidenceId: EvidenceId;
     readonly startUs?: number;
     readonly durationUs?: number;
     readonly offset?: number;
   };
 }
 
@@ -196,25 +197,31 @@ export function validateIntelligenceFinding(value: unknown): string[] {
   if (value === null || typeof value !== 'object') {
     return ['Finding must be an object'];
   }
 
   const finding = value as Record<string, unknown>;
 
   if (!isNonEmptyString(finding.id) || finding.id.length > MAX_ID_LENGTH) {
     errors.push(`Finding id must be a non-empty string <= ${MAX_ID_LENGTH} chars`);
   }
 
-  if (!isNonEmptyString(finding.category) || !FINDING_CATEGORIES_V1.includes(finding.category as FindingCategoryV1)) {
+  if (
+    !isNonEmptyString(finding.category) ||
+    !FINDING_CATEGORIES_V1.includes(finding.category as FindingCategoryV1)
+  ) {
     errors.push(`Finding category must be one of: ${FINDING_CATEGORIES_V1.join(', ')}`);
   }
 
-  if (!isNonEmptyString(finding.severity) || !FINDING_SEVERITIES_V1.includes(finding.severity as FindingSeverityV1)) {
+  if (
+    !isNonEmptyString(finding.severity) ||
+    !FINDING_SEVERITIES_V1.includes(finding.severity as FindingSeverityV1)
+  ) {
     errors.push(`Finding severity must be one of: ${FINDING_SEVERITIES_V1.join(', ')}`);
   }
 
   if (!isNonEmptyString(finding.title) || finding.title.length > MAX_LABEL_LENGTH) {
     errors.push(`Finding title must be a non-empty string <= ${MAX_LABEL_LENGTH} chars`);
   }
 
   if (!isNonEmptyString(finding.description) || finding.description.length > MAX_FINDING_LENGTH) {
     errors.push(`Finding description must be a non-empty string <= ${MAX_FINDING_LENGTH} chars`);
   }
@@ -226,21 +233,22 @@ export function validateIntelligenceFinding(value: unknown): string[] {
     for (const id of evidenceIds) {
       if (!isNonEmptyString(id)) {
         errors.push('Each evidenceId must be a non-empty string');
         break;
       }
     }
   }
 
   if (
     finding.evidenceKind !== undefined &&
-    (!isNonEmptyString(finding.evidenceKind) || !EVIDENCE_KINDS_V1.includes(finding.evidenceKind as EvidenceKindV1))
+    (!isNonEmptyString(finding.evidenceKind) ||
+      !EVIDENCE_KINDS_V1.includes(finding.evidenceKind as EvidenceKindV1))
   ) {
     errors.push(`Finding evidenceKind must be one of: ${EVIDENCE_KINDS_V1.join(', ')}`);
   }
 
   if (finding.metric !== undefined) {
     const metric = finding.metric as Record<string, unknown>;
     if (metric === null || typeof metric !== 'object') {
       errors.push('Finding metric must be an object if present');
     } else {
       if (!isNonEmptyString(metric.name) || metric.name.length > MAX_LABEL_LENGTH) {
@@ -254,58 +262,60 @@ export function validateIntelligenceFinding(value: unknown): string[] {
       }
     }
   }
 
   if (finding.location !== undefined) {
     const location = finding.location as Record<string, unknown>;
     if (location === null || typeof location !== 'object') {
       errors.push('Finding location must be an object if present');
     } else {
       if (!isNonEmptyString(location.evidenceId) || location.evidenceId.length > MAX_ID_LENGTH) {
-        errors.push(`Finding location evidenceId must be a non-empty string <= ${MAX_ID_LENGTH} chars`);
+        errors.push(
+          `Finding location evidenceId must be a non-empty string <= ${MAX_ID_LENGTH} chars`,
+        );
       }
       if (location.startUs !== undefined && !isBoundedTimeUs(location.startUs)) {
         errors.push(`Finding location startUs must be a non-negative integer <= ${MAX_TIME_US}`);
       }
       if (location.durationUs !== undefined && !isBoundedTimeUs(location.durationUs)) {
         errors.push(`Finding location durationUs must be a non-negative integer <= ${MAX_TIME_US}`);
       }
       if (location.offset !== undefined && !isNonNegativeInteger(location.offset)) {
         errors.push('Finding location offset must be a non-negative integer');
       }
     }
   }
 
   return errors;
 }
 
 // ============================================================================
 // Rule Types
 // ============================================================================
 
-/** 
+/**
  * A semantic rule that produces findings.
  * Rules are deterministic transformations from snapshot state to findings.
  */
 export interface IntelligenceRuleV1 {
   readonly id: string;
   readonly name: string;
   readonly description: string;
   readonly category: FindingCategoryV1;
   /** Default severity when this rule fires */
   readonly defaultSeverity: FindingSeverityV1;
-  /** 
+  /**
    * Whether this rule is enabled by default.
    * Disabled rules can be explicitly enabled.
    */
   readonly enabled: boolean;
-  /** 
+  /**
    * Evidence kinds this rule applies to.
    * Empty array means all kinds.
    */
   readonly appliesTo: readonly EvidenceKindV1[];
 }
 
 /** Validation for intelligence rules */
 export function validateIntelligenceRule(value: unknown): string[] {
   const errors: string[] = [];
 
@@ -320,51 +330,224 @@ export function validateIntelligenceRule(value: unknown): string[] {
   }
 
   if (!isNonEmptyString(rule.name) || rule.name.length > MAX_LABEL_LENGTH) {
     errors.push(`Rule name must be a non-empty string <= ${MAX_LABEL_LENGTH} chars`);
   }
 
   if (!isNonEmptyString(rule.description) || rule.description.length > MAX_DESCRIPTION_LENGTH) {
     errors.push(`Rule description must be a non-empty string <= ${MAX_DESCRIPTION_LENGTH} chars`);
   }
 
-  if (!isNonEmptyString(rule.category) || !FINDING_CATEGORIES_V1.includes(rule.category as FindingCategoryV1)) {
+  if (
+    !isNonEmptyString(rule.category) ||
+    !FINDING_CATEGORIES_V1.includes(rule.category as FindingCategoryV1)
+  ) {
     errors.push(`Rule category must be one of: ${FINDING_CATEGORIES_V1.join(', ')}`);
   }
 
-  if (!isNonEmptyString(rule.defaultSeverity) || !FINDING_SEVERITIES_V1.includes(rule.defaultSeverity as FindingSeverityV1)) {
+  if (
+    !isNonEmptyString(rule.defaultSeverity) ||
+    !FINDING_SEVERITIES_V1.includes(rule.defaultSeverity as FindingSeverityV1)
+  ) {
     errors.push(`Rule defaultSeverity must be one of: ${FINDING_SEVERITIES_V1.join(', ')}`);
   }
 
   if (typeof rule.enabled !== 'boolean') {
     errors.push('Rule enabled must be a boolean');
   }
 
   const appliesTo = rule.appliesTo as unknown[];
   if (!Array.isArray(appliesTo)) {
     errors.push('Rule appliesTo must be an array');
   } else {
     if (appliesTo.length > MAX_APPLIES_TO_COUNT) {
       errors.push(`Rule appliesTo must contain at most ${MAX_APPLIES_TO_COUNT} evidence kinds`);
     }
 
     for (const evidenceKind of appliesTo) {
-      if (!isNonEmptyString(evidenceKind) || !EVIDENCE_KINDS_V1.includes(evidenceKind as EvidenceKindV1)) {
+      if (
+        !isNonEmptyString(evidenceKind) ||
+        !EVIDENCE_KINDS_V1.includes(evidenceKind as EvidenceKindV1)
+      ) {
         errors.push(`Rule appliesTo entries must be one of: ${EVIDENCE_KINDS_V1.join(', ')}`);
         break;
       }
     }
   }
 
   return errors;
 }
 
+// ============================================================================
+// B-roll Semantic Search Index
+// ============================================================================
+
+export interface SemanticBrollTimeRangeV1 {
+  readonly rangeId: string;
+  readonly assetId: string;
+  readonly startUs: number;
+  readonly durationUs: number;
+  readonly label: string;
+  readonly text: string;
+  readonly evidenceIds: readonly EvidenceId[];
+}
+
+export interface SemanticBrollAssetV1 {
+  readonly assetId: string;
+  readonly displayName: string;
+  readonly assetType: 'video' | 'audio' | 'image' | 'other';
+  readonly durationUs?: number;
+  readonly usedInTimeline: boolean;
+  readonly tags?: readonly string[];
+  readonly ranges: readonly SemanticBrollTimeRangeV1[];
+}
+
+export interface SemanticBrollSearchIndexV1 {
+  readonly schemaVersion: 1;
+  readonly projectId: string;
+  readonly createdAt: ISO8601;
+  readonly evidenceIndex: ReadonlyMap<EvidenceId, SnapshotEvidenceV1>;
+  readonly assets: readonly SemanticBrollAssetV1[];
+}
+
+export function validateSemanticBrollSearchIndexV1(index: unknown): readonly string[] {
+  const errors: string[] = [];
+
+  if (index === null || typeof index !== 'object' || Array.isArray(index)) {
+    return ['Semantic B-roll search index must be an object'];
+  }
+
+  const value = index as Record<string, unknown>;
+  if (value.schemaVersion !== 1) {
+    errors.push('Semantic B-roll search index schemaVersion must be 1');
+  }
+  if (!isNonEmptyString(value.projectId) || value.projectId.length > MAX_ID_LENGTH) {
+    errors.push(
+      `Semantic B-roll search index projectId must be a non-empty string <= ${MAX_ID_LENGTH} chars`,
+    );
+  }
+  if (!isNonEmptyString(value.createdAt)) {
+    errors.push('Semantic B-roll search index createdAt is required');
+  }
+  if (!(value.evidenceIndex instanceof Map)) {
+    errors.push('Semantic B-roll search index evidenceIndex must be a Map');
+  }
+
+  const evidenceIndex =
+    value.evidenceIndex instanceof Map
+      ? (value.evidenceIndex as ReadonlyMap<EvidenceId, SnapshotEvidenceV1>)
+      : new Map<EvidenceId, SnapshotEvidenceV1>();
+
+  if (!Array.isArray(value.assets)) {
+    errors.push('Semantic B-roll search index assets must be an array');
+    return errors;
+  }
+
+  if (value.assets.length > MAX_FINDINGS_COUNT) {
+    errors.push(
+      `Semantic B-roll search index assets count exceeds maximum of ${MAX_FINDINGS_COUNT}`,
+    );
+  }
+
+  for (const [assetIndex, asset] of value.assets.entries()) {
+    if (asset === null || typeof asset !== 'object' || Array.isArray(asset)) {
+      errors.push(`Semantic B-roll asset ${assetIndex} must be an object`);
+      continue;
+    }
+    const assetValue = asset as Record<string, unknown>;
+    if (!isNonEmptyString(assetValue.assetId) || assetValue.assetId.length > MAX_ID_LENGTH) {
+      errors.push(`Semantic B-roll asset ${assetIndex} assetId is required`);
+    }
+    if (
+      !isNonEmptyString(assetValue.displayName) ||
+      assetValue.displayName.length > MAX_LABEL_LENGTH
+    ) {
+      errors.push(`Semantic B-roll asset ${assetIndex} displayName is required`);
+    }
+    if (
+      assetValue.assetType !== 'video' &&
+      assetValue.assetType !== 'audio' &&
+      assetValue.assetType !== 'image' &&
+      assetValue.assetType !== 'other'
+    ) {
+      errors.push(`Semantic B-roll asset ${assetIndex} assetType is invalid`);
+    }
+    if (typeof assetValue.usedInTimeline !== 'boolean') {
+      errors.push(`Semantic B-roll asset ${assetIndex} usedInTimeline must be a boolean`);
+    }
+    if (assetValue.durationUs !== undefined && !isBoundedTimeUs(assetValue.durationUs)) {
+      errors.push(`Semantic B-roll asset ${assetIndex} durationUs is invalid`);
+    }
+    if (!Array.isArray(assetValue.ranges)) {
+      errors.push(`Semantic B-roll asset ${assetIndex} ranges must be an array`);
+      continue;
+    }
+    for (const [rangeIndex, range] of assetValue.ranges.entries()) {
+      if (range === null || typeof range !== 'object' || Array.isArray(range)) {
+        errors.push(`Semantic B-roll range ${assetIndex}.${rangeIndex} must be an object`);
+        continue;
+      }
+      const rangeValue = range as Record<string, unknown>;
+      if (!isNonEmptyString(rangeValue.rangeId) || rangeValue.rangeId.length > MAX_ID_LENGTH) {
+        errors.push(`Semantic B-roll range ${assetIndex}.${rangeIndex} rangeId is required`);
+      }
+      if (rangeValue.assetId !== assetValue.assetId) {
+        errors.push(
+          `Semantic B-roll range ${assetIndex}.${rangeIndex} assetId must match its asset`,
+        );
+      }
+      if (!isBoundedTimeUs(rangeValue.startUs)) {
+        errors.push(`Semantic B-roll range ${assetIndex}.${rangeIndex} startUs is invalid`);
+      }
+      if (!isBoundedTimeUs(rangeValue.durationUs)) {
+        errors.push(`Semantic B-roll range ${assetIndex}.${rangeIndex} durationUs is invalid`);
+      }
+      if (!isNonEmptyString(rangeValue.label) || rangeValue.label.length > MAX_LABEL_LENGTH) {
+        errors.push(`Semantic B-roll range ${assetIndex}.${rangeIndex} label is required`);
+      }
+      if (typeof rangeValue.text !== 'string' || rangeValue.text.length > MAX_FINDING_LENGTH) {
+        errors.push(
+          `Semantic B-roll range ${assetIndex}.${rangeIndex} text must be a bounded string`,
+        );
+      }
+      if (!Array.isArray(rangeValue.evidenceIds) || rangeValue.evidenceIds.length === 0) {
+        errors.push(`Semantic B-roll range ${assetIndex}.${rangeIndex} must cite evidence`);
+        continue;
+      }
+      for (const evidenceId of rangeValue.evidenceIds) {
+        if (!isNonEmptyString(evidenceId)) {
+          errors.push(
+            `Semantic B-roll range ${assetIndex}.${rangeIndex} evidenceIds must be non-empty strings`,
+          );
+          continue;
+        }
+        const evidence = evidenceIndex.get(evidenceId);
+        if (evidence === undefined) {
+          errors.push(
+            `Semantic B-roll range ${assetIndex}.${rangeIndex} cites missing evidence ${evidenceId}`,
+          );
+        } else if (
+          evidence.kind !== 'asset-shot' &&
+          evidence.kind !== 'asset-caption' &&
+          evidence.kind !== 'asset-audio'
+        ) {
+          errors.push(
+            `Semantic B-roll range ${assetIndex}.${rangeIndex} cites non-B-roll evidence ${evidenceId}`,
+          );
+        }
+      }
+    }
+  }
+
+  return errors;
+}
+
 // ============================================================================
 // Statistical Summary
 // ============================================================================
 
 /** Statistical summary of intelligence findings */
 export interface IntelligenceStatisticsV1 {
   readonly totalFindings: number;
   readonly findingsBySeverity: {
     readonly info: number;
     readonly notice: number;
@@ -375,55 +558,55 @@ export interface IntelligenceStatisticsV1 {
   readonly totalRulesApplied: number;
   readonly totalRulesMatched: number;
 }
 
 // ============================================================================
 // S2 Semantic Intelligence
 // ============================================================================
 
 /**
  * S2: Semantic Intelligence Version 1
- * 
+ *
  * Deterministic analysis results derived from an S1 semantic snapshot.
  * All findings are **verifiable facts** about the project state.
- * 
+ *
  * Key invariants:
  * - All arrays are readonly and bounded
  * - All strings are bounded
  * - All IDs are non-empty
  * - All evidence references must be valid S1 evidence IDs
  * - Findings are deterministic and reproducible
  * - No inferences, suggestions, or opinions
  */
 export interface SemanticIntelligenceV1 {
   readonly schemaVersion: 1;
   readonly metadata: IntelligenceMetadataV1;
-  
+
   /** The S1 snapshot revision this intelligence was derived from */
   readonly snapshotRevision: SnapshotRevision;
-  
+
   /** Deterministic findings from analysis */
   readonly findings: readonly IntelligenceFindingV1[];
-  
+
   /** The rules that were applied to produce these findings */
   readonly rules: readonly IntelligenceRuleV1[];
-  
+
   /** Statistical summary of findings */
   readonly statistics: IntelligenceStatisticsV1;
-  
-  /** 
+
+  /**
    * Flat index of all findings by ID for O(1) lookup.
    * Derived from findings for convenience.
    */
   readonly findingIndex: ReadonlyMap<string, IntelligenceFindingV1>;
-  
-  /** 
+
+  /**
    * Flat list of all finding IDs for iteration.
    */
   readonly findingIds: readonly string[];
 }
 
 // ============================================================================
 // Builder and Validation
 // ============================================================================
 
 /** Validation result for intelligence */
@@ -475,33 +658,33 @@ export function createSemanticIntelligenceV1(
       structure: 0,
       content: 0,
       timing: 0,
       quality: 0,
       accessibility: 0,
       completeness: 0,
       consistency: 0,
       performance: 0,
       metadata: 0,
     },
-    totalRulesApplied: rules.filter(r => r.enabled).length,
+    totalRulesApplied: rules.filter((r) => r.enabled).length,
     totalRulesMatched: 0, // Would be computed by rule matching, not set here
   };
 
   for (const finding of findings) {
     statistics.findingsBySeverity[finding.severity]++;
     statistics.findingsByCategory[finding.category]++;
   }
 
   // Build index
   const findingIndex = new Map<string, IntelligenceFindingV1>();
   const findingIds: string[] = [];
-  
+
   for (const finding of findings) {
     findingIndex.set(finding.id, finding);
     findingIds.push(finding.id);
   }
 
   return {
     schemaVersion: 1,
     metadata,
     snapshotRevision: options.snapshotRevision,
     findings,
@@ -556,48 +739,50 @@ export function validateSemanticIntelligenceV1(
   }
 
   // Validate findings
   const findings = i.findings as unknown[];
   if (!Array.isArray(findings)) {
     errors.push('Findings must be an array');
   } else {
     if (findings.length > MAX_FINDINGS_COUNT) {
       errors.push(`Findings count exceeds maximum of ${MAX_FINDINGS_COUNT}`);
     }
-    
+
     for (const finding of findings) {
       const findingErrors = validateIntelligenceFinding(finding);
       errors.push(...findingErrors);
-      
+
       // Validate evidence references if snapshot evidence IDs provided
       if (snapshotEvidenceIds && Array.isArray(snapshotEvidenceIds)) {
         const evidenceIds = (finding as IntelligenceFindingV1).evidenceIds;
         if (Array.isArray(evidenceIds)) {
           for (const evId of evidenceIds) {
             if (!snapshotEvidenceIds.includes(evId)) {
-              warnings.push(`Finding ${(finding as IntelligenceFindingV1).id} references unknown evidence ID: ${evId}`);
+              warnings.push(
+                `Finding ${(finding as IntelligenceFindingV1).id} references unknown evidence ID: ${evId}`,
+              );
             }
           }
         }
       }
     }
   }
 
   // Validate rules
   const rules = i.rules as unknown[];
   if (!Array.isArray(rules)) {
     errors.push('Rules must be an array');
   } else {
     if (rules.length > MAX_RULES_COUNT) {
       errors.push(`Rules count exceeds maximum of ${MAX_RULES_COUNT}`);
     }
-    
+
     for (const rule of rules) {
       const ruleErrors = validateIntelligenceRule(rule);
       errors.push(...ruleErrors);
     }
   }
 
   // Validate statistics
   const statistics = i.statistics as Record<string, unknown>;
   if (!statistics || typeof statistics !== 'object') {
     errors.push('Statistics is required');
@@ -618,24 +803,21 @@ export function validateSemanticIntelligenceV1(
   return {
     valid: errors.length === 0,
     errors: errors.length > 0 ? errors : [],
     warnings,
   };
 }
 
 /**
  * Check if a finding ID exists in intelligence
  */
-export function hasFinding(
-  intelligence: SemanticIntelligenceV1,
-  findingId: string,
-): boolean {
+export function hasFinding(intelligence: SemanticIntelligenceV1, findingId: string): boolean {
   return intelligence.findingIndex.has(findingId);
 }
 
 /**
  * Get finding by ID
  */
 export function getFinding(
   intelligence: SemanticIntelligenceV1,
   findingId: string,
 ): IntelligenceFindingV1 | undefined {
@@ -668,22 +850,22 @@ export function getFindingsBySeverity(
 
 /**
  * Get findings that reference specific evidence
  */
 export function getFindingsByEvidence(
   intelligence: SemanticIntelligenceV1,
   evidenceId: EvidenceId,
 ): readonly IntelligenceFindingV1[] {
   return intelligence.findingIds
     .map((id) => intelligence.findingIndex.get(id))
-    .filter((f): f is IntelligenceFindingV1 => 
-      f !== undefined && f.evidenceIds.includes(evidenceId)
+    .filter(
+      (f): f is IntelligenceFindingV1 => f !== undefined && f.evidenceIds.includes(evidenceId),
     );
 }
 
 // ============================================================================
 // Type Guards
 // ============================================================================
 
 export function isSemanticIntelligenceV1(value: unknown): value is SemanticIntelligenceV1 {
   if (value === null || typeof value !== 'object') return false;
   const i = value as SemanticIntelligenceV1;
@@ -834,14 +1016,14 @@ const BUILT_IN_RULES_V1: readonly IntelligenceRuleV1[] = [
   },
 ];
 
 /** Get all built-in rules */
 export function getBuiltInRulesV1(): readonly IntelligenceRuleV1[] {
   return BUILT_IN_RULES_V1;
 }
 
 /** Get a built-in rule by ID */
 export function getBuiltInRuleV1(id: string): IntelligenceRuleV1 | undefined {
-  return BUILT_IN_RULES_V1.find(r => r.id === id);
+  return BUILT_IN_RULES_V1.find((r) => r.id === id);
 }
 
 export { BUILT_IN_RULES_V1 };
diff --git a/packages/project-schema/src/semantic-snapshot.ts b/packages/project-schema/src/semantic-snapshot.ts
index c570d48..8896f4d 100644
--- a/packages/project-schema/src/semantic-snapshot.ts
+++ b/packages/project-schema/src/semantic-snapshot.ts
@@ -1,17 +1,17 @@
 /**
  * S1: Semantic Snapshot Types
- * 
+ *
  * Bounded, versioned project state capture for AI Creative OS foundation.
  * These types provide a stable, bounded view of project state suitable for
  * semantic analysis without exposing the full project structure.
- * 
+ *
  * Dependency: none (innermost package)
  */
 
 // ============================================================================
 // Core Types
 // ============================================================================
 
 /** Unique identifier for a semantic snapshot */
 export type SnapshotId = string;
 
@@ -71,21 +71,23 @@ function isBoundedTimeUs(value: unknown): value is number {
 }
 
 function hasSameDerivedEvidence(
   expected: SnapshotEvidenceV1,
   actual: unknown,
 ): actual is SnapshotEvidenceV1 {
   if (!isSnapshotEvidenceV1(actual)) {
     return false;
   }
 
-  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
+  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
+    left.localeCompare(right),
+  );
   const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
 
   return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
 }
 
 // ============================================================================
 // Snapshot Metadata
 // ============================================================================
 
 /** Metadata about the snapshot capture */
@@ -99,42 +101,48 @@ export interface SnapshotMetadataV1 {
   /** Hash of the snapshot content for integrity verification */
   readonly contentHash: string;
   /** User or agent who created the snapshot */
   readonly createdBy: string;
 }
 
 // ============================================================================
 // Evidence Types
 // ============================================================================
 
-/** 
+/**
  * EvidenceKind categorizes the type of evidence available in the snapshot.
  * These are the canonical evidence types that S3 recommendations can reference.
  */
 export type EvidenceKindV1 =
   | 'clip'
   | 'asset'
+  | 'asset-shot'
+  | 'asset-caption'
+  | 'asset-audio'
   | 'caption-document'
   | 'marker'
   | 'composition'
   | 'track'
   | 'visual-object'
   | 'effect'
   | 'transition'
   | 'audio-region'
   | 'workflow-artifact'
   | 'export-preset';
 
 /** All valid evidence kinds */
 export const EVIDENCE_KINDS_V1: readonly EvidenceKindV1[] = [
   'clip',
   'asset',
+  'asset-shot',
+  'asset-caption',
+  'asset-audio',
   'caption-document',
   'marker',
   'composition',
   'track',
   'visual-object',
   'effect',
   'transition',
   'audio-region',
   'workflow-artifact',
   'export-preset',
@@ -154,75 +162,111 @@ export interface SnapshotEvidenceV1 {
   readonly durationUs?: number;
   /** Reference to the source entity ID in the project */
   readonly sourceEntityId: string;
   /** Revision of the source entity at capture time */
   readonly sourceEntityRevision: number;
 }
 
 /** Validation for evidence entries */
 export function validateSnapshotEvidence(value: unknown): string[] {
   const errors: string[] = [];
-  
+
   if (value === null || typeof value !== 'object') {
     return ['Evidence must be an object'];
   }
-  
+
   const evidence = value as Record<string, unknown>;
-  
+
   if (!isNonEmptyString(evidence.id) || evidence.id.length > MAX_ID_LENGTH) {
     errors.push(`Evidence id must be a non-empty string <= ${MAX_ID_LENGTH} chars`);
   }
-  
-  if (!isNonEmptyString(evidence.kind) || !EVIDENCE_KINDS_V1.includes(evidence.kind as EvidenceKindV1)) {
+
+  if (
+    !isNonEmptyString(evidence.kind) ||
+    !EVIDENCE_KINDS_V1.includes(evidence.kind as EvidenceKindV1)
+  ) {
     errors.push(`Evidence kind must be one of: ${EVIDENCE_KINDS_V1.join(', ')}`);
   }
-  
+
   if (!isNonEmptyString(evidence.label) || evidence.label.length > MAX_LABEL_LENGTH) {
     errors.push(`Evidence label must be a non-empty string <= ${MAX_LABEL_LENGTH} chars`);
   }
-  
+
   if (evidence.summary !== undefined && !isStringMaxLength(evidence.summary, MAX_SUMMARY_LENGTH)) {
     errors.push(`Evidence summary must be <= ${MAX_SUMMARY_LENGTH} chars`);
   }
-  
+
   if (evidence.startUs !== undefined && !isBoundedTimeUs(evidence.startUs)) {
     errors.push(`Evidence startUs must be a non-negative integer <= ${MAX_TIME_US}`);
   }
-  
+
   if (evidence.durationUs !== undefined && !isBoundedTimeUs(evidence.durationUs)) {
     errors.push(`Evidence durationUs must be a non-negative integer <= ${MAX_TIME_US}`);
   }
-  
-  if (!isNonEmptyString(evidence.sourceEntityId) || evidence.sourceEntityId.length > MAX_ID_LENGTH) {
+
+  if (
+    !isNonEmptyString(evidence.sourceEntityId) ||
+    evidence.sourceEntityId.length > MAX_ID_LENGTH
+  ) {
     errors.push(`Evidence sourceEntityId must be a non-empty string <= ${MAX_ID_LENGTH} chars`);
   }
-  
+
   if (!isNonNegativeInteger(evidence.sourceEntityRevision)) {
     errors.push('Evidence sourceEntityRevision must be a non-negative integer');
   }
-  
+
   return errors;
 }
 
 // ============================================================================
 // Media Evidence Subtypes
 // ============================================================================
 
 /** Evidence for video/audio/image assets */
 export interface AssetEvidenceV1 extends SnapshotEvidenceV1 {
   readonly kind: 'asset';
   readonly assetType: 'video' | 'audio' | 'image' | 'other';
   readonly fileSizeBytes: number;
   readonly mimeType: string;
   readonly durationUs?: number;
 }
 
+/** Evidence for a semantically searchable time range inside an asset. */
+export interface AssetShotEvidenceV1 extends SnapshotEvidenceV1 {
+  readonly kind: 'asset-shot';
+  readonly assetId: string;
+  readonly startUs: number;
+  readonly durationUs: number;
+  readonly tags?: readonly string[];
+}
+
+/** Evidence for caption/transcript text aligned to an asset time range. */
+export interface AssetCaptionEvidenceV1 extends SnapshotEvidenceV1 {
+  readonly kind: 'asset-caption';
+  readonly assetId: string;
+  readonly startUs: number;
+  readonly durationUs: number;
+  readonly text: string;
+  readonly language?: string;
+}
+
+/** Evidence for audio events or dialog aligned to an asset time range. */
+export interface AssetAudioEvidenceV1 extends SnapshotEvidenceV1 {
+  readonly kind: 'asset-audio';
+  readonly assetId: string;
+  readonly startUs: number;
+  readonly durationUs: number;
+  readonly audioKind: 'dialogue' | 'music' | 'sfx' | 'ambient' | 'unknown';
+  readonly transcript?: string;
+  readonly loudnessLufs?: number;
+}
+
 /** Evidence for timeline clips */
 export interface ClipEvidenceV1 extends SnapshotEvidenceV1 {
   readonly kind: 'clip';
   readonly trackId: string;
   readonly startUs: number;
   readonly durationUs: number;
   readonly assetId?: string;
 }
 
 /** Evidence for caption documents */
@@ -302,44 +346,55 @@ export interface ExportPresetEvidenceV1 extends SnapshotEvidenceV1 {
   readonly resolution: { readonly width: number; readonly height: number };
 }
 
 // ============================================================================
 // Discriminated Union for Evidence
 // ============================================================================
 
 /** All possible evidence types as a discriminated union */
 export type SnapshotEvidenceUnionV1 =
   | AssetEvidenceV1
+  | AssetShotEvidenceV1
+  | AssetCaptionEvidenceV1
+  | AssetAudioEvidenceV1
   | ClipEvidenceV1
   | CaptionDocumentEvidenceV1
   | MarkerEvidenceV1
   | CompositionEvidenceV1
   | TrackEvidenceV1
   | VisualObjectEvidenceV1
   | EffectEvidenceV1
   | TransitionEvidenceV1
   | AudioRegionEvidenceV1
   | WorkflowArtifactEvidenceV1
   | ExportPresetEvidenceV1;
 
 // ============================================================================
 // Snapshot Sections
 // ============================================================================
 
-/** 
+/**
  * A named section of evidence within the snapshot.
  * Sections help organize evidence by domain (timeline, assets, captions, etc.)
  */
 export interface SnapshotSectionV1 {
   readonly id: string;
   readonly label: string;
-  readonly domain: 'timeline' | 'assets' | 'captions' | 'audio' | 'composition' | 'workflow' | 'export' | 'metadata';
+  readonly domain:
+    | 'timeline'
+    | 'assets'
+    | 'captions'
+    | 'audio'
+    | 'composition'
+    | 'workflow'
+    | 'export'
+    | 'metadata';
   readonly evidence: readonly SnapshotEvidenceV1[];
 }
 
 // ============================================================================
 // Statistical Summary
 // ============================================================================
 
 /** Statistical summary of the snapshot for quick analysis */
 export interface SnapshotStatisticsV1 {
   readonly totalClips: number;
@@ -358,52 +413,52 @@ export interface SnapshotStatisticsV1 {
   /** Count of timeline gaps */
   readonly gapCount: number;
 }
 
 // ============================================================================
 // S1 Semantic Snapshot
 // ============================================================================
 
 /**
  * S1: Semantic Snapshot Version 1
- * 
+ *
  * A bounded, revisioned capture of project state suitable for semantic analysis.
  * This is the canonical source of evidence that S3 recommendations must reference.
- * 
+ *
  * Key invariants:
  * - All arrays are readonly and bounded
  * - All strings are bounded
  * - All IDs are non-empty
  * - Evidence can be referenced by ID from S3
  * - No raw project objects exposed
  * - No executable content
  */
 export interface SemanticSnapshotV1 {
   readonly schemaVersion: 1;
   readonly metadata: SnapshotMetadataV1;
-  
+
   /** Statistics for quick analysis without deep inspection */
   readonly statistics: SnapshotStatisticsV1;
-  
-  /** 
+
+  /**
    * All evidence in the snapshot, organized by section.
    * S3 recommendations must reference evidence IDs from this collection.
    */
   readonly sections: readonly SnapshotSectionV1[];
-  
-  /** 
+
+  /**
    * Flat index of all evidence by ID for O(1) lookup.
    * Derived from sections for convenience, not user-provided.
    */
   readonly evidenceIndex: ReadonlyMap<EvidenceId, SnapshotEvidenceV1>;
-  
-  /** 
+
+  /**
    * Flat list of all evidence IDs for iteration.
    */
   readonly evidenceIds: readonly EvidenceId[];
 }
 
 // ============================================================================
 // Builder and Validation
 // ============================================================================
 
 /** Validation result for a snapshot */
@@ -453,26 +508,26 @@ export function createSemanticSnapshotV1(
     totalVisualObjects: 0,
     totalEffects: 0,
     totalTransitions: 0,
     missingAssetCount: 0,
     emptyCaptionCount: 0,
     gapCount: 0,
   };
 
   const evidenceIndex = new Map<EvidenceId, SnapshotEvidenceV1>();
   const evidenceIds: EvidenceId[] = [];
-  
+
   for (const section of sections) {
     for (const evidence of section.evidence) {
       evidenceIndex.set(evidence.id, evidence);
       evidenceIds.push(evidence.id);
-      
+
       // Update statistics based on evidence kind
       switch (evidence.kind) {
         case 'clip':
           statistics.totalClips++;
           if (evidence.durationUs) {
             statistics.totalDurationUs += evidence.durationUs;
           }
           break;
         case 'asset':
           statistics.totalAssets++;
@@ -511,23 +566,21 @@ export function createSemanticSnapshotV1(
     statistics,
     sections,
     evidenceIndex,
     evidenceIds,
   };
 }
 
 /**
  * Validate a semantic snapshot
  */
-export function validateSemanticSnapshotV1(
-  snapshot: unknown,
-): SnapshotValidationResultV1 {
+export function validateSemanticSnapshotV1(snapshot: unknown): SnapshotValidationResultV1 {
   const errors: string[] = [];
   const warnings: string[] = [];
 
   if (snapshot === null || typeof snapshot !== 'object') {
     return { valid: false, errors: ['Snapshot must be an object'], warnings: [] };
   }
 
   const s = snapshot as Record<string, unknown>;
 
   // Check schema version
@@ -560,53 +613,64 @@ export function validateSemanticSnapshotV1(
   // Validate sections
   const sections = s.sections as unknown[];
   if (!Array.isArray(sections)) {
     errors.push('Sections must be an array');
   } else {
     for (const section of sections) {
       if (section === null || typeof section !== 'object') {
         errors.push('Each section must be an object');
         continue;
       }
-      
+
       const sec = section as Record<string, unknown>;
       if (!isNonEmptyString(sec.id)) {
         errors.push('Section id is required');
       }
       if (!isNonEmptyString(sec.label)) {
         errors.push('Section label is required');
       }
-      
+
       const domain = sec.domain as string;
-      const validDomains = ['timeline', 'assets', 'captions', 'audio', 'composition', 'workflow', 'export', 'metadata'];
+      const validDomains = [
+        'timeline',
+        'assets',
+        'captions',
+        'audio',
+        'composition',
+        'workflow',
+        'export',
+        'metadata',
+      ];
       if (!validDomains.includes(domain)) {
         errors.push(`Invalid section domain: ${domain}`);
       }
-      
+
       const evidence = sec.evidence as unknown[];
       if (!Array.isArray(evidence)) {
         errors.push(`Section ${sec.id} evidence must be an array`);
       } else {
         for (const ev of evidence) {
           const evErrors = validateSnapshotEvidence(ev);
           errors.push(...evErrors);
         }
       }
     }
   }
 
   const expectedEvidenceEntries = Array.isArray(sections)
     ? sections.flatMap((section) =>
         section !== null &&
         typeof section === 'object' &&
         Array.isArray((section as Record<string, unknown>).evidence)
-          ? ((section as Record<string, unknown>).evidence as SnapshotEvidenceV1[]).map((evidence) => [evidence.id, evidence] as const)
+          ? ((section as Record<string, unknown>).evidence as SnapshotEvidenceV1[]).map(
+              (evidence) => [evidence.id, evidence] as const,
+            )
           : [],
       )
     : [];
   const expectedEvidenceIndex = new Map<EvidenceId, SnapshotEvidenceV1>(expectedEvidenceEntries);
   const expectedEvidenceIds = expectedEvidenceEntries.map(([id]) => id);
 
   // Validate evidence index matches sections
   const evidenceIndex = s.evidenceIndex as Map<EvidenceId, SnapshotEvidenceV1>;
   if (!(evidenceIndex instanceof Map)) {
     errors.push('evidenceIndex must be a Map');
@@ -657,24 +721,21 @@ export function validateSemanticSnapshotV1(
   return {
     valid: errors.length === 0,
     errors: errors.length > 0 ? errors : [],
     warnings,
   };
 }
 
 /**
  * Check if an evidence ID exists in the snapshot
  */
-export function hasEvidence(
-  snapshot: SemanticSnapshotV1,
-  evidenceId: EvidenceId,
-): boolean {
+export function hasEvidence(snapshot: SemanticSnapshotV1, evidenceId: EvidenceId): boolean {
   return snapshot.evidenceIndex.has(evidenceId);
 }
 
 /**
  * Get evidence by ID from snapshot
  */
 export function getEvidence(
   snapshot: SemanticSnapshotV1,
   evidenceId: EvidenceId,
 ): SnapshotEvidenceV1 | undefined {
