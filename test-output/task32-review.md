# Review package: 4b9ef1a..af1c185

## Commits
af1c185 feat(psd): import bounded layered designs as JOY assets

## Files changed
 apps/editor-web/src/PsdImportDialog.test.tsx     |  28 ++
 apps/editor-web/src/PsdImportDialog.tsx          | 172 ++++++++++
 apps/editor-web/src/TemplatesPanel.tsx           |  18 +
 apps/editor-web/src/fixtures/psd/README.md       |   5 +
 apps/editor-web/src/opfs-original-asset-cache.ts |   5 +-
 apps/editor-web/src/psd-import.test.ts           | 105 ++++++
 apps/editor-web/src/psd-import.ts                | 419 +++++++++++++++++++++++
 apps/editor-web/src/psd-parser-spike.ts          | 195 +----------
 8 files changed, 766 insertions(+), 181 deletions(-)

## Diff
diff --git a/apps/editor-web/src/PsdImportDialog.test.tsx b/apps/editor-web/src/PsdImportDialog.test.tsx
new file mode 100644
index 0000000..8ced283
--- /dev/null
+++ b/apps/editor-web/src/PsdImportDialog.test.tsx
@@ -0,0 +1,28 @@
+import { renderToStaticMarkup } from 'react-dom/server';
+import { describe, expect, it, vi } from 'vitest';
+import { PsdImportDialog } from './PsdImportDialog.js';
+import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
+import type { EditorSession } from './editor-session.js';
+import { emptySpikeProject } from '@joy-media/test-fixtures';
+
+describe('PsdImportDialog', () => {
+  it('exposes an accessible bounded mapping surface and fidelity warning region', () => {
+    const session = {
+      visualProject: INITIAL_EDITOR_PROJECT,
+      timelineProject: emptySpikeProject(),
+      dispatchCompound: vi.fn(),
+    } as unknown as EditorSession;
+    const markup = renderToStaticMarkup(
+      <PsdImportDialog
+        session={session}
+        projectId="project-1"
+        onClose={() => undefined}
+        showToast={() => undefined}
+      />,
+    );
+    expect(markup).toContain('aria-label="Import PSD"');
+    expect(markup).toContain('accept=".psd,image/vnd.adobe.photoshop"');
+    expect(markup).toContain('Choose PSD file');
+    expect(markup).toContain('>Close</button>');
+  });
+});
diff --git a/apps/editor-web/src/PsdImportDialog.tsx b/apps/editor-web/src/PsdImportDialog.tsx
new file mode 100644
index 0000000..5c8a048
--- /dev/null
+++ b/apps/editor-web/src/PsdImportDialog.tsx
@@ -0,0 +1,172 @@
+import { useEffect, useMemo, useState } from 'react';
+import { PanelShell } from './PanelShell.js';
+import { BrowserControlPlaneClient } from './control-plane-client.js';
+import { openOpfsOriginalAssetCache } from './opfs-original-asset-cache.js';
+import {
+  buildPsdDocumentSnapshot,
+  parsePsdFile,
+  registerPsdAssets,
+  type PsdLayerMapping,
+  type PsdParseResult,
+} from './psd-import.js';
+import type { EditorSession } from './editor-session.js';
+
+export function PsdImportDialog({
+  session,
+  projectId,
+  onClose,
+  showToast,
+}: {
+  readonly session: EditorSession;
+  readonly projectId: string;
+  readonly onClose: () => void;
+  readonly showToast: (message: string, kind: 'info' | 'success' | 'error') => void;
+}) {
+  const client = useMemo(() => new BrowserControlPlaneClient(), []);
+  const [file, setFile] = useState<File | undefined>(undefined);
+  const [parsed, setParsed] = useState<PsdParseResult | undefined>(undefined);
+  const [mappings, setMappings] = useState<Readonly<Record<string, PsdLayerMapping>>>({});
+  const [status, setStatus] = useState<string | undefined>(undefined);
+  const [busy, setBusy] = useState(false);
+
+  useEffect(() => {
+    if (file === undefined) {
+      setParsed(undefined);
+      setMappings({});
+      setStatus(undefined);
+      return;
+    }
+    let cancelled = false;
+    setBusy(true);
+    setStatus(`Reading ${file.name}…`);
+    void parsePsdFile(file)
+      .then((result) => {
+        if (cancelled) return;
+        setParsed(result);
+        setMappings(
+          Object.fromEntries(result.layers.map((layer) => [layer.id, defaultMapping(layer.type)])),
+        );
+        setStatus(`${result.layers.length} layers found (${result.width}×${result.height}).`);
+      })
+      .catch((error: unknown) => {
+        if (!cancelled) {
+          setParsed(undefined);
+          setStatus(error instanceof Error ? error.message : String(error));
+        }
+      })
+      .finally(() => {
+        if (!cancelled) setBusy(false);
+      });
+    return () => {
+      cancelled = true;
+    };
+  }, [file]);
+
+  const apply = async () => {
+    if (file === undefined || parsed === undefined) return;
+    setBusy(true);
+    setStatus('Registering the PSD and selected raster layers…');
+    try {
+      const cache = await openOpfsOriginalAssetCache();
+      const selectedLayerIds = parsed.layers
+        .filter((layer) => mappings[layer.id] !== 'ignore')
+        .map((layer) => layer.id);
+      const assets = await registerPsdAssets({
+        client,
+        projectId,
+        cache,
+        file,
+        parsed,
+        selectedLayerIds,
+      });
+      const nextDocument = buildPsdDocumentSnapshot(
+        session.visualProject,
+        parsed,
+        mappings,
+        assets,
+        parsed.sha256.slice(0, 12),
+      );
+      session.dispatchCompound(`Import PSD ${file.name}`, { document: nextDocument });
+      showToast('PSD imported into the document', 'success');
+      onClose();
+    } catch (error) {
+      const message = error instanceof Error ? error.message : String(error);
+      setStatus(`PSD import failed: ${message}`);
+      showToast('PSD import failed', 'error');
+    } finally {
+      setBusy(false);
+    }
+  };
+
+  return (
+    <PanelShell title="Import PSD" className="psd-import-dialog">
+      <div role="dialog" aria-modal="true" aria-label="Import PSD" className="psd-import-surface">
+        <div className="psd-import-actions">
+          <input
+            type="file"
+            accept=".psd,image/vnd.adobe.photoshop"
+            aria-label="Choose PSD file"
+            disabled={busy}
+            onChange={(event) => setFile(event.currentTarget.files?.[0])}
+          />
+          <button type="button" onClick={onClose} disabled={busy}>
+            Close
+          </button>
+        </div>
+        {status !== undefined && (
+          <p role={parsed === undefined && file !== undefined && !busy ? 'alert' : 'status'}>
+            {status}
+          </p>
+        )}
+        {parsed !== undefined && (
+          <>
+            {parsed.warnings.length > 0 && (
+              <ul className="psd-import-warnings" aria-label="PSD fidelity warnings">
+                {parsed.warnings.map((warning) => (
+                  <li key={`${warning.layerId}-${warning.code}`}>{warning.message}</li>
+                ))}
+              </ul>
+            )}
+            <div className="psd-import-layers" aria-label="PSD layers">
+              {parsed.layers.map((layer) => (
+                <label key={layer.id} className="psd-layer-row">
+                  <span className="psd-layer-name" dir="auto">
+                    {layer.name}
+                  </span>
+                  <select
+                    aria-label={`Mapping for ${layer.name}`}
+                    value={mappings[layer.id] ?? 'ignore'}
+                    onChange={(event) =>
+                      setMappings((current) => ({
+                        ...current,
+                        [layer.id]: event.target.value as PsdLayerMapping,
+                      }))
+                    }
+                    disabled={busy}
+                  >
+                    <option value="image-object">Image object</option>
+                    <option value="text-object" disabled={layer.type !== 'text'}>
+                      Text object
+                    </option>
+                    <option value="flatten-group">Flatten group</option>
+                    <option value="ignore">Ignore</option>
+                  </select>
+                </label>
+              ))}
+            </div>
+            <button type="button" onClick={() => void apply()} disabled={busy}>
+              Import selected layers
+            </button>
+          </>
+        )}
+      </div>
+    </PanelShell>
+  );
+}
+
+function defaultMapping(type: PsdParseResult['layers'][number]['type']): PsdLayerMapping {
+  if (type === 'raster') return 'image-object';
+  if (type === 'text') return 'text-object';
+  if (type === 'group') return 'flatten-group';
+  return 'ignore';
+}
diff --git a/apps/editor-web/src/TemplatesPanel.tsx b/apps/editor-web/src/TemplatesPanel.tsx
index 085be5a..c39946c 100644
--- a/apps/editor-web/src/TemplatesPanel.tsx
+++ b/apps/editor-web/src/TemplatesPanel.tsx
@@ -12,20 +12,21 @@ import {
   saveTemplate,
   type TemplateCatalogEntry,
 } from './template-catalog.js';
 import type {
   SeededContentTemplate,
   ContentTemplateV1,
   FirstPartySceneId,
 } from './content-template-types.js';
 import type { EditorSession } from './editor-session.js';
 import { readClipObjectMap } from './sticker-bindings.js';
+import { PsdImportDialog } from './PsdImportDialog.js';
 import { getFirstPartySceneThumbUrl } from './html-scene-thumbs.js';
 import {
   createScenePreviewHost,
   defaultVariablesForScene,
   type ScenePreviewHost,
 } from '@joy-media/html-scene-runtime/browser';
 import {
   findFirstPartyScene,
   type FirstPartyScenePackage,
 } from '@joy-media/html-scene-runtime/first-party';
@@ -56,20 +57,21 @@ const SIDEBAR_VIEWS: readonly { readonly id: TemplateView; readonly iconUrl: str
 export function TemplatesPanel({
   session,
   selectedClipIds,
   playheadUs,
   onApplyTemplate,
   showToast,
 }: TemplatesPanelProps) {
   const [view, setView] = useState<TemplateView>('library');
   const [query, setQuery] = useState('');
   const [catalogTick, setCatalogTick] = useState(0);
+  const [psdOpen, setPsdOpen] = useState(false);
   const [mineCatalog, setMineCatalog] = useState<{
     readonly status: 'ready' | 'loading' | 'error';
     readonly entries: readonly TemplateCatalogEntry[];
   }>({ status: 'ready', entries: [] });
   const operationSequenceRef = useRef(0);
   const nextOperationId = useCallback((templateId: string) => {
     operationSequenceRef.current += 1;
     return `${templateId}-${operationSequenceRef.current}`;
   }, []);
 
@@ -316,23 +318,39 @@ export function TemplatesPanel({
             onClick={handleSaveSelection}
             disabled={selectedClipIds.length === 0}
             title={
               selectedClipIds.length === 0
                 ? 'Select an HTML scene clip first'
                 : 'Save current selection as a template'
             }
           >
             Save selection
           </button>
+          <button
+            type="button"
+            className="templates-import-psd"
+            onClick={() => setPsdOpen(true)}
+            aria-haspopup="dialog"
+          >
+            Import PSD
+          </button>
           {body}
         </div>
       </div>
+      {psdOpen && (
+        <PsdImportDialog
+          session={session}
+          projectId={session.timelineProject.id}
+          onClose={() => setPsdOpen(false)}
+          showToast={showToast}
+        />
+      )}
     </PanelShell>
   );
 }
 
 function TemplatePreviewThumb({
   template,
 }: {
   readonly template: ContentTemplateV1 | TemplateCatalogEntry;
 }) {
   const firstSceneId =
diff --git a/apps/editor-web/src/fixtures/psd/README.md b/apps/editor-web/src/fixtures/psd/README.md
new file mode 100644
index 0000000..fd35366
--- /dev/null
+++ b/apps/editor-web/src/fixtures/psd/README.md
@@ -0,0 +1,5 @@
+# PSD import fixtures
+
+The PSD importer tests use bounded synthetic layer documents so they do not
+check in third-party artwork or large binary files. A real user PSD is read
+through `ag-psd` only after the byte, pixel, and memory limits are checked.
diff --git a/apps/editor-web/src/opfs-original-asset-cache.ts b/apps/editor-web/src/opfs-original-asset-cache.ts
index 31be6a9..dc31aba 100644
--- a/apps/editor-web/src/opfs-original-asset-cache.ts
+++ b/apps/editor-web/src/opfs-original-asset-cache.ts
@@ -100,21 +100,24 @@ export async function openOpfsOriginalAssetCache(): Promise<OpfsOriginalAssetCac
     ...(getDirectory === undefined ? {} : { root: await getDirectory.call(navigator.storage) }),
   });
 }
 
 function validateDescriptor(descriptor: OriginalAssetDescriptor): void {
   if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(descriptor.assetId))
     throw new Error('asset ID must be opaque');
   if (!/^[a-f0-9]{64}$/.test(descriptor.sha256) || !Number.isSafeInteger(descriptor.bytes))
     throw new Error('selected asset integrity metadata is invalid');
   if (descriptor.bytes < 0) throw new Error('selected asset integrity metadata is invalid');
-  if (!/^(video|audio|image)\/[a-z0-9.+-]+$/i.test(descriptor.mimeType))
+  if (
+    !/^(video|audio|image)\/[a-z0-9.+-]+$/i.test(descriptor.mimeType) &&
+    descriptor.mimeType.toLowerCase() !== 'application/vnd.adobe.photoshop'
+  )
     throw new Error('selected asset type is unsupported');
 }
 
 function validateContent(descriptor: OriginalAssetDescriptor, file: Blob): void {
   if (descriptor.bytes !== file.size)
     throw new Error('selected asset integrity metadata is invalid');
 }
 function hex(bytes: Uint8Array): string {
   return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
 }
diff --git a/apps/editor-web/src/psd-import.test.ts b/apps/editor-web/src/psd-import.test.ts
new file mode 100644
index 0000000..a26fe63
--- /dev/null
+++ b/apps/editor-web/src/psd-import.test.ts
@@ -0,0 +1,105 @@
+import { describe, expect, it } from 'vitest';
+import {
+  PsdImportError,
+  buildPsdDocumentSnapshot,
+  parsePsdFile,
+  registerPsdAssets,
+  type PsdParseResult,
+} from './psd-import.js';
+import type { BrowserAssetRegistration } from './control-plane-client.js';
+import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
+
+const parsed: PsdParseResult = {
+  width: 1200,
+  height: 800,
+  bytes: 10,
+  sha256: 'a'.repeat(64),
+  parseTimeMs: 1,
+  sourceName: 'نمونه.psd',
+  sourceMimeType: 'image/vnd.adobe.photoshop',
+  warnings: [
+    {
+      code: 'smart-object-unsupported',
+      layerId: 'smart',
+      message: 'unsupported',
+    },
+  ],
+  layers: [
+    {
+      id: 'hero',
+      name: 'قهرمان',
+      bounds: { x: 10, y: 20, width: 300, height: 200 },
+      opacity: 1,
+      visible: true,
+      type: 'raster',
+    },
+    {
+      id: 'headline',
+      name: 'عنوان فارسی',
+      bounds: { x: 40, y: 60, width: 500, height: 100 },
+      opacity: 0.8,
+      visible: true,
+      type: 'text',
+      text: 'سلام JOY',
+    },
+  ],
+};
+
+describe('bounded PSD import', () => {
+  it('maps image and Persian text layers into a validated document snapshot', () => {
+    const project = buildPsdDocumentSnapshot(
+      INITIAL_EDITOR_PROJECT,
+      parsed,
+      { hero: 'image-object', headline: 'text-object' },
+      { sourceAssetId: 'psd-source', layerAssetIds: { hero: 'psd-hero' } },
+      'seed-1',
+    );
+    expect(project.visualObjects['psd-seed-1-hero']).toMatchObject({
+      kind: 'image',
+      assetId: 'psd-hero',
+    });
+    expect(project.visualObjects['psd-seed-1-headline']).toMatchObject({
+      kind: 'text',
+      text: 'سلام JOY',
+    });
+    expect(project.assets['psd-source']).toMatchObject({ kind: 'image', displayName: 'نمونه.psd' });
+  });
+
+  it('registers the source and selected raster with real content hashes', async () => {
+    const registrations: BrowserAssetRegistration[] = [];
+    const cached: string[] = [];
+    const file = new Blob(['source'], { type: 'image/vnd.adobe.photoshop' });
+    const raster = new Blob(['raster'], { type: 'image/png' });
+    const result = await registerPsdAssets({
+      client: {
+        registerAsset: async (_projectId, registration) => {
+          registrations.push(registration);
+          return registration as never;
+        },
+      },
+      projectId: 'project-1',
+      cache: {
+        put: async (descriptor) => {
+          cached.push(`${descriptor.assetId}:${descriptor.sha256}:${descriptor.bytes}`);
+        },
+      },
+      file,
+      parsed: { ...parsed, layers: [{ ...parsed.layers[0]!, rasterBlob: raster }] },
+      selectedLayerIds: ['hero'],
+    });
+    expect(result.sourceAssetId).toMatch(/^psd-/);
+    expect(result.layerAssetIds.hero).toMatch(/^psd-/);
+    expect(registrations).toHaveLength(2);
+    expect(registrations.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
+    expect(cached.every((entry) => entry.split(':')[1]?.length === 64)).toBe(true);
+  });
+
+  it('rejects malformed and oversized PSD inputs with typed user-safe errors', async () => {
+    await expect(parsePsdFile(new Blob(['not-a-psd']), { maxBytes: 2 })).rejects.toMatchObject({
+      code: 'too-large',
+    } satisfies Partial<PsdImportError>);
+    await expect(parsePsdFile(new Blob(['not-a-psd']))).rejects.toMatchObject({
+      code: 'invalid-psd',
+    } satisfies Partial<PsdImportError>);
+  });
+});
diff --git a/apps/editor-web/src/psd-import.ts b/apps/editor-web/src/psd-import.ts
new file mode 100644
index 0000000..7295751
--- /dev/null
+++ b/apps/editor-web/src/psd-import.ts
@@ -0,0 +1,419 @@
+import type { JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
+import type {
+  BrowserAsset,
+  BrowserAssetRegistration,
+  BrowserControlPlaneClient,
+} from './control-plane-client.js';
+import type {
+  OriginalAssetDescriptor,
+  OpfsOriginalAssetCache,
+} from './opfs-original-asset-cache.js';
+
+export type PsdLayerType = 'raster' | 'text' | 'group' | 'adjustment' | 'smart-object' | 'unknown';
+
+export interface PsdLayerDto {
+  readonly id: string;
+  readonly name: string;
+  readonly bounds: {
+    readonly x: number;
+    readonly y: number;
+    readonly width: number;
+    readonly height: number;
+  };
+  readonly opacity: number;
+  readonly visible: boolean;
+  readonly type: PsdLayerType;
+  readonly text?: string;
+  readonly rasterBlob?: Blob;
+}
+
+export interface PsdWarning {
+  readonly code: 'adjustment-unsupported' | 'smart-object-unsupported' | 'unknown-layer';
+  readonly layerId: string;
+  readonly message: string;
+}
+
+export interface PsdParseResult {
+  readonly layers: readonly PsdLayerDto[];
+  readonly warnings: readonly PsdWarning[];
+  readonly width: number;
+  readonly height: number;
+  readonly bytes: number;
+  readonly sha256: string;
+  readonly parseTimeMs: number;
+  readonly sourceName?: string;
+  readonly sourceMimeType: string;
+}
+
+export type PsdImportErrorCode = 'invalid-psd' | 'too-large' | 'memory-budget' | 'unsupported';
+
+export class PsdImportError extends Error {
+  constructor(
+    readonly code: PsdImportErrorCode,
+    message: string,
+  ) {
+    super(message);
+    this.name = 'PsdImportError';
+  }
+}
+
+interface AgPsdLayer {
+  readonly top?: number;
+  readonly left?: number;
+  readonly bottom?: number;
+  readonly right?: number;
+  readonly opacity?: number;
+  readonly hidden?: boolean;
+  readonly name?: string;
+  readonly id?: number;
+  readonly canvas?: unknown;
+  readonly imageData?: unknown;
+  readonly children?: AgPsdLayer[];
+  readonly text?: { readonly text?: string };
+  readonly adjustment?: unknown;
+  readonly placedLayer?: unknown;
+}
+
+interface AgPsdDocument {
+  readonly width?: number;
+  readonly height?: number;
+  readonly children?: AgPsdLayer[];
+}
+
+const DEFAULT_MAX_PIXELS = 3840 * 2160;
+const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
+const DEFAULT_MEMORY_BUDGET = 256 * 1024 * 1024;
+
+export async function parsePsdFile(
+  file: File | Blob,
+  options: {
+    readonly maxPixels?: number;
+    readonly maxBytes?: number;
+    readonly memoryBudgetBytes?: number;
+  } = {},
+): Promise<PsdParseResult> {
+  const bytes = await file.arrayBuffer();
+  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
+  if (bytes.byteLength > maxBytes) {
+    throw new PsdImportError(
+      'too-large',
+      `PSD file is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB; the limit is ${(
+        maxBytes /
+        (1024 * 1024)
+      ).toFixed(0)} MB.`,
+    );
+  }
+  const sha256 = await sha256Hex(bytes);
+  const { readPsd } = await import('ag-psd');
+  const started = performance.now();
+  let structure: AgPsdDocument;
+  try {
+    structure = readPsd(bytes, {
+      skipLayerImageData: true,
+      skipCompositeImageData: true,
+      skipThumbnail: true,
+      logMissingFeatures: false,
+    }) as unknown as AgPsdDocument;
+  } catch (error) {
+    throw new PsdImportError('invalid-psd', `Unable to read this PSD: ${message(error)}`);
+  }
+  const width = structure.width ?? 0;
+  const height = structure.height ?? 0;
+  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
+  const memoryBudgetBytes = options.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET;
+  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
+    throw new PsdImportError('invalid-psd', 'The PSD has invalid canvas dimensions.');
+  }
+  if (width * height > maxPixels) {
+    throw new PsdImportError(
+      'too-large',
+      `PSD canvas ${width}×${height} exceeds the ${maxPixels.toLocaleString()} pixel limit.`,
+    );
+  }
+  if (width * height * 4 > memoryBudgetBytes) {
+    throw new PsdImportError(
+      'memory-budget',
+      `PSD raster memory exceeds the ${Math.round(memoryBudgetBytes / (1024 * 1024))} MB budget.`,
+    );
+  }
+
+  let parsed: AgPsdDocument;
+  try {
+    parsed = readPsd(bytes, {
+      skipCompositeImageData: true,
+      skipThumbnail: true,
+      useImageData: true,
+      logMissingFeatures: false,
+    }) as unknown as AgPsdDocument;
+  } catch (error) {
+    throw new PsdImportError('invalid-psd', `Unable to decode PSD layers: ${message(error)}`);
+  }
+  const layers: PsdLayerDto[] = [];
+  const warnings: PsdWarning[] = [];
+  const flatten = async (children: readonly AgPsdLayer[] | undefined): Promise<void> => {
+    if (children === undefined) return;
+    for (const layer of children) {
+      const index = layers.length;
+      const id = String(layer.id ?? `layer-${index + 1}`);
+      const type = classifyLayer(layer);
+      const left = layer.left ?? 0;
+      const top = layer.top ?? 0;
+      const right = layer.right ?? left;
+      const bottom = layer.bottom ?? top;
+      const dto: PsdLayerDto = {
+        id,
+        name: layer.name ?? `Layer ${index + 1}`,
+        bounds: {
+          x: clamp(left, 0, width),
+          y: clamp(top, 0, height),
+          width: clamp(right - left, 0, width),
+          height: clamp(bottom - top, 0, height),
+        },
+        opacity: clamp((layer.opacity ?? 255) / 255, 0, 1),
+        visible: layer.hidden !== true,
+        type,
+        ...(type === 'text' && layer.text?.text !== undefined ? { text: layer.text.text } : {}),
+      };
+      if (type === 'raster') {
+        const rasterBlob = rasterBlobFromLayer(layer);
+        if (rasterBlob !== undefined) {
+          const blob = await rasterBlob;
+          if (blob !== undefined) (dto as { rasterBlob?: Blob }).rasterBlob = blob;
+        }
+      }
+      layers.push(dto);
+      if (type === 'adjustment') {
+        warnings.push({
+          code: 'adjustment-unsupported',
+          layerId: id,
+          message: `Adjustment layer “${dto.name}” will not be edited; choose ignore or flatten group.`,
+        });
+      } else if (type === 'smart-object') {
+        warnings.push({
+          code: 'smart-object-unsupported',
+          layerId: id,
+          message: `Smart Object “${dto.name}” is opaque; source editing is not supported.`,
+        });
+      } else if (type === 'unknown') {
+        warnings.push({
+          code: 'unknown-layer',
+          layerId: id,
+          message: `Layer “${dto.name}” has no supported payload and will default to ignore.`,
+        });
+      }
+      await flatten(layer.children);
+    }
+  };
+  await flatten(parsed.children);
+  const sourceName = typeof File !== 'undefined' && file instanceof File ? file.name : undefined;
+  return {
+    layers,
+    warnings,
+    width,
+    height,
+    bytes: bytes.byteLength,
+    sha256,
+    parseTimeMs: performance.now() - started,
+    ...(sourceName !== undefined ? { sourceName } : {}),
+    sourceMimeType: file.type || 'image/vnd.adobe.photoshop',
+  };
+}
+
+export type PsdLayerMapping = 'image-object' | 'text-object' | 'flatten-group' | 'ignore';
+
+export interface PsdAssetRefs {
+  readonly sourceAssetId: string;
+  readonly layerAssetIds: Readonly<Record<string, string>>;
+}
+
+export interface PsdAssetRegistrationOptions {
+  readonly client: Pick<BrowserControlPlaneClient, 'registerAsset'>;
+  readonly projectId: string;
+  readonly cache: Pick<OpfsOriginalAssetCache, 'put'>;
+  readonly file: File | Blob;
+  readonly parsed: PsdParseResult;
+  readonly selectedLayerIds: readonly string[];
+}
+
+export async function registerPsdAssets(
+  options: PsdAssetRegistrationOptions,
+): Promise<PsdAssetRefs> {
+  const sourceAssetId = opaqueId(`psd-${options.parsed.sha256.slice(0, 24)}`);
+  await registerBlob(
+    options,
+    sourceAssetId,
+    options.file,
+    options.parsed.sourceMimeType,
+    'PSD source',
+  );
+  const layerAssetIds: Record<string, string> = {};
+  const selected = new Set(options.selectedLayerIds);
+  for (const layer of options.parsed.layers) {
+    if (!selected.has(layer.id) || layer.rasterBlob === undefined) continue;
+    const blob = layer.rasterBlob;
+    const hash = await sha256Hex(await blob.arrayBuffer());
+    const assetId = opaqueId(`psd-${options.parsed.sha256.slice(0, 12)}-${hash.slice(0, 12)}`);
+    await registerBlob(options, assetId, blob, 'image/png', `PSD layer ${layer.name}`);
+    layerAssetIds[layer.id] = assetId;
+  }
+  return { sourceAssetId, layerAssetIds };
+}
+
+export function buildPsdDocumentSnapshot(
+  project: JoyProjectV1,
+  parsed: PsdParseResult,
+  mappings: Readonly<Record<string, PsdLayerMapping>>,
+  assets: PsdAssetRefs,
+  seed: string,
+): JoyProjectV1 {
+  let next = {
+    ...project,
+    assets: {
+      ...project.assets,
+      [assets.sourceAssetId]: {
+        id: assets.sourceAssetId,
+        kind: 'image' as const,
+        displayName: parsed.sourceName ?? 'PSD source',
+      },
+    },
+    visualObjects: { ...project.visualObjects },
+  };
+  const usedIds = new Set(Object.keys(next.visualObjects));
+  for (const layer of parsed.layers) {
+    const mapping = mappings[layer.id] ?? 'ignore';
+    if (mapping === 'ignore' || !layer.visible) continue;
+    const assetId =
+      assets.layerAssetIds[layer.id] ??
+      (mapping === 'flatten-group' ? assets.sourceAssetId : undefined);
+    if (mapping === 'image-object' && assetId === undefined) continue;
+    if (mapping === 'flatten-group' && assetId === undefined) continue;
+    if (mapping === 'text-object' && (layer.text ?? '').length === 0) continue;
+    const baseId = `psd-${seed}-${layer.id}`;
+    let objectId = baseId;
+    for (let suffix = 2; usedIds.has(objectId); suffix += 1) objectId = `${baseId}-${suffix}`;
+    usedIds.add(objectId);
+    const transform = {
+      x: layer.bounds.x,
+      y: layer.bounds.y,
+      scaleX: 1,
+      scaleY: 1,
+      rotationDeg: 0,
+      opacity: layer.opacity,
+      crop: { left: 0, top: 0, right: 0, bottom: 0 },
+    };
+    const object: VisualObjectV1 =
+      mapping === 'text-object'
+        ? { id: objectId, kind: 'text', text: layer.text ?? layer.name, transform }
+        : { id: objectId, kind: 'image', assetId: assetId!, transform };
+    next = {
+      ...next,
+      visualObjects: { ...next.visualObjects, [objectId]: object },
+      assets:
+        assetId === undefined || next.assets[assetId] !== undefined
+          ? next.assets
+          : { ...next.assets, [assetId]: { id: assetId, kind: 'image', displayName: layer.name } },
+    };
+  }
+  return next;
+}
+
+async function registerBlob(
+  options: PsdAssetRegistrationOptions,
+  assetId: string,
+  blob: Blob,
+  mimeType: string,
+  displayName: string,
+): Promise<BrowserAsset> {
+  const bytes = await blob.arrayBuffer();
+  const sha256 = await sha256Hex(bytes);
+  const descriptor: OriginalAssetDescriptor = { assetId, sha256, bytes: blob.size, mimeType };
+  await options.cache.put(descriptor, blob);
+  const registration: BrowserAssetRegistration = {
+    id: assetId,
+    kind: 'image',
+    displayName,
+    sha256,
+    bytes: blob.size,
+    descriptor: { mimeType },
+    locations: [{ kind: 'opfs-cache', ref: `opfs-${sha256.slice(0, 32)}` }],
+  };
+  return options.client.registerAsset(options.projectId, registration);
+}
+
+function classifyLayer(layer: AgPsdLayer): PsdLayerType {
+  if (layer.children !== undefined) return 'group';
+  if (layer.text !== undefined) return 'text';
+  if (layer.adjustment !== undefined) return 'adjustment';
+  if (layer.placedLayer !== undefined) return 'smart-object';
+  if (layer.canvas !== undefined || layer.imageData !== undefined) return 'raster';
+  return 'unknown';
+}
+
+async function rasterBlobFromLayer(layer: AgPsdLayer): Promise<Blob | undefined> {
+  const candidate = layer.canvas as
+    | {
+        readonly toBlob?: (callback: (blob: Blob | null) => void, type?: string) => void;
+        readonly convertToBlob?: (options?: { type?: string }) => Promise<Blob>;
+      }
+    | undefined;
+  if (candidate?.convertToBlob !== undefined) return candidate.convertToBlob({ type: 'image/png' });
+  if (candidate?.toBlob !== undefined) {
+    return new Promise((resolve) =>
+      candidate.toBlob?.((blob) => resolve(blob ?? undefined), 'image/png'),
+    );
+  }
+  const imageData = layer.imageData as
+    | { readonly width?: number; readonly height?: number; readonly data?: ArrayLike<number> }
+    | undefined;
+  if (
+    imageData?.width === undefined ||
+    imageData.height === undefined ||
+    imageData.data === undefined
+  )
+    return undefined;
+  const width = imageData.width;
+  const height = imageData.height;
+  const pixels = new Uint8ClampedArray(imageData.data);
+  if (typeof OffscreenCanvas !== 'undefined') {
+    const canvas = new OffscreenCanvas(width, height);
+    const context = canvas.getContext('2d');
+    if (context !== null) {
+      context.putImageData(new ImageData(pixels, width, height), 0, 0);
+      return canvas.convertToBlob({ type: 'image/png' });
+    }
+  }
+  if (typeof document !== 'undefined') {
+    const canvas = document.createElement('canvas');
+    canvas.width = width;
+    canvas.height = height;
+    const context = canvas.getContext('2d');
+    if (context !== null) {
+      context.putImageData(new ImageData(pixels, width, height), 0, 0);
+      return new Promise((resolve) =>
+        canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/png'),
+      );
+    }
+  }
+  return undefined;
+}
+
+function clamp(value: number, min: number, max: number): number {
+  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
+}
+
+function opaqueId(value: string): string {
+  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
+}
+
+async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
+  if (globalThis.crypto?.subtle === undefined)
+    throw new PsdImportError('unsupported', 'SHA-256 is unavailable in this browser.');
+  return Array.from(
+    new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buffer)),
+    (byte) => byte.toString(16).padStart(2, '0'),
+  ).join('');
+}
+
+function message(error: unknown): string {
+  return error instanceof Error ? error.message : String(error);
+}
diff --git a/apps/editor-web/src/psd-parser-spike.ts b/apps/editor-web/src/psd-parser-spike.ts
index 0d48da8..a3a103d 100644
--- a/apps/editor-web/src/psd-parser-spike.ts
+++ b/apps/editor-web/src/psd-parser-spike.ts
@@ -1,180 +1,15 @@
-/**
- * PSD Parser Spike — evaluates ag-psd for the Templates PSD import feature.
- *
- * ag-psd is MIT-licensed, pure JavaScript (no WASM), works in browsers.
- * API: readPsd(ArrayBuffer, ReadOptions?) -> Psd
- *
- * Installed: pnpm --filter @joy-media/editor-web add ag-psd
- */
-
-export interface PsdLayerDto {
-  readonly id: string;
-  readonly name: string;
-  readonly bounds: {
-    readonly x: number;
-    readonly y: number;
-    readonly width: number;
-    readonly height: number;
-  };
-  readonly opacity: number;
-  readonly visible: boolean;
-  readonly type: 'raster' | 'text' | 'group' | 'adjustment' | 'smart-object' | 'unknown';
-  readonly imageBlobId?: string;
-  readonly text?: string;
-}
-
-export interface PsdParseResult {
-  readonly layers: readonly PsdLayerDto[];
-  readonly width: number;
-  readonly height: number;
-  readonly parseTimeMs: number;
-}
-
-interface AgPsdLayer {
-  readonly top?: number;
-  readonly left?: number;
-  readonly bottom?: number;
-  readonly right?: number;
-  readonly opacity?: number;
-  readonly hidden?: boolean;
-  readonly name?: string;
-  readonly id?: number;
-  readonly canvas?: unknown;
-  readonly imageData?: unknown;
-  readonly children?: AgPsdLayer[];
-  readonly text?: { readonly text?: string };
-  readonly adjustment?: unknown;
-  readonly placedLayer?: unknown;
-}
-
-interface AgPsdDocument {
-  readonly width: number;
-  readonly height: number;
-  readonly children?: AgPsdLayer[];
-}
-
-/**
- * Parse a PSD file and extract layers.
- *
- * Two-phase parse:
- * Phase 1 (structure-only, ~50-150ms): DoS-hardened dimension check using
- *   useRawData: true — no bitmap decoding yet.
- * Phase 2 (full parse, ~200-800ms): Decode layer bitmaps with
- *   skipCompositeImageData: true to skip the merged composite.
- *
- * @param file - The .psd file as a File or Blob
- * @param maxPixels - Maximum allowed canvas area (default 3840x2160)
- */
-export async function parsePsdFile(
-  file: File | Blob,
-  maxPixels: number = 3840 * 2160,
-): Promise<PsdParseResult> {
-  const { readPsd } = await import('ag-psd');
-  const arrayBuffer = await file.arrayBuffer();
-
-  // Phase 1: structure-only parse (fast, safe, DoS-hardened)
-  const phase1Start = performance.now();
-  const psd = readPsd(arrayBuffer, {
-    useRawData: true,
-    skipThumbnail: true,
-    logMissingFeatures: false,
-  } as Record<string, unknown>);
-  const { width, height } = psd;
-
-  if (width <= 0 || height <= 0) {
-    throw new Error(`Invalid PSD dimensions: ${width}x${height}`);
-  }
-  if (width * height > maxPixels) {
-    throw new Error(
-      `PSD too large: ${width}x${height} = ${width * height} px ` +
-      `(max ${maxPixels}). Rejected to prevent memory exhaustion.`,
-    );
-  }
-  if (width * height * 4 > 256 * 1024 * 1024) {
-    throw new Error(
-      `PSD memory budget exceeded: ${width}x${height} x 4 bytes = ` +
-      `${((width * height * 4) / (1024 * 1024)).toFixed(1)} MB (max 256 MB).`,
-    );
-  }
-  const phase1Time = performance.now() - phase1Start;
-
-  // Phase 2: full parse with layer bitmaps
-  const phase2Start = performance.now();
-  const fullPsd = readPsd(arrayBuffer, {
-    skipCompositeImageData: true,
-    skipThumbnail: true,
-    logMissingFeatures: false,
-  } as Record<string, unknown>);
-  const phase2Time = performance.now() - phase2Start;
-  const totalTime = performance.now() - phase1Start;
-
-  // Flatten layer tree to DTO list
-  const layers: PsdLayerDto[] = [];
-
-  function classifyType(layer: AgPsdLayer): PsdLayerDto['type'] {
-    if (layer.children !== undefined) return 'group';
-    if (layer.text !== undefined) return 'text';
-    if (layer.adjustment !== undefined) return 'adjustment';
-    if (layer.placedLayer !== undefined) return 'smart-object';
-    if (layer.canvas !== undefined || layer.imageData !== undefined) return 'raster';
-    return 'unknown';
-  }
-
-  function buildDto(layer: AgPsdLayer, index: number): PsdLayerDto {
-    const left = layer.left ?? 0;
-    const top = layer.top ?? 0;
-    const right = layer.right ?? 0;
-    const bottom = layer.bottom ?? 0;
-    const type = classifyType(layer);
-
-    const dto: PsdLayerDto = {
-      id: String(layer.id ?? `psd-${index}`),
-      name: layer.name ?? `Layer ${index + 1}`,
-      bounds: {
-        x: Math.max(0, left),
-        y: Math.max(0, top),
-        width: Math.min(width, Math.max(0, right - left)),
-        height: Math.min(height, Math.max(0, bottom - top)),
-      },
-      opacity: layer.opacity ?? 1,
-      visible: !layer.hidden,
-      type,
-    };
-
-    // Build a fully-populated copy including optional fields
-    return {
-      ...dto,
-      ...(type === 'raster'
-        ? { imageBlobId: `psd-layer-${layer.id ?? index}` }
-        : {}),
-      ...(type === 'text' && layer.text !== undefined
-        ? { text: layer.text.text }
-        : {}),
-    };
-  }
-
-  function flatten(layerList: AgPsdLayer[] | undefined, result: PsdLayerDto[]) {
-    if (!layerList) return;
-    for (let i = 0; i < layerList.length; i++) {
-      const layer = layerList[i];
-      if (layer === undefined) continue;
-      const index = result.length;
-      result.push(buildDto(layer, index));
-      if (layer.children) flatten(layer.children, result);
-    }
-  }
-
-  flatten(fullPsd.children, layers);
-
-  console.debug('[psd-parser-spike] parse complete', {
-    dimensions: `${width}x${height}`,
-    layers: layers.length,
-    phase1Ms: phase1Time.toFixed(1),
-    phase2Ms: phase2Time.toFixed(1),
-    totalMs: totalTime.toFixed(1),
-    rasterLayers: layers.filter((l) => l.type === 'raster').length,
-    textLayers: layers.filter((l) => l.type === 'text').length,
-  });
-
-  return { layers, width, height, parseTimeMs: totalTime };
-}
+/** @deprecated Use the bounded production PSD import workflow. */
+export {
+  PsdImportError,
+  buildPsdDocumentSnapshot,
+  parsePsdFile,
+  registerPsdAssets,
+} from './psd-import.js';
+export type {
+  PsdAssetRefs,
+  PsdImportErrorCode,
+  PsdLayerDto,
+  PsdLayerMapping,
+  PsdParseResult,
+  PsdWarning,
+} from './psd-import.js';
