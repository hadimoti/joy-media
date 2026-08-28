# Review package: 0ad2eda..HEAD

## Commits
77bbc68 feat(3d): add durable fullscreen JOY 3D Studio

## Files changed
 apps/editor-web/package.json                       |   1 +
 apps/editor-web/src/AgentPanel.tsx                 |   4 +-
 apps/editor-web/src/App.tsx                        |  11 ++
 apps/editor-web/src/app.css                        | 142 +++++++++++++++++
 apps/editor-web/src/scene3d-catalog.test.ts        |  33 ++++
 apps/editor-web/src/scene3d-catalog.ts             |  26 ++++
 .../src/three-d-studio/ThreeDStudioCanvas.test.tsx |  13 ++
 .../src/three-d-studio/ThreeDStudioCanvas.tsx      | 157 +++++++++++++++++++
 .../src/three-d-studio/ThreeDStudioChat.tsx        |  32 ++++
 .../src/three-d-studio/ThreeDStudioHierarchy.tsx   |  89 +++++++++++
 .../src/three-d-studio/ThreeDStudioInspector.tsx   | 103 +++++++++++++
 .../src/three-d-studio/ThreeDStudioShell.test.tsx  |  39 +++++
 .../src/three-d-studio/ThreeDStudioShell.tsx       | 170 +++++++++++++++++++++
 apps/editor-web/src/three-d-studio/index.ts        |   6 +
 apps/editor-web/src/three-d-studio/state/index.ts  |   2 +
 .../state/useThreeDSceneEditor.test.ts             |  60 ++++++++
 .../three-d-studio/state/useThreeDSceneEditor.ts   |  97 ++++++++++++
 apps/editor-web/tsconfig.json                      |   3 +
 packages/scene3d-core/src/commands.test.ts         |  18 +++
 packages/scene3d-core/src/commands.ts              |  65 ++++++++
 pnpm-lock.yaml                                     |   4 +
 21 files changed, 1074 insertions(+), 1 deletion(-)

## Diff
diff --git a/apps/editor-web/package.json b/apps/editor-web/package.json
index a8f88ae..07cd56b 100644
--- a/apps/editor-web/package.json
+++ b/apps/editor-web/package.json
@@ -17,20 +17,21 @@
     "@joy-media/html-scene-runtime": "workspace:*",
     "@joy-media/job-protocol": "workspace:*",
     "@joy-media/motion-core": "workspace:*",
     "@joy-media/playback-engine": "workspace:*",
     "@joy-media/plugin-sdk": "workspace:*",
     "@joy-media/project-persistence": "workspace:*",
     "@joy-media/project-schema": "workspace:*",
     "@joy-media/property-system": "workspace:*",
     "@joy-media/provider-sdk": "workspace:*",
     "@joy-media/render-planner": "workspace:*",
+    "@joy-media/scene3d-core": "workspace:*",
     "@joy-media/render-ir": "workspace:*",
     "@joy-media/renderer-headless": "workspace:*",
     "@joy-media/renderer-pixi": "workspace:*",
     "@joy-media/test-fixtures": "workspace:*",
     "@joy-media/timeline-engine": "workspace:*",
     "@joy-media/transition-shaders": "workspace:*",
     "@joy-media/visual-effects": "workspace:*",
     "@joy-media/visual-object-renderer": "workspace:*",
     "@joy-media/workflow-engine": "workspace:*",
     "ag-psd": "^31.0.2",
diff --git a/apps/editor-web/src/AgentPanel.tsx b/apps/editor-web/src/AgentPanel.tsx
index 9988b11..a7c4f62 100644
--- a/apps/editor-web/src/AgentPanel.tsx
+++ b/apps/editor-web/src/AgentPanel.tsx
@@ -454,34 +454,36 @@ function threadTimestamp(value: string): string {
  */
 export function AgentPanel({
   project,
   selectedClipIds,
   playheadUs,
   agentContext,
   onUndo,
   session,
   attachedAssets = [],
   assets = [],
+  onOpen3DStudio,
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
   /** Registered catalog assets available to the asset-backed 3D preview. */
   readonly assets?: readonly BrowserAsset[];
+  readonly onOpen3DStudio?: () => void;
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
@@ -1389,15 +1391,15 @@ export function AgentPanel({
                     else submitPrompt(draft);
                   }}
                 >
                   {!hasBlockingPending ? <PlayIcon /> : <CloseIcon />}
                 </button>
               </div>
             </div>
           </section>
         )}
 
-        {tab === '3d' && <JoyCode3DViewer assets={assets} />}
+        {tab === '3d' && <JoyCode3DViewer assets={assets} onOpenStudio={onOpen3DStudio} />}
       </div>
     </PanelShell>
   );
 }
diff --git a/apps/editor-web/src/App.tsx b/apps/editor-web/src/App.tsx
index 8048e57..96a8ee5 100644
--- a/apps/editor-web/src/App.tsx
+++ b/apps/editor-web/src/App.tsx
@@ -81,20 +81,21 @@ import {
   upsertCatalogProject,
   type ProjectCatalogEntry,
 } from './project-catalog.js';
 import { createBlankProjectDocuments, seedsForCatalogEntry } from './project-factory.js';
 import { CaptionsPanel } from './CaptionsPanel.js';
 import { InspectorPanel } from './InspectorPanel.js';
 import { MotionPanel } from './MotionPanel.js';
 import { MotionStudioShell } from './motion-studio/index.js';
 import { buildMotionScenePlacementPlan } from './motion-studio/motionScenePlacement.js';
 import { EffectStudioShell } from './effect-studio/index.js';
+import { ThreeDStudioShell } from './three-d-studio/index.js';
 import { CameraPanel } from './CameraPanel.js';
 import { JobsPanel } from './JobsPanel.js';
 import { AssetLibraryPanel } from './AssetLibraryPanel.js';
 import {
   BrowserControlPlaneClient,
   type BrowserAsset,
   type BrowserDerivative,
 } from './control-plane-client.js';
 import { AudioPanel } from './AudioPanel.js';
 import { EffectsPanel } from './EffectsPanel.js';
@@ -553,20 +554,21 @@ function EditorWorkspace({
     readonly { id: string; message: string; kind: 'info' | 'success' | 'error' }[]
   >([]);
   const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false);
   const shortcutsDialogRef = useRef<HTMLDivElement | null>(null);
   const [viewMode, setViewMode] = useState<EditorViewMode>(() => loadViewMode(window.localStorage));
   const viewModeRef = useRef(viewMode);
   viewModeRef.current = viewMode;
   const paletteRef = useRef<HTMLElement | null>(null);
   const accountDropdownRef = useRef<HTMLElement | null>(null);
   const [motionStudioSceneId, setMotionStudioSceneId] = useState<string | undefined>(undefined);
+  const [threeDStudioSceneId, setThreeDStudioSceneId] = useState<string | undefined>(undefined);
   const [effectStudioSession, setEffectStudioSession] = useState<
     { readonly recipeId: string; readonly objectId?: string } | undefined
   >(undefined);
   useEffect(() => {
     return () => {
       stickerImageCache.clear();
       partnerMediaBindingRef.current.dispose(partnerVideoRef.current);
     };
   }, []);
   const lastExportRef = useRef<{ readonly entryId: string; readonly url: string } | null>(null);
@@ -2836,20 +2838,21 @@ function EditorWorkspace({
           playheadUs={state.playheadUs}
           agentContext={context.agentContext}
           onUndo={context.undo}
           session={context.session}
           settings={context.agentSettings}
           {...(context.agentPanelCommand === undefined
             ? {}
             : { command: context.agentPanelCommand })}
           attachedAssets={context.kiloCodeAttachedAssets}
           assets={Object.values(monitorAssetCatalog.assets)}
+          onOpen3DStudio={() => setThreeDStudioSceneId(controlPlaneProject.controlPlaneProjectId)}
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
@@ -3417,20 +3420,28 @@ function EditorWorkspace({
           onReady={onReady}
         />
       </EditorPanelContext.Provider>
       {motionStudioSceneId !== undefined && (
         <MotionStudioShell
           key={motionStudioSceneId}
           sceneId={motionStudioSceneId}
           onClose={() => setMotionStudioSceneId(undefined)}
         />
       )}
+      {threeDStudioSceneId !== undefined && (
+        <ThreeDStudioShell
+          key={threeDStudioSceneId}
+          sceneId={threeDStudioSceneId}
+          assets={Object.values(monitorAssetCatalog.assets)}
+          onClose={() => setThreeDStudioSceneId(undefined)}
+        />
+      )}
       {effectStudioSession !== undefined && (
         <EffectStudioShell
           key={effectStudioSession.recipeId}
           recipeId={effectStudioSession.recipeId}
           canApply={
             effectStudioSession.objectId !== undefined ||
             resolveObjectIdForSelection(session.visualProject, state.selectedIds) !== undefined
           }
           onApply={(effects) => {
             const objectId =
diff --git a/apps/editor-web/src/app.css b/apps/editor-web/src/app.css
index 2315764..296bcec 100644
--- a/apps/editor-web/src/app.css
+++ b/apps/editor-web/src/app.css
@@ -11907,10 +11907,152 @@ label {
 }
 
 .psd-import-apply-btn:hover:not(:disabled) {
   filter: brightness(1.1);
 }
 
 .psd-import-apply-btn:disabled {
   opacity: 0.45;
   cursor: not-allowed;
 }
+
+.three-d-studio-overlay {
+  position: fixed;
+  inset: 0;
+  z-index: 1200;
+  display: flex;
+  flex-direction: column;
+  background: #0b1020;
+  color: #e5e7eb;
+}
+.three-d-studio-topbar {
+  min-height: 48px;
+  display: flex;
+  align-items: center;
+  gap: 10px;
+  padding: 8px 14px;
+  border-bottom: 1px solid #26324a;
+  background: #111827;
+}
+.three-d-studio-topbar strong {
+  flex: 1;
+}
+.three-d-studio-topbar button,
+.three-d-studio-hierarchy button,
+.three-d-studio-hierarchy select,
+.three-d-studio-inspector select,
+.three-d-studio-inspector input,
+.three-d-studio-chat button {
+  color: inherit;
+  background: #1f2937;
+  border: 1px solid #374151;
+  border-radius: 4px;
+  padding: 5px 8px;
+}
+.three-d-studio-body {
+  min-height: 0;
+  flex: 1;
+  display: grid;
+  grid-template-columns: 220px minmax(0, 1fr) 260px 220px;
+}
+.three-d-studio-hierarchy,
+.three-d-studio-inspector,
+.three-d-studio-chat {
+  min-width: 0;
+  padding: 12px;
+  background: #111827;
+  border-right: 1px solid #26324a;
+  overflow: auto;
+}
+.three-d-studio-inspector {
+  border-left: 1px solid #26324a;
+  border-right: 0;
+}
+.three-d-studio-chat {
+  border-left: 1px solid #26324a;
+  border-right: 0;
+}
+.three-d-studio-section-title {
+  font-size: 12px;
+  font-weight: 700;
+  letter-spacing: 0.08em;
+  text-transform: uppercase;
+  color: #94a3b8;
+  margin-bottom: 10px;
+}
+.three-d-studio-adds {
+  display: flex;
+  flex-wrap: wrap;
+  gap: 5px;
+  margin-bottom: 12px;
+}
+.three-d-studio-object-list {
+  list-style: none;
+  padding: 0;
+  margin: 0;
+}
+.three-d-studio-object-list button {
+  width: 100%;
+  display: flex;
+  align-items: center;
+  gap: 7px;
+  text-align: left;
+  background: transparent;
+  border-color: transparent;
+}
+.three-d-studio-object-list button.is-selected {
+  background: #334155;
+  border-color: #64748b;
+}
+.three-d-studio-danger {
+  margin-top: 12px;
+  color: #fecaca !important;
+}
+.three-d-studio-center {
+  min-width: 0;
+  min-height: 0;
+  position: relative;
+}
+.three-d-studio-canvas {
+  position: absolute;
+  inset: 0;
+}
+.three-d-studio-inspector label {
+  display: grid;
+  gap: 4px;
+  margin-bottom: 10px;
+  font-size: 12px;
+  color: #cbd5e1;
+}
+.three-d-studio-inspector fieldset {
+  display: grid;
+  grid-template-columns: repeat(3, 1fr);
+  gap: 4px;
+  border: 1px solid #26324a;
+  margin: 10px 0;
+  padding: 6px;
+}
+.three-d-studio-inspector fieldset label {
+  margin: 0;
+}
+.three-d-studio-chat textarea {
+  width: 100%;
+  min-height: 90px;
+  resize: vertical;
+  color: inherit;
+  background: #0f172a;
+  border: 1px solid #374151;
+  border-radius: 4px;
+  padding: 7px;
+}
+.three-d-studio-chat-note {
+  color: #94a3b8;
+  font-size: 12px;
+  line-height: 1.45;
+}
+.three-d-studio-proposal {
+  margin-top: 10px;
+  padding: 8px;
+  border: 1px solid #7c3aed;
+  border-radius: 4px;
+  font-size: 12px;
+}
diff --git a/apps/editor-web/src/scene3d-catalog.test.ts b/apps/editor-web/src/scene3d-catalog.test.ts
new file mode 100644
index 0000000..6fcb605
--- /dev/null
+++ b/apps/editor-web/src/scene3d-catalog.test.ts
@@ -0,0 +1,33 @@
+import { describe, expect, it } from 'vitest';
+import { emptyScene3D } from '@joy-media/scene3d-core';
+import { loadScene3DDocument, saveScene3DDocument } from './scene3d-catalog.js';
+
+function memoryStorage(): Storage {
+  const values = new Map<string, string>();
+  return {
+    getItem: (key) => values.get(key) ?? null,
+    setItem: (key, value) => void values.set(key, value),
+    removeItem: (key) => void values.delete(key),
+    clear: () => values.clear(),
+    key: (index) => [...values.keys()][index] ?? null,
+    get length() {
+      return values.size;
+    },
+  } as Storage;
+}
+
+describe('scene3d catalog', () => {
+  it('saves and reopens a separate durable scene domain', () => {
+    const storage = memoryStorage();
+    const scene = emptyScene3D('scene-1', 'Studio');
+    saveScene3DDocument(storage, scene);
+    expect(loadScene3DDocument(storage, 'scene-1')).toEqual(scene);
+    expect(loadScene3DDocument(storage, 'missing')).toBeUndefined();
+  });
+
+  it('fails closed on malformed persisted JSON', () => {
+    const storage = memoryStorage();
+    storage.setItem('joy-media.scene3d.v1:scene-1', '{"schemaVersion":1}');
+    expect(loadScene3DDocument(storage, 'scene-1')).toBeUndefined();
+  });
+});
diff --git a/apps/editor-web/src/scene3d-catalog.ts b/apps/editor-web/src/scene3d-catalog.ts
new file mode 100644
index 0000000..b5f975b
--- /dev/null
+++ b/apps/editor-web/src/scene3d-catalog.ts
@@ -0,0 +1,26 @@
+import { migrateScene3DDocument, type Scene3DDocumentV1 } from '@joy-media/scene3d-core';
+
+const PREFIX = 'joy-media.scene3d.v1:';
+
+export function loadScene3DDocument(
+  storage: Pick<Storage, 'getItem'>,
+  sceneId: string,
+): Scene3DDocumentV1 | undefined {
+  try {
+    const raw = storage.getItem(`${PREFIX}${sceneId}`);
+    return raw === null ? undefined : migrateScene3DDocument(JSON.parse(raw) as unknown);
+  } catch {
+    return undefined;
+  }
+}
+
+export function saveScene3DDocument(
+  storage: Pick<Storage, 'setItem'>,
+  document: Scene3DDocumentV1,
+): void {
+  storage.setItem(`${PREFIX}${document.id}`, JSON.stringify(document));
+}
+
+export function deleteScene3DDocument(storage: Pick<Storage, 'removeItem'>, sceneId: string): void {
+  storage.removeItem(`${PREFIX}${sceneId}`);
+}
diff --git a/apps/editor-web/src/three-d-studio/ThreeDStudioCanvas.test.tsx b/apps/editor-web/src/three-d-studio/ThreeDStudioCanvas.test.tsx
new file mode 100644
index 0000000..1669a59
--- /dev/null
+++ b/apps/editor-web/src/three-d-studio/ThreeDStudioCanvas.test.tsx
@@ -0,0 +1,13 @@
+import { renderToStaticMarkup } from 'react-dom/server';
+import { describe, expect, it } from 'vitest';
+import { ThreeDStudioCanvas } from './ThreeDStudioCanvas.js';
+import { emptyScene3D } from '@joy-media/scene3d-core';
+
+describe('3D canvas shell', () => {
+  it('renders a dedicated viewport boundary for the scene document', () => {
+    const markup = renderToStaticMarkup(
+      <ThreeDStudioCanvas document={emptyScene3D('scene-1')} onSelect={() => undefined} />,
+    );
+    expect(markup).toContain('aria-label="3D viewport"');
+  });
+});
diff --git a/apps/editor-web/src/three-d-studio/ThreeDStudioCanvas.tsx b/apps/editor-web/src/three-d-studio/ThreeDStudioCanvas.tsx
new file mode 100644
index 0000000..bcffc8a
--- /dev/null
+++ b/apps/editor-web/src/three-d-studio/ThreeDStudioCanvas.tsx
@@ -0,0 +1,157 @@
+import { useEffect, useRef } from 'react';
+import * as THREE from 'three';
+import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
+import type { Scene3DDocumentV1 } from '@joy-media/scene3d-core';
+
+export function ThreeDStudioCanvas({
+  document,
+  selectedObjectId,
+  onSelect,
+}: {
+  readonly document: Scene3DDocumentV1;
+  readonly selectedObjectId?: string;
+  readonly onSelect: (objectId: string | undefined) => void;
+}) {
+  const hostRef = useRef<HTMLDivElement | null>(null);
+  const selectedRef = useRef(selectedObjectId);
+  selectedRef.current = selectedObjectId;
+  const objectsRef = useRef(new Map<string, THREE.Object3D>());
+  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
+  const sceneRef = useRef<THREE.Scene | null>(null);
+
+  useEffect(() => {
+    const host = hostRef.current;
+    if (host === null) return;
+    const scene = new THREE.Scene();
+    scene.background = new THREE.Color(0x0b1020);
+    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
+    camera.position.set(5, 4, 7);
+    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
+    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
+    renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
+    host.appendChild(renderer.domElement);
+    rendererRef.current = renderer;
+    sceneRef.current = scene;
+    const controls = new OrbitControls(camera, renderer.domElement);
+    controls.enableDamping = true;
+    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
+    const key = new THREE.DirectionalLight(0xffffff, 1.2);
+    key.position.set(4, 6, 4);
+    scene.add(key, new THREE.GridHelper(12, 24, 0x334155, 0x1e293b));
+    const raycaster = new THREE.Raycaster();
+    const pointer = new THREE.Vector2();
+    const onPointerDown = (event: PointerEvent) => {
+      const rect = renderer.domElement.getBoundingClientRect();
+      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
+      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
+      raycaster.setFromCamera(pointer, camera);
+      const hit = raycaster.intersectObjects([...objectsRef.current.values()], true)[0];
+      const id = hit?.object.userData.sceneObjectId;
+      onSelect(typeof id === 'string' ? id : undefined);
+    };
+    renderer.domElement.addEventListener('pointerdown', onPointerDown);
+    let frame = 0;
+    const animate = () => {
+      frame = requestAnimationFrame(animate);
+      controls.update();
+      renderer.render(scene, camera);
+    };
+    animate();
+    const resize =
+      typeof ResizeObserver === 'undefined'
+        ? undefined
+        : new ResizeObserver(() => {
+            const width = Math.max(1, host.clientWidth);
+            const height = Math.max(1, host.clientHeight);
+            camera.aspect = width / height;
+            camera.updateProjectionMatrix();
+            renderer.setSize(width, height);
+          });
+    resize?.observe(host);
+    return () => {
+      cancelAnimationFrame(frame);
+      resize?.disconnect();
+      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
+      controls.dispose();
+      for (const object of objectsRef.current.values()) disposeObject(object);
+      objectsRef.current.clear();
+      renderer.dispose();
+      renderer.forceContextLoss();
+      renderer.domElement.remove();
+      rendererRef.current = null;
+      sceneRef.current = null;
+    };
+  }, [onSelect]);
+
+  useEffect(() => {
+    const scene = sceneRef.current;
+    if (scene === null) return;
+    for (const object of objectsRef.current.values()) {
+      scene.remove(object);
+      disposeObject(object);
+    }
+    objectsRef.current.clear();
+    for (const object of Object.values(document.objects)) {
+      const mesh =
+        object.kind === 'light'
+          ? new THREE.Mesh(
+              new THREE.SphereGeometry(0.16),
+              new THREE.MeshBasicMaterial({ color: 0xffd166 }),
+            )
+          : object.kind === 'camera'
+            ? new THREE.Mesh(
+                new THREE.ConeGeometry(0.25, 0.6, 4),
+                new THREE.MeshBasicMaterial({ color: 0x8ecae6 }),
+              )
+            : new THREE.Mesh(
+                object.primitive === 'sphere'
+                  ? new THREE.SphereGeometry(0.7)
+                  : object.primitive === 'plane'
+                    ? new THREE.PlaneGeometry(1.4, 1.4)
+                    : new THREE.BoxGeometry(1.2, 1.2, 1.2),
+                new THREE.MeshStandardMaterial({
+                  color:
+                    object.id === selectedRef.current
+                      ? 0xfbbf24
+                      : object.kind === 'model'
+                        ? 0x7c3aed
+                        : 0x38bdf8,
+                  roughness: 0.55,
+                  metalness: 0.1,
+                }),
+              );
+      mesh.userData.sceneObjectId = object.id;
+      mesh.position.set(
+        object.transform.position.x,
+        object.transform.position.y,
+        object.transform.position.z,
+      );
+      mesh.rotation.set(
+        object.transform.rotation.x,
+        object.transform.rotation.y,
+        object.transform.rotation.z,
+      );
+      mesh.scale.set(object.transform.scale.x, object.transform.scale.y, object.transform.scale.z);
+      scene.add(mesh);
+      objectsRef.current.set(object.id, mesh);
+    }
+  }, [document, selectedObjectId]);
+
+  return (
+    <div
+      ref={hostRef}
+      className="three-d-studio-canvas"
+      aria-label="3D viewport"
+      data-selected-object={selectedObjectId ?? ''}
+    />
+  );
+}
+
+function disposeObject(object: THREE.Object3D): void {
+  object.traverse((child) => {
+    if (!(child instanceof THREE.Mesh)) return;
+    child.geometry.dispose();
+    for (const material of Array.isArray(child.material) ? child.material : [child.material])
+      material.dispose();
+  });
+}
diff --git a/apps/editor-web/src/three-d-studio/ThreeDStudioChat.tsx b/apps/editor-web/src/three-d-studio/ThreeDStudioChat.tsx
new file mode 100644
index 0000000..b6f3a7b
--- /dev/null
+++ b/apps/editor-web/src/three-d-studio/ThreeDStudioChat.tsx
@@ -0,0 +1,32 @@
+import { useState } from 'react';
+
+export function ThreeDStudioChat() {
+  const [draft, setDraft] = useState('');
+  const [proposal, setProposal] = useState<string | undefined>(undefined);
+  return (
+    <aside className="three-d-studio-chat" aria-label="3D Studio chat">
+      <div className="three-d-studio-section-title">Joy Code 3D</div>
+      <p className="three-d-studio-chat-note">
+        Chat drafts proposals only. Apply changes from the inspector or an approved tool plan.
+      </p>
+      <textarea
+        value={draft}
+        onChange={(event) => setDraft(event.target.value)}
+        placeholder="Describe a 3D edit…"
+      />
+      <button
+        type="button"
+        onClick={() => {
+          if (draft.trim()) setProposal(`Proposal: ${draft.trim()}`);
+        }}
+      >
+        Draft proposal
+      </button>
+      {proposal !== undefined && (
+        <div role="status" className="three-d-studio-proposal">
+          {proposal}
+        </div>
+      )}
+    </aside>
+  );
+}
diff --git a/apps/editor-web/src/three-d-studio/ThreeDStudioHierarchy.tsx b/apps/editor-web/src/three-d-studio/ThreeDStudioHierarchy.tsx
new file mode 100644
index 0000000..c8f5d25
--- /dev/null
+++ b/apps/editor-web/src/three-d-studio/ThreeDStudioHierarchy.tsx
@@ -0,0 +1,89 @@
+import type { BrowserAsset } from '../control-plane-client.js';
+import type { Scene3DDocumentV1 } from '@joy-media/scene3d-core';
+
+export function ThreeDStudioHierarchy({
+  document,
+  assets,
+  selectedObjectId,
+  onSelect,
+  onAdd,
+  onRemove,
+}: {
+  readonly document: Scene3DDocumentV1;
+  readonly assets: readonly BrowserAsset[];
+  readonly selectedObjectId?: string;
+  readonly onSelect: (objectId: string) => void;
+  readonly onAdd: (object: {
+    readonly kind: 'empty' | 'primitive' | 'light' | 'camera' | 'model';
+    readonly assetId?: string;
+  }) => void;
+  readonly onRemove: () => void;
+}) {
+  const models = assets.filter((asset) => asset.kind === 'model');
+  return (
+    <aside className="three-d-studio-hierarchy" aria-label="3D scene hierarchy">
+      <div className="three-d-studio-section-title">Hierarchy</div>
+      <div className="three-d-studio-adds">
+        <button type="button" onClick={() => onAdd({ kind: 'empty' })}>
+          Empty
+        </button>
+        <button type="button" onClick={() => onAdd({ kind: 'primitive' })}>
+          Box
+        </button>
+        <button type="button" onClick={() => onAdd({ kind: 'light' })}>
+          Light
+        </button>
+        <button type="button" onClick={() => onAdd({ kind: 'camera' })}>
+          Camera
+        </button>
+        {models.length > 0 && (
+          <select
+            aria-label="Add registered model"
+            defaultValue=""
+            onChange={(event) => {
+              if (event.target.value) onAdd({ kind: 'model', assetId: event.target.value });
+              event.target.value = '';
+            }}
+          >
+            <option value="">Add model…</option>
+            {models.map((asset) => (
+              <option key={asset.id} value={asset.id}>
+                {asset.displayName}
+              </option>
+            ))}
+          </select>
+        )}
+      </div>
+      <ul className="three-d-studio-object-list">
+        {Object.values(document.objects).map((object) => (
+          <li key={object.id}>
+            <button
+              type="button"
+              className={object.id === selectedObjectId ? 'is-selected' : ''}
+              onClick={() => onSelect(object.id)}
+            >
+              <span aria-hidden>
+                {object.kind === 'model'
+                  ? '◇'
+                  : object.kind === 'camera'
+                    ? '◉'
+                    : object.kind === 'light'
+                      ? '☼'
+                      : '□'}
+              </span>
+              {object.name}
+            </button>
+          </li>
+        ))}
+      </ul>
+      <button
+        type="button"
+        className="three-d-studio-danger"
+        disabled={selectedObjectId === undefined}
+        onClick={onRemove}
+      >
+        Delete selected
+      </button>
+    </aside>
+  );
+}
diff --git a/apps/editor-web/src/three-d-studio/ThreeDStudioInspector.tsx b/apps/editor-web/src/three-d-studio/ThreeDStudioInspector.tsx
new file mode 100644
index 0000000..977a0e2
--- /dev/null
+++ b/apps/editor-web/src/three-d-studio/ThreeDStudioInspector.tsx
@@ -0,0 +1,103 @@
+import type {
+  Scene3DCommand,
+  Scene3DDocumentV1,
+  Scene3DMaterial,
+  Scene3DTransform,
+} from '@joy-media/scene3d-core';
+
+export function ThreeDStudioInspector({
+  document,
+  selectedObjectId,
+  onCommand,
+}: {
+  readonly document: Scene3DDocumentV1;
+  readonly selectedObjectId?: string;
+  readonly onCommand: (command: Scene3DCommand) => void;
+}) {
+  const object = selectedObjectId === undefined ? undefined : document.objects[selectedObjectId];
+  if (object === undefined)
+    return (
+      <aside className="three-d-studio-inspector">
+        <div className="three-d-studio-section-title">Inspector</div>
+        <p>Select an object to edit.</p>
+      </aside>
+    );
+  const setTransform = (key: keyof Scene3DTransform, axis: 'x' | 'y' | 'z', value: string) => {
+    const number = Number(value);
+    if (!Number.isFinite(number)) return;
+    onCommand({
+      type: 'object.setTransform',
+      payload: {
+        objectId: object.id,
+        transform: { ...object.transform, [key]: { ...object.transform[key], [axis]: number } },
+      },
+    });
+  };
+  const setParent = (parentId: string) => {
+    onCommand({
+      type: 'object.setParent',
+      payload: { objectId: object.id, ...(parentId ? { parentId } : {}) },
+    });
+  };
+  const materials = Object.values(document.materials);
+  return (
+    <aside className="three-d-studio-inspector" aria-label="3D inspector">
+      <div className="three-d-studio-section-title">Inspector</div>
+      <label>
+        Name
+        <input value={object.name} readOnly />
+      </label>
+      <label>
+        Parent
+        <select value={object.parentId ?? ''} onChange={(event) => setParent(event.target.value)}>
+          <option value="">Scene root</option>
+          {Object.values(document.objects)
+            .filter((candidate) => candidate.id !== object.id)
+            .map((candidate) => (
+              <option key={candidate.id} value={candidate.id}>
+                {candidate.name}
+              </option>
+            ))}
+        </select>
+      </label>
+      {(['position', 'rotation', 'scale'] as const).map((key) => (
+        <fieldset key={key}>
+          <legend>{key}</legend>
+          {(['x', 'y', 'z'] as const).map((axis) => (
+            <label key={axis}>
+              {axis}
+              <input
+                type="number"
+                step="0.1"
+                value={object.transform[key][axis]}
+                onChange={(event) => setTransform(key, axis, event.target.value)}
+              />
+            </label>
+          ))}
+        </fieldset>
+      ))}
+      <label>
+        Material
+        <select
+          value={object.materialId ?? ''}
+          onChange={(event) =>
+            onCommand({
+              type: 'object.setMaterial',
+              payload: {
+                objectId: object.id,
+                ...(event.target.value ? { materialId: event.target.value } : {}),
+              },
+            })
+          }
+        >
+          <option value="">Default</option>
+          {materials.map((material: Scene3DMaterial) => (
+            <option key={material.id} value={material.id}>
+              {material.id}
+            </option>
+          ))}
+        </select>
+      </label>
+    </aside>
+  );
+}
diff --git a/apps/editor-web/src/three-d-studio/ThreeDStudioShell.test.tsx b/apps/editor-web/src/three-d-studio/ThreeDStudioShell.test.tsx
new file mode 100644
index 0000000..12c6154
--- /dev/null
+++ b/apps/editor-web/src/three-d-studio/ThreeDStudioShell.test.tsx
@@ -0,0 +1,39 @@
+import { renderToStaticMarkup } from 'react-dom/server';
+import { describe, expect, it } from 'vitest';
+import { ThreeDStudioChat } from './ThreeDStudioChat.js';
+import { ThreeDStudioHierarchy } from './ThreeDStudioHierarchy.js';
+import { emptyScene3D } from '@joy-media/scene3d-core';
+import type { BrowserAsset } from '../control-plane-client.js';
+
+const MODEL: BrowserAsset = {
+  id: 'model-1',
+  projectId: 'project-1',
+  kind: 'model',
+  displayName: 'hero.glb',
+  sha256: 'a'.repeat(64),
+  bytes: 1,
+  descriptor: { mimeType: 'model/gltf-binary' },
+  createdAt: 1,
+};
+
+describe('3D studio surfaces', () => {
+  it('keeps chat as a proposal surface', () => {
+    const markup = renderToStaticMarkup(<ThreeDStudioChat />);
+    expect(markup).toContain('drafts proposals only');
+    expect(markup).toContain('Draft proposal');
+  });
+  it('exposes hierarchy actions without mutating the document directly', () => {
+    const markup = renderToStaticMarkup(
+      <ThreeDStudioHierarchy
+        document={emptyScene3D('scene-1')}
+        assets={[MODEL]}
+        selectedObjectId={undefined}
+        onSelect={() => undefined}
+        onAdd={() => undefined}
+        onRemove={() => undefined}
+      />,
+    );
+    expect(markup).toContain('Add model');
+    expect(markup).toContain('Delete selected');
+  });
+});
diff --git a/apps/editor-web/src/three-d-studio/ThreeDStudioShell.tsx b/apps/editor-web/src/three-d-studio/ThreeDStudioShell.tsx
new file mode 100644
index 0000000..f491b5e
--- /dev/null
+++ b/apps/editor-web/src/three-d-studio/ThreeDStudioShell.tsx
@@ -0,0 +1,170 @@
+import { useCallback, useEffect, useMemo, useState } from 'react';
+import type { BrowserAsset } from '../control-plane-client.js';
+import {
+  emptyScene3D,
+  type Scene3DCommand,
+  type Scene3DDocumentV1,
+  type Scene3DObject,
+} from '@joy-media/scene3d-core';
+import { loadScene3DDocument, saveScene3DDocument } from '../scene3d-catalog.js';
+import { useThreeDSceneEditor } from './state/useThreeDSceneEditor.js';
+import { ThreeDStudioCanvas } from './ThreeDStudioCanvas.js';
+import { ThreeDStudioHierarchy } from './ThreeDStudioHierarchy.js';
+import { ThreeDStudioInspector } from './ThreeDStudioInspector.js';
+import { ThreeDStudioChat } from './ThreeDStudioChat.js';
+
+export interface ThreeDStudioShellProps {
+  readonly sceneId: string;
+  readonly assets?: readonly BrowserAsset[];
+  readonly onClose: () => void;
+}
+
+export function ThreeDStudioShell({ sceneId, assets = [], onClose }: ThreeDStudioShellProps) {
+  const storage = typeof window === 'undefined' ? undefined : window.localStorage;
+  const [initialDocument] = useState<Scene3DDocumentV1>(
+    () =>
+      (storage === undefined ? undefined : loadScene3DDocument(storage, sceneId)) ??
+      emptyScene3D(sceneId, 'JOY 3D Scene'),
+  );
+  const editor = useThreeDSceneEditor(initialDocument);
+  const [saveState, setSaveState] = useState<'saved' | 'unsaved' | 'saving' | 'error'>('saved');
+  useEffect(() => {
+    if (storage === undefined) return;
+    setSaveState('unsaved');
+    const timer = window.setTimeout(() => {
+      try {
+        setSaveState('saving');
+        saveScene3DDocument(storage, editor.document);
+        setSaveState('saved');
+      } catch {
+        setSaveState('error');
+      }
+    }, 500);
+    return () => window.clearTimeout(timer);
+  }, [editor.document, storage]);
+  const saveNow = useCallback(() => {
+    if (storage === undefined) return;
+    try {
+      saveScene3DDocument(storage, editor.document);
+      setSaveState('saved');
+    } catch {
+      setSaveState('error');
+    }
+  }, [editor.document, storage]);
+  const dispatch = useCallback(
+    (label: string, command: Scene3DCommand) => {
+      editor.dispatch({ label, commands: [command] });
+    },
+    [editor],
+  );
+  const addObject = useCallback(
+    (input: { readonly kind: Scene3DObject['kind']; readonly assetId?: string }) => {
+      const id = `object-${crypto.randomUUID().slice(0, 8)}`;
+      const object: Scene3DObject = {
+        id,
+        name: input.kind === 'model' ? 'Model' : input.kind[0]!.toUpperCase() + input.kind.slice(1),
+        kind: input.kind,
+        transform: {
+          position: { x: 0, y: 0, z: 0 },
+          rotation: { x: 0, y: 0, z: 0 },
+          scale: { x: 1, y: 1, z: 1 },
+        },
+        ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
+        ...(input.kind === 'primitive' ? { primitive: 'box' as const } : {}),
+        ...(input.kind === 'light'
+          ? { light: { kind: 'point' as const, intensity: 1, color: '#ffffff' } }
+          : {}),
+        ...(input.kind === 'camera' ? { camera: { fieldOfViewDeg: 50, near: 0.1, far: 100 } } : {}),
+      };
+      if (input.kind === 'model' && input.assetId !== undefined) {
+        const asset = assets.find((candidate) => candidate.id === input.assetId);
+        if (asset !== undefined) {
+          const modelAsset = {
+            id: asset.id,
+            kind: 'model' as const,
+            mimeType: asset.descriptor.mimeType as 'model/gltf-binary' | 'model/gltf+json',
+            sha256: asset.sha256,
+          };
+          editor.dispatch({
+            label: 'Add model',
+            commands: [
+              { type: 'asset.upsert', payload: { asset: modelAsset } },
+              {
+                type: 'material.upsert',
+                payload: {
+                  material: { id: 'default', color: '#7c3aed', roughness: 0.55, metalness: 0.1 },
+                },
+              },
+              { type: 'object.add', payload: { object } },
+            ],
+          });
+        }
+      } else
+        editor.dispatch({
+          label: `Add ${input.kind}`,
+          commands: [{ type: 'object.add', payload: { object } }],
+        });
+      editor.selectObject(id);
+    },
+    [assets, editor],
+  );
+  const removeSelected = useCallback(() => {
+    if (editor.selectedObjectId === undefined) return;
+    editor.dispatch({
+      label: 'Delete object',
+      commands: [{ type: 'object.remove', payload: { objectId: editor.selectedObjectId } }],
+    });
+    editor.selectObject(undefined);
+  }, [editor]);
+  const close = useCallback(() => {
+    saveNow();
+    onClose();
+  }, [onClose, saveNow]);
+  const command = useMemo(
+    () => (command: Scene3DCommand) => dispatch('Inspector edit', command),
+    [dispatch],
+  );
+  return (
+    <div className="three-d-studio-overlay">
+      <header className="three-d-studio-topbar">
+        <button type="button" onClick={close}>
+          Back to Editor
+        </button>
+        <strong>{editor.document.name}</strong>
+        <span role="status">{editor.error ?? `Autosave: ${saveState}`}</span>
+        <button type="button" onClick={editor.undo} disabled={!editor.canUndo}>
+          Undo
+        </button>
+        <button type="button" onClick={editor.redo} disabled={!editor.canRedo}>
+          Redo
+        </button>
+        <button type="button" onClick={saveNow}>
+          Save
+        </button>
+      </header>
+      <div className="three-d-studio-body">
+        <ThreeDStudioHierarchy
+          document={editor.document}
+          assets={assets}
+          selectedObjectId={editor.selectedObjectId}
+          onSelect={editor.selectObject}
+          onAdd={addObject}
+          onRemove={removeSelected}
+        />
+        <main className="three-d-studio-center">
+          <ThreeDStudioCanvas
+            document={editor.document}
+            selectedObjectId={editor.selectedObjectId}
+            onSelect={editor.selectObject}
+          />
+        </main>
+        <ThreeDStudioInspector
+          document={editor.document}
+          selectedObjectId={editor.selectedObjectId}
+          onCommand={command}
+        />
+        <ThreeDStudioChat />
+      </div>
+    </div>
+  );
+}
diff --git a/apps/editor-web/src/three-d-studio/index.ts b/apps/editor-web/src/three-d-studio/index.ts
new file mode 100644
index 0000000..7250f5f
--- /dev/null
+++ b/apps/editor-web/src/three-d-studio/index.ts
@@ -0,0 +1,6 @@
+export { ThreeDStudioShell } from './ThreeDStudioShell.js';
+export type { ThreeDStudioShellProps } from './ThreeDStudioShell.js';
+export { ThreeDStudioCanvas } from './ThreeDStudioCanvas.js';
+export { ThreeDStudioHierarchy } from './ThreeDStudioHierarchy.js';
+export { ThreeDStudioInspector } from './ThreeDStudioInspector.js';
+export { ThreeDStudioChat } from './ThreeDStudioChat.js';
diff --git a/apps/editor-web/src/three-d-studio/state/index.ts b/apps/editor-web/src/three-d-studio/state/index.ts
new file mode 100644
index 0000000..550cec5
--- /dev/null
+++ b/apps/editor-web/src/three-d-studio/state/index.ts
@@ -0,0 +1,2 @@
+export { useThreeDSceneEditor, transformCommand } from './useThreeDSceneEditor.js';
+export type { ThreeDSceneEditorState } from './useThreeDSceneEditor.js';
diff --git a/apps/editor-web/src/three-d-studio/state/useThreeDSceneEditor.test.ts b/apps/editor-web/src/three-d-studio/state/useThreeDSceneEditor.test.ts
new file mode 100644
index 0000000..7339036
--- /dev/null
+++ b/apps/editor-web/src/three-d-studio/state/useThreeDSceneEditor.test.ts
@@ -0,0 +1,60 @@
+import { describe, expect, it } from 'vitest';
+import {
+  applyScene3DTransaction,
+  emptyScene3D,
+  IDENTITY_3D_TRANSFORM,
+} from '@joy-media/scene3d-core';
+
+describe('3D studio command boundary', () => {
+  it('keeps a compound edit atomic and invertible', () => {
+    const scene = emptyScene3D('scene-1');
+    const object = {
+      id: 'box',
+      name: 'Box',
+      kind: 'primitive' as const,
+      primitive: 'box' as const,
+      transform: IDENTITY_3D_TRANSFORM,
+    };
+    const applied = applyScene3DTransaction(scene, {
+      label: 'Add box',
+      commands: [{ type: 'object.add', payload: { object } }],
+    });
+    expect(applied.document.objects.box).toEqual(object);
+    expect(applyScene3DTransaction(applied.document, applied.record.inverses).document).toEqual(
+      scene,
+    );
+  });
+
+  it('rejects a reparenting cycle at the durable validation boundary', () => {
+    const scene = emptyScene3D('scene-1');
+    const result = applyScene3DTransaction(scene, {
+      label: 'Bad hierarchy',
+      commands: [
+        {
+          type: 'object.add',
+          payload: {
+            object: { id: 'a', name: 'A', kind: 'empty', transform: IDENTITY_3D_TRANSFORM },
+          },
+        },
+        {
+          type: 'object.add',
+          payload: {
+            object: {
+              id: 'b',
+              name: 'B',
+              kind: 'empty',
+              parentId: 'a',
+              transform: IDENTITY_3D_TRANSFORM,
+            },
+          },
+        },
+      ],
+    });
+    expect(() =>
+      applyScene3DTransaction(result.document, {
+        label: 'cycle',
+        commands: [{ type: 'object.setParent', payload: { objectId: 'a', parentId: 'b' } }],
+      }),
+    ).toThrow('cycle');
+  });
+});
diff --git a/apps/editor-web/src/three-d-studio/state/useThreeDSceneEditor.ts b/apps/editor-web/src/three-d-studio/state/useThreeDSceneEditor.ts
new file mode 100644
index 0000000..fa7d193
--- /dev/null
+++ b/apps/editor-web/src/three-d-studio/state/useThreeDSceneEditor.ts
@@ -0,0 +1,97 @@
+import { useCallback, useRef, useState } from 'react';
+import {
+  applyScene3DTransaction,
+  type Scene3DCommand,
+  type Scene3DDocumentV1,
+  type Scene3DTransaction,
+} from '@joy-media/scene3d-core';
+
+interface HistoryEntry {
+  readonly transaction: Scene3DTransaction;
+  readonly inverse: Scene3DTransaction;
+}
+
+export interface ThreeDSceneEditorState {
+  readonly document: Scene3DDocumentV1;
+  readonly selectedObjectId?: string;
+  readonly error?: string;
+  readonly canUndo: boolean;
+  readonly canRedo: boolean;
+  readonly selectObject: (objectId: string | undefined) => void;
+  readonly dispatch: (transaction: Scene3DTransaction) => boolean;
+  readonly undo: () => void;
+  readonly redo: () => void;
+}
+
+export function useThreeDSceneEditor(initial: Scene3DDocumentV1): ThreeDSceneEditorState {
+  const documentRef = useRef(initial);
+  const [document, setDocument] = useState(initial);
+  const [selectedObjectId, setSelectedObjectId] = useState<string | undefined>(undefined);
+  const [error, setError] = useState<string | undefined>(undefined);
+  const undoRef = useRef<HistoryEntry[]>([]);
+  const redoRef = useRef<HistoryEntry[]>([]);
+  const commit = useCallback((next: Scene3DDocumentV1) => {
+    documentRef.current = next;
+    setDocument(next);
+  }, []);
+  const dispatch = useCallback(
+    (transaction: Scene3DTransaction): boolean => {
+      try {
+        const result = applyScene3DTransaction(documentRef.current, transaction);
+        commit(result.document);
+        undoRef.current = [...undoRef.current, { transaction, inverse: result.record.inverses }];
+        redoRef.current = [];
+        setError(undefined);
+        return true;
+      } catch (cause) {
+        setError(cause instanceof Error ? cause.message : String(cause));
+        return false;
+      }
+    },
+    [commit],
+  );
+  const undo = useCallback(() => {
+    const entry = undoRef.current.pop();
+    if (entry === undefined) return;
+    const result = applyScene3DTransaction(documentRef.current, entry.inverse);
+    commit(result.document);
+    redoRef.current = [
+      ...redoRef.current,
+      { transaction: entry.transaction, inverse: result.record.inverses },
+    ];
+    setError(undefined);
+  }, [commit]);
+  const redo = useCallback(() => {
+    const entry = redoRef.current.pop();
+    if (entry === undefined) return;
+    const result = applyScene3DTransaction(documentRef.current, entry.transaction);
+    commit(result.document);
+    undoRef.current = [
+      ...undoRef.current,
+      { transaction: entry.transaction, inverse: result.record.inverses },
+    ];
+    setError(undefined);
+  }, [commit]);
+  const selectObject = useCallback(
+    (objectId: string | undefined) => setSelectedObjectId(objectId),
+    [],
+  );
+  return {
+    document,
+    ...(selectedObjectId === undefined ? {} : { selectedObjectId }),
+    ...(error === undefined ? {} : { error }),
+    canUndo: undoRef.current.length > 0,
+    canRedo: redoRef.current.length > 0,
+    selectObject,
+    dispatch,
+    undo,
+    redo,
+  };
+}
+
+export function transformCommand(
+  objectId: string,
+  transform: Scene3DDocumentV1['objects'][string]['transform'],
+): Scene3DCommand {
+  return { type: 'object.setTransform', payload: { objectId, transform } };
+}
diff --git a/apps/editor-web/tsconfig.json b/apps/editor-web/tsconfig.json
index 22e81a8..3398f89 100644
--- a/apps/editor-web/tsconfig.json
+++ b/apps/editor-web/tsconfig.json
@@ -67,18 +67,21 @@
     },
     {
       "path": "../../packages/workflow-engine"
     },
     {
       "path": "../../packages/plugin-sdk"
     },
     {
       "path": "../../packages/audio-core"
     },
+    {
+      "path": "../../packages/scene3d-core"
+    },
     {
       "path": "../../packages/transition-shaders"
     },
     {
       "path": "../../packages/renderer-pixi"
     }
   ]
 }
diff --git a/packages/scene3d-core/src/commands.test.ts b/packages/scene3d-core/src/commands.test.ts
index f288d82..347fdd9 100644
--- a/packages/scene3d-core/src/commands.test.ts
+++ b/packages/scene3d-core/src/commands.test.ts
@@ -77,11 +77,29 @@ describe('scene3d commands', () => {
           { type: 'object.add', payload: { object: model } },
           {
             type: 'object.setTransform',
             payload: { objectId: 'missing', transform: IDENTITY_3D_TRANSFORM },
           },
         ],
       }),
     ).toThrow('missing');
     expect(base.objects).toEqual({});
   });
+
+  it('registers opaque model assets before adding a model object and undoes both', () => {
+    const asset = {
+      id: 'model-asset',
+      kind: 'model' as const,
+      mimeType: 'model/gltf-binary' as const,
+    };
+    const object: Scene3DObject = { ...model, id: 'model-2', assetId: asset.id };
+    const result = applyScene3DTransaction(base, {
+      label: 'Add registered model',
+      commands: [
+        { type: 'asset.upsert', payload: { asset } },
+        { type: 'object.add', payload: { object } },
+      ],
+    });
+    expect(result.document.assets[asset.id]).toEqual(asset);
+    expect(applyScene3DTransaction(result.document, result.record.inverses).document).toEqual(base);
+  });
 });
diff --git a/packages/scene3d-core/src/commands.ts b/packages/scene3d-core/src/commands.ts
index c634da3..11997e4 100644
--- a/packages/scene3d-core/src/commands.ts
+++ b/packages/scene3d-core/src/commands.ts
@@ -1,31 +1,38 @@
 import { assertValidScene3DDocument, validateScene3DDocument } from './validation.js';
 import type {
   Scene3DDocumentV1,
+  Scene3DAssetRef,
   Scene3DEnvironment,
   Scene3DMaterial,
   Scene3DObject,
   Scene3DTransform,
 } from './scene.js';
 
 export type Scene3DCommand =
   | { readonly type: 'object.add'; readonly payload: { readonly object: Scene3DObject } }
   | { readonly type: 'object.remove'; readonly payload: { readonly objectId: string } }
   | {
       readonly type: 'object.setTransform';
       readonly payload: { readonly objectId: string; readonly transform: Scene3DTransform };
     }
+  | {
+      readonly type: 'object.setParent';
+      readonly payload: { readonly objectId: string; readonly parentId?: string };
+    }
   | {
       readonly type: 'object.setMaterial';
       readonly payload: { readonly objectId: string; readonly materialId?: string };
     }
   | { readonly type: 'material.upsert'; readonly payload: { readonly material: Scene3DMaterial } }
+  | { readonly type: 'asset.upsert'; readonly payload: { readonly asset: Scene3DAssetRef } }
+  | { readonly type: 'asset.remove'; readonly payload: { readonly assetId: string } }
   | { readonly type: 'material.remove'; readonly payload: { readonly materialId: string } }
   | {
       readonly type: 'scene.setEnvironment';
       readonly payload: { readonly environment: Scene3DEnvironment };
     }
   | { readonly type: 'scene.setActiveCamera'; readonly payload: { readonly cameraId?: string } };
 export interface Scene3DTransaction {
   readonly label: string;
   readonly commands: readonly Scene3DCommand[];
 }
@@ -105,20 +112,52 @@ function applyScene3DCommandUnchecked(
           ...document.objects,
           [object.id]: { ...object, transform: command.payload.transform },
         },
       },
       inverse: {
         type: 'object.setTransform',
         payload: { objectId: object.id, transform: object.transform },
       },
     };
   }
+  if (command.type === 'object.setParent') {
+    const object = document.objects[command.payload.objectId];
+    if (object === undefined)
+      throw new RangeError(`object "${command.payload.objectId}" does not exist`);
+    const parentId = command.payload.parentId;
+    if (parentId !== undefined && document.objects[parentId] === undefined)
+      throw new RangeError(`parent "${parentId}" does not exist`);
+    if (parentId === object.id) throw new RangeError('object cannot parent itself');
+    let current = parentId;
+    while (current !== undefined) {
+      if (current === object.id) throw new RangeError('object hierarchy contains a cycle');
+      current = document.objects[current]?.parentId;
+    }
+    const nextObject =
+      parentId === undefined
+        ? (() => {
+            const withoutParent = { ...object };
+            delete withoutParent.parentId;
+            return withoutParent;
+          })()
+        : { ...object, parentId };
+    return {
+      document: { ...document, objects: { ...document.objects, [object.id]: nextObject } },
+      inverse: {
+        type: 'object.setParent',
+        payload: {
+          objectId: object.id,
+          ...(object.parentId === undefined ? {} : { parentId: object.parentId }),
+        },
+      },
+    };
+  }
   if (command.type === 'object.setMaterial') {
     const object = document.objects[command.payload.objectId];
     if (object === undefined)
       throw new RangeError(`object "${command.payload.objectId}" does not exist`);
     const nextObject =
       command.payload.materialId === undefined
         ? (() => {
             const objectWithoutMaterial = { ...object };
             delete objectWithoutMaterial.materialId;
             return objectWithoutMaterial;
@@ -144,20 +183,46 @@ function applyScene3DCommandUnchecked(
           ...document.materials,
           [command.payload.material.id]: command.payload.material,
         },
       },
       inverse:
         previous === undefined
           ? { type: 'material.remove', payload: { materialId: command.payload.material.id } }
           : { type: 'material.upsert', payload: { material: previous } },
     };
   }
+  if (command.type === 'asset.upsert') {
+    const previous = document.assets[command.payload.asset.id];
+    return {
+      document: {
+        ...document,
+        assets: { ...document.assets, [command.payload.asset.id]: command.payload.asset },
+      },
+      inverse:
+        previous === undefined
+          ? { type: 'asset.remove', payload: { assetId: command.payload.asset.id } }
+          : { type: 'asset.upsert', payload: { asset: previous } },
+    };
+  }
+  if (command.type === 'asset.remove') {
+    const asset = document.assets[command.payload.assetId];
+    if (asset === undefined)
+      throw new RangeError(`asset "${command.payload.assetId}" does not exist`);
+    if (Object.values(document.objects).some((object) => object.assetId === asset.id))
+      throw new RangeError('asset is still referenced');
+    const assets = { ...document.assets };
+    delete assets[asset.id];
+    return {
+      document: { ...document, assets },
+      inverse: { type: 'asset.upsert', payload: { asset } },
+    };
+  }
   if (command.type === 'material.remove') {
     const material = document.materials[command.payload.materialId];
     if (material === undefined)
       throw new RangeError(`material "${command.payload.materialId}" does not exist`);
     if (Object.values(document.objects).some((object) => object.materialId === material.id))
       throw new RangeError('material is still referenced');
     const materials = { ...document.materials };
     delete materials[material.id];
     return {
       document: { ...document, materials },
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 938aea7..1ce6ab0 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -116,20 +116,23 @@ importers:
         version: link:../../packages/render-ir
       '@joy-media/render-planner':
         specifier: workspace:*
         version: link:../../packages/render-planner
       '@joy-media/renderer-headless':
         specifier: workspace:*
         version: link:../../packages/renderer-headless
       '@joy-media/renderer-pixi':
         specifier: workspace:*
         version: link:../../packages/renderer-pixi
+      '@joy-media/scene3d-core':
+        specifier: workspace:*
+        version: link:../../packages/scene3d-core
       '@joy-media/test-fixtures':
         specifier: workspace:*
         version: link:../../packages/test-fixtures
       '@joy-media/timeline-engine':
         specifier: workspace:*
         version: link:../../packages/timeline-engine
       '@joy-media/transition-shaders':
         specifier: workspace:*
         version: link:../../packages/transition-shaders
       '@joy-media/visual-effects':
@@ -1181,20 +1184,21 @@ packages:
 
   '@vitest/utils@3.2.7':
     resolution: {integrity: sha512-x6BDOd7dyo3PFLY3I9/HJ25X/6OurhGXk2/B9gOZNPF7XDVjeBK4k01lQE5uvDpbuheErh91qYuE1E2OEjK3Rw==}
 
   '@webgpu/types@0.1.71':
     resolution: {integrity: sha512-mMy8/ODcKhab808co15eW+yN+HgXoQxRQHTiBV9Mrvl1r0ufnid7YOcI+gi4eUWSWl9ezD6TW2KXccrL8HCh2A==}
 
   '@xmldom/xmldom@0.8.13':
     resolution: {integrity: sha512-KRYzxepc14G/CEpEGc3Yn+JKaAeT63smlDr+vjB8jRfgTBBI9wRj/nkQEO+ucV8p8I9bfKLWp37uHgFrbntPvw==}
     engines: {node: '>=10.0.0'}
+    deprecated: this version has critical issues, please update to the latest version
 
   acorn-jsx@5.3.2:
     resolution: {integrity: sha512-rq9s+JNhf0IChjtDXxllJ7g41oZk5SlXtp0LHwyA5cejwn7vKmKp4pPri6YEePv2PU65sAsegbXtIinmDFDXgQ==}
     peerDependencies:
       acorn: ^6.0.0 || ^7.0.0 || ^8.0.0
 
   acorn@8.17.0:
     resolution: {integrity: sha512-xRQbDb9BnwDafYNn6Vwl839DYVjqXYb1XVGtWAZ1kcDc6iwAL4hg3B1dZlRiuENFeO2H53gFG3in621AdERVAg==}
     engines: {node: '>=0.4.0'}
     hasBin: true
