# Review package: af1c185..4cdcfba

## Commits
4cdcfba fix(psd): bound flattening and clean up failed imports

## Files changed
 apps/editor-web/src/PsdImportDialog.tsx          |  11 ++-
 apps/editor-web/src/opfs-original-asset-cache.ts |  11 +++
 apps/editor-web/src/psd-import.test.ts           |  27 ++++++
 apps/editor-web/src/psd-import.ts                | 109 ++++++++++++++++++-----
 4 files changed, 133 insertions(+), 25 deletions(-)

## Diff
diff --git a/apps/editor-web/src/PsdImportDialog.tsx b/apps/editor-web/src/PsdImportDialog.tsx
index 5c8a048..644d310 100644
--- a/apps/editor-web/src/PsdImportDialog.tsx
+++ b/apps/editor-web/src/PsdImportDialog.tsx
@@ -79,21 +79,26 @@ export function PsdImportDialog({
         parsed,
         selectedLayerIds,
       });
       const nextDocument = buildPsdDocumentSnapshot(
         session.visualProject,
         parsed,
         mappings,
         assets,
         parsed.sha256.slice(0, 12),
       );
-      session.dispatchCompound(`Import PSD ${file.name}`, { document: nextDocument });
+      try {
+        session.dispatchCompound(`Import PSD ${file.name}`, { document: nextDocument });
+      } catch (error) {
+        await assets.cleanup?.();
+        throw error;
+      }
       showToast('PSD imported into the document', 'success');
       onClose();
     } catch (error) {
       const message = error instanceof Error ? error.message : String(error);
       setStatus(`PSD import failed: ${message}`);
       showToast('PSD import failed', 'error');
     } finally {
       setBusy(false);
     }
   };
@@ -106,20 +111,24 @@ export function PsdImportDialog({
             type="file"
             accept=".psd,image/vnd.adobe.photoshop"
             aria-label="Choose PSD file"
             disabled={busy}
             onChange={(event) => setFile(event.currentTarget.files?.[0])}
           />
           <button type="button" onClick={onClose} disabled={busy}>
             Close
           </button>
         </div>
+        <p className="psd-import-subhint">
+          Smart-object editing, complete layer-style/text fidelity, and PSD round-trip export are
+          not supported. Import is bounded to safe image, text, and flattened-group payloads.
+        </p>
         {status !== undefined && (
           <p role={parsed === undefined && file !== undefined && !busy ? 'alert' : 'status'}>
             {status}
           </p>
         )}
         {parsed !== undefined && (
           <>
             {parsed.warnings.length > 0 && (
               <ul className="psd-import-warnings" aria-label="PSD fidelity warnings">
                 {parsed.warnings.map((warning) => (
diff --git a/apps/editor-web/src/opfs-original-asset-cache.ts b/apps/editor-web/src/opfs-original-asset-cache.ts
index dc31aba..ec73c2c 100644
--- a/apps/editor-web/src/opfs-original-asset-cache.ts
+++ b/apps/editor-web/src/opfs-original-asset-cache.ts
@@ -54,20 +54,31 @@ export class OpfsOriginalAssetCache {
     if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assetId)) return undefined;
     try {
       const directory = await this.root.getDirectoryHandle('joy-media-assets', { create: false });
       const handle = await directory.getFileHandle(`${assetId}.bin`, { create: false });
       return await handle.getFile();
     } catch {
       return undefined;
     }
   }
 
+  /** Removes a locally cached original after a failed multi-step import. */
+  async remove(assetId: string): Promise<void> {
+    if (this.root === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assetId)) return;
+    try {
+      const directory = await this.root.getDirectoryHandle('joy-media-assets', { create: false });
+      await directory.removeEntry(`${assetId}.bin`);
+    } catch {
+      // Cleanup is best effort; the authoritative catalog delete below still runs.
+    }
+  }
+
   async resolve(descriptor: OriginalAssetDescriptor): Promise<OriginalAssetCacheResult> {
     validateDescriptor(descriptor);
     if (this.root === undefined) return { state: 'unsupported' };
     try {
       const directory = await this.root.getDirectoryHandle('joy-media-assets', { create: false });
       const handle = await directory.getFileHandle(`${descriptor.assetId}.bin`, { create: false });
       const file = await handle.getFile();
       const localBlob = new Blob([file], { type: descriptor.mimeType });
       try {
         await verify(descriptor, localBlob, this.digest);
diff --git a/apps/editor-web/src/psd-import.test.ts b/apps/editor-web/src/psd-import.test.ts
index a26fe63..834ad77 100644
--- a/apps/editor-web/src/psd-import.test.ts
+++ b/apps/editor-web/src/psd-import.test.ts
@@ -1,20 +1,22 @@
 import { describe, expect, it } from 'vitest';
 import {
   PsdImportError,
   buildPsdDocumentSnapshot,
   parsePsdFile,
   registerPsdAssets,
   type PsdParseResult,
 } from './psd-import.js';
 import type { BrowserAssetRegistration } from './control-plane-client.js';
 import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
+import { EditorSession } from './editor-session.js';
+import { emptySpikeProject } from '@joy-media/test-fixtures';
 
 const parsed: PsdParseResult = {
   width: 1200,
   height: 800,
   bytes: 10,
   sha256: 'a'.repeat(64),
   parseTimeMs: 1,
   sourceName: 'نمونه.psd',
   sourceMimeType: 'image/vnd.adobe.photoshop',
   warnings: [
@@ -95,11 +97,36 @@ describe('bounded PSD import', () => {
   });
 
   it('rejects malformed and oversized PSD inputs with typed user-safe errors', async () => {
     await expect(parsePsdFile(new Blob(['not-a-psd']), { maxBytes: 2 })).rejects.toMatchObject({
       code: 'too-large',
     } satisfies Partial<PsdImportError>);
     await expect(parsePsdFile(new Blob(['not-a-psd']))).rejects.toMatchObject({
       code: 'invalid-psd',
     } satisfies Partial<PsdImportError>);
   });
+
+  it('applies through the compound document boundary and survives undo/redo/reopen', () => {
+    const values = new Map<string, string>();
+    const storage = {
+      getItem: (key: string) => values.get(key) ?? null,
+      setItem: (key: string, value: string) => values.set(key, value),
+    };
+    const session = new EditorSession(storage, emptySpikeProject(), INITIAL_EDITOR_PROJECT);
+    const next = buildPsdDocumentSnapshot(
+      session.visualProject,
+      parsed,
+      { hero: 'image-object', headline: 'text-object' },
+      { sourceAssetId: 'psd-source', layerAssetIds: { hero: 'psd-hero' } },
+      'journey',
+    );
+    session.dispatchCompound('Import PSD sample', { document: next });
+    expect(session.historyEntries.at(-1)?.source).toBe('visual-object');
+    expect(session.visualProject.visualObjects['psd-journey-hero']).toBeDefined();
+    session.undo();
+    expect(session.visualProject.visualObjects['psd-journey-hero']).toBeUndefined();
+    session.redo();
+    expect(session.visualProject.visualObjects['psd-journey-hero']).toBeDefined();
+    const reopened = new EditorSession(storage, emptySpikeProject(), INITIAL_EDITOR_PROJECT);
+    expect(reopened.visualProject.visualObjects['psd-journey-hero']).toBeDefined();
+  });
 });
diff --git a/apps/editor-web/src/psd-import.ts b/apps/editor-web/src/psd-import.ts
index 7295751..9fbe995 100644
--- a/apps/editor-web/src/psd-import.ts
+++ b/apps/editor-web/src/psd-import.ts
@@ -21,21 +21,25 @@ export interface PsdLayerDto {
     readonly height: number;
   };
   readonly opacity: number;
   readonly visible: boolean;
   readonly type: PsdLayerType;
   readonly text?: string;
   readonly rasterBlob?: Blob;
 }
 
 export interface PsdWarning {
-  readonly code: 'adjustment-unsupported' | 'smart-object-unsupported' | 'unknown-layer';
+  readonly code:
+    | 'adjustment-unsupported'
+    | 'smart-object-unsupported'
+    | 'unknown-layer'
+    | 'group-flatten-unavailable';
   readonly layerId: string;
   readonly message: string;
 }
 
 export interface PsdParseResult {
   readonly layers: readonly PsdLayerDto[];
   readonly warnings: readonly PsdWarning[];
   readonly width: number;
   readonly height: number;
   readonly bytes: number;
@@ -85,22 +89,31 @@ const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
 const DEFAULT_MEMORY_BUDGET = 256 * 1024 * 1024;
 
 export async function parsePsdFile(
   file: File | Blob,
   options: {
     readonly maxPixels?: number;
     readonly maxBytes?: number;
     readonly memoryBudgetBytes?: number;
   } = {},
 ): Promise<PsdParseResult> {
-  const bytes = await file.arrayBuffer();
   const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
+  if (file.size > maxBytes) {
+    throw new PsdImportError(
+      'too-large',
+      `PSD file is ${(file.size / (1024 * 1024)).toFixed(1)} MB; the limit is ${(
+        maxBytes /
+        (1024 * 1024)
+      ).toFixed(0)} MB.`,
+    );
+  }
+  const bytes = await file.arrayBuffer();
   if (bytes.byteLength > maxBytes) {
     throw new PsdImportError(
       'too-large',
       `PSD file is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB; the limit is ${(
         maxBytes /
         (1024 * 1024)
       ).toFixed(0)} MB.`,
     );
   }
   const sha256 = await sha256Hex(bytes);
@@ -136,27 +149,30 @@ export async function parsePsdFile(
       `PSD raster memory exceeds the ${Math.round(memoryBudgetBytes / (1024 * 1024))} MB budget.`,
     );
   }
 
   let parsed: AgPsdDocument;
   try {
     parsed = readPsd(bytes, {
       skipCompositeImageData: true,
       skipThumbnail: true,
       useImageData: true,
+      totalMemoryLimit: memoryBudgetBytes,
       logMissingFeatures: false,
     }) as unknown as AgPsdDocument;
   } catch (error) {
     throw new PsdImportError('invalid-psd', `Unable to decode PSD layers: ${message(error)}`);
   }
   const layers: PsdLayerDto[] = [];
   const warnings: PsdWarning[] = [];
+  let decodedLayerPixels = 0;
+  const maxLayerPixels = Math.floor(memoryBudgetBytes / 4);
   const flatten = async (children: readonly AgPsdLayer[] | undefined): Promise<void> => {
     if (children === undefined) return;
     for (const layer of children) {
       const index = layers.length;
       const id = String(layer.id ?? `layer-${index + 1}`);
       const type = classifyLayer(layer);
       const left = layer.left ?? 0;
       const top = layer.top ?? 0;
       const right = layer.right ?? left;
       const bottom = layer.bottom ?? top;
@@ -167,21 +183,28 @@ export async function parsePsdFile(
           x: clamp(left, 0, width),
           y: clamp(top, 0, height),
           width: clamp(right - left, 0, width),
           height: clamp(bottom - top, 0, height),
         },
         opacity: clamp((layer.opacity ?? 255) / 255, 0, 1),
         visible: layer.hidden !== true,
         type,
         ...(type === 'text' && layer.text?.text !== undefined ? { text: layer.text.text } : {}),
       };
-      if (type === 'raster') {
+      decodedLayerPixels += Math.ceil(dto.bounds.width) * Math.ceil(dto.bounds.height);
+      if (decodedLayerPixels > maxLayerPixels) {
+        throw new PsdImportError(
+          'memory-budget',
+          'PSD layer rasters exceed the bounded decoded-pixel budget.',
+        );
+      }
+      if (type === 'raster' || type === 'group') {
         const rasterBlob = rasterBlobFromLayer(layer);
         if (rasterBlob !== undefined) {
           const blob = await rasterBlob;
           if (blob !== undefined) (dto as { rasterBlob?: Blob }).rasterBlob = blob;
         }
       }
       layers.push(dto);
       if (type === 'adjustment') {
         warnings.push({
           code: 'adjustment-unsupported',
@@ -194,76 +217,116 @@ export async function parsePsdFile(
           layerId: id,
           message: `Smart Object “${dto.name}” is opaque; source editing is not supported.`,
         });
       } else if (type === 'unknown') {
         warnings.push({
           code: 'unknown-layer',
           layerId: id,
           message: `Layer “${dto.name}” has no supported payload and will default to ignore.`,
         });
       }
+      if (type === 'group' && layer.canvas === undefined && layer.imageData === undefined) {
+        warnings.push({
+          code: 'group-flatten-unavailable',
+          layerId: id,
+          message: `Group “${dto.name}” has no composite raster; choose ignore unless a flatten asset is available.`,
+        });
+      }
       await flatten(layer.children);
     }
   };
   await flatten(parsed.children);
   const sourceName = typeof File !== 'undefined' && file instanceof File ? file.name : undefined;
   return {
     layers,
     warnings,
     width,
     height,
     bytes: bytes.byteLength,
     sha256,
     parseTimeMs: performance.now() - started,
     ...(sourceName !== undefined ? { sourceName } : {}),
-    sourceMimeType: file.type || 'image/vnd.adobe.photoshop',
+    sourceMimeType: 'image/vnd.adobe.photoshop',
   };
 }
 
 export type PsdLayerMapping = 'image-object' | 'text-object' | 'flatten-group' | 'ignore';
 
 export interface PsdAssetRefs {
   readonly sourceAssetId: string;
   readonly layerAssetIds: Readonly<Record<string, string>>;
+  readonly cleanup?: () => Promise<void>;
 }
 
 export interface PsdAssetRegistrationOptions {
-  readonly client: Pick<BrowserControlPlaneClient, 'registerAsset'>;
+  readonly client: Pick<BrowserControlPlaneClient, 'registerAsset'> &
+    Partial<Pick<BrowserControlPlaneClient, 'deleteAsset'>>;
   readonly projectId: string;
-  readonly cache: Pick<OpfsOriginalAssetCache, 'put'>;
+  readonly cache: Pick<OpfsOriginalAssetCache, 'put'> &
+    Partial<Pick<OpfsOriginalAssetCache, 'remove'>>;
   readonly file: File | Blob;
   readonly parsed: PsdParseResult;
   readonly selectedLayerIds: readonly string[];
 }
 
 export async function registerPsdAssets(
   options: PsdAssetRegistrationOptions,
 ): Promise<PsdAssetRefs> {
   const sourceAssetId = opaqueId(`psd-${options.parsed.sha256.slice(0, 24)}`);
-  await registerBlob(
-    options,
-    sourceAssetId,
-    options.file,
-    options.parsed.sourceMimeType,
-    'PSD source',
-  );
+  const registeredIds: string[] = [];
+  const register = async (
+    assetId: string,
+    blob: Blob,
+    mimeType: string,
+    displayName: string,
+  ): Promise<void> => {
+    await registerBlob(options, assetId, blob, mimeType, displayName);
+    registeredIds.push(assetId);
+  };
+  const cleanup = async (): Promise<void> => {
+    for (const assetId of [...registeredIds].reverse()) {
+      await options.cache.remove?.(assetId);
+      const deletion = options.client.deleteAsset?.(options.projectId, assetId);
+      await deletion?.catch(() => undefined);
+    }
+  };
+  try {
+    await register(sourceAssetId, options.file, 'image/vnd.adobe.photoshop', 'PSD source');
+  } catch (error) {
+    await cleanup();
+    throw error;
+  }
   const layerAssetIds: Record<string, string> = {};
   const selected = new Set(options.selectedLayerIds);
-  for (const layer of options.parsed.layers) {
-    if (!selected.has(layer.id) || layer.rasterBlob === undefined) continue;
-    const blob = layer.rasterBlob;
-    const hash = await sha256Hex(await blob.arrayBuffer());
-    const assetId = opaqueId(`psd-${options.parsed.sha256.slice(0, 12)}-${hash.slice(0, 12)}`);
-    await registerBlob(options, assetId, blob, 'image/png', `PSD layer ${layer.name}`);
-    layerAssetIds[layer.id] = assetId;
+  try {
+    for (const layer of options.parsed.layers) {
+      if (!selected.has(layer.id) || layer.rasterBlob === undefined) continue;
+      const blob = layer.rasterBlob;
+      const hash = await sha256Hex(await blob.arrayBuffer());
+      const assetId = opaqueId(`psd-${options.parsed.sha256.slice(0, 12)}-${hash.slice(0, 12)}`);
+      const registeredAssetId = registerAssetId(assetId, registeredIds);
+      await register(registeredAssetId, blob, 'image/png', `PSD layer ${layer.name}`);
+      layerAssetIds[layer.id] = registeredAssetId;
+    }
+  } catch (error) {
+    await cleanup();
+    throw error;
+  }
+  return { sourceAssetId, layerAssetIds, cleanup };
+}
+
+function registerAssetId(assetId: string, registeredIds: readonly string[]): string {
+  if (!registeredIds.includes(assetId)) return assetId;
+  for (let suffix = 2; ; suffix += 1) {
+    const candidate = `${assetId}-${suffix}`;
+    if (!registeredIds.includes(candidate)) return candidate;
   }
-  return { sourceAssetId, layerAssetIds };
 }
 
 export function buildPsdDocumentSnapshot(
   project: JoyProjectV1,
   parsed: PsdParseResult,
   mappings: Readonly<Record<string, PsdLayerMapping>>,
   assets: PsdAssetRefs,
   seed: string,
 ): JoyProjectV1 {
   let next = {
@@ -275,23 +338,21 @@ export function buildPsdDocumentSnapshot(
         kind: 'image' as const,
         displayName: parsed.sourceName ?? 'PSD source',
       },
     },
     visualObjects: { ...project.visualObjects },
   };
   const usedIds = new Set(Object.keys(next.visualObjects));
   for (const layer of parsed.layers) {
     const mapping = mappings[layer.id] ?? 'ignore';
     if (mapping === 'ignore' || !layer.visible) continue;
-    const assetId =
-      assets.layerAssetIds[layer.id] ??
-      (mapping === 'flatten-group' ? assets.sourceAssetId : undefined);
+    const assetId = assets.layerAssetIds[layer.id];
     if (mapping === 'image-object' && assetId === undefined) continue;
     if (mapping === 'flatten-group' && assetId === undefined) continue;
     if (mapping === 'text-object' && (layer.text ?? '').length === 0) continue;
     const baseId = `psd-${seed}-${layer.id}`;
     let objectId = baseId;
     for (let suffix = 2; usedIds.has(objectId); suffix += 1) objectId = `${baseId}-${suffix}`;
     usedIds.add(objectId);
     const transform = {
       x: layer.bounds.x,
       y: layer.bounds.y,
