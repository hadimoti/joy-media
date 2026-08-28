# Review package: a6a3de5..HEAD

## Commits
7811b27 feat(joy-code): preview registered 3D assets safely

## Files changed
 apps/api/src/asset-hermes-tags.ts                |   8 +-
 apps/api/src/control-plane.ts                    |   9 +-
 apps/api/src/http-server.ts                      |   2 +-
 apps/editor-web/src/AgentPanel.tsx               |   6 +-
 apps/editor-web/src/App.tsx                      |   1 +
 apps/editor-web/src/AssetLibraryPanel.tsx        |  23 +-
 apps/editor-web/src/JoyCode3DViewer.test.tsx     |  72 ++++
 apps/editor-web/src/JoyCode3DViewer.tsx          | 451 +++++++++++++----------
 apps/editor-web/src/asset-card-preview.ts        |   2 +-
 apps/editor-web/src/asset-library-icons.ts       |   1 +
 apps/editor-web/src/asset-resolver.ts            |   2 +-
 apps/editor-web/src/control-plane-client.ts      |   2 +-
 apps/editor-web/src/opfs-original-asset-cache.ts |   4 +-
 13 files changed, 379 insertions(+), 204 deletions(-)

## Diff
diff --git a/apps/api/src/asset-hermes-tags.ts b/apps/api/src/asset-hermes-tags.ts
index 828502b..e327fbe 100644
--- a/apps/api/src/asset-hermes-tags.ts
+++ b/apps/api/src/asset-hermes-tags.ts
@@ -1,16 +1,16 @@
 /**
  * Hermes-style automatic asset tags for the catalog.
  * Always applies deterministic tags; optionally enriches via vision API when configured.
  */
 export interface HermesTagInput {
-  readonly kind: 'video' | 'audio' | 'image';
+  readonly kind: 'video' | 'audio' | 'image' | 'model';
   readonly displayName: string;
   readonly mimeType: string;
   readonly bytes: number;
   readonly width?: number;
   readonly height?: number;
   /** Optional image bytes for vision enrichment (images only). */
   readonly imageBytes?: Uint8Array;
 }
 
 export interface HermesTagResult {
@@ -52,21 +52,25 @@ export function heuristicTags(input: HermesTagInput): readonly string[] {
 
   if (mime === 'image/gif' || mime === 'image/webp') tags.push('animated-candidate');
   if (mime.startsWith('image/')) tags.push('image');
   if (mime === 'image/png') tags.push('png');
   if (mime === 'image/jpeg' || mime === 'image/jpg') tags.push('photo');
   if (mime === 'image/gif') tags.push('gif');
   if (mime === 'image/webp') tags.push('webp');
 
   if (input.width !== undefined && input.height !== undefined) {
     const orient =
-      input.width === input.height ? 'square' : input.width > input.height ? 'landscape' : 'portrait';
+      input.width === input.height
+        ? 'square'
+        : input.width > input.height
+          ? 'landscape'
+          : 'portrait';
     tags.push(orient);
     if (input.width >= 1920 || input.height >= 1920) tags.push('hires');
   }
 
   if (input.bytes < 100_000) tags.push('tiny');
   else if (input.bytes < 2_000_000) tags.push('small');
   else if (input.bytes < 20_000_000) tags.push('medium');
   else tags.push('large');
 
   const name = input.displayName.toLocaleLowerCase();
diff --git a/apps/api/src/control-plane.ts b/apps/api/src/control-plane.ts
index a0a8a0b..bb87440 100644
--- a/apps/api/src/control-plane.ts
+++ b/apps/api/src/control-plane.ts
@@ -16,21 +16,21 @@ export interface Actor {
   readonly id: string;
 }
 export interface ProjectMetadata {
   readonly id: string;
   readonly title: string;
   readonly revision: number;
   readonly ownerId: string;
   /** Explicit opt-in prerequisite for private object-storage synchronization. */
   readonly assetSyncEnabled: boolean;
 }
-export type MediaAssetKind = 'video' | 'audio' | 'image';
+export type MediaAssetKind = 'video' | 'audio' | 'image' | 'model';
 export type DerivativeKind = 'thumbnail' | 'proxy';
 export type DerivativeAvailability =
   'pending' | 'available-local' | 'available-cloud' | 'evicted' | 'invalid';
 
 /** An opaque browser/cache or private-store reference, never a path or URL. */
 export interface AssetLocationRecord {
   readonly kind: 'opfs-cache' | 'private-object';
   readonly ref: string;
 }
 
@@ -1274,21 +1274,21 @@ function derivativeOf(
     workerRef,
     resultRef: `derivative:${jobId}`,
     verifiedAt,
     ...receipt,
   };
 }
 
 export function validateAssetRegistration(value: AssetRegistration): void {
   validateOpaqueId(value.id, 'asset id');
   validateDisplayName(value.displayName);
-  if (!['video', 'audio', 'image'].includes(value.kind))
+  if (!['video', 'audio', 'image', 'model'].includes(value.kind))
     throw new ControlPlaneError('ASSET_INVALID', 'asset kind is invalid');
   validateHashAndBytes(value.sha256, value.bytes, 'asset');
   validateDescriptor(value.descriptor);
   validateLocations(value.locations);
 }
 
 export function validateLocalDerivativeRegistration(value: LocalDerivativeRegistration): void {
   validateDerivativeRegistration(value);
   if (value.availability !== 'pending' && value.availability !== 'available-local')
     throw new ControlPlaneError('DERIVATIVE_INVALID', 'cloud derivative state is API-owned');
@@ -1353,21 +1353,24 @@ export function validateSortName(value: string): string {
     throw new ControlPlaneError('ASSET_INVALID', 'sort name is invalid');
   return value;
 }
 
 function validateHashAndBytes(hash: string, bytes: number, label: string): void {
   if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(bytes) || bytes < 1)
     throw new ControlPlaneError('ASSET_INVALID', `${label} hash or byte length is invalid`);
 }
 
 function validateDescriptor(value: MediaDescriptor): void {
-  if (!/^(video|audio|image)\/[a-z0-9.+-]+$/.test(value.mimeType))
+  if (
+    !/^(video|audio|image)\/[a-z0-9.+-]+$/.test(value.mimeType) &&
+    !['model/gltf-binary', 'model/gltf+json'].includes(value.mimeType)
+  )
     throw new ControlPlaneError('ASSET_INVALID', 'media MIME type is invalid');
   for (const dimension of [value.durationUs, value.width, value.height]) {
     if (dimension !== undefined && (!Number.isSafeInteger(dimension) || dimension < 1))
       throw new ControlPlaneError('ASSET_INVALID', 'media descriptor is invalid');
   }
 }
 
 function validateLocations(value: readonly AssetLocationRecord[]): void {
   if (value.length === 0 || value.length > 2)
     throw new ControlPlaneError('ASSET_INVALID', 'one or two opaque locations are required');
diff --git a/apps/api/src/http-server.ts b/apps/api/src/http-server.ts
index 5153269..c3067e7 100644
--- a/apps/api/src/http-server.ts
+++ b/apps/api/src/http-server.ts
@@ -1804,21 +1804,21 @@ function assetLocations(body: Record<string, unknown>): AssetRegistration['locat
       throw new ControlPlaneError('REQUEST_INVALID', 'location kind is invalid');
     return { kind, ref: requiredString(location, 'ref') };
   });
 }
 
 function requiredAssetKind(
   body: Record<string, unknown>,
   field: string,
 ): AssetRegistration['kind'] {
   const value = body[field];
-  if (value !== 'video' && value !== 'audio' && value !== 'image')
+  if (value !== 'video' && value !== 'audio' && value !== 'image' && value !== 'model')
     throw new ControlPlaneError('REQUEST_INVALID', `${field} is invalid`);
   return value;
 }
 
 function requiredSha256(body: Record<string, unknown>, field: string): string {
   const value = body[field];
   if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
     throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a SHA-256 hex digest`);
   return value;
 }
diff --git a/apps/editor-web/src/AgentPanel.tsx b/apps/editor-web/src/AgentPanel.tsx
index 9c08b43..9988b11 100644
--- a/apps/editor-web/src/AgentPanel.tsx
+++ b/apps/editor-web/src/AgentPanel.tsx
@@ -29,20 +29,21 @@ import { AgentTimelineCanvas } from './AgentTimelineCanvas.js';
 import { extractPendingChanges } from './agent-plan-visualizer.js';
 import { saveWorkflow } from './workflow-recorder.js';
 import type { EditorSession } from './editor-session.js';
 import { JOY_MEDIA_ASSET_DND } from './TimelinePanel.js';
 import { PanelShell, type PanelTabSpec } from './PanelShell.js';
 import type { AgentSettings } from './agent-settings.js';
 import { approvalPolicyForAgentSettings } from './agent-settings.js';
 import {
   BrowserControlPlaneError,
   BrowserControlPlaneClient,
+  type BrowserAsset,
   type BrowserProviderApprovalPreflight,
   type BrowserJoyCodeReasoningRequest,
   type BrowserJoyCodeReasoningResponse,
 } from './control-plane-client.js';
 import { JoyCodeLogo } from './JoyCodeLogo.js';
 import { JoyCode3DViewer } from './JoyCode3DViewer.js';
 import { openJoyCodeOpfsAssetCache } from './joycode-opfs-assets.js';
 import {
   addJoyCodeMessage,
   createJoyCodeThread,
@@ -452,32 +453,35 @@ function threadTimestamp(value: string): string {
  * the former dashboard; unsupported free-form prompts are reported honestly.
  */
 export function AgentPanel({
   project,
   selectedClipIds,
   playheadUs,
   agentContext,
   onUndo,
   session,
   attachedAssets = [],
+  assets = [],
   onDetachAsset,
   onAttachAsset,
   settings,
   command,
 }: {
   readonly project: SpikeProject;
   readonly selectedClipIds: readonly string[];
   readonly playheadUs: number;
   readonly agentContext: EditorContext;
   readonly onUndo: () => void;
   readonly session: EditorSession;
   readonly attachedAssets?: readonly KiloCodeAttachedAsset[];
+  /** Registered catalog assets available to the asset-backed 3D preview. */
+  readonly assets?: readonly BrowserAsset[];
   readonly onDetachAsset?: (assetId: string) => void;
   readonly onAttachAsset?: (asset: KiloCodeAttachedAsset) => void;
   readonly settings: AgentSettings;
   readonly command?: AgentPanelCommand;
 }) {
   const registry = useMemo(() => createToolRegistry(), []);
   const controlPlaneClient = useMemo(() => new BrowserControlPlaneClient(), []);
   const auditRef = useRef(createAuditTrail());
   const handledCommandRef = useRef<number | undefined>(undefined);
   const thinkingTimerRef = useRef<number | undefined>(undefined);
@@ -1385,15 +1389,15 @@ export function AgentPanel({
                     else submitPrompt(draft);
                   }}
                 >
                   {!hasBlockingPending ? <PlayIcon /> : <CloseIcon />}
                 </button>
               </div>
             </div>
           </section>
         )}
 
-        {tab === '3d' && <JoyCode3DViewer />}
+        {tab === '3d' && <JoyCode3DViewer assets={assets} />}
       </div>
     </PanelShell>
   );
 }
diff --git a/apps/editor-web/src/App.tsx b/apps/editor-web/src/App.tsx
index a7bc980..8048e57 100644
--- a/apps/editor-web/src/App.tsx
+++ b/apps/editor-web/src/App.tsx
@@ -2835,20 +2835,21 @@ function EditorWorkspace({
           selectedClipIds={state.selectedIds}
           playheadUs={state.playheadUs}
           agentContext={context.agentContext}
           onUndo={context.undo}
           session={context.session}
           settings={context.agentSettings}
           {...(context.agentPanelCommand === undefined
             ? {}
             : { command: context.agentPanelCommand })}
           attachedAssets={context.kiloCodeAttachedAssets}
+          assets={Object.values(monitorAssetCatalog.assets)}
           onDetachAsset={context.detachKiloCodeAsset}
           onAttachAsset={context.attachKiloCodeAsset}
         />
       );
     }
     if (api.id === 'history') {
       return <HistoryPanel entries={context.historyEntries} onJumpTo={context.jumpToHistory} />;
     }
     if (api.id === 'diagnostics')
       return (
diff --git a/apps/editor-web/src/AssetLibraryPanel.tsx b/apps/editor-web/src/AssetLibraryPanel.tsx
index 6954367..3538247 100644
--- a/apps/editor-web/src/AssetLibraryPanel.tsx
+++ b/apps/editor-web/src/AssetLibraryPanel.tsx
@@ -68,20 +68,21 @@ import { useAccessibleDialog } from './dialog-a11y.js';
 
 const ASSET_RENDER_PAGE_SIZE = 120;
 
 const categories: readonly {
   readonly id: AssetCategory;
   readonly label: string;
 }[] = [
   { id: 'image', label: 'Images' },
   { id: 'video', label: 'Video' },
   { id: 'audio', label: 'Audio' },
+  { id: 'model', label: '3D Models' },
 ];
 
 interface Preview {
   readonly derivativeId: string;
   readonly displayName: string;
   readonly mimeType: string;
   readonly url: string;
   readonly revoke: () => void;
 }
 
@@ -465,21 +466,21 @@ export function AssetLibraryPanel({
         setStatus(
           `${selectedFile.name} در Cloud پشتیبان‌گیری شد. برچسب‌های Agent اعمال شدند و کاتالوگ در حال تازه‌سازی است.`,
         );
       } else {
         try {
           await client.retagAsset(projectId, registered.id);
         } catch {
           /* heuristic retag is best-effort for video/audio */
         }
         setStatus(
-          `${selectedFile.name} به‌صورت محلی ثبت شد. پشتیبان‌گیری Cloud برای Video و Audio در v1 اولویت پایین‌تری دارد.`,
+          `${selectedFile.name} به‌صورت محلی ثبت شد. پشتیبان‌گیری Cloud برای ${kind === 'model' ? '3D model' : 'Video و Audio'} در v1 اولویت پایین‌تری دارد.`,
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
@@ -499,21 +500,27 @@ export function AssetLibraryPanel({
   const fetchCloudOriginal = useCallback(
     (id: string) => cloudPreviewQueue.load(id, () => client.sharedCloudOriginalBytes(id)),
     [client, cloudPreviewQueue],
   );
 
   const openPreview = useCallback(
     async (asset: BrowserAsset, assetDerivatives: readonly BrowserDerivative[]) => {
       const requestId = ++previewSeqRef.current;
       clearPreview();
       const sourceKind =
-        asset.kind === 'video' ? 'video' : asset.kind === 'audio' ? 'audio' : 'image';
+        asset.kind === 'video'
+          ? 'video'
+          : asset.kind === 'audio'
+            ? 'audio'
+            : asset.kind === 'model'
+              ? '3D model'
+              : 'image';
       setStatus(`در حال باز کردن Preview ${sourceKind} تأییدشده…`);
       try {
         const [resolverInstance, originalCache] = await Promise.all([resolver, originalAssetCache]);
         const outcome = await resolveAssetThumb({
           asset,
           derivatives: assetDerivatives,
           projectId,
           resolver: resolverInstance,
           originalCache,
           fetchCloudOriginal,
@@ -1811,26 +1818,36 @@ function formatSeconds(valueUs: number): string {
 function formatBytes(bytes: number): string {
   if (bytes < 1024) return `${bytes} B`;
   if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
   return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
 }
 function message(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
 }
 
 function assetKind(file: File): BrowserAsset['kind'] {
+  if (
+    file.type === 'model/gltf-binary' ||
+    file.type === 'model/gltf+json' ||
+    /\.(glb|gltf)$/i.test(file.name)
+  )
+    return 'model';
   if (file.type.startsWith('video/')) return 'video';
   if (file.type.startsWith('audio/')) return 'audio';
   if (file.type.startsWith('image/')) return 'image';
-  throw new Error('selected file must be video, audio, or an image');
+  throw new Error('selected file must be video, audio, image, or GLB/GLTF');
 }
 function normalizedMimeType(file: File, kind: BrowserAsset['kind']): string {
+  if (kind === 'model' && (file.type === 'model/gltf-binary' || file.type === 'model/gltf+json'))
+    return file.type;
+  if (kind === 'model' && /\.glb$/i.test(file.name)) return 'model/gltf-binary';
+  if (kind === 'model' && /\.gltf$/i.test(file.name)) return 'model/gltf+json';
   if (/^(video|audio|image)\/[a-z0-9.+-]+$/i.test(file.type)) return file.type;
   throw new Error(`${kind} file has no supported MIME type`);
 }
 function hex(bytes: Uint8Array): string {
   return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
 }
 
 const ASSET_VIEW_KEY = 'joy-media.asset-view.v1';
 
 function readAssetViewMode(): AssetViewMode {
diff --git a/apps/editor-web/src/JoyCode3DViewer.test.tsx b/apps/editor-web/src/JoyCode3DViewer.test.tsx
new file mode 100644
index 0000000..343743d
--- /dev/null
+++ b/apps/editor-web/src/JoyCode3DViewer.test.tsx
@@ -0,0 +1,72 @@
+import { renderToStaticMarkup } from 'react-dom/server';
+import { describe, expect, it } from 'vitest';
+import * as THREE from 'three';
+import {
+  disposeThreeObject,
+  JoyCode3DViewer,
+  isSupported3DAsset,
+  registered3DAssets,
+  resolveRegistered3DAsset,
+} from './JoyCode3DViewer.js';
+import type { BrowserAsset } from './control-plane-client.js';
+
+const MODEL: BrowserAsset = {
+  id: 'model-1',
+  projectId: 'project-1',
+  kind: 'model',
+  displayName: 'hero.glb',
+  sha256: 'a'.repeat(64),
+  bytes: 4,
+  descriptor: { mimeType: 'model/gltf-binary' },
+  createdAt: 1,
+};
+
+describe('JoyCode3DViewer asset boundary', () => {
+  it('only selects registered GLB/GLTF catalog assets', () => {
+    expect(isSupported3DAsset(MODEL)).toBe(true);
+    expect(isSupported3DAsset({ ...MODEL, kind: 'image' })).toBe(false);
+    expect(
+      isSupported3DAsset({ ...MODEL, descriptor: { mimeType: 'application/octet-stream' } }),
+    ).toBe(false);
+    expect(registered3DAssets([MODEL, { ...MODEL, id: 'image-1', kind: 'image' }])).toEqual([
+      MODEL,
+    ]);
+  });
+
+  it('checks the catalog byte contract before loading', async () => {
+    await expect(
+      resolveRegistered3DAsset(MODEL, async () => new Blob([new Uint8Array([1, 2, 3, 4])])),
+    ).resolves.toBeInstanceOf(Blob);
+    await expect(
+      resolveRegistered3DAsset(MODEL, async () => new Blob([new Uint8Array([1])])),
+    ).rejects.toThrow('integrity');
+  });
+
+  it('renders an honest empty state instead of a fake file picker', () => {
+    const markup = renderToStaticMarkup(<JoyCode3DViewer assets={[]} />);
+    expect(markup).toContain('No registered 3D assets');
+    expect(markup).toContain('Import a GLB or GLTF through Assets first');
+    expect(markup).not.toContain('type="file"');
+  });
+
+  it('releases geometry and material resources when a model is replaced', () => {
+    const geometry = new THREE.BoxGeometry();
+    const material = new THREE.MeshBasicMaterial();
+    const mesh = new THREE.Mesh(geometry, material);
+    const geometryDispose = geometry.dispose;
+    const materialDispose = material.dispose;
+    let geometryReleased = false;
+    let materialReleased = false;
+    geometry.dispose = () => {
+      geometryReleased = true;
+      geometryDispose.call(geometry);
+    };
+    material.dispose = () => {
+      materialReleased = true;
+      materialDispose.call(material);
+    };
+    disposeThreeObject(mesh);
+    expect(geometryReleased).toBe(true);
+    expect(materialReleased).toBe(true);
+  });
+});
diff --git a/apps/editor-web/src/JoyCode3DViewer.tsx b/apps/editor-web/src/JoyCode3DViewer.tsx
index 7225d31..623d29e 100644
--- a/apps/editor-web/src/JoyCode3DViewer.tsx
+++ b/apps/editor-web/src/JoyCode3DViewer.tsx
@@ -1,240 +1,311 @@
-import { useCallback, useEffect, useRef, useState } from 'react';
+import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
 import * as THREE from 'three';
 import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
 import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
+import type { BrowserAsset, BrowserControlPlaneClient } from './control-plane-client.js';
+import { BrowserControlPlaneClient as ControlPlaneClient } from './control-plane-client.js';
+import { openOpfsOriginalAssetCache } from './opfs-original-asset-cache.js';
 
-export function JoyCode3DViewer() {
+export const SUPPORTED_3D_MIME_TYPES = ['model/gltf-binary', 'model/gltf+json'] as const;
+export type Supported3DMimeType = (typeof SUPPORTED_3D_MIME_TYPES)[number];
+
+export function isSupported3DAsset(asset: Pick<BrowserAsset, 'kind' | 'descriptor'>): boolean {
+  return (
+    asset.kind === 'model' &&
+    (SUPPORTED_3D_MIME_TYPES as readonly string[]).includes(asset.descriptor.mimeType)
+  );
+}
+
+export function registered3DAssets(assets: readonly BrowserAsset[]): readonly BrowserAsset[] {
+  return assets.filter(isSupported3DAsset);
+}
+
+export async function resolveRegistered3DAsset(
+  asset: BrowserAsset,
+  resolve: (asset: BrowserAsset) => Promise<Blob>,
+): Promise<Blob> {
+  if (!isSupported3DAsset(asset))
+    throw new Error('Only registered GLB/GLTF assets can be previewed.');
+  const blob = await resolve(asset);
+  if (blob.size !== asset.bytes)
+    throw new Error('3D asset integrity metadata does not match its bytes.');
+  return blob;
+}
+
+/** Release GPU-owned geometry/material/texture resources when replacing a model. */
+export function disposeThreeObject(object: THREE.Object3D): void {
+  object.traverse((child) => {
+    if (!(child instanceof THREE.Mesh)) return;
+    child.geometry.dispose();
+    const materials = Array.isArray(child.material) ? child.material : [child.material];
+    for (const material of materials) {
+      for (const value of Object.values(material)) {
+        if (value instanceof THREE.Texture) value.dispose();
+      }
+      material.dispose();
+    }
+  });
+}
+
+interface JoyCode3DViewerProps {
+  readonly assets?: readonly BrowserAsset[];
+  /** Injected in tests/hosts; production uses OPFS first and the authenticated private catalog. */
+  readonly resolveAsset?: (asset: BrowserAsset) => Promise<Blob>;
+}
+
+interface ViewerResources {
+  readonly container: HTMLDivElement;
+  readonly scene: THREE.Scene;
+  readonly camera: THREE.PerspectiveCamera;
+  readonly renderer: THREE.WebGLRenderer;
+  readonly controls: OrbitControls;
+  readonly grid: THREE.GridHelper;
+}
+
+export function JoyCode3DViewer({ assets = [], resolveAsset }: JoyCode3DViewerProps) {
+  const models = useMemo(() => registered3DAssets(assets), [assets]);
+  const [selectedAssetId, setSelectedAssetId] = useState<string | undefined>(models[0]?.id);
+  const [status, setStatus] = useState('Select a registered GLB/GLTF asset');
+  const [sceneReady, setSceneReady] = useState(false);
   const containerRef = useRef<HTMLDivElement | null>(null);
-  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
-  const sceneRef = useRef<THREE.Scene | null>(null);
-  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
-  const controlsRef = useRef<OrbitControls | null>(null);
+  const resourcesRef = useRef<ViewerResources | null>(null);
+  const modelRef = useRef<THREE.Object3D | null>(null);
   const animFrameRef = useRef<number | undefined>(undefined);
   const resizeObserverRef = useRef<ResizeObserver | null>(null);
   const loadSeqRef = useRef(0);
-  const contextLostHandlerRef = useRef<((event: Event) => void) | undefined>(undefined);
-  const contextRestoredHandlerRef = useRef<(() => void) | undefined>(undefined);
-  const [status, setStatus] = useState('Ready — drag to orbit, scroll to zoom');
-  const [fileList, setFileList] = useState<readonly string[]>([]);
-  const fileInputRef = useRef<HTMLInputElement | null>(null);
-
-  const disposeModel = useCallback((model: THREE.Object3D) => {
-    model.traverse((child) => {
-      if (child instanceof THREE.Mesh) {
-        child.geometry?.dispose();
-        if (child.material instanceof THREE.Material) {
-          child.material.dispose();
-        } else if (Array.isArray(child.material)) {
-          child.material.forEach((m) => m.dispose());
-        }
-      }
-    });
-  }, []);
+  const loadUrlRef = useRef<string | undefined>(undefined);
+  const defaultClientRef = useRef<BrowserControlPlaneClient | null>(null);
 
-  const clearScene = useCallback(() => {
-    const scene = sceneRef.current;
-    if (!scene) return;
-    const toRemove: THREE.Object3D[] = [];
-    scene.traverse((child) => {
-      if (child instanceof THREE.Mesh || child instanceof THREE.Group) {
-        toRemove.push(child);
-      }
-    });
-    toRemove.forEach((child) => {
-      scene.remove(child);
-      disposeModel(child);
-    });
-  }, [disposeModel]);
-
-  const initScene = useCallback(() => {
-    const container = containerRef.current;
-    if (!container) return;
+  useEffect(() => {
+    if (selectedAssetId !== undefined && models.some((asset) => asset.id === selectedAssetId))
+      return;
+    setSelectedAssetId(models[0]?.id);
+  }, [models, selectedAssetId]);
 
-    const width = container.clientWidth;
-    const height = container.clientHeight;
+  const disposeObject = useCallback(disposeThreeObject, []);
 
-    const scene = new THREE.Scene();
-    scene.background = new THREE.Color(0x1a1a2e);
-    sceneRef.current = scene;
+  const clearModel = useCallback(() => {
+    const model = modelRef.current;
+    if (model === null) return;
+    resourcesRef.current?.scene.remove(model);
+    disposeObject(model);
+    modelRef.current = null;
+  }, [disposeObject]);
 
-    const camera = new THREE.PerspectiveCamera(50, width / Math.max(1, height), 0.1, 1000);
-    camera.position.set(3, 2, 5);
-    camera.lookAt(0, 0, 0);
-    cameraRef.current = camera;
+  const stopAnimation = useCallback(() => {
+    if (animFrameRef.current !== undefined) {
+      cancelAnimationFrame(animFrameRef.current);
+      animFrameRef.current = undefined;
+    }
+  }, []);
 
+  useEffect(() => {
+    const container = containerRef.current;
+    if (container === null || resourcesRef.current !== null) return;
+    const width = Math.max(1, container.clientWidth);
+    const height = Math.max(1, container.clientHeight);
+    const scene = new THREE.Scene();
+    scene.background = new THREE.Color(0x111827);
+    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
+    camera.position.set(3, 2, 5);
     const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
     renderer.setSize(width, height);
-    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
+    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
     renderer.shadowMap.enabled = true;
     container.appendChild(renderer.domElement);
-    rendererRef.current = renderer;
-
     const controls = new OrbitControls(camera, renderer.domElement);
     controls.enableDamping = true;
     controls.dampingFactor = 0.08;
     controls.target.set(0, 0.5, 0);
-    controls.update();
-    controlsRef.current = controls;
-
-    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
-    scene.add(ambient);
-
-    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
-    dirLight.position.set(5, 8, 5);
-    dirLight.castShadow = true;
-    scene.add(dirLight);
-
-    const grid = new THREE.GridHelper(10, 20, 0x444466, 0x222244);
+    const ambient = new THREE.AmbientLight(0xffffff, 0.65);
+    const directional = new THREE.DirectionalLight(0xffffff, 1.1);
+    directional.position.set(5, 8, 5);
+    directional.castShadow = true;
+    scene.add(ambient, directional);
+    const grid = new THREE.GridHelper(10, 20, 0x4b5563, 0x273449);
     scene.add(grid);
-
-    setStatus('Scene ready — load a GLB/GLTF file to preview');
+    const resources: ViewerResources = { container, scene, camera, renderer, controls, grid };
+    resourcesRef.current = resources;
 
     const animate = () => {
       animFrameRef.current = requestAnimationFrame(animate);
       controls.update();
       renderer.render(scene, camera);
     };
     animate();
-
-    resizeObserverRef.current = new ResizeObserver((entries) => {
-      for (const entry of entries) {
-        const { width: w, height: h } = entry.contentRect;
-        if (w > 0 && h > 0) {
-          camera.aspect = w / Math.max(1, h);
-          camera.updateProjectionMatrix();
-          renderer.setSize(w, h);
-        }
-      }
-    });
-    resizeObserverRef.current.observe(container);
-
-    const handleContextLost = (event: Event) => {
+    const resizeObserver =
+      typeof ResizeObserver === 'undefined'
+        ? undefined
+        : new ResizeObserver((entries) => {
+            for (const entry of entries) {
+              const nextWidth = entry.contentRect.width;
+              const nextHeight = entry.contentRect.height;
+              if (nextWidth <= 0 || nextHeight <= 0) continue;
+              camera.aspect = nextWidth / nextHeight;
+              camera.updateProjectionMatrix();
+              renderer.setSize(nextWidth, nextHeight);
+            }
+          });
+    resizeObserver?.observe(container);
+    resizeObserverRef.current = resizeObserver ?? null;
+    const onContextLost = (event: Event) => {
       event.preventDefault();
-      if (animFrameRef.current !== undefined) {
-        cancelAnimationFrame(animFrameRef.current);
-        animFrameRef.current = undefined;
-      }
-      setStatus('WebGL context lost — attempting recovery...');
+      stopAnimation();
+      setStatus('WebGL context lost — waiting for recovery…');
     };
-    const handleContextRestored = () => {
-      setStatus('WebGL context restored — reinitializing...');
+    const onContextRestored = () => {
+      setStatus('WebGL context restored — resuming preview…');
       animate();
     };
-    contextLostHandlerRef.current = handleContextLost;
-    contextRestoredHandlerRef.current = handleContextRestored;
-    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
-    renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored);
-  }, []);
-
-  useEffect(() => {
-    initScene();
+    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
+    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);
+    controls.update();
+    setSceneReady(true);
     return () => {
-      if (animFrameRef.current !== undefined) cancelAnimationFrame(animFrameRef.current);
-      resizeObserverRef.current?.disconnect();
-      const canvas = rendererRef.current?.domElement;
-      if (canvas && contextLostHandlerRef.current) {
-        canvas.removeEventListener('webglcontextlost', contextLostHandlerRef.current);
-      }
-      if (canvas && contextRestoredHandlerRef.current) {
-        canvas.removeEventListener('webglcontextrestored', contextRestoredHandlerRef.current);
+      ++loadSeqRef.current;
+      if (loadUrlRef.current !== undefined) {
+        URL.revokeObjectURL(loadUrlRef.current);
+        loadUrlRef.current = undefined;
       }
-      controlsRef.current?.dispose();
-      rendererRef.current?.dispose();
-      clearScene();
-      sceneRef.current = null;
-      cameraRef.current = null;
-      controlsRef.current = null;
-      rendererRef.current = null;
-      contextLostHandlerRef.current = undefined;
-      contextRestoredHandlerRef.current = undefined;
+      clearModel();
+      stopAnimation();
+      resizeObserverRef.current?.disconnect();
+      resizeObserverRef.current = null;
+      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
+      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
+      controls.dispose();
+      renderer.dispose();
+      renderer.forceContextLoss();
+      renderer.domElement.remove();
+      resourcesRef.current = null;
+      setSceneReady(false);
     };
-  }, [initScene, clearScene]);
+  }, [clearModel, stopAnimation]);
 
-  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
-    const file = event.target.files?.[0];
-    if (!file) return;
-    const url = URL.createObjectURL(file);
-    const requestId = ++loadSeqRef.current;
-    setFileList((prev) => [...prev, file.name]);
-    setStatus(`Loading ${file.name}…`);
-
-    clearScene();
+  const fallbackResolver = useCallback(async (asset: BrowserAsset): Promise<Blob> => {
+    const cache = await openOpfsOriginalAssetCache();
+    const local = await cache.get(asset.id);
+    if (local !== undefined) return local;
+    if (defaultClientRef.current === null) defaultClientRef.current = new ControlPlaneClient();
+    return defaultClientRef.current.sharedCloudOriginalBytes(asset.id);
+  }, []);
 
+  useEffect(() => {
+    if (!sceneReady || selectedAssetId === undefined) return;
+    const asset = models.find((candidate) => candidate.id === selectedAssetId);
+    if (asset === undefined) return;
+    const requestId = ++loadSeqRef.current;
     const loader = new GLTFLoader();
-    loader.load(
-      url,
-      (gltf) => {
-        if (requestId !== loadSeqRef.current) {
-          URL.revokeObjectURL(url);
-          return;
-        }
-        URL.revokeObjectURL(url);
-        const model = gltf.scene;
-        model.traverse((child) => {
-          if (child instanceof THREE.Mesh) {
-            child.castShadow = true;
-            child.receiveShadow = true;
-          }
-        });
-        const box = new THREE.Box3().setFromObject(model);
-        const size = box.getSize(new THREE.Vector3());
-        const center = box.getCenter(new THREE.Vector3());
-        const maxDim = Math.max(size.x, size.y, size.z, 1);
-        const scale = 3 / maxDim;
-        model.scale.setScalar(scale);
-        model.position.sub(center.multiplyScalar(scale));
-        model.position.y += size.y * scale * 0.5;
-        sceneRef.current?.add(model);
-        setStatus(`Loaded: ${file.name}`);
-      },
-      (progress) => {
+    clearModel();
+    setStatus(`Loading ${asset.displayName}…`);
+    void resolveRegistered3DAsset(asset, resolveAsset ?? fallbackResolver)
+      .then((blob) => {
         if (requestId !== loadSeqRef.current) return;
-        const pct = progress.loaded / Math.max(1, progress.total);
-        setStatus(`Loading ${file.name}… ${Math.round(pct * 100)}%`);
-      },
-      (err: unknown) => {
-        if (requestId !== loadSeqRef.current) {
-          URL.revokeObjectURL(url);
-          return;
-        }
-        URL.revokeObjectURL(url);
-        const msg = err instanceof Error ? err.message : String(err);
-        setStatus(`Error loading ${file.name}: ${msg}`);
-      },
-    );
+        const url = URL.createObjectURL(blob);
+        loadUrlRef.current = url;
+        loader.load(
+          url,
+          (gltf) => {
+            URL.revokeObjectURL(url);
+            if (loadUrlRef.current === url) loadUrlRef.current = undefined;
+            if (requestId !== loadSeqRef.current) {
+              disposeObject(gltf.scene);
+              return;
+            }
+            const model = gltf.scene;
+            model.traverse((child) => {
+              if (child instanceof THREE.Mesh) {
+                child.castShadow = true;
+                child.receiveShadow = true;
+              }
+            });
+            const bounds = new THREE.Box3().setFromObject(model);
+            const size = bounds.getSize(new THREE.Vector3());
+            const center = bounds.getCenter(new THREE.Vector3());
+            const maxDimension = Math.max(size.x, size.y, size.z, 1);
+            const scale = 3 / maxDimension;
+            model.scale.setScalar(scale);
+            model.position.sub(center.multiplyScalar(scale));
+            model.position.y += size.y * scale * 0.5;
+            resourcesRef.current?.scene.add(model);
+            modelRef.current = model;
+            setStatus(`Loaded ${asset.displayName}`);
+          },
+          (progress) => {
+            if (requestId !== loadSeqRef.current) return;
+            const ratio = progress.total > 0 ? progress.loaded / progress.total : 0;
+            setStatus(`Loading ${asset.displayName}… ${Math.round(ratio * 100)}%`);
+          },
+          (error: unknown) => {
+            URL.revokeObjectURL(url);
+            if (loadUrlRef.current === url) loadUrlRef.current = undefined;
+            if (requestId === loadSeqRef.current)
+              setStatus(
+                `Unable to preview ${asset.displayName}: ${error instanceof Error ? error.message : 'invalid GLB/GLTF'}`,
+              );
+          },
+        );
+      })
+      .catch((error: unknown) => {
+        if (requestId === loadSeqRef.current)
+          setStatus(
+            `Unable to load ${asset.displayName}: ${error instanceof Error ? error.message : String(error)}`,
+          );
+      });
+    return () => {
+      if (requestId !== loadSeqRef.current) return;
+      ++loadSeqRef.current;
+      if (loadUrlRef.current !== undefined) {
+        URL.revokeObjectURL(loadUrlRef.current);
+        loadUrlRef.current = undefined;
+      }
+    };
+  }, [
+    clearModel,
+    disposeObject,
+    fallbackResolver,
+    models,
+    resolveAsset,
+    sceneReady,
+    selectedAssetId,
+  ]);
 
-    event.target.value = '';
-  }, [clearScene]);
+  if (models.length === 0) {
+    return (
+      <div className="joy-code-3d joy-code-3d--empty" role="status">
+        <strong>No registered 3D assets</strong>
+        <span>Import a GLB or GLTF through Assets first, then open this preview.</span>
+      </div>
+    );
+  }
 
   return (
-    <div className="joy-code-3d" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
+    <div
+      className="joy-code-3d"
+      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
+    >
       <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--joy-border)' }}>
-        <button
-          type="button"
-          className="icon-button"
-          aria-label="Import 3D model"
-          title="Import GLB/GLTF"
-          onClick={() => fileInputRef.current?.click()}
+        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
+          <span>3D asset</span>
+          <select
+            aria-label="Registered 3D asset"
+            value={selectedAssetId ?? ''}
+            onChange={(event) => setSelectedAssetId(event.target.value || undefined)}
+          >
+            {models.map((asset) => (
+              <option key={asset.id} value={asset.id}>
+                {asset.displayName}
+              </option>
+            ))}
+          </select>
+        </label>
+        <span
+          style={{ display: 'block', marginTop: 6, fontSize: 12, color: 'var(--joy-text-muted)' }}
         >
-          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
-            <path d="M8 2v9M4 7l4-4 4 4M3 13h10" />
-          </svg>
-        </button>
-        <input
-          ref={fileInputRef}
-          type="file"
-          accept=".glb,.gltf"
-          style={{ display: 'none' }}
-          onChange={handleFileSelect}
-        />
-        <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--joy-text-muted)' }}>{status}</span>
+          {status}
+        </span>
       </div>
       <div ref={containerRef} style={{ flex: 1, minHeight: 0, cursor: 'grab' }} />
-      {fileList.length > 0 && (
-        <div style={{ padding: '4px 12px', borderTop: '1px solid var(--joy-border)', fontSize: 11, color: 'var(--joy-text-muted)' }}>
-          {fileList.length} model(s) loaded
-        </div>
-      )}
     </div>
   );
 }
diff --git a/apps/editor-web/src/asset-card-preview.ts b/apps/editor-web/src/asset-card-preview.ts
index 3f17c99..183fefb 100644
--- a/apps/editor-web/src/asset-card-preview.ts
+++ b/apps/editor-web/src/asset-card-preview.ts
@@ -11,21 +11,21 @@ export interface AssetThumbResult {
   readonly source: AssetThumbSource;
   readonly revoke: () => void;
   /** True when OPFS has original bytes (used for Backup to cloud affordance). */
   readonly hasOpfsOriginal: boolean;
 }
 
 export function playableAssetDescriptorFromBrowserAsset(
   asset:
     | {
         readonly id: string;
-        readonly kind: 'video' | 'audio' | 'image' | 'other';
+        readonly kind: 'video' | 'audio' | 'image' | 'model' | 'other';
         readonly sha256?: unknown;
         readonly bytes?: unknown;
         readonly descriptor?: { readonly mimeType?: unknown };
       }
     | undefined,
 ): PlayableAssetDescriptor | undefined {
   if (asset === undefined || asset.kind === 'other') return undefined;
   const mimeType = asset.descriptor?.mimeType;
   if (
     typeof asset.sha256 !== 'string' ||
diff --git a/apps/editor-web/src/asset-library-icons.ts b/apps/editor-web/src/asset-library-icons.ts
index 1c1c1ec..c1b74ff 100644
--- a/apps/editor-web/src/asset-library-icons.ts
+++ b/apps/editor-web/src/asset-library-icons.ts
@@ -3,20 +3,21 @@ import type { AssetCategory, AssetCollectionId } from './asset-library-state.js'
 
 /**
  * Owner-supplied 24×24 black-on-transparent masks for Assets sections and
  * collection tabs. Same art as https://media.joyteam.ir/assets/24_*.png —
  * imported through Vite so redeploys bust CDN/browser caches.
  */
 export const ASSET_CATEGORY_ICONS: Readonly<Record<AssetCategory, string>> = {
   image: iconUrl('asset/24_Images.png'),
   video: iconUrl('asset/24_video.png'),
   audio: iconUrl('asset/24_Audio.png'),
+  model: '/assets/24_3d.png',
 };
 
 const COLLECTION_ICONS: Readonly<Record<string, string>> = {
   browse: iconUrl('asset/24_Browse.png'),
   elements: iconUrl('asset/24_creative.png'),
   logo: iconUrl('asset/24_Brand.png'),
   arrow: iconUrl('asset/24_arrows.png'),
   effects: iconUrl('ui/effects-org_24x24.png'),
   icon: iconUrl('asset/24_Icons.png'),
   illustration: iconUrl('asset/24_illustrator.png'),
diff --git a/apps/editor-web/src/asset-resolver.ts b/apps/editor-web/src/asset-resolver.ts
index 664f677..b6cdf64 100644
--- a/apps/editor-web/src/asset-resolver.ts
+++ b/apps/editor-web/src/asset-resolver.ts
@@ -19,21 +19,21 @@ export interface AuthorizedOriginalRequest {
   readonly projectId: string;
   readonly assetId: string;
 }
 
 export interface AuthorizedOriginalTransport {
   fetch(request: AuthorizedOriginalRequest): Promise<Blob>;
 }
 
 export interface PlayableAssetDescriptor {
   readonly assetId: string;
-  readonly kind: 'video' | 'audio' | 'image';
+  readonly kind: 'video' | 'audio' | 'image' | 'model';
   readonly sha256: string;
   readonly byteLength: number;
   readonly mimeType: string;
 }
 
 export interface PlayableAssetDerivativeRequest extends PlayableDerivativeDescriptor {
   readonly kind: 'thumbnail' | 'proxy';
   readonly availability: 'pending' | 'available-local' | 'available-cloud' | 'evicted' | 'invalid';
 }
 
diff --git a/apps/editor-web/src/control-plane-client.ts b/apps/editor-web/src/control-plane-client.ts
index cf03d3a..3068ef6 100644
--- a/apps/editor-web/src/control-plane-client.ts
+++ b/apps/editor-web/src/control-plane-client.ts
@@ -84,21 +84,21 @@ export interface BrowserRenderReport {
   };
   readonly facts?: unknown;
   readonly checkedAt?: string;
   readonly promiseId?: string;
 }
 
 /** Owner-safe catalog metadata. Locations are deliberately not exposed to the editor UI. */
 export interface BrowserAsset {
   readonly id: string;
   readonly projectId: string;
-  readonly kind: 'video' | 'audio' | 'image';
+  readonly kind: 'video' | 'audio' | 'image' | 'model';
   readonly displayName: string;
   readonly sha256: string;
   readonly bytes: number;
   readonly descriptor: BrowserMediaDescriptor;
   readonly tags?: readonly string[];
   readonly sortName?: string;
   readonly createdAt: number;
 }
 
 export interface BrowserMediaDescriptor {
diff --git a/apps/editor-web/src/opfs-original-asset-cache.ts b/apps/editor-web/src/opfs-original-asset-cache.ts
index ec73c2c..7ca6b4a 100644
--- a/apps/editor-web/src/opfs-original-asset-cache.ts
+++ b/apps/editor-web/src/opfs-original-asset-cache.ts
@@ -113,21 +113,23 @@ export async function openOpfsOriginalAssetCache(): Promise<OpfsOriginalAssetCac
 }
 
 function validateDescriptor(descriptor: OriginalAssetDescriptor): void {
   if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(descriptor.assetId))
     throw new Error('asset ID must be opaque');
   if (!/^[a-f0-9]{64}$/.test(descriptor.sha256) || !Number.isSafeInteger(descriptor.bytes))
     throw new Error('selected asset integrity metadata is invalid');
   if (descriptor.bytes < 0) throw new Error('selected asset integrity metadata is invalid');
   if (
     !/^(video|audio|image)\/[a-z0-9.+-]+$/i.test(descriptor.mimeType) &&
-    descriptor.mimeType.toLowerCase() !== 'application/vnd.adobe.photoshop'
+    descriptor.mimeType.toLowerCase() !== 'application/vnd.adobe.photoshop' &&
+    descriptor.mimeType.toLowerCase() !== 'model/gltf-binary' &&
+    descriptor.mimeType.toLowerCase() !== 'model/gltf+json'
   )
     throw new Error('selected asset type is unsupported');
 }
 
 function validateContent(descriptor: OriginalAssetDescriptor, file: Blob): void {
   if (descriptor.bytes !== file.size)
     throw new Error('selected asset integrity metadata is invalid');
 }
 function hex(bytes: Uint8Array): string {
   return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
