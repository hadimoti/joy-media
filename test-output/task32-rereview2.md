# Review package: 4cdcfba..32203d0

## Commits
32203d0 fix(psd): preserve typed failures and cleanup scope

## Files changed
 apps/editor-web/src/PsdImportDialog.tsx | 14 +++++++-------
 apps/editor-web/src/psd-import.test.ts  | 25 +++++++++++++++++++++++++
 apps/editor-web/src/psd-import.ts       | 12 ++++++++++--
 3 files changed, 42 insertions(+), 9 deletions(-)

## Diff
diff --git a/apps/editor-web/src/PsdImportDialog.tsx b/apps/editor-web/src/PsdImportDialog.tsx
index 644d310..c747f2d 100644
--- a/apps/editor-web/src/PsdImportDialog.tsx
+++ b/apps/editor-web/src/PsdImportDialog.tsx
@@ -72,28 +72,28 @@ export function PsdImportDialog({
         .filter((layer) => mappings[layer.id] !== 'ignore')
         .map((layer) => layer.id);
       const assets = await registerPsdAssets({
         client,
         projectId,
         cache,
         file,
         parsed,
         selectedLayerIds,
       });
-      const nextDocument = buildPsdDocumentSnapshot(
-        session.visualProject,
-        parsed,
-        mappings,
-        assets,
-        parsed.sha256.slice(0, 12),
-      );
       try {
+        const nextDocument = buildPsdDocumentSnapshot(
+          session.visualProject,
+          parsed,
+          mappings,
+          assets,
+          parsed.sha256.slice(0, 12),
+        );
         session.dispatchCompound(`Import PSD ${file.name}`, { document: nextDocument });
       } catch (error) {
         await assets.cleanup?.();
         throw error;
       }
       showToast('PSD imported into the document', 'success');
       onClose();
     } catch (error) {
       const message = error instanceof Error ? error.message : String(error);
       setStatus(`PSD import failed: ${message}`);
diff --git a/apps/editor-web/src/psd-import.test.ts b/apps/editor-web/src/psd-import.test.ts
index 834ad77..717c45c 100644
--- a/apps/editor-web/src/psd-import.test.ts
+++ b/apps/editor-web/src/psd-import.test.ts
@@ -85,24 +85,49 @@ describe('bounded PSD import', () => {
           cached.push(`${descriptor.assetId}:${descriptor.sha256}:${descriptor.bytes}`);
         },
       },
       file,
       parsed: { ...parsed, layers: [{ ...parsed.layers[0]!, rasterBlob: raster }] },
       selectedLayerIds: ['hero'],
     });
     expect(result.sourceAssetId).toMatch(/^psd-/);
     expect(result.layerAssetIds.hero).toMatch(/^psd-/);
     expect(registrations).toHaveLength(2);
+    expect(registrations[0]?.descriptor.mimeType).toBe('image/vnd.adobe.photoshop');
     expect(registrations.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
     expect(cached.every((entry) => entry.split(':')[1]?.length === 64)).toBe(true);
   });
 
+  it('cleans the in-flight OPFS original when catalog registration fails', async () => {
+    const removed: string[] = [];
+    await expect(
+      registerPsdAssets({
+        client: {
+          registerAsset: async () => {
+            throw new Error('catalog unavailable');
+          },
+        },
+        projectId: 'project-1',
+        cache: {
+          put: async () => undefined,
+          remove: async (assetId) => {
+            removed.push(assetId);
+          },
+        },
+        file: new Blob(['source'], { type: 'application/octet-stream' }),
+        parsed,
+        selectedLayerIds: [],
+      }),
+    ).rejects.toThrow('catalog unavailable');
+    expect(removed).toHaveLength(1);
+  });
+
   it('rejects malformed and oversized PSD inputs with typed user-safe errors', async () => {
     await expect(parsePsdFile(new Blob(['not-a-psd']), { maxBytes: 2 })).rejects.toMatchObject({
       code: 'too-large',
     } satisfies Partial<PsdImportError>);
     await expect(parsePsdFile(new Blob(['not-a-psd']))).rejects.toMatchObject({
       code: 'invalid-psd',
     } satisfies Partial<PsdImportError>);
   });
 
   it('applies through the compound document boundary and survives undo/redo/reopen', () => {
diff --git a/apps/editor-web/src/psd-import.ts b/apps/editor-web/src/psd-import.ts
index 9fbe995..782b074 100644
--- a/apps/editor-web/src/psd-import.ts
+++ b/apps/editor-web/src/psd-import.ts
@@ -153,21 +153,25 @@ export async function parsePsdFile(
   let parsed: AgPsdDocument;
   try {
     parsed = readPsd(bytes, {
       skipCompositeImageData: true,
       skipThumbnail: true,
       useImageData: true,
       totalMemoryLimit: memoryBudgetBytes,
       logMissingFeatures: false,
     }) as unknown as AgPsdDocument;
   } catch (error) {
-    throw new PsdImportError('invalid-psd', `Unable to decode PSD layers: ${message(error)}`);
+    const detail = message(error);
+    throw new PsdImportError(
+      /memory|limit|allocation/i.test(detail) ? 'memory-budget' : 'invalid-psd',
+      `Unable to decode PSD layers: ${detail}`,
+    );
   }
   const layers: PsdLayerDto[] = [];
   const warnings: PsdWarning[] = [];
   let decodedLayerPixels = 0;
   const maxLayerPixels = Math.floor(memoryBudgetBytes / 4);
   const flatten = async (children: readonly AgPsdLayer[] | undefined): Promise<void> => {
     if (children === undefined) return;
     for (const layer of children) {
       const index = layers.length;
       const id = String(layer.id ?? `layer-${index + 1}`);
@@ -272,22 +276,26 @@ export async function registerPsdAssets(
   options: PsdAssetRegistrationOptions,
 ): Promise<PsdAssetRefs> {
   const sourceAssetId = opaqueId(`psd-${options.parsed.sha256.slice(0, 24)}`);
   const registeredIds: string[] = [];
   const register = async (
     assetId: string,
     blob: Blob,
     mimeType: string,
     displayName: string,
   ): Promise<void> => {
-    await registerBlob(options, assetId, blob, mimeType, displayName);
     registeredIds.push(assetId);
+    try {
+      await registerBlob(options, assetId, blob, mimeType, displayName);
+    } catch (error) {
+      throw error;
+    }
   };
   const cleanup = async (): Promise<void> => {
     for (const assetId of [...registeredIds].reverse()) {
       await options.cache.remove?.(assetId);
       const deletion = options.client.deleteAsset?.(options.projectId, assetId);
       await deletion?.catch(() => undefined);
     }
   };
   try {
     await register(sourceAssetId, options.file, 'image/vnd.adobe.photoshop', 'PSD source');
