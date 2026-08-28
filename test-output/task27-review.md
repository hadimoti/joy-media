# Review package: 43e531a..405a2d2

## Commits
405a2d2 feat(motion): certify and close production Motion Studio seams

## Files changed
 apps/editor-web/src/App.tsx                        |  27 +
 apps/editor-web/src/MotionPanel.tsx                | 310 ++++++-----
 .../src/motion-studio/MotionStudioCanvas.test.tsx  |  59 +++
 .../src/motion-studio/MotionStudioCanvas.tsx       | 233 ++++++--
 .../motion-studio/MotionStudioInspector.test.tsx   |  57 ++
 .../src/motion-studio/MotionStudioInspector.tsx    | 587 ++++++++++++++++++---
 .../src/motion-studio/MotionStudioShell.tsx        |  60 ++-
 .../motion-studio/MotionStudioTimeline.test.tsx    | 135 +++++
 .../src/motion-studio/MotionStudioTimeline.tsx     | 122 ++++-
 .../src/motion-studio/motionScenePlacement.ts      | 128 +++++
 .../src/motion-studio/state/layerFactory.ts        |  58 +-
 .../src/motion-studio/state/useSceneEditor.test.ts |  47 ++
 packages/production-quality/src/preflight.ts       |  13 +-
 packages/project-schema/src/v1.test.ts             |  52 ++
 packages/project-schema/src/v1.ts                  |  39 +-
 packages/property-system/src/index.test.ts         |  33 ++
 packages/property-system/src/index.ts              |  49 +-
 packages/render-planner/src/plan-frame.ts          |  25 +-
 packages/render-planner/src/render-bundle.ts       |  29 +-
 packages/render-planner/src/types.ts               |   6 +-
 packages/visual-object-renderer/src/index.test.ts  |  17 +
 packages/visual-object-renderer/src/index.ts       |   5 +-
 22 files changed, 1775 insertions(+), 316 deletions(-)

## Diff
diff --git a/apps/editor-web/src/App.tsx b/apps/editor-web/src/App.tsx
index cf0df98..5be677c 100644
--- a/apps/editor-web/src/App.tsx
+++ b/apps/editor-web/src/App.tsx
@@ -75,20 +75,21 @@ import {
   loadActiveProjectId,
   saveActiveProjectId,
   upsertCatalogProject,
   type ProjectCatalogEntry,
 } from './project-catalog.js';
 import { createBlankProjectDocuments, seedsForCatalogEntry } from './project-factory.js';
 import { CaptionsPanel } from './CaptionsPanel.js';
 import { InspectorPanel } from './InspectorPanel.js';
 import { MotionPanel } from './MotionPanel.js';
 import { MotionStudioShell } from './motion-studio/index.js';
+import { buildMotionScenePlacementPlan } from './motion-studio/motionScenePlacement.js';
 import { EffectStudioShell } from './effect-studio/index.js';
 import { CameraPanel } from './CameraPanel.js';
 import { JobsPanel } from './JobsPanel.js';
 import { AssetLibraryPanel } from './AssetLibraryPanel.js';
 import {
   BrowserControlPlaneClient,
   type BrowserAsset,
   type BrowserDerivative,
 } from './control-plane-client.js';
 import { AudioPanel } from './AudioPanel.js';
@@ -389,20 +390,21 @@ interface EditorPanelContextValue {
     value: number,
   ) => void;
   readonly dispatchProject: (transaction: VisualObjectTransaction) => void;
   readonly replaceVisualProject: (next: JoyProjectV1) => void;
   readonly addStickerFromAsset: (asset: {
     readonly assetId: string;
     readonly displayName?: string;
     readonly blob?: Blob;
   }) => Promise<void>;
   readonly addHtmlSceneToSelectedClip: (scenePackageId: string) => void;
+  readonly addMotionSceneToSelectedClip: (motionSceneId: string) => void;
   readonly stickerTick: number;
   readonly audioState: AudioState;
   readonly setAudioState: (next: AudioState, label?: string) => void;
   readonly transcribe: (documentId: string, language: 'fa-IR' | 'en-US') => Promise<void>;
   readonly transcriptionError: string | undefined;
   readonly undo: () => void;
   readonly redo: () => void;
   readonly jumpToHistory: (sequence: number) => void;
   /**
    * Dockview keeps panel component instances alive, so panel-only runtime
@@ -1388,20 +1390,43 @@ function EditorWorkspace({
         label: `Place HTML scene ${scenePackageId}`,
         commands: timelineCommands,
       });
       session.replaceVisualProject(bindClipToObject(session.visualProject, clipId, objectId));
       setState((current) => ({ ...current, selectedIds: [clipId] }));
       setRevision((revision) => revision + 1);
     },
     [session, state.selectedIds],
   );
 
+  const addMotionSceneToSelectedClip = useCallback(
+    (motionSceneId: string) => {
+      const composition = session.timelineProject.compositions.root;
+      if (composition === undefined) return;
+      const plan = buildMotionScenePlacementPlan({
+        composition,
+        visualProject: session.visualProject,
+        selectedClipId: state.selectedIds[0],
+        motionSceneId,
+        nowMs: Date.now(),
+      });
+      if (plan === undefined) return;
+      session.dispatchVisualObjects(plan.visualTransaction);
+      session.dispatchTimeline(plan.timelineTransaction);
+      session.replaceVisualProject(
+        bindClipToObject(session.visualProject, plan.clipId, plan.objectId),
+      );
+      setState((current) => ({ ...current, selectedIds: [plan.clipId] }));
+      setRevision((revision) => revision + 1);
+    },
+    [session, state.selectedIds],
+  );
+
   const setAudioState = useCallback(
     (next: AudioState) => {
       setAudioStateRaw(next);
       saveAudioState(projectId, next);
       session.replaceVisualProject(withProjectAudio(session.visualProject, next));
       setRevision((revision) => revision + 1);
     },
     [projectId, session],
   );
 
@@ -2467,20 +2492,21 @@ function EditorWorkspace({
           object={object}
           allObjects={visualProject.visualObjects}
           compositionDurationUs={
             context.timelineProject.compositions.root?.durationUs ?? 30_000_000
           }
           playheadUs={state.playheadUs}
           onSeek={context.seek}
           onDispatch={context.dispatchProject}
           {...(state.selectedIds[0] !== undefined ? { selectedClipId: state.selectedIds[0] } : {})}
           onAddHtmlSceneToSelection={context.addHtmlSceneToSelectedClip}
+          onAddMotionSceneToSelection={context.addMotionSceneToSelectedClip}
         />
       );
     }
     if (api.id === 'camera') {
       const composition = visualProject.compositions[visualProject.rootCompositionId];
       if (composition === undefined) return <p>Main composition is missing.</p>;
       return (
         <CameraPanel
           allObjects={visualProject.visualObjects}
           composition={composition}
@@ -3293,20 +3319,21 @@ function EditorWorkspace({
               selectedIds: toggleSelection({ clipIds: current.selectedIds }, id).clipIds,
             })),
           selectClips,
           clearSelection: () => setState((current) => ({ ...current, selectedIds: [] })),
           dispatchTimeline,
           updateVisualProperty,
           dispatchProject,
           replaceVisualProject,
           addStickerFromAsset,
           addHtmlSceneToSelectedClip,
+          addMotionSceneToSelectedClip,
           stickerTick,
           audioState,
           setAudioState,
           transcribe,
           transcriptionError,
           undo,
           redo,
           jumpToHistory,
           session,
           activatePanel,
diff --git a/apps/editor-web/src/MotionPanel.tsx b/apps/editor-web/src/MotionPanel.tsx
index bfa0d66..313f7ea 100644
--- a/apps/editor-web/src/MotionPanel.tsx
+++ b/apps/editor-web/src/MotionPanel.tsx
@@ -71,20 +71,21 @@ import {
 
 interface MotionPanelProps {
   readonly object: VisualObjectV1 | undefined;
   readonly allObjects: Readonly<Record<string, VisualObjectV1>>;
   readonly compositionDurationUs: number;
   readonly playheadUs: number;
   readonly onSeek: (timeUs: number) => void;
   readonly onDispatch: (transaction: VisualObjectTransaction) => void;
   readonly selectedClipId?: string;
   readonly onAddHtmlSceneToSelection: (sceneId: FirstPartySceneId) => void;
+  readonly onAddMotionSceneToSelection: (sceneId: string) => void;
 }
 
 const LANE_WIDTH = 280;
 const PRESET_DURATION_US = 1_000_000;
 const LIVE_TILE_W = 90;
 const LIVE_TILE_H = 160;
 const INFO_PREVIEW_W = 168;
 const INFO_PREVIEW_H = 298;
 const LIVE_LOOP_MS = 3_200;
 
@@ -125,21 +126,25 @@ const IDLE_OBJECT: VisualObjectV1 = {
     x: 0,
     y: 0,
     scaleX: 1,
     scaleY: 1,
     rotationDeg: 0,
     opacity: 1,
     crop: { left: 0, top: 0, right: 0, bottom: 0 },
   },
 };
 
-const LIBRARY_SUBTABS: readonly { readonly id: LibrarySubtab; readonly label: string; readonly iconUrl: string }[] = [
+const LIBRARY_SUBTABS: readonly {
+  readonly id: LibrarySubtab;
+  readonly label: string;
+  readonly iconUrl: string;
+}[] = [
   { id: 'my-motions', label: 'My Motions', iconUrl: iconUrl('24_my-media.png') },
   { id: 'library', label: 'Library', iconUrl: iconUrl('24_library.png') },
   { id: 'html-scenes', label: 'Scenes', iconUrl: iconUrl('24_scenes.png') },
   { id: 'presets', label: 'Presets', iconUrl: iconUrl('24_presets.png') },
   { id: 'spatial', label: 'Spatial', iconUrl: iconUrl('24_spatial.png') },
 ];
 
 /* ─── Motion Card ─── */
 
 /**
@@ -340,23 +345,21 @@ function LibraryTab({
     return matching.filter((motion) => !favorites.has(motion.id));
   }, [matching, favorites, favoritesOnly]);
 
   const builtinRest = useMemo(() => rest.filter((motion) => motion.source === 'built-in'), [rest]);
   const userRest = useMemo(() => rest.filter((motion) => motion.source !== 'built-in'), [rest]);
 
   return (
     <div className="motion-library">
       <div className="motion-library-scroll">
         {filtered.length === 0 && rest.length === 0 ? (
-          <p className="motion-library-empty">
-            No motions available.
-          </p>
+          <p className="motion-library-empty">No motions available.</p>
         ) : (
           <>
             {filtered.length > 0 && (
               <MotionLibrarySection
                 motions={filtered}
                 label={favoritesOnly ? 'Favorites' : 'Favorited'}
                 emptyMessage=""
                 favorites={favorites}
                 onToggleFavorite={onToggleFavorite}
                 onOpenMotion={onOpenMotion}
@@ -390,26 +393,28 @@ function LibraryTab({
       </div>
     </div>
   );
 }
 
 /* ─── My Motions tab: the user's own MotionSceneDocuments (Motion Studio's library) ─── */
 
 function MotionSceneCard({
   entry,
   onOpen,
+  onPlace,
   onRename,
   onDuplicate,
   onDelete,
 }: {
   readonly entry: MotionSceneCatalogEntry;
   readonly onOpen: (id: string) => void;
+  readonly onPlace: (id: string) => void;
   readonly onRename: (id: string, title: string) => void;
   readonly onDuplicate: (id: string) => void;
   readonly onDelete: (id: string) => void;
 }) {
   return (
     <div className="motion-card" role="listitem">
       <div className="motion-card-preview" aria-hidden="true">
         <div className="motion-scene-card-swatch" />
         <span className="motion-card-duration">{(entry.durationMs / 1000).toFixed(1)}s</span>
       </div>
@@ -425,20 +430,34 @@ function MotionSceneCard({
       <div className="motion-card-actions">
         <button
           type="button"
           className="icon-button"
           aria-label={`Open ${entry.title}`}
           title={`Open · ${entry.title}`}
           onClick={() => onOpen(entry.id)}
         >
           <InfoIcon />
         </button>
+        <button
+          type="button"
+          className="icon-button"
+          aria-label={`Place ${entry.title} on the timeline`}
+          title={
+            entry.publishedAt === undefined
+              ? 'Publish this motion before placing it'
+              : 'Place on timeline'
+          }
+          disabled={entry.publishedAt === undefined}
+          onClick={() => onPlace(entry.id)}
+        >
+          <PlusIcon />
+        </button>
         <button
           type="button"
           className="icon-button"
           aria-label={`Rename ${entry.title}`}
           title="Rename"
           onClick={() => {
             const next = window.prompt('Rename motion', entry.title);
             if (next !== null && next.trim().length > 0) onRename(entry.id, next.trim());
           }}
         >
@@ -452,64 +471,67 @@ function MotionSceneCard({
           onClick={() => onDuplicate(entry.id)}
         >
           <DuplicateIcon />
         </button>
         <button
           type="button"
           className="icon-button"
           aria-label={`Delete ${entry.title}`}
           title="Delete"
           onClick={() => {
-            if (window.confirm(`Remove “${entry.title}” from your motions? This can't be undone.`)) {
+            if (
+              window.confirm(`Remove “${entry.title}” from your motions? This can't be undone.`)
+            ) {
               onDelete(entry.id);
             }
           }}
         >
           <TrashIcon />
         </button>
       </div>
     </div>
   );
 }
 
 function MyMotionsTab({
   entries,
   onOpen,
+  onPlace,
   onRename,
   onDuplicate,
   onDelete,
 }: {
   readonly entries: readonly MotionSceneCatalogEntry[];
   readonly onOpen: (id: string) => void;
+  readonly onPlace: (id: string) => void;
   readonly onRename: (id: string, title: string) => void;
   readonly onDuplicate: (id: string) => void;
   readonly onDelete: (id: string) => void;
 }) {
   if (entries.length === 0) {
     return (
       <div className="motion-library">
-        <p className="motion-library-empty">
-          You have not created a motion yet. Tap + to start.
-        </p>
+        <p className="motion-library-empty">You have not created a motion yet. Tap + to start.</p>
       </div>
     );
   }
   return (
     <div className="motion-library">
       <div className="motion-library-scroll">
         <section className="motion-library-section">
           <div className="motion-library-grid" role="list" aria-label="My Motions">
             {entries.map((entry) => (
               <MotionSceneCard
                 key={entry.id}
                 entry={entry}
                 onOpen={onOpen}
+                onPlace={onPlace}
                 onRename={onRename}
                 onDuplicate={onDuplicate}
                 onDelete={onDelete}
               />
             ))}
           </div>
         </section>
       </div>
     </div>
   );
@@ -665,23 +687,21 @@ function HtmlSceneInfoPanel({ scene }: { readonly scene: FirstPartyScenePackage
         <div>
           <dt>Preview focus</dt>
           <dd dir="ltr">
             x {focus.x.toFixed(2)} · y {focus.y.toFixed(2)} · w {focus.w.toFixed(2)} · h{' '}
             {focus.h.toFixed(2)}
           </dd>
         </div>
       </dl>
       <h4 className="html-scene-info-vars-title">Variables</h4>
       {Object.keys(scene.variableSchema).length === 0 ? (
-        <p className="html-scene-info-empty">
-          No variables.
-        </p>
+        <p className="html-scene-info-empty">No variables.</p>
       ) : (
         <ul className="html-scene-info-vars">
           {Object.entries(scene.variableSchema).map(([key, def]) => (
             <li key={key}>
               <span className="html-scene-info-var-key" dir="ltr">
                 {key}
               </span>
               <span className="html-scene-info-var-meta">
                 {def.label ?? key} · {def.type} · default{' '}
                 <code dir="ltr">{String(def.default)}</code>
@@ -969,23 +989,21 @@ function SpatialPathPreview({
 }: {
   readonly object: VisualObjectV1;
   readonly duration: number;
   readonly playheadUs: number;
 }) {
   const xCurve = object.animations?.x;
   const yCurve = object.animations?.y;
   if (xCurve === undefined || yCurve === undefined) {
     return (
       <section className="motion-spatial">
-        <p className="empty-hint">
-          Animate both X and Y to preview a 2D motion path.
-        </p>
+        <p className="empty-hint">Animate both X and Y to preview a 2D motion path.</p>
       </section>
     );
   }
   const samples = 48;
   const points: { x: number; y: number }[] = [];
   for (let i = 0; i <= samples; i += 1) {
     const t = (duration * i) / samples;
     points.push({ x: sampleCurve(xCurve, t), y: sampleCurve(yCurve, t) });
   }
   const xs = points.map((p) => p.x);
@@ -1018,20 +1036,21 @@ function SpatialPathPreview({
 
 export function MotionPanel({
   object,
   allObjects,
   compositionDurationUs,
   playheadUs,
   onSeek,
   onDispatch,
   selectedClipId,
   onAddHtmlSceneToSelection,
+  onAddMotionSceneToSelection,
 }: MotionPanelProps) {
   const [subtab, setSubtab] = useState<LibrarySubtab>('my-motions');
   const [graphChannel, setGraphChannel] = useState<AnimatablePropertyV1 | undefined>(undefined);
   const [presetId, setPresetId] = useState<string>(JOY_MOTION_PRESETS[0]!.id);
   const [favorites, setFavorites] = useState<Set<string>>(loadFavorites);
   const [favoritesOnly, setFavoritesOnly] = useState(false);
   // Was `searchOpen` plus a ref, driving an input with no value/onChange — the
   // box rendered and filtered nothing. PanelShell owns the toggle now and this
   // is the query it feeds.
   const [query, setQuery] = useState('');
@@ -1055,20 +1074,24 @@ export function MotionPanel({
   // myMotionsTick is the refresh signal; window.localStorage's identity never changes.
   const myMotions = useMemo(() => listCatalogScenes(window.localStorage), [myMotionsTick]);
 
   const createMotion = useCallback(() => {
     const scene = createMotionScene(window.localStorage, `Untitled Motion ${myMotions.length + 1}`);
     setMyMotionsTick((tick) => tick + 1);
     openMotionStudio(scene.id);
   }, [myMotions.length, openMotionStudio]);
 
   const openMySceneMotion = useCallback((id: string) => openMotionStudio(id), [openMotionStudio]);
+  const placeMySceneMotion = useCallback(
+    (id: string) => onAddMotionSceneToSelection(id),
+    [onAddMotionSceneToSelection],
+  );
 
   const renameMySceneMotion = useCallback((id: string, title: string) => {
     renameMotionScene(window.localStorage, id, title);
     setMyMotionsTick((tick) => tick + 1);
   }, []);
 
   const duplicateMySceneMotion = useCallback(
     (id: string) => {
       const source = myMotions.find((entry) => entry.id === id);
       duplicateMotionScene(window.localStorage, id, `${source?.title ?? 'Motion'} (Copy)`);
@@ -1243,20 +1266,21 @@ export function MotionPanel({
                 />
               </button>
             ))}
           </div>
         </aside>
         <div className="templates-main">
           {subtab === 'my-motions' && (
             <MyMotionsTab
               entries={myMotions}
               onOpen={openMySceneMotion}
+              onPlace={placeMySceneMotion}
               onRename={renameMySceneMotion}
               onDuplicate={duplicateMySceneMotion}
               onDelete={deleteMySceneMotion}
             />
           )}
 
           {subtab === 'library' && (
             <LibraryTab
               registry={motionRegistry}
               favorites={favorites}
@@ -1289,151 +1313,151 @@ export function MotionPanel({
                       <option key={candidate.id} value={candidate.id}>
                         {candidate.id}
                         {candidate.kind === 'null' ? ' (null)' : ''}
                       </option>
                     ))}
                   </select>
                 </label>
                 <label className="motion-field motion-field-grow">
                   Preset
                   <select
-                  value={presetId}
-                  disabled={inactive}
-                  onChange={(event) => setPresetId(event.target.value)}
-                >
-                  {JOY_MOTION_PRESETS.map((preset) => (
-                    <option key={preset.id} value={preset.id}>
-                      {preset.name}
-                    </option>
-                  ))}
-                </select>
-              </label>
-              <div className="field-action">
-                <span className="field-action-label">Apply</span>
-                <div className="field-action-row">
-                  <button
-                    type="button"
-                    className="icon-button motion-preset-apply"
-                    data-guide="Apply preset"
-                    aria-label="Apply motion preset"
+                    value={presetId}
                     disabled={inactive}
-                    onClick={applyPreset}
+                    onChange={(event) => setPresetId(event.target.value)}
                   >
-                    <CheckIcon />
-                  </button>
+                    {JOY_MOTION_PRESETS.map((preset) => (
+                      <option key={preset.id} value={preset.id}>
+                        {preset.name}
+                      </option>
+                    ))}
+                  </select>
+                </label>
+                <div className="field-action">
+                  <span className="field-action-label">Apply</span>
+                  <div className="field-action-row">
+                    <button
+                      type="button"
+                      className="icon-button motion-preset-apply"
+                      data-guide="Apply preset"
+                      aria-label="Apply motion preset"
+                      disabled={inactive}
+                      onClick={applyPreset}
+                    >
+                      <CheckIcon />
+                    </button>
+                  </div>
                 </div>
               </div>
-            </div>
-            <section className="motion-presets-channels" aria-label="Animation channels">
-              {channels.length === 0 ? (
-                <p className="motion-empty">
-                  No keyframes yet; add them in Inspector or apply a preset above.
-                </p>
-              ) : (
-                <div className="motion-lanes">
-                  {channels.map((channel) => {
-                    const curve = target.animations![channel]!;
-                    return (
-                      <div key={channel} className="motion-lane">
-                        <button
-                          type="button"
-                          className={
-                            activeGraph === channel
-                              ? 'motion-lane-label active'
-                              : 'motion-lane-label'
-                          }
-                          onClick={() => setGraphChannel(channel)}
-                          title="Show this channel in the graph"
-                        >
-                          {channel}
-                        </button>
-                        <svg
-                          className="motion-lane-track"
-                          viewBox={`0 0 ${LANE_WIDTH} 16`}
-                          width={LANE_WIDTH}
-                          height={16}
-                          role="img"
-                          aria-label={`${channel} keyframes`}
-                        >
-                          <line
-                            x1={0}
-                            y1={8}
-                            x2={LANE_WIDTH}
-                            y2={8}
-                            stroke={JOY_COLORS.border}
-                            strokeWidth={1}
-                          />
-                          <line
-                            x1={timeToX(playheadUs)}
-                            y1={0}
-                            x2={timeToX(playheadUs)}
-                            y2={16}
-                            stroke={JOY_COLORS.accent}
-                            strokeWidth={1}
-                          />
-                          {curve.keyframes.map((kf) => (
-                            <rect
-                              key={kf.timeUs}
-                              x={timeToX(kf.timeUs) - 4}
-                              y={4}
-                              width={8}
-                              height={8}
-                              transform={`rotate(45 ${timeToX(kf.timeUs)} 8)`}
-                              fill={JOY_COLORS.textMuted}
-                              style={{ cursor: 'pointer' }}
-                              onClick={() => onSeek(kf.timeUs)}
-                            >
-                              <title>{`${channel} @ ${(kf.timeUs / 1_000_000).toFixed(2)}s = ${kf.value}`}</title>
-                            </rect>
-                          ))}
-                        </svg>
-                      </div>
-                    );
-                  })}
-                </div>
+              <section className="motion-presets-channels" aria-label="Animation channels">
+                {channels.length === 0 ? (
+                  <p className="motion-empty">
+                    No keyframes yet; add them in Inspector or apply a preset above.
+                  </p>
+                ) : (
+                  <div className="motion-lanes">
+                    {channels.map((channel) => {
+                      const curve = target.animations![channel]!;
+                      return (
+                        <div key={channel} className="motion-lane">
+                          <button
+                            type="button"
+                            className={
+                              activeGraph === channel
+                                ? 'motion-lane-label active'
+                                : 'motion-lane-label'
+                            }
+                            onClick={() => setGraphChannel(channel)}
+                            title="Show this channel in the graph"
+                          >
+                            {channel}
+                          </button>
+                          <svg
+                            className="motion-lane-track"
+                            viewBox={`0 0 ${LANE_WIDTH} 16`}
+                            width={LANE_WIDTH}
+                            height={16}
+                            role="img"
+                            aria-label={`${channel} keyframes`}
+                          >
+                            <line
+                              x1={0}
+                              y1={8}
+                              x2={LANE_WIDTH}
+                              y2={8}
+                              stroke={JOY_COLORS.border}
+                              strokeWidth={1}
+                            />
+                            <line
+                              x1={timeToX(playheadUs)}
+                              y1={0}
+                              x2={timeToX(playheadUs)}
+                              y2={16}
+                              stroke={JOY_COLORS.accent}
+                              strokeWidth={1}
+                            />
+                            {curve.keyframes.map((kf) => (
+                              <rect
+                                key={kf.timeUs}
+                                x={timeToX(kf.timeUs) - 4}
+                                y={4}
+                                width={8}
+                                height={8}
+                                transform={`rotate(45 ${timeToX(kf.timeUs)} 8)`}
+                                fill={JOY_COLORS.textMuted}
+                                style={{ cursor: 'pointer' }}
+                                onClick={() => onSeek(kf.timeUs)}
+                              >
+                                <title>{`${channel} @ ${(kf.timeUs / 1_000_000).toFixed(2)}s = ${kf.value}`}</title>
+                              </rect>
+                            ))}
+                          </svg>
+                        </div>
+                      );
+                    })}
+                  </div>
+                )}
+              </section>
+              {activeGraph !== undefined && (
+                <GraphEditor
+                  object={target}
+                  channel={activeGraph}
+                  duration={duration}
+                  playheadUs={playheadUs}
+                  onSeek={onSeek}
+                  onDispatch={onDispatch}
+                />
               )}
-            </section>
-            {activeGraph !== undefined && (
-              <GraphEditor
-                object={target}
-                channel={activeGraph}
-                duration={duration}
-                playheadUs={playheadUs}
-                onSeek={onSeek}
-                onDispatch={onDispatch}
-              />
-            )}
-          </div>
-        )}
-
-        {subtab === 'spatial' && (
-          <>
-            <div className="motion-spatial-actions">
-              <button
-                type="button"
-                className="icon-button"
-                data-guide="Save spatial path"
-                aria-label="Save spatial path"
-                title="Save spatial path"
-                disabled={inactive || !canSaveSpatial}
-                onClick={saveSpatialPath}
-              >
-                <SaveIcon />
-              </button>
             </div>
-            <SpatialPathPreview object={target} duration={duration} playheadUs={playheadUs} />
-          </>
-        )}
+          )}
 
-        {subtab === 'html-scenes' && (
-          <HtmlScenesSection
-            allObjects={allObjects}
-            onDispatch={onDispatch}
-            {...(selectedClipId !== undefined ? { selectedClipId } : {})}
-            onAddHtmlSceneToSelection={onAddHtmlSceneToSelection}
-          />
-        )}
+          {subtab === 'spatial' && (
+            <>
+              <div className="motion-spatial-actions">
+                <button
+                  type="button"
+                  className="icon-button"
+                  data-guide="Save spatial path"
+                  aria-label="Save spatial path"
+                  title="Save spatial path"
+                  disabled={inactive || !canSaveSpatial}
+                  onClick={saveSpatialPath}
+                >
+                  <SaveIcon />
+                </button>
+              </div>
+              <SpatialPathPreview object={target} duration={duration} playheadUs={playheadUs} />
+            </>
+          )}
+
+          {subtab === 'html-scenes' && (
+            <HtmlScenesSection
+              allObjects={allObjects}
+              onDispatch={onDispatch}
+              {...(selectedClipId !== undefined ? { selectedClipId } : {})}
+              onAddHtmlSceneToSelection={onAddHtmlSceneToSelection}
+            />
+          )}
         </div>
       </div>
     </PanelShell>
   );
 }
diff --git a/apps/editor-web/src/motion-studio/MotionStudioCanvas.test.tsx b/apps/editor-web/src/motion-studio/MotionStudioCanvas.test.tsx
new file mode 100644
index 0000000..b1fff38
--- /dev/null
+++ b/apps/editor-web/src/motion-studio/MotionStudioCanvas.test.tsx
@@ -0,0 +1,59 @@
+import { describe, expect, it } from 'vitest';
+import { renderToStaticMarkup } from 'react-dom/server';
+import { createBlankScene } from '@joy-media/motion-core';
+import {
+  motionStudioAssetUrl,
+  MotionStudioCanvas,
+  svgContentToDataUrl,
+} from './MotionStudioCanvas.js';
+import { createImageLayer, createSvgLayer, createVideoLayer } from './state/layerFactory.js';
+
+function noop() {}
+
+describe('MotionStudioCanvas media surface', () => {
+  it('routes real image and video layers through the cloud asset content endpoint', () => {
+    expect(motionStudioAssetUrl('asset real/video 1')).toBe(
+      '/v1/library/cloud-assets/asset%20real%2Fvideo%201/content',
+    );
+    expect(motionStudioAssetUrl('asset real/video 1')).not.toContain('/api/assets/');
+  });
+
+  it('renders image, video, and SVG layers without replacing SVG content with a placeholder', () => {
+    const image = createImageLayer('asset-image-1', 'Imported Image');
+    const video = createVideoLayer('asset-video-1', 'Imported Video');
+    const svg = createSvgLayer('<svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>', 'Logo');
+    const document = { ...createBlankScene('Canvas'), layers: [image, video, svg] };
+
+    const markup = renderToStaticMarkup(
+      <MotionStudioCanvas
+        document={document}
+        selectedLayerIds={[]}
+        onSelectLayer={noop}
+        onSelectLayers={noop}
+        onToggleLayerSelection={noop}
+        onClearSelection={noop}
+        onSetLayerTransform={noop}
+        onDispatch={noop}
+        onBeginTransaction={noop}
+        onUpdateTransaction={noop}
+        onCommitTransaction={noop}
+        onCancelTransaction={noop}
+        onDuplicateSelected={noop}
+        onDeleteSelected={noop}
+        onBringToFront={noop}
+        onSendToBack={noop}
+        onGroupSelected={noop}
+        onUngroupSelected={noop}
+        onAddTextLayer={noop}
+        onAddRectangleLayer={noop}
+        onAddEllipseLayer={noop}
+        onAddImageLayer={noop}
+        onAddVideoLayer={noop}
+      />,
+    );
+
+    expect(markup).toContain('/v1/library/cloud-assets/asset-image-1/content');
+    expect(markup).toContain('/v1/library/cloud-assets/asset-video-1/content');
+    expect(markup).toContain(svgContentToDataUrl(svg.svgContent));
+  });
+});
diff --git a/apps/editor-web/src/motion-studio/MotionStudioCanvas.tsx b/apps/editor-web/src/motion-studio/MotionStudioCanvas.tsx
index 42eee87..62f763c 100644
--- a/apps/editor-web/src/motion-studio/MotionStudioCanvas.tsx
+++ b/apps/editor-web/src/motion-studio/MotionStudioCanvas.tsx
@@ -1,61 +1,73 @@
 import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
-import type { MotionFill, MotionLayer, MotionLayerId, MotionSceneDocument } from '@joy-media/motion-core';
-import { evaluateMotionScene, resolveLayerWorld, resolvedLayerOpacity, resolvedLayerTransform, type LayerWorldEvaluation } from '@joy-media/motion-core';
+import type {
+  MotionFill,
+  MotionLayer,
+  MotionLayerId,
+  MotionSceneDocument,
+} from '@joy-media/motion-core';
+import {
+  evaluateMotionScene,
+  resolveLayerWorld,
+  resolvedLayerOpacity,
+  resolvedLayerTransform,
+  type LayerWorldEvaluation,
+} from '@joy-media/motion-core';
 import { JOY_COLORS } from '../theme.js';
 import { TrashIcon, DuplicateIcon, LayersIcon, UnlockIcon, LockIcon } from '../icons.js';
 import type { SceneCommand } from './state/sceneCommands.js';
 
 interface LayerElementProps {
   readonly layer: MotionLayer;
   readonly evaluation: import('@joy-media/motion-core').LayerEvaluation | undefined;
   readonly world: import('@joy-media/motion-core').LayerWorldEvaluation | undefined;
   readonly isSelected: boolean;
   readonly editingText: boolean;
   readonly onPointerDown: (e: React.PointerEvent, layerId: MotionLayerId) => void;
   readonly onDoubleClick: (e: React.MouseEvent, layerId: MotionLayerId) => void;
   readonly onContextMenu: (e: React.MouseEvent, layerId: MotionLayerId) => void;
   readonly onTextChange: (layerId: MotionLayerId, text: string) => void;
   readonly onTextEditEnd: (layerId: MotionLayerId) => void;
 }
 
-function assetUrl(assetId: string | undefined): string {
+export function motionStudioAssetUrl(assetId: string | undefined): string {
   if (!assetId) return '';
   return `/v1/library/cloud-assets/${encodeURIComponent(assetId)}/content`;
 }
 
+export function svgContentToDataUrl(svgContent: string | undefined): string {
+  if (svgContent === undefined || svgContent.trim().length === 0) return '';
+  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`;
+}
+
 function bgToCSS(background: MotionSceneDocument['background']): string {
   switch (background.kind) {
     case 'solid':
       return background.color ?? 'transparent';
     case 'gradient': {
       const g = background.gradient;
       if (!g) return 'transparent';
-      const stops = g.stops
-        .map((s) => `${s.color} ${(s.position * 100).toFixed(1)}%`)
-        .join(', ');
+      const stops = g.stops.map((s) => `${s.color} ${(s.position * 100).toFixed(1)}%`).join(', ');
       return `linear-gradient(${g.angle ?? 90}deg, ${stops})`;
     }
     case 'image':
-      return assetUrl(background.assetId);
+      return motionStudioAssetUrl(background.assetId);
     default:
       return 'transparent';
   }
 }
 
 function fillToCSS(fill: MotionFill): string {
   if (fill.kind === 'solid') return fill.color;
   if (fill.kind === 'gradient') {
     const g = fill.gradient;
-    const stops = g.stops
-      .map((s) => `${s.color} ${(s.position * 100).toFixed(1)}%`)
-      .join(', ');
+    const stops = g.stops.map((s) => `${s.color} ${(s.position * 100).toFixed(1)}%`).join(', ');
     return `linear-gradient(${g.angle ?? 90}deg, ${stops})`;
   }
   return 'transparent';
 }
 
 function LayerElement({
   layer,
   evaluation,
   world,
   isSelected,
@@ -152,21 +164,22 @@ function LayerElement({
             display: 'flex',
             alignItems: 'flex-start',
             justifyContent: 'flex-start',
             color: layer.fills[0] ? fillToCSS(layer.fills[0]) : '#ffffff',
             fontFamily: layer.typography?.fontFamily ?? 'system-ui',
             fontSize: layer.typography?.fontSize ?? 40,
             fontWeight: layer.typography?.fontWeight ?? 400,
             lineHeight: layer.typography?.lineHeight ?? 1.2,
             letterSpacing: layer.typography?.letterSpacing ?? 0,
             textAlign: (layer.typography?.textAlign as React.CSSProperties['textAlign']) ?? 'left',
-            textTransform: (layer.typography?.textTransform as React.CSSProperties['textTransform']) ?? 'none',
+            textTransform:
+              (layer.typography?.textTransform as React.CSSProperties['textTransform']) ?? 'none',
             whiteSpace: 'pre-wrap',
             wordBreak: 'break-word',
             pointerEvents: 'none',
           }}
         >
           {layer.text ?? ''}
         </div>
       </div>
     );
   }
@@ -175,60 +188,91 @@ function LayerElement({
     const fill = layer.fills[0];
     const stroke = layer.strokes[0];
     return (
       <div {...commonProps}>
         <div
           style={{
             width: '100%',
             height: '100%',
             background: fill ? fillToCSS(fill) : 'transparent',
             border: stroke ? `${stroke.width}px solid ${stroke.color}` : 'none',
-            borderRadius: `${(layer.borderRadius[0] ?? 0)}px ${(layer.borderRadius[1] ?? 0)}px ${(layer.borderRadius[2] ?? 0)}px ${(layer.borderRadius[3] ?? 0)}px`,
+            borderRadius: `${layer.borderRadius[0] ?? 0}px ${layer.borderRadius[1] ?? 0}px ${layer.borderRadius[2] ?? 0}px ${layer.borderRadius[3] ?? 0}px`,
             pointerEvents: 'none',
           }}
         />
       </div>
     );
   }
 
   if (layer.type === 'image' || layer.type === 'video') {
     return (
       <div {...commonProps}>
         {layer.assetId ? (
           <img
-            src={assetUrl(layer.assetId)}
+            src={motionStudioAssetUrl(layer.assetId)}
             alt={layer.name}
             style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
             draggable={false}
           />
         ) : (
-          <div style={{ width: '100%', height: '100%', background: '#333', pointerEvents: 'none' }} />
+          <div
+            style={{ width: '100%', height: '100%', background: '#333', pointerEvents: 'none' }}
+          />
+        )}
+      </div>
+    );
+  }
+
+  if (layer.type === 'svg') {
+    return (
+      <div {...commonProps}>
+        {layer.svgContent ? (
+          <img
+            src={svgContentToDataUrl(layer.svgContent)}
+            alt={layer.name}
+            style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
+            draggable={false}
+          />
+        ) : (
+          <div
+            style={{ width: '100%', height: '100%', background: '#333', pointerEvents: 'none' }}
+          />
         )}
       </div>
     );
   }
 
   return (
     <div {...commonProps}>
-      <div style={{ width: '100%', height: '100%', background: 'rgba(255,255,255,0.08)', pointerEvents: 'none' }} />
+      <div
+        style={{
+          width: '100%',
+          height: '100%',
+          background: 'rgba(255,255,255,0.08)',
+          pointerEvents: 'none',
+        }}
+      />
     </div>
   );
 }
 
 export interface MotionStudioCanvasProps {
   readonly document: MotionSceneDocument;
   readonly selectedLayerIds: readonly MotionLayerId[];
   readonly onSelectLayer: (layerId: MotionLayerId | null) => void;
   readonly onSelectLayers: (layerIds: readonly MotionLayerId[]) => void;
   readonly onToggleLayerSelection: (layerId: MotionLayerId) => void;
   readonly onClearSelection: () => void;
-  readonly onSetLayerTransform: (layerId: MotionLayerId, transform: Partial<MotionLayer['transform']>) => void;
+  readonly onSetLayerTransform: (
+    layerId: MotionLayerId,
+    transform: Partial<MotionLayer['transform']>,
+  ) => void;
   readonly onDispatch: (label: string, ...commands: SceneCommand[]) => void;
   readonly onBeginTransaction: () => void;
   readonly onUpdateTransaction: (...commands: SceneCommand[]) => void;
   readonly onCommitTransaction: (label: string) => void;
   readonly onCancelTransaction: () => void;
   readonly onDuplicateSelected: () => void;
   readonly onDeleteSelected: () => void;
   readonly onBringToFront: () => void;
   readonly onSendToBack: () => void;
   readonly onGroupSelected: () => void;
@@ -257,21 +301,24 @@ interface Point {
   readonly x: number;
   readonly y: number;
 }
 
 const HANDLE_SIZE = 8;
 const ROTATE_HANDLE_OFFSET = 24;
 const SNAP_THRESHOLD = 8;
 
 function rotatedAxes(deg: number): { axisX: Point; axisY: Point } {
   const rad = (deg * Math.PI) / 180;
-  return { axisX: { x: Math.cos(rad), y: Math.sin(rad) }, axisY: { x: -Math.sin(rad), y: Math.cos(rad) } };
+  return {
+    axisX: { x: Math.cos(rad), y: Math.sin(rad) },
+    axisY: { x: -Math.sin(rad), y: Math.cos(rad) },
+  };
 }
 
 function worldToLocal(point: Point, center: Point, deg: number): Point {
   const { axisX, axisY } = rotatedAxes(deg);
   const dx = point.x - center.x;
   const dy = point.y - center.y;
   return { x: dx * axisX.x + dy * axisX.y, y: dx * axisY.x + dy * axisY.y };
 }
 
 function localToWorld(local: Point, center: Point, deg: number): Point {
@@ -304,21 +351,24 @@ export function MotionStudioCanvas({
   onAddTextLayer,
   onAddRectangleLayer,
   onAddEllipseLayer,
   onAddImageLayer,
   onAddVideoLayer,
   canvasScale = 1,
   playheadMs = 0,
 }: MotionStudioCanvasProps) {
   const stageRef = useRef<HTMLDivElement | null>(null);
   const [editingTextLayerId, setEditingTextLayerId] = useState<MotionLayerId | null>(null);
-  const evaluated = useMemo(() => evaluateMotionScene(document, playheadMs), [document, playheadMs]);
+  const evaluated = useMemo(
+    () => evaluateMotionScene(document, playheadMs),
+    [document, playheadMs],
+  );
   const layersById = useMemo(() => {
     const map: Record<string, MotionLayer> = {};
     for (const layer of document.layers) map[layer.id] = layer;
     return map;
   }, [document.layers]);
   const world = useMemo(() => {
     const map = new Map<MotionLayerId, LayerWorldEvaluation>();
     for (const layer of document.layers) {
       map.set(layer.id, resolveLayerWorld(layer, evaluated.get(layer.id), layersById));
     }
@@ -390,29 +440,35 @@ export function MotionStudioCanvas({
     }
     return null;
   }, [document.layers, selectedLayerIds]);
 
   const selectedLayers = useMemo(
     () => document.layers.filter((l) => selectedLayerIds.includes(l.id)),
     [document.layers, selectedLayerIds],
   );
 
   const commitLayerTransforms = useCallback(
-    (layerIds: readonly MotionLayerId[], transformMap: Map<MotionLayerId, MotionLayer['transform']>) => {
+    (
+      layerIds: readonly MotionLayerId[],
+      transformMap: Map<MotionLayerId, MotionLayer['transform']>,
+    ) => {
       const commands: SceneCommand[] = [];
       for (const id of layerIds) {
         const layer = document.layers.find((l) => l.id === id);
         const base = transformMap.get(id);
         if (!layer || !base) continue;
         const next = layer.transform;
         if (next !== base) {
-          commands.push({ type: 'scene.setLayerTransform', payload: { layerId: id, transform: next } });
+          commands.push({
+            type: 'scene.setLayerTransform',
+            payload: { layerId: id, transform: next },
+          });
         }
       }
       if (commands.length > 0) {
         onUpdateTransaction(...commands);
       }
     },
     [document.layers, onUpdateTransaction],
   );
 
   const computeSnap = useCallback(
@@ -423,25 +479,21 @@ export function MotionStudioCanvas({
     ): { snap: Point; guides: GuideLine[] } => {
       const threshold = SNAP_THRESHOLD / canvasScale;
       let snapX = 0;
       let snapY = 0;
       const foundGuides: GuideLine[] = [];
 
       const candidates: number[] = [];
       const addVertical = (x: number) => candidates.push(x);
       const addHorizontal = (y: number) => candidates.push(y);
 
-      const sceneTargets = [
-        document.width / 2,
-        0,
-        document.width,
-      ];
+      const sceneTargets = [document.width / 2, 0, document.width];
 
       for (const layer of movingLayers) {
         const base = transformMap.get(layer.id);
         if (!base) continue;
         const t = {
           ...base,
           x: base.x + delta.x,
           y: base.y + delta.y,
         };
         addVertical(t.x + t.width / 2);
@@ -492,25 +544,29 @@ export function MotionStudioCanvas({
         const targetH = layer.transform.y + layer.transform.height / 2;
         for (const c of candidates) {
           const diff = targetH - c;
           if (Math.abs(diff) < threshold && Math.abs(diff) > Math.abs(snapY)) {
             snapY = diff;
           }
         }
       }
 
       if (snapX !== 0) {
-        const guideX = movingLayers[0] ? movingLayers[0].transform.x + movingLayers[0].transform.width / 2 + snapX : document.width / 2;
+        const guideX = movingLayers[0]
+          ? movingLayers[0].transform.x + movingLayers[0].transform.width / 2 + snapX
+          : document.width / 2;
         foundGuides.push({ orientation: 'vertical', position: guideX });
       }
       if (snapY !== 0) {
-        const guideY = movingLayers[0] ? movingLayers[0].transform.y + movingLayers[0].transform.height / 2 + snapY : document.height / 2;
+        const guideY = movingLayers[0]
+          ? movingLayers[0].transform.y + movingLayers[0].transform.height / 2 + snapY
+          : document.height / 2;
         foundGuides.push({ orientation: 'horizontal', position: guideY });
       }
 
       return { snap: { x: snapX, y: snapY }, guides: foundGuides };
     },
     [canvasScale, document.layers, document.width, document.height],
   );
 
   const handlePointerDown = useCallback(
     (e: React.PointerEvent) => {
@@ -531,25 +587,26 @@ export function MotionStudioCanvas({
         if (!layer || layer.locked) return;
 
         if (!selectedLayerIds.includes(layerId)) {
           if (addToSelection) {
             onToggleLayerSelection(layerId);
           } else {
             onSelectLayer(layerId);
           }
         }
 
-        const selection = addToSelection && selectedLayerIds.includes(layerId)
-          ? [...selectedLayerIds]
-          : selectedLayerIds.includes(layerId) && selectedLayerIds.length > 1
+        const selection =
+          addToSelection && selectedLayerIds.includes(layerId)
             ? [...selectedLayerIds]
-            : [layerId];
+            : selectedLayerIds.includes(layerId) && selectedLayerIds.length > 1
+              ? [...selectedLayerIds]
+              : [layerId];
 
         const transforms = new Map<MotionLayerId, MotionLayer['transform']>();
         for (const id of selection) {
           const l = document.layers.find((x) => x.id === id);
           if (l) transforms.set(id, l.transform);
         }
 
         dragRef.current = {
           mode: 'move',
           layerId,
@@ -581,21 +638,31 @@ export function MotionStudioCanvas({
           altKey: e.altKey,
           metaKey: e.metaKey || e.ctrlKey,
           canvasScale,
         };
         setMarquee({ start: scenePoint, current: scenePoint });
         onBeginTransaction();
       }
 
       stage.setPointerCapture(e.pointerId);
     },
-    [document.layers, editingTextLayerId, onBeginTransaction, onClearSelection, onSelectLayer, onToggleLayerSelection, screenToScene, selectedLayerIds, canvasScale],
+    [
+      document.layers,
+      editingTextLayerId,
+      onBeginTransaction,
+      onClearSelection,
+      onSelectLayer,
+      onToggleLayerSelection,
+      screenToScene,
+      selectedLayerIds,
+      canvasScale,
+    ],
   );
 
   const handleHandlePointerDown = useCallback(
     (e: React.PointerEvent, handle: string) => {
       e.stopPropagation();
       e.preventDefault();
       const layer = singleSelectedLayer;
       const stage = stageRef.current;
       if (!layer || !stage) return;
 
@@ -644,21 +711,22 @@ export function MotionStudioCanvas({
           }
         }
       }
       onSetLayerTransform(layerId, { rotationDeg: final });
     },
     [document.layers, onSetLayerTransform],
   );
 
   const handleResizeMove = useCallback(
     (pointer: Point) => {
-      const { layerId, handle, initialTransforms, initialCenter, shiftKey, altKey } = dragRef.current;
+      const { layerId, handle, initialTransforms, initialCenter, shiftKey, altKey } =
+        dragRef.current;
       const layer = document.layers.find((l) => l.id === layerId);
       if (!layer || !layerId || !handle) return;
       const base = initialTransforms.get(layerId);
       if (!base) return;
 
       const t = base;
       const w = t.width;
       const h = t.height;
       const deg = t.rotationDeg;
       const { axisX, axisY } = rotatedAxes(deg);
@@ -731,21 +799,23 @@ export function MotionStudioCanvas({
     [document.layers, onSetLayerTransform],
   );
 
   const handleMoveMove = useCallback(
     (pointer: Point) => {
       const { initialPointer, initialTransforms, shiftKey } = dragRef.current;
       const dx = pointer.x - initialPointer.x;
       const dy = pointer.y - initialPointer.y;
 
       const movingLayers = selectedLayers.filter((l) => !l.locked);
-      const { snap, guides } = shiftKey ? computeSnap(movingLayers, initialTransforms, { x: dx, y: dy }) : { snap: { x: 0, y: 0 }, guides: [] };
+      const { snap, guides } = shiftKey
+        ? computeSnap(movingLayers, initialTransforms, { x: dx, y: dy })
+        : { snap: { x: 0, y: 0 }, guides: [] };
       setGuides(guides);
 
       const finalDx = dx + snap.x;
       const finalDy = dy + snap.y;
       for (const layer of movingLayers) {
         const base = initialTransforms.get(layer.id);
         if (!base) continue;
         onSetLayerTransform(layer.id, { x: base.x + finalDx, y: base.y + finalDy });
       }
     },
@@ -797,21 +867,23 @@ export function MotionStudioCanvas({
     },
     [handleMarqueeMove, handleMoveMove, handleResizeMove, handleRotateMove, screenToScene],
   );
 
   const handlePointerUp = useCallback(
     (e: React.PointerEvent) => {
       const { mode } = dragRef.current;
       if (mode === 'marquee') {
         handleMarqueeEnd();
       } else if (mode === 'move' || mode === 'resize' || mode === 'rotate') {
-        onCommitTransaction(mode === 'move' ? 'Move layers' : mode === 'resize' ? 'Resize layer' : 'Rotate layer');
+        onCommitTransaction(
+          mode === 'move' ? 'Move layers' : mode === 'resize' ? 'Resize layer' : 'Rotate layer',
+        );
       }
       dragRef.current = {
         ...dragRef.current,
         mode: null,
         layerId: null,
         handle: null,
       };
       setGuides([]);
       try {
         stageRef.current?.releasePointerCapture(e.pointerId);
@@ -848,27 +920,24 @@ export function MotionStudioCanvas({
       e.preventDefault();
       e.stopPropagation();
       if (!selectedLayerIds.includes(layerId)) {
         onSelectLayer(layerId);
       }
       setContextMenu({ x: e.clientX, y: e.clientY, layerId });
     },
     [onSelectLayer, selectedLayerIds],
   );
 
-  const handleStageContextMenu = useCallback(
-    (e: React.MouseEvent) => {
-      e.preventDefault();
-      setContextMenu({ x: e.clientX, y: e.clientY, layerId: null });
-    },
-    [],
-  );
+  const handleStageContextMenu = useCallback((e: React.MouseEvent) => {
+    e.preventDefault();
+    setContextMenu({ x: e.clientX, y: e.clientY, layerId: null });
+  }, []);
 
   const handleTextChange = useCallback(
     (layerId: MotionLayerId, text: string) => {
       onDispatch('Set text', { type: 'scene.setLayerText', payload: { layerId, text } });
     },
     [onDispatch],
   );
 
   const handleTextEditEnd = useCallback(() => {
     setEditingTextLayerId(null);
@@ -916,21 +985,35 @@ export function MotionStudioCanvas({
           onAddEllipseLayer();
           break;
         case 'add-image':
           onAddImageLayer();
           break;
         case 'add-video':
           onAddVideoLayer();
           break;
       }
     },
-    [document.layers, onAddEllipseLayer, onAddRectangleLayer, onAddTextLayer, onBringToFront, onDeleteSelected, onDuplicateSelected, onGroupSelected, onSelectLayers, onSendToBack, onUngroupSelected, onAddImageLayer, onAddVideoLayer],
+    [
+      document.layers,
+      onAddEllipseLayer,
+      onAddRectangleLayer,
+      onAddTextLayer,
+      onBringToFront,
+      onDeleteSelected,
+      onDuplicateSelected,
+      onGroupSelected,
+      onSelectLayers,
+      onSendToBack,
+      onUngroupSelected,
+      onAddImageLayer,
+      onAddVideoLayer,
+    ],
   );
 
   useEffect(() => {
     function onGlobalPointerMove(ev: PointerEvent) {
       const stage = stageRef.current;
       if (!stage || dragRef.current.mode === null) return;
       handlePointerMove(ev as unknown as React.PointerEvent);
     }
     function onGlobalPointerUp(ev: PointerEvent) {
       handlePointerUp(ev as unknown as React.PointerEvent);
@@ -1122,21 +1205,26 @@ function SelectionOverlay({ layer, onHandlePointerDown }: SelectionOverlayProps)
           key={name}
           className={`ms-handle ms-handle-${name}`}
           style={{
             position: 'absolute',
             width: HANDLE_SIZE,
             height: HANDLE_SIZE,
             borderRadius: 2,
             background: JOY_COLORS.accent,
             border: '1px solid #fff',
             pointerEvents: 'auto',
-            cursor: name.length === 2 ? `${name}-resize` : name === 'n' || name === 's' ? `${name}s-resize` : `${name}w-resize`,
+            cursor:
+              name.length === 2
+                ? `${name}-resize`
+                : name === 'n' || name === 's'
+                  ? `${name}s-resize`
+                  : `${name}w-resize`,
             ...pos,
           }}
           onPointerDown={(e) => onHandlePointerDown(e, name)}
           data-handle={name}
         />
       ))}
       <div
         className="ms-handle ms-handle-rotate"
         style={{
           position: 'absolute',
@@ -1213,56 +1301,91 @@ function ContextMenu({
     <div
       ref={ref}
       className="ms-context-menu"
       style={{ left: x, top: y }}
       onClick={(e) => e.stopPropagation()}
       role="menu"
     >
       {layerId ? (
         <>
           <button className="ms-context-item" role="menuitem" onClick={() => onDuplicateSelected()}>
-            <span className="ms-context-icon"><DuplicateIcon /></span> Duplicate
+            <span className="ms-context-icon">
+              <DuplicateIcon />
+            </span>{' '}
+            Duplicate
           </button>
           <button className="ms-context-item" role="menuitem" onClick={() => onDeleteSelected()}>
-            <span className="ms-context-icon"><TrashIcon /></span> Delete
+            <span className="ms-context-icon">
+              <TrashIcon />
+            </span>{' '}
+            Delete
           </button>
           <div className="ms-context-separator" />
           <button className="ms-context-item" role="menuitem" onClick={() => onBringToFront()}>
-            <span className="ms-context-icon"><LayersIcon /></span> Bring to front
+            <span className="ms-context-icon">
+              <LayersIcon />
+            </span>{' '}
+            Bring to front
           </button>
           <button className="ms-context-item" role="menuitem" onClick={() => onSendToBack()}>
-            <span className="ms-context-icon"><LayersIcon /></span> Send to back
+            <span className="ms-context-icon">
+              <LayersIcon />
+            </span>{' '}
+            Send to back
           </button>
           <div className="ms-context-separator" />
           <button className="ms-context-item" role="menuitem" onClick={() => onGroupSelected()}>
-            <span className="ms-context-icon"><LockIcon /></span> Group
+            <span className="ms-context-icon">
+              <LockIcon />
+            </span>{' '}
+            Group
           </button>
           <button className="ms-context-item" role="menuitem" onClick={() => onUngroupSelected()}>
-            <span className="ms-context-icon"><UnlockIcon /></span> Ungroup
+            <span className="ms-context-icon">
+              <UnlockIcon />
+            </span>{' '}
+            Ungroup
           </button>
         </>
       ) : (
         <>
           <button className="ms-context-item" role="menuitem" onClick={() => onAction('add-text')}>
-            <span className="ms-add-text-glyph" aria-hidden="true">T</span> Add text
+            <span className="ms-add-text-glyph" aria-hidden="true">
+              T
+            </span>{' '}
+            Add text
           </button>
           <button className="ms-context-item" role="menuitem" onClick={() => onAction('add-rect')}>
             <span className="ms-shape-icon-rect" /> Add rectangle
           </button>
-          <button className="ms-context-item" role="menuitem" onClick={() => onAction('add-ellipse')}>
+          <button
+            className="ms-context-item"
+            role="menuitem"
+            onClick={() => onAction('add-ellipse')}
+          >
             <span className="ms-shape-icon-ellipse" /> Add ellipse
           </button>
           <button className="ms-context-item" role="menuitem" onClick={() => onAction('add-image')}>
-            <span className="ms-image-icon" aria-hidden="true">🖼</span> Add image
+            <span className="ms-image-icon" aria-hidden="true">
+              🖼
+            </span>{' '}
+            Add image
           </button>
           <button className="ms-context-item" role="menuitem" onClick={() => onAction('add-video')}>
-            <span className="ms-video-icon" aria-hidden="true">🎬</span> Add video
+            <span className="ms-video-icon" aria-hidden="true">
+              🎬
+            </span>{' '}
+            Add video
           </button>
           <div className="ms-context-separator" />
-          <button className="ms-context-item" role="menuitem" onClick={() => onAction('select-all')}>
+          <button
+            className="ms-context-item"
+            role="menuitem"
+            onClick={() => onAction('select-all')}
+          >
             Select all
           </button>
         </>
       )}
     </div>
   );
 }
diff --git a/apps/editor-web/src/motion-studio/MotionStudioInspector.test.tsx b/apps/editor-web/src/motion-studio/MotionStudioInspector.test.tsx
new file mode 100644
index 0000000..4d36638
--- /dev/null
+++ b/apps/editor-web/src/motion-studio/MotionStudioInspector.test.tsx
@@ -0,0 +1,57 @@
+import { describe, expect, it } from 'vitest';
+import { renderToStaticMarkup } from 'react-dom/server';
+import { createBlankScene, type MotionLayer } from '@joy-media/motion-core';
+import {
+  buildAutokeyAnimations,
+  buildToggleKeyframeAnimations,
+  layerHasKeyframeAt,
+  MotionStudioInspector,
+} from './MotionStudioInspector.js';
+import { createRectangleLayer } from './state/layerFactory.js';
+
+describe('MotionStudioInspector keyframe controls', () => {
+  it('toggles transform keyframes at the live playhead through animations', () => {
+    const layer = createRectangleLayer(10, 20, 100, 80);
+    const keyed = buildToggleKeyframeAnimations(layer, 'transform.x', 500, layer.transform.x);
+    const next = { ...layer, animations: keyed } satisfies MotionLayer;
+
+    expect(layerHasKeyframeAt(next, 'transform.x', 500)).toBe(true);
+    expect(buildToggleKeyframeAnimations(next, 'transform.x', 500, 99)).toEqual([]);
+  });
+
+  it('autokeys a numeric transform edit when a key already exists at the playhead', () => {
+    const layer = {
+      ...createRectangleLayer(10, 20, 100, 80),
+      animations: buildToggleKeyframeAnimations(
+        createRectangleLayer(10, 20, 100, 80),
+        'transform.x',
+        750,
+        10,
+      ),
+    };
+
+    const animations = buildAutokeyAnimations(layer, 'transform.x', 750, 42);
+    expect(animations?.[0]?.curve.keyframes[0]).toMatchObject({ timeMs: 750, value: 42 });
+    expect(buildAutokeyAnimations(layer, 'transform.y', 750, 24)).toBeUndefined();
+  });
+
+  it('renders active keyframe diamonds for selected single-layer properties', () => {
+    const layer = createRectangleLayer(10, 20, 100, 80);
+    const keyedLayer = {
+      ...layer,
+      animations: buildToggleKeyframeAnimations(layer, 'transform.x', 1000, layer.transform.x),
+    };
+    const document = { ...createBlankScene('Inspector'), layers: [keyedLayer] };
+    const markup = renderToStaticMarkup(
+      <MotionStudioInspector
+        document={document}
+        selectedLayerIds={[keyedLayer.id]}
+        playheadMs={1000}
+        dispatch={() => {}}
+      />,
+    );
+
+    expect(markup).toContain('aria-label="Toggle X keyframe"');
+    expect(markup).toContain('aria-pressed="true"');
+  });
+});
diff --git a/apps/editor-web/src/motion-studio/MotionStudioInspector.tsx b/apps/editor-web/src/motion-studio/MotionStudioInspector.tsx
index 00da8ab..b00af42 100644
--- a/apps/editor-web/src/motion-studio/MotionStudioInspector.tsx
+++ b/apps/editor-web/src/motion-studio/MotionStudioInspector.tsx
@@ -7,25 +7,30 @@ import type {
   MotionTypography,
   MotionFill,
   MotionStroke,
   MotionShadow,
   MotionFilter,
   SceneBackground,
   BlendMode,
   MotionAnimation,
   MotionEasing,
 } from '@joy-media/motion-core';
-import { setKeyframeAt, hasKeyframeAtMotion, type LayerEvaluation } from '@joy-media/motion-core';
+import { setKeyframeAt, removeKeyframeAt, hasKeyframeAtMotion } from '@joy-media/motion-core';
 import type { SceneCommand } from './state/sceneCommands.js';
 import { UI_ICONS } from '../ui-icons.js';
 import { MsTitle } from './MsTitle.js';
-import { layerCapabilities, commonCapabilities, MOTION_BLEND_MODES, type CapabilitySection } from './state/motionCapabilities.js';
+import {
+  layerCapabilities,
+  commonCapabilities,
+  MOTION_BLEND_MODES,
+  type CapabilitySection,
+} from './state/motionCapabilities.js';
 import { KeyframeDiamondIcon, StrokeIcon, ShadowIcon, FilterIcon } from './MsIcons.js';
 
 /**
  * Curated content-creation fonts (fontiran pack), registered as @font-face
  * in public/assets/fonts/content-fonts.css. 'system-ui' is the fallback.
  */
 const CONTENT_FONT_FAMILIES: readonly string[] = [
   'system-ui',
   'YekanBakh',
   'Vazin',
@@ -101,42 +106,84 @@ function isMixedNumber(value: number | string): value is string {
 function parseNumber(value: number | string): number | undefined {
   if (typeof value === 'number') return value;
   const n = parseFloat(value);
   return isNaN(n) ? undefined : n;
 }
 
 function isMixedString(value: string | number): value is string {
   return typeof value === 'string';
 }
 
+export function layerHasKeyframeAt(layer: MotionLayer, property: string, timeMs: number): boolean {
+  return hasKeyframeAtMotion(
+    layer.animations.find((animation) => animation.property === property),
+    timeMs,
+  );
+}
+
+export function buildToggleKeyframeAnimations(
+  layer: MotionLayer,
+  property: string,
+  timeMs: number,
+  value: number,
+): readonly MotionAnimation[] {
+  return layerHasKeyframeAt(layer, property, timeMs)
+    ? removeKeyframeAt(layer.animations, property, timeMs)
+    : setKeyframeAt(layer.animations, property, timeMs, value, { kind: 'builtin', name: 'linear' });
+}
+
+export function buildAutokeyAnimations(
+  layer: MotionLayer,
+  property: string,
+  timeMs: number,
+  value: number,
+): readonly MotionAnimation[] | undefined {
+  if (!layerHasKeyframeAt(layer, property, timeMs)) return undefined;
+  return setKeyframeAt(layer.animations, property, timeMs, value, {
+    kind: 'builtin',
+    name: 'linear',
+  });
+}
+
 function NumberRow({
   label,
   value,
   step,
   onChange,
   min,
   max,
   diamond,
+  diamondActive = false,
+  onToggleKeyframe,
 }: {
   readonly label: string | number;
   readonly value: number | string;
   readonly step: number;
   readonly onChange: (v: number) => void;
   readonly min?: number;
   readonly max?: number;
   readonly diamond?: boolean;
+  readonly diamondActive?: boolean;
+  readonly onToggleKeyframe?: () => void;
 }) {
   return (
     <div className="ms-inspector-row" key={label}>
       <label className="ms-inspector-label">{label}</label>
       {diamond && (
-        <button type="button" className="ms-inspector-keyframe" aria-label="Toggle keyframe" title="Keyframe (Phase 4)">
+        <button
+          type="button"
+          className="ms-inspector-keyframe"
+          aria-label={`Toggle ${label} keyframe`}
+          aria-pressed={diamondActive}
+          title={diamondActive ? 'Remove keyframe' : 'Add keyframe'}
+          onClick={onToggleKeyframe}
+        >
           <KeyframeDiamondIcon />
         </button>
       )}
       <input
         type="number"
         className="ms-inspector-input"
         value={typeof value === 'number' ? Math.round(value * 100) / 100 : value}
         step={step}
         min={min}
         max={max}
@@ -161,25 +208,34 @@ function SelectRow({
   readonly label: string;
   readonly value: string;
   readonly options: readonly string[];
   readonly onChange: (v: string) => void;
   readonly diamond?: boolean;
 }) {
   return (
     <div className="ms-inspector-row" key={label}>
       <label className="ms-inspector-label">{label}</label>
       {diamond && (
-        <button type="button" className="ms-inspector-keyframe" aria-label="Toggle keyframe" title="Keyframe (Phase 4)">
+        <button
+          type="button"
+          className="ms-inspector-keyframe"
+          aria-label="Toggle keyframe"
+          title="Keyframe (Phase 4)"
+        >
           <KeyframeDiamondIcon />
         </button>
       )}
-      <select className="ms-inspector-input" value={value} onChange={(e) => onChange(e.target.value)}>
+      <select
+        className="ms-inspector-input"
+        value={value}
+        onChange={(e) => onChange(e.target.value)}
+      >
         {options.map((opt) => (
           <option key={opt} value={opt}>
             {opt}
           </option>
         ))}
       </select>
     </div>
   );
 }
 
@@ -208,105 +264,139 @@ function ColorRow({
         value={opacity}
         step={0.05}
         min={0}
         max={1}
         onChange={(v) => onChange(color, v)}
       />
     </div>
   );
 }
 
-function useSelectedLayers(document: MotionSceneDocument, selectedLayerIds: readonly MotionLayerId[]) {
+function useSelectedLayers(
+  document: MotionSceneDocument,
+  selectedLayerIds: readonly MotionLayerId[],
+) {
   return useMemo(
-    () => selectedLayerIds.map((id) => document.layers.find((l) => l.id === id)).filter((l): l is MotionLayer => Boolean(l)),
+    () =>
+      selectedLayerIds
+        .map((id) => document.layers.find((l) => l.id === id))
+        .filter((l): l is MotionLayer => Boolean(l)),
     [document, selectedLayerIds],
   );
 }
 
 function SceneInspector({
   document,
   dispatch,
 }: {
   readonly document: MotionSceneDocument;
   readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
 }) {
   const bg = document.background;
 
   const setBg = useCallback(
-    (background: SceneBackground) => dispatch('Set background', { type: 'scene.setSceneBackground', payload: { background } }),
+    (background: SceneBackground) =>
+      dispatch('Set background', { type: 'scene.setSceneBackground', payload: { background } }),
     [dispatch],
   );
   const setDimensions = useCallback(
-    (w: number, h: number) => dispatch('Set dimensions', { type: 'scene.setDocumentDimensions', payload: { width: w, height: h } }),
+    (w: number, h: number) =>
+      dispatch('Set dimensions', {
+        type: 'scene.setDocumentDimensions',
+        payload: { width: w, height: h },
+      }),
     [dispatch],
   );
   const setDuration = useCallback(
-    (durationMs: number) => dispatch('Set duration', { type: 'scene.setDocumentDuration', payload: { durationMs: Math.max(100, durationMs) } }),
+    (durationMs: number) =>
+      dispatch('Set duration', {
+        type: 'scene.setDocumentDuration',
+        payload: { durationMs: Math.max(100, durationMs) },
+      }),
     [dispatch],
   );
 
   return (
     <aside className="ms-panel ms-right" aria-label="Inspector">
       <div className="ms-panel-header">
         <MsTitle iconSrc={UI_ICONS.crop} className="ms-panel-title">
           Scene
         </MsTitle>
       </div>
       <div className="ms-panel-body">
         <div className="ms-inspector-section">
           <h4 className="ms-inspector-section-title">Document</h4>
           <div className="ms-inspector-row">
             <label className="ms-inspector-label">Name</label>
             <span className="ms-inspector-readonly">{document.name}</span>
           </div>
-          <NumberRow label="Width" value={document.width} step={1} min={1} onChange={(w) => setDimensions(w, document.height)} />
-          <NumberRow label="Height" value={document.height} step={1} min={1} onChange={(h) => setDimensions(document.width, h)} />
+          <NumberRow
+            label="Width"
+            value={document.width}
+            step={1}
+            min={1}
+            onChange={(w) => setDimensions(w, document.height)}
+          />
+          <NumberRow
+            label="Height"
+            value={document.height}
+            step={1}
+            min={1}
+            onChange={(h) => setDimensions(document.width, h)}
+          />
           <NumberRow
             label="Duration"
             value={document.durationMs / 1000}
             step={0.1}
             min={0.1}
             onChange={(s) => setDuration(Math.round(s * 1000))}
           />
           <div className="ms-inspector-row">
             <label className="ms-inspector-label">Layers</label>
             <span className="ms-inspector-readonly">{document.layers.length}</span>
           </div>
         </div>
 
         <div className="ms-inspector-section">
           <MsTitle as="h4" iconSrc={UI_ICONS.colors} className="ms-inspector-section-title">
             Background
           </MsTitle>
           <SelectRow
             label="Kind"
             value={bg.kind}
-            options={['transparent', 'solid', 'gradient', 'image', 'video', 'animated-gradient', 'noise', 'particles']}
+            options={[
+              'transparent',
+              'solid',
+              'gradient',
+              'image',
+              'video',
+              'animated-gradient',
+              'noise',
+              'particles',
+            ]}
             onChange={(kind) => setBg({ kind: kind as SceneBackground['kind'] })}
           />
           {bg.kind === 'solid' && (
             <ColorRow
               label="Fill"
               color={bg.color ?? '#000000'}
               opacity={bg.opacity ?? 1}
               onChange={(color, opacity) => setBg({ ...bg, color, opacity })}
             />
           )}
           {bg.kind === 'gradient' && bg.gradient && (
             <>
               <NumberRow
                 label="Angle"
                 value={bg.gradient.angle ?? 0}
                 step={1}
-                onChange={(angle) =>
-                  setBg({ ...bg, gradient: { ...bg.gradient!, angle } })
-                }
+                onChange={(angle) => setBg({ ...bg, gradient: { ...bg.gradient!, angle } })}
               />
               <NumberRow
                 label="Opacity"
                 value={bg.opacity ?? 1}
                 step={0.05}
                 min={0}
                 max={1}
                 onChange={(opacity) => setBg({ ...bg, opacity })}
               />
             </>
@@ -325,60 +415,176 @@ function SceneInspector({
       </div>
     </aside>
   );
 }
 
 function TransformSection({
   selected,
   dispatch,
   isMulti,
   showDiamonds,
+  playheadMs,
 }: {
   readonly selected: readonly MotionLayer[];
   readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
   readonly isMulti: boolean;
   readonly showDiamonds: boolean;
+  readonly playheadMs: number;
 }) {
   const xs = selected.map((l) => l.transform.x);
   const ys = selected.map((l) => l.transform.y);
   const ws = selected.map((l) => l.transform.width);
   const hs = selected.map((l) => l.transform.height);
   const rots = selected.map((l) => l.transform.rotationDeg);
   const ops = selected.map((l) => l.transform.opacity);
   const scaleXs = selected.map((l) => l.transform.scaleX);
   const scaleYs = selected.map((l) => l.transform.scaleY);
 
   const updateTransform = (patch: Partial<MotionTransform>) => {
     dispatch(
       'Set transform',
-      ...selected.map<SceneCommand>((layer) => ({ type: 'scene.setLayerTransform', payload: { layerId: layer.id, transform: patch } })),
+      ...selected.map<SceneCommand>((layer) => ({
+        type: 'scene.setLayerTransform',
+        payload: { layerId: layer.id, transform: patch },
+      })),
     );
   };
+  const updateTransformProperty = (
+    key: keyof Pick<
+      MotionTransform,
+      'x' | 'y' | 'width' | 'height' | 'rotationDeg' | 'scaleX' | 'scaleY' | 'opacity'
+    >,
+    value: number,
+  ) => {
+    if (!showDiamonds || selected.length !== 1) {
+      updateTransform({ [key]: value });
+      return;
+    }
+    const layer = selected[0]!;
+    const property = `transform.${key}`;
+    const animations = buildAutokeyAnimations(layer, property, playheadMs, value);
+    if (animations === undefined) {
+      updateTransform({ [key]: value });
+      return;
+    }
+    dispatch('Set keyframe', {
+      type: 'scene.setLayerAnimations',
+      payload: { layerId: layer.id, animations },
+    });
+  };
+  const toggleTransformKeyframe = (
+    key: keyof Pick<
+      MotionTransform,
+      'x' | 'y' | 'width' | 'height' | 'rotationDeg' | 'scaleX' | 'scaleY' | 'opacity'
+    >,
+    value: number | string,
+  ) => {
+    if (selected.length !== 1 || typeof value !== 'number') return;
+    const layer = selected[0]!;
+    const property = `transform.${key}`;
+    dispatch('Toggle keyframe', {
+      type: 'scene.setLayerAnimations',
+      payload: {
+        layerId: layer.id,
+        animations: buildToggleKeyframeAnimations(layer, property, playheadMs, value),
+      },
+    });
+  };
+  const isKeyed = (
+    key: keyof Pick<
+      MotionTransform,
+      'x' | 'y' | 'width' | 'height' | 'rotationDeg' | 'scaleX' | 'scaleY' | 'opacity'
+    >,
+  ) => selected.length === 1 && layerHasKeyframeAt(selected[0]!, `transform.${key}`, playheadMs);
 
   return (
     <div className="ms-inspector-section">
       <h4 className="ms-inspector-section-title">Transform</h4>
-      <NumberRow label="X" value={mixedNumber(xs)} step={1} onChange={(v) => updateTransform({ x: v })} diamond={showDiamonds} />
-      <NumberRow label="Y" value={mixedNumber(ys)} step={1} onChange={(v) => updateTransform({ y: v })} diamond={showDiamonds} />
-      <NumberRow label="Width" value={mixedNumber(ws)} step={1} min={1} onChange={(v) => updateTransform({ width: Math.max(1, v) })} diamond={showDiamonds} />
-      <NumberRow label="Height" value={mixedNumber(hs)} step={1} min={1} onChange={(v) => updateTransform({ height: Math.max(1, v) })} diamond={showDiamonds} />
-      <NumberRow label="Rotation" value={mixedNumber(rots)} step={1} onChange={(v) => updateTransform({ rotationDeg: v })} diamond={showDiamonds} />
-      <NumberRow label="Scale X" value={mixedNumber(scaleXs)} step={0.05} min={-10} max={10} onChange={(v) => updateTransform({ scaleX: v })} diamond={showDiamonds} />
-      <NumberRow label="Scale Y" value={mixedNumber(scaleYs)} step={0.05} min={-10} max={10} onChange={(v) => updateTransform({ scaleY: v })} diamond={showDiamonds} />
+      <NumberRow
+        label="X"
+        value={mixedNumber(xs)}
+        step={1}
+        onChange={(v) => updateTransformProperty('x', v)}
+        diamond={showDiamonds}
+        diamondActive={isKeyed('x')}
+        onToggleKeyframe={() => toggleTransformKeyframe('x', mixedNumber(xs))}
+      />
+      <NumberRow
+        label="Y"
+        value={mixedNumber(ys)}
+        step={1}
+        onChange={(v) => updateTransformProperty('y', v)}
+        diamond={showDiamonds}
+        diamondActive={isKeyed('y')}
+        onToggleKeyframe={() => toggleTransformKeyframe('y', mixedNumber(ys))}
+      />
+      <NumberRow
+        label="Width"
+        value={mixedNumber(ws)}
+        step={1}
+        min={1}
+        onChange={(v) => updateTransformProperty('width', Math.max(1, v))}
+        diamond={showDiamonds}
+        diamondActive={isKeyed('width')}
+        onToggleKeyframe={() => toggleTransformKeyframe('width', mixedNumber(ws))}
+      />
+      <NumberRow
+        label="Height"
+        value={mixedNumber(hs)}
+        step={1}
+        min={1}
+        onChange={(v) => updateTransformProperty('height', Math.max(1, v))}
+        diamond={showDiamonds}
+        diamondActive={isKeyed('height')}
+        onToggleKeyframe={() => toggleTransformKeyframe('height', mixedNumber(hs))}
+      />
+      <NumberRow
+        label="Rotation"
+        value={mixedNumber(rots)}
+        step={1}
+        onChange={(v) => updateTransformProperty('rotationDeg', v)}
+        diamond={showDiamonds}
+        diamondActive={isKeyed('rotationDeg')}
+        onToggleKeyframe={() => toggleTransformKeyframe('rotationDeg', mixedNumber(rots))}
+      />
+      <NumberRow
+        label="Scale X"
+        value={mixedNumber(scaleXs)}
+        step={0.05}
+        min={-10}
+        max={10}
+        onChange={(v) => updateTransformProperty('scaleX', v)}
+        diamond={showDiamonds}
+        diamondActive={isKeyed('scaleX')}
+        onToggleKeyframe={() => toggleTransformKeyframe('scaleX', mixedNumber(scaleXs))}
+      />
+      <NumberRow
+        label="Scale Y"
+        value={mixedNumber(scaleYs)}
+        step={0.05}
+        min={-10}
+        max={10}
+        onChange={(v) => updateTransformProperty('scaleY', v)}
+        diamond={showDiamonds}
+        diamondActive={isKeyed('scaleY')}
+        onToggleKeyframe={() => toggleTransformKeyframe('scaleY', mixedNumber(scaleYs))}
+      />
       <NumberRow
         label="Opacity"
         value={mixedNumber(ops)}
         step={0.05}
         min={0}
         max={1}
-        onChange={(v) => updateTransform({ opacity: Math.min(1, Math.max(0, v)) })}
+        onChange={(v) => updateTransformProperty('opacity', Math.min(1, Math.max(0, v)))}
         diamond={showDiamonds}
+        diamondActive={isKeyed('opacity')}
+        onToggleKeyframe={() => toggleTransformKeyframe('opacity', mixedNumber(ops))}
       />
     </div>
   );
 }
 
 function TextSection({
   selected,
   dispatch,
   showDiamonds,
 }: {
@@ -392,51 +598,129 @@ function TextSection({
   const lineHeights = selected.map((l) => l.typography?.lineHeight ?? 1.2);
   const letterSpacings = selected.map((l) => l.typography?.letterSpacing ?? 0);
   const wordSpacings = selected.map((l) => l.typography?.wordSpacing ?? 0);
   const paragraphSpacings = selected.map((l) => l.typography?.paragraphSpacing ?? 0);
   const fontWeights = selected.map((l) => l.typography?.fontWeight ?? 400);
   const textAligns = selected.map((l) => l.typography?.textAlign ?? 'center');
   const textTransforms = selected.map((l) => l.typography?.textTransform ?? 'none');
   const directions = selected.map((l) => l.typography?.direction ?? 'auto');
 
   const updateText = (text: string) =>
-    dispatch('Set text', ...selected.map<SceneCommand>((layer) => ({ type: 'scene.setLayerText', payload: { layerId: layer.id, text } })));
+    dispatch(
+      'Set text',
+      ...selected.map<SceneCommand>((layer) => ({
+        type: 'scene.setLayerText',
+        payload: { layerId: layer.id, text },
+      })),
+    );
   const updateTypography = (patch: Partial<MotionTypography>) =>
     dispatch(
       'Set typography',
-      ...selected.map<SceneCommand>((layer) => ({ type: 'scene.setLayerTypography', payload: { layerId: layer.id, typography: patch } })),
+      ...selected.map<SceneCommand>((layer) => ({
+        type: 'scene.setLayerTypography',
+        payload: { layerId: layer.id, typography: patch },
+      })),
     );
 
   return (
     <>
       <div className="ms-inspector-section">
         <h4 className="ms-inspector-section-title">Text</h4>
         <textarea
           className="ms-inspector-textarea"
           value={mixedString(texts)}
           onChange={(e) => !isMixed(texts) && updateText(e.target.value)}
           rows={3}
           placeholder="Enter text…"
         />
       </div>
       <div className="ms-inspector-section">
         <h4 className="ms-inspector-section-title">Typography</h4>
-        <SelectRow label="Font Family" value={mixedString(fontFamilies)} options={CONTENT_FONT_FAMILIES} onChange={(v) => updateTypography({ fontFamily: v })} />
-        <NumberRow label="Font Size" value={mixedNumber(fontSizes)} step={1} min={1} max={400} onChange={(v) => updateTypography({ fontSize: v })} diamond={showDiamonds} />
-        <NumberRow label="Line Height" value={mixedNumber(lineHeights)} step={0.1} min={0.5} max={5} onChange={(v) => updateTypography({ lineHeight: v })} diamond={showDiamonds} />
-        <NumberRow label="Letter Spacing" value={mixedNumber(letterSpacings)} step={0.1} min={-20} max={100} onChange={(v) => updateTypography({ letterSpacing: v })} diamond={showDiamonds} />
-        <NumberRow label="Word Spacing" value={mixedNumber(wordSpacings)} step={0.1} min={-50} max={100} onChange={(v) => updateTypography({ wordSpacing: v })} diamond={showDiamonds} />
-        <NumberRow label="Paragraph Spacing" value={mixedNumber(paragraphSpacings)} step={0.1} min={0} max={200} onChange={(v) => updateTypography({ paragraphSpacing: v })} diamond={showDiamonds} />
-        <NumberRow label="Font Weight" value={mixedNumber(fontWeights)} step={100} min={100} max={900} onChange={(v) => updateTypography({ fontWeight: v })} />
-        <SelectRow label="Text Align" value={mixedString(textAligns)} options={TEXT_ALIGNS} onChange={(v) => updateTypography({ textAlign: v as MotionTypography['textAlign'] })} />
-        <SelectRow label="Text Transform" value={mixedString(textTransforms)} options={TEXT_TRANSFORMS} onChange={(v) => updateTypography({ textTransform: v as MotionTypography['textTransform'] })} />
-        <SelectRow label="Direction" value={mixedString(directions)} options={['auto', 'ltr', 'rtl']} onChange={(v) => updateTypography({ direction: v as MotionTypography['direction'] })} />
+        <SelectRow
+          label="Font Family"
+          value={mixedString(fontFamilies)}
+          options={CONTENT_FONT_FAMILIES}
+          onChange={(v) => updateTypography({ fontFamily: v })}
+        />
+        <NumberRow
+          label="Font Size"
+          value={mixedNumber(fontSizes)}
+          step={1}
+          min={1}
+          max={400}
+          onChange={(v) => updateTypography({ fontSize: v })}
+          diamond={showDiamonds}
+        />
+        <NumberRow
+          label="Line Height"
+          value={mixedNumber(lineHeights)}
+          step={0.1}
+          min={0.5}
+          max={5}
+          onChange={(v) => updateTypography({ lineHeight: v })}
+          diamond={showDiamonds}
+        />
+        <NumberRow
+          label="Letter Spacing"
+          value={mixedNumber(letterSpacings)}
+          step={0.1}
+          min={-20}
+          max={100}
+          onChange={(v) => updateTypography({ letterSpacing: v })}
+          diamond={showDiamonds}
+        />
+        <NumberRow
+          label="Word Spacing"
+          value={mixedNumber(wordSpacings)}
+          step={0.1}
+          min={-50}
+          max={100}
+          onChange={(v) => updateTypography({ wordSpacing: v })}
+          diamond={showDiamonds}
+        />
+        <NumberRow
+          label="Paragraph Spacing"
+          value={mixedNumber(paragraphSpacings)}
+          step={0.1}
+          min={0}
+          max={200}
+          onChange={(v) => updateTypography({ paragraphSpacing: v })}
+          diamond={showDiamonds}
+        />
+        <NumberRow
+          label="Font Weight"
+          value={mixedNumber(fontWeights)}
+          step={100}
+          min={100}
+          max={900}
+          onChange={(v) => updateTypography({ fontWeight: v })}
+        />
+        <SelectRow
+          label="Text Align"
+          value={mixedString(textAligns)}
+          options={TEXT_ALIGNS}
+          onChange={(v) => updateTypography({ textAlign: v as MotionTypography['textAlign'] })}
+        />
+        <SelectRow
+          label="Text Transform"
+          value={mixedString(textTransforms)}
+          options={TEXT_TRANSFORMS}
+          onChange={(v) =>
+            updateTypography({ textTransform: v as MotionTypography['textTransform'] })
+          }
+        />
+        <SelectRow
+          label="Direction"
+          value={mixedString(directions)}
+          options={['auto', 'ltr', 'rtl']}
+          onChange={(v) => updateTypography({ direction: v as MotionTypography['direction'] })}
+        />
       </div>
     </>
   );
 }
 
 function FillSection({
   selected,
   dispatch,
   showDiamonds,
 }: {
@@ -458,31 +742,44 @@ function FillSection({
         return { type: 'scene.setLayerFills', payload: { layerId: layer.id, fills: [next] } };
       }),
     );
   };
 
   return (
     <div className="ms-inspector-section">
       <MsTitle as="h4" iconSrc={UI_ICONS.paint} className="ms-inspector-section-title">
         Fill
       </MsTitle>
-      <SelectRow label="Kind" value={mixedString(kinds)} options={['solid', 'gradient', 'transparent']} onChange={(v) => updateFill({ kind: v as MotionFill['kind'] })} />
+      <SelectRow
+        label="Kind"
+        value={mixedString(kinds)}
+        options={['solid', 'gradient', 'transparent']}
+        onChange={(v) => updateFill({ kind: v as MotionFill['kind'] })}
+      />
       {(mixedString(kinds) === 'solid' || isMixedString(mixedString(kinds))) && (
         <ColorRow
           label="Fill"
           color={mixedString(colors)}
           opacity={mixedNumber(opacities)}
           onChange={(color, opacity) => updateFill({ kind: 'solid', color, opacity })}
         />
       )}
       {showDiamonds && (
-        <NumberRow label="Opacity" value={mixedNumber(opacities)} step={0.05} min={0} max={1} onChange={(v) => updateFill({ opacity: v })} diamond />
+        <NumberRow
+          label="Opacity"
+          value={mixedNumber(opacities)}
+          step={0.05}
+          min={0}
+          max={1}
+          onChange={(v) => updateFill({ opacity: v })}
+          diamond
+        />
       )}
     </div>
   );
 }
 
 function StrokeSection({
   selected,
   dispatch,
   showDiamonds,
 }: {
@@ -503,26 +800,44 @@ function StrokeSection({
         return { type: 'scene.setLayerStrokes', payload: { layerId: layer.id, strokes: [next] } };
       }),
     );
   };
 
   return (
     <div className="ms-inspector-section">
       <MsTitle as="h4" iconSrc={UI_ICONS.borderRadius} className="ms-inspector-section-title">
         <StrokeIcon /> Stroke
       </MsTitle>
-      <NumberRow label="Width" value={mixedNumber(widths)} step={0.5} min={0} max={50} onChange={(v) => updateStrokes({ width: v })} diamond={showDiamonds} />
+      <NumberRow
+        label="Width"
+        value={mixedNumber(widths)}
+        step={0.5}
+        min={0}
+        max={50}
+        onChange={(v) => updateStrokes({ width: v })}
+        diamond={showDiamonds}
+      />
       <div className="ms-inspector-row">
         <label className="ms-inspector-label">Color</label>
-        <input type="color" className="ms-inspector-color" value={mixedString(colors)} onChange={(e) => updateStrokes({ color: e.target.value })} />
+        <input
+          type="color"
+          className="ms-inspector-color"
+          value={mixedString(colors)}
+          onChange={(e) => updateStrokes({ color: e.target.value })}
+        />
       </div>
-      <SelectRow label="Style" value={mixedString(styles)} options={STROKE_STYLES} onChange={(v) => updateStrokes({ style: v as NonNullable<MotionStroke['style']> })} />
+      <SelectRow
+        label="Style"
+        value={mixedString(styles)}
+        options={STROKE_STYLES}
+        onChange={(v) => updateStrokes({ style: v as NonNullable<MotionStroke['style']> })}
+      />
     </div>
   );
 }
 
 function ShadowSection({
   selected,
   dispatch,
   showDiamonds,
 }: {
   readonly selected: readonly MotionLayer[];
@@ -534,40 +849,89 @@ function ShadowSection({
   const blurs = selected.map((l) => l.shadows[0]?.blur ?? 0);
   const spreads = selected.map((l) => l.shadows[0]?.spread ?? 0);
   const colors = selected.map((l) => l.shadows[0]?.color ?? '#000000');
   const opacities = selected.map((l) => l.shadows[0]?.opacity ?? 1);
   const insets = selected.map((l) => l.shadows[0]?.inset ?? false);
 
   const updateShadows = (patch: Partial<MotionShadow>) => {
     dispatch(
       'Set shadow',
       ...selected.map<SceneCommand>((layer) => {
-        const existing = layer.shadows[0] ?? { x: 0, y: 0, blur: 0, spread: 0, color: '#000000', opacity: 1, inset: false };
+        const existing = layer.shadows[0] ?? {
+          x: 0,
+          y: 0,
+          blur: 0,
+          spread: 0,
+          color: '#000000',
+          opacity: 1,
+          inset: false,
+        };
         const next = { ...existing, ...patch } as MotionShadow;
         return { type: 'scene.setLayerShadows', payload: { layerId: layer.id, shadows: [next] } };
       }),
     );
   };
 
   return (
     <div className="ms-inspector-section">
       <MsTitle as="h4" iconSrc={UI_ICONS.opacity} className="ms-inspector-section-title">
         <ShadowIcon /> Shadow
       </MsTitle>
-      <NumberRow label="X" value={mixedNumber(xs)} step={1} onChange={(v) => updateShadows({ x: v })} diamond={showDiamonds} />
-      <NumberRow label="Y" value={mixedNumber(ys)} step={1} onChange={(v) => updateShadows({ y: v })} diamond={showDiamonds} />
-      <NumberRow label="Blur" value={mixedNumber(blurs)} step={0.5} min={0} max={100} onChange={(v) => updateShadows({ blur: v })} diamond={showDiamonds} />
-      <NumberRow label="Spread" value={mixedNumber(spreads)} step={0.5} min={0} max={100} onChange={(v) => updateShadows({ spread: v })} diamond={showDiamonds} />
-      <NumberRow label="Opacity" value={mixedNumber(opacities)} step={0.05} min={0} max={1} onChange={(v) => updateShadows({ opacity: v })} diamond={showDiamonds} />
+      <NumberRow
+        label="X"
+        value={mixedNumber(xs)}
+        step={1}
+        onChange={(v) => updateShadows({ x: v })}
+        diamond={showDiamonds}
+      />
+      <NumberRow
+        label="Y"
+        value={mixedNumber(ys)}
+        step={1}
+        onChange={(v) => updateShadows({ y: v })}
+        diamond={showDiamonds}
+      />
+      <NumberRow
+        label="Blur"
+        value={mixedNumber(blurs)}
+        step={0.5}
+        min={0}
+        max={100}
+        onChange={(v) => updateShadows({ blur: v })}
+        diamond={showDiamonds}
+      />
+      <NumberRow
+        label="Spread"
+        value={mixedNumber(spreads)}
+        step={0.5}
+        min={0}
+        max={100}
+        onChange={(v) => updateShadows({ spread: v })}
+        diamond={showDiamonds}
+      />
+      <NumberRow
+        label="Opacity"
+        value={mixedNumber(opacities)}
+        step={0.05}
+        min={0}
+        max={1}
+        onChange={(v) => updateShadows({ opacity: v })}
+        diamond={showDiamonds}
+      />
       <div className="ms-inspector-row">
         <label className="ms-inspector-label">Color</label>
-        <input type="color" className="ms-inspector-color" value={mixedString(colors)} onChange={(e) => updateShadows({ color: e.target.value })} />
+        <input
+          type="color"
+          className="ms-inspector-color"
+          value={mixedString(colors)}
+          onChange={(e) => updateShadows({ color: e.target.value })}
+        />
       </div>
       <div className="ms-inspector-row">
         <label className="ms-inspector-label">Inset</label>
         <input
           type="checkbox"
           checked={mixedBoolean(insets) === true}
           ref={(el) => {
             if (el) el.indeterminate = mixedBoolean(insets) === 'mixed';
           }}
           onChange={(e) => updateShadows({ inset: e.target.checked })}
@@ -588,61 +952,96 @@ function CornerRadiusSection({
   const r1 = selected.map((l) => l.borderRadius[1]);
   const r2 = selected.map((l) => l.borderRadius[2]);
   const r3 = selected.map((l) => l.borderRadius[3]);
 
   const update = (index: 0 | 1 | 2 | 3, value: number) => {
     dispatch(
       'Set border radius',
       ...selected.map<SceneCommand>((layer) => {
         const next = [...layer.borderRadius] as [number, number, number, number];
         next[index] = value;
-        return { type: 'scene.setLayerBorderRadius', payload: { layerId: layer.id, borderRadius: next } };
+        return {
+          type: 'scene.setLayerBorderRadius',
+          payload: { layerId: layer.id, borderRadius: next },
+        };
       }),
     );
   };
 
   return (
     <div className="ms-inspector-section">
       <MsTitle as="h4" iconSrc={UI_ICONS.borderRadius} className="ms-inspector-section-title">
         Corner Radius
       </MsTitle>
       <div className="ms-inspector-row ms-inspector-four">
-        <NumberRow label="TL" value={mixedNumber(r0)} step={1} min={0} onChange={(v) => update(0, v)} />
-        <NumberRow label="TR" value={mixedNumber(r1)} step={1} min={0} onChange={(v) => update(1, v)} />
-        <NumberRow label="BR" value={mixedNumber(r2)} step={1} min={0} onChange={(v) => update(2, v)} />
-        <NumberRow label="BL" value={mixedNumber(r3)} step={1} min={0} onChange={(v) => update(3, v)} />
+        <NumberRow
+          label="TL"
+          value={mixedNumber(r0)}
+          step={1}
+          min={0}
+          onChange={(v) => update(0, v)}
+        />
+        <NumberRow
+          label="TR"
+          value={mixedNumber(r1)}
+          step={1}
+          min={0}
+          onChange={(v) => update(1, v)}
+        />
+        <NumberRow
+          label="BR"
+          value={mixedNumber(r2)}
+          step={1}
+          min={0}
+          onChange={(v) => update(2, v)}
+        />
+        <NumberRow
+          label="BL"
+          value={mixedNumber(r3)}
+          step={1}
+          min={0}
+          onChange={(v) => update(3, v)}
+        />
       </div>
     </div>
   );
 }
 
 function BlendModeSection({
   selected,
   dispatch,
 }: {
   readonly selected: readonly MotionLayer[];
   readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
 }) {
   const values = selected.map((l) => l.blendMode);
 
   const update = (blendMode: BlendMode) =>
     dispatch(
       'Set blend mode',
-      ...selected.map<SceneCommand>((layer) => ({ type: 'scene.setLayerProperty', payload: { layerId: layer.id, property: 'blendMode', value: blendMode } })),
+      ...selected.map<SceneCommand>((layer) => ({
+        type: 'scene.setLayerProperty',
+        payload: { layerId: layer.id, property: 'blendMode', value: blendMode },
+      })),
     );
 
   return (
     <div className="ms-inspector-section">
       <MsTitle as="h4" iconSrc={UI_ICONS.blend} className="ms-inspector-section-title">
         Blend Mode
       </MsTitle>
-      <SelectRow label="Blend" value={mixedString(values)} options={MOTION_BLEND_MODES} onChange={(v) => update(v as BlendMode)} />
+      <SelectRow
+        label="Blend"
+        value={mixedString(values)}
+        options={MOTION_BLEND_MODES}
+        onChange={(v) => update(v as BlendMode)}
+      />
     </div>
   );
 }
 
 function SimpleFilterSection({
   selected,
   dispatch,
   showDiamonds,
 }: {
   readonly selected: readonly MotionLayer[];
@@ -652,67 +1051,117 @@ function SimpleFilterSection({
   const firsts = selected.map((l) => l.filters[0]);
   const kinds = firsts.map((f) => f?.kind ?? 'blur');
   const values = firsts.map((f) => (f && 'value' in f ? f.value : 0));
 
   const updateFilters = (patch: Partial<MotionFilter>) => {
     dispatch(
       'Set filter',
       ...selected.map<SceneCommand>((layer) => {
         const existing = layer.filters[0] ?? { kind: 'blur', value: 0 };
         const next = { ...existing, ...patch } as MotionFilter;
-        return { type: 'scene.setLayerProperty', payload: { layerId: layer.id, property: 'filters', value: [next] } };
+        return {
+          type: 'scene.setLayerProperty',
+          payload: { layerId: layer.id, property: 'filters', value: [next] },
+        };
       }),
     );
   };
 
   return (
     <div className="ms-inspector-section">
       <MsTitle as="h4" iconSrc={UI_ICONS.opacity} className="ms-inspector-section-title">
         <FilterIcon /> Filter
       </MsTitle>
-      <SelectRow label="Kind" value={mixedString(kinds)} options={FILTER_KINDS} onChange={(v) => updateFilters({ kind: v as MotionFilter['kind'] })} />
-      <NumberRow label="Value" value={mixedNumber(values)} step={1} min={0} max={1000} onChange={(v) => updateFilters({ value: v })} diamond={showDiamonds} />
+      <SelectRow
+        label="Kind"
+        value={mixedString(kinds)}
+        options={FILTER_KINDS}
+        onChange={(v) => updateFilters({ kind: v as MotionFilter['kind'] })}
+      />
+      <NumberRow
+        label="Value"
+        value={mixedNumber(values)}
+        step={1}
+        min={0}
+        max={1000}
+        onChange={(v) => updateFilters({ value: v })}
+        diamond={showDiamonds}
+      />
     </div>
   );
 }
 
 function LayerInspector({
   selected,
   dispatch,
   playheadMs = 0,
 }: {
   readonly selected: readonly MotionLayer[];
   readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
   readonly playheadMs?: number;
 }) {
   const isMulti = selected.length > 1;
   const types = selected.map((l) => l.type);
-  const sections = useMemo(() => (isMulti ? commonCapabilities(types) : layerCapabilities(types[0]!).sections), [isMulti, types]);
+  const sections = useMemo(
+    () => (isMulti ? commonCapabilities(types) : layerCapabilities(types[0]!).sections),
+    [isMulti, types],
+  );
   const showDiamonds = !isMulti;
   const first = selected[0]!;
 
   return (
     <aside className="ms-panel ms-right" aria-label="Inspector">
       <div className="ms-panel-header">
         <h3 className="ms-panel-title">{isMulti ? `${selected.length} selected` : first.name}</h3>
       </div>
       <div className="ms-panel-body">
-        {sections.includes('transform') && <TransformSection selected={selected} dispatch={dispatch} isMulti={isMulti} showDiamonds={showDiamonds} />}
-        {sections.includes('text') && <TextSection selected={selected} dispatch={dispatch} showDiamonds={showDiamonds} />}
-        {sections.includes('fill') && <FillSection selected={selected} dispatch={dispatch} showDiamonds={showDiamonds} />}
-        {sections.includes('stroke') && <StrokeSection selected={selected} dispatch={dispatch} showDiamonds={showDiamonds} />}
-        {sections.includes('shadow') && <ShadowSection selected={selected} dispatch={dispatch} showDiamonds={showDiamonds} />}
-        {sections.includes('cornerRadius') && <CornerRadiusSection selected={selected} dispatch={dispatch} />}
-        {sections.includes('blendMode') && <BlendModeSection selected={selected} dispatch={dispatch} />}
-        {sections.includes('filter') && <SimpleFilterSection selected={selected} dispatch={dispatch} showDiamonds={showDiamonds} />}
+        {sections.includes('transform') && (
+          <TransformSection
+            selected={selected}
+            dispatch={dispatch}
+            isMulti={isMulti}
+            showDiamonds={showDiamonds}
+            playheadMs={playheadMs}
+          />
+        )}
+        {sections.includes('text') && (
+          <TextSection selected={selected} dispatch={dispatch} showDiamonds={showDiamonds} />
+        )}
+        {sections.includes('fill') && (
+          <FillSection selected={selected} dispatch={dispatch} showDiamonds={showDiamonds} />
+        )}
+        {sections.includes('stroke') && (
+          <StrokeSection selected={selected} dispatch={dispatch} showDiamonds={showDiamonds} />
+        )}
+        {sections.includes('shadow') && (
+          <ShadowSection selected={selected} dispatch={dispatch} showDiamonds={showDiamonds} />
+        )}
+        {sections.includes('cornerRadius') && (
+          <CornerRadiusSection selected={selected} dispatch={dispatch} />
+        )}
+        {sections.includes('blendMode') && (
+          <BlendModeSection selected={selected} dispatch={dispatch} />
+        )}
+        {sections.includes('filter') && (
+          <SimpleFilterSection
+            selected={selected}
+            dispatch={dispatch}
+            showDiamonds={showDiamonds}
+          />
+        )}
       </div>
     </aside>
   );
 }
 
-export function MotionStudioInspector({ document, selectedLayerIds, dispatch, playheadMs = 0 }: InspectorProps) {
+export function MotionStudioInspector({
+  document,
+  selectedLayerIds,
+  dispatch,
+  playheadMs = 0,
+}: InspectorProps) {
   const selected = useSelectedLayers(document, selectedLayerIds);
   if (selected.length === 0) {
     return <SceneInspector document={document} dispatch={dispatch} />;
   }
   return <LayerInspector selected={selected} dispatch={dispatch} playheadMs={playheadMs} />;
 }
diff --git a/apps/editor-web/src/motion-studio/MotionStudioShell.tsx b/apps/editor-web/src/motion-studio/MotionStudioShell.tsx
index c0fed7a..60cf297 100644
--- a/apps/editor-web/src/motion-studio/MotionStudioShell.tsx
+++ b/apps/editor-web/src/motion-studio/MotionStudioShell.tsx
@@ -1,21 +1,42 @@
-import { useState, useCallback, useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
-import { MotionStudioTopBar, type MotionStudioMode, type MotionSaveState } from './MotionStudioTopBar.js';
+import {
+  useState,
+  useCallback,
+  useEffect,
+  useRef,
+  type CSSProperties,
+  type PointerEvent as ReactPointerEvent,
+} from 'react';
+import {
+  MotionStudioTopBar,
+  type MotionStudioMode,
+  type MotionSaveState,
+} from './MotionStudioTopBar.js';
 import { MotionStudioCanvas } from './MotionStudioCanvas.js';
 import { MotionStudioLayersPanel } from './MotionStudioLayersPanel.js';
 import { MotionStudioInspector } from './MotionStudioInspector.js';
 import { MotionStudioTimeline } from './MotionStudioTimeline.js';
 import { useSceneEditor } from './state/useSceneEditor.js';
 import type { MotionLayer, MotionLayerId } from '@joy-media/motion-core';
 import { createBlankScene } from '@joy-media/motion-core';
-import { createTextLayer, createRectangleLayer, createEllipseLayer, createImageLayer, createVideoLayer } from './state/layerFactory.js';
-import { loadMotionSceneDocument, saveMotionSceneDocument, publishMotionScene } from '../motion-scene-catalog.js';
+import {
+  createTextLayer,
+  createRectangleLayer,
+  createEllipseLayer,
+  createImageLayer,
+  createVideoLayer,
+} from './state/layerFactory.js';
+import {
+  loadMotionSceneDocument,
+  saveMotionSceneDocument,
+  publishMotionScene,
+} from '../motion-scene-catalog.js';
 
 export interface MotionStudioShellProps {
   readonly sceneId: string;
   readonly onClose: () => void;
 }
 
 const AUTOSAVE_DEBOUNCE_MS = 800;
 
 const LEFT_WIDTH_DEFAULT = 240;
 const RIGHT_WIDTH_DEFAULT = 260;
@@ -248,21 +269,22 @@ export function MotionStudioShell({ sceneId, onClose }: MotionStudioShellProps)
   const handleCommit = useCallback(
     (label: string) => {
       commitTransaction(label);
     },
     [commitTransaction],
   );
 
   const handleKeyDown = useCallback(
     (event: KeyboardEvent) => {
       const target = event.target as HTMLElement | null;
-      const editing = target?.isContentEditable || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
+      const editing =
+        target?.isContentEditable || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
       if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
         event.preventDefault();
         saveNow();
         return;
       }
       if (editing) return;
       if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
         event.preventDefault();
         selectLayers(document.layers.map((l) => l.id));
         return;
@@ -280,27 +302,40 @@ export function MotionStudioShell({ sceneId, onClose }: MotionStudioShellProps)
         event.preventDefault();
         const step = event.shiftKey ? 10 : 1;
         const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
         const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
         beginTransaction();
         for (const id of selectedLayerIds) {
           const layer = document.layers.find((l) => l.id === id);
           if (!layer || layer.locked) continue;
           updateTransaction({
             type: 'scene.setLayerTransform',
-            payload: { layerId: id, transform: { x: layer.transform.x + dx, y: layer.transform.y + dy } },
+            payload: {
+              layerId: id,
+              transform: { x: layer.transform.x + dx, y: layer.transform.y + dy },
+            },
           });
         }
         commitTransaction('Nudge layers');
       }
     },
-    [beginTransaction, clearSelection, commitTransaction, deleteSelected, document.layers, saveNow, selectLayers, selectedLayerIds, updateTransaction],
+    [
+      beginTransaction,
+      clearSelection,
+      commitTransaction,
+      deleteSelected,
+      document.layers,
+      saveNow,
+      selectLayers,
+      selectedLayerIds,
+      updateTransaction,
+    ],
   );
 
   useEffect(() => {
     window.addEventListener('keydown', handleKeyDown);
     return () => window.removeEventListener('keydown', handleKeyDown);
   }, [handleKeyDown]);
 
   const handleMoveLayer = useCallback(
     (layerId: MotionLayerId, direction: 'up' | 'down') => {
       const idx = document.layers.findIndex((l) => l.id === layerId);
@@ -330,21 +365,23 @@ export function MotionStudioShell({ sceneId, onClose }: MotionStudioShellProps)
       const startBottom = bottomHeight;
       const pointerId = event.pointerId;
       const sash = event.currentTarget;
       sash.setPointerCapture(pointerId);
       setResizing(edge);
 
       const onMove = (ev: PointerEvent) => {
         if (edge === 'left') {
           setLeftWidth(clamp(startLeft + (ev.clientX - startX), LEFT_WIDTH_MIN, LEFT_WIDTH_MAX));
         } else if (edge === 'right') {
-          setRightWidth(clamp(startRight - (ev.clientX - startX), RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX));
+          setRightWidth(
+            clamp(startRight - (ev.clientX - startX), RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX),
+          );
         } else {
           setBottomHeight(
             clamp(startBottom - (ev.clientY - startY), BOTTOM_HEIGHT_MIN, BOTTOM_HEIGHT_MAX),
           );
         }
       };
 
       const onUp = () => {
         sash.releasePointerCapture(pointerId);
         window.removeEventListener('pointermove', onMove);
@@ -498,17 +535,22 @@ export function MotionStudioShell({ sceneId, onClose }: MotionStudioShellProps)
             <div
               role="separator"
               aria-orientation="vertical"
               aria-label="Resize inspector panel"
               aria-valuenow={rightWidth}
               aria-valuemin={RIGHT_WIDTH_MIN}
               aria-valuemax={RIGHT_WIDTH_MAX}
               className="ms-sash ms-sash-west"
               onPointerDown={(e) => startPanelResize('right', e)}
             />
-            <MotionStudioInspector document={document} selectedLayerIds={selectedLayerIds} dispatch={dispatch} />
+            <MotionStudioInspector
+              document={document}
+              selectedLayerIds={selectedLayerIds}
+              dispatch={dispatch}
+              playheadMs={playheadMs}
+            />
           </div>
         )}
       </div>
     </div>
   );
 }
diff --git a/apps/editor-web/src/motion-studio/MotionStudioTimeline.test.tsx b/apps/editor-web/src/motion-studio/MotionStudioTimeline.test.tsx
new file mode 100644
index 0000000..cffec5e
--- /dev/null
+++ b/apps/editor-web/src/motion-studio/MotionStudioTimeline.test.tsx
@@ -0,0 +1,135 @@
+import { describe, expect, it, vi } from 'vitest';
+import type { MotionAnimation } from '@joy-media/motion-core';
+import {
+  copyMotionKeyframes,
+  moveMotionKeyframes,
+  pasteMotionKeyframes,
+} from './MotionStudioTimeline.js';
+import { buildMotionScenePlacementPlan } from './motionScenePlacement.js';
+
+const animations: readonly MotionAnimation[] = [
+  {
+    property: 'transform.x',
+    curve: {
+      keyframes: [
+        { id: 'x0', timeMs: 120, value: 0, easing: { kind: 'builtin', name: 'linear' } },
+        { id: 'x1', timeMs: 1120, value: 100, easing: { kind: 'builtin', name: 'linear' } },
+      ],
+    },
+  },
+  {
+    property: 'transform.y',
+    curve: {
+      keyframes: [{ id: 'y0', timeMs: 620, value: 20, easing: { kind: 'builtin', name: 'ease' } }],
+    },
+  },
+];
+
+describe('MotionStudioTimeline keyframe editing helpers', () => {
+  it('moves multi-selected keyframes and snaps them to the requested grid', () => {
+    const moved = moveMotionKeyframes(
+      animations,
+      [
+        { property: 'transform.x', keyframeId: 'x0' },
+        { property: 'transform.y', keyframeId: 'y0' },
+      ],
+      260,
+      { durationMs: 2000, snapIntervalMs: 100 },
+    );
+
+    expect(moved[0]!.curve.keyframes.map((keyframe) => keyframe.timeMs)).toEqual([400, 1120]);
+    expect(moved[1]!.curve.keyframes.map((keyframe) => keyframe.timeMs)).toEqual([900]);
+  });
+
+  it('copies a multi-property selection relative to the earliest keyframe and pastes with fresh ids', () => {
+    vi.spyOn(crypto, 'randomUUID')
+      .mockReturnValueOnce('new-x' as `${string}-${string}-${string}-${string}-${string}`)
+      .mockReturnValueOnce('new-y' as `${string}-${string}-${string}-${string}-${string}`);
+
+    const clipboard = copyMotionKeyframes(animations, [
+      { property: 'transform.x', keyframeId: 'x0' },
+      { property: 'transform.y', keyframeId: 'y0' },
+    ]);
+    expect(clipboard?.anchorTimeMs).toBe(120);
+
+    const pasted = pasteMotionKeyframes(animations, clipboard!, 1000, {
+      durationMs: 2000,
+      snapIntervalMs: 50,
+    });
+    expect(pasted[0]!.curve.keyframes.map((keyframe) => [keyframe.id, keyframe.timeMs])).toEqual([
+      ['x0', 120],
+      ['new-x', 1000],
+      ['x1', 1120],
+    ]);
+    expect(pasted[1]!.curve.keyframes.map((keyframe) => [keyframe.id, keyframe.timeMs])).toEqual([
+      ['y0', 620],
+      ['new-y', 1500],
+    ]);
+  });
+
+  it('builds main-timeline placement for a published Motion Studio scene using opaque asset ids', () => {
+    const plan = buildMotionScenePlacementPlan({
+      nowMs: 1234,
+      motionSceneId: 'motion-doc-1',
+      selectedClipId: 'source',
+      visualProject: {
+        schemaVersion: 1,
+        id: 'visual',
+        title: 'Visual',
+        createdAt: '2026-08-22T00:00:00.000Z',
+        updatedAt: '2026-08-22T00:00:00.000Z',
+        rootCompositionId: 'root',
+        settings: { defaultLocale: 'en-US' },
+        compositions: {},
+        assets: {},
+        variables: {},
+        markers: [],
+        visualObjects: {},
+        captionDocuments: {},
+        pluginData: {},
+      },
+      composition: {
+        id: 'root',
+        name: 'Root',
+        width: 1080,
+        height: 1920,
+        frameRate: { num: 30, den: 1 },
+        durationUs: 2_000_000,
+        tracks: [
+          {
+            id: 'V1',
+            kind: 'video',
+            order: 0,
+            enabled: true,
+            clips: [
+              {
+                kind: 'video',
+                id: 'source',
+                assetId: 'real-source',
+                startUs: 100_000,
+                durationUs: 900_000,
+                sourceInUs: 0,
+              },
+            ],
+          },
+        ],
+      },
+    });
+
+    expect(plan?.visualTransaction.commands[0]).toMatchObject({
+      type: 'motionScene.create',
+      payload: { object: { kind: 'motion-scene', motionSceneId: 'motion-doc-1' } },
+    });
+    expect(plan?.timelineTransaction.commands.at(-1)).toMatchObject({
+      type: 'timeline.insertClip',
+      payload: {
+        clip: {
+          kind: 'video',
+          assetId: 'motion-scene:motion-doc-1',
+          startUs: 100_000,
+          durationUs: 900_000,
+        },
+      },
+    });
+  });
+});
diff --git a/apps/editor-web/src/motion-studio/MotionStudioTimeline.tsx b/apps/editor-web/src/motion-studio/MotionStudioTimeline.tsx
index c65c34a..9db7818 100644
--- a/apps/editor-web/src/motion-studio/MotionStudioTimeline.tsx
+++ b/apps/editor-web/src/motion-studio/MotionStudioTimeline.tsx
@@ -1,12 +1,18 @@
 import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
-import type { MotionLayer, MotionSceneDocument, MotionLayerId, MotionAnimation, MotionKeyframe } from '@joy-media/motion-core';
+import type {
+  MotionLayer,
+  MotionSceneDocument,
+  MotionLayerId,
+  MotionAnimation,
+  MotionKeyframe,
+} from '@joy-media/motion-core';
 import {
   clampPixelsPerSecond,
   fitPixelsPerSecond,
   MIN_PIXELS_PER_SECOND,
   MAX_PIXELS_PER_SECOND,
   type TimelineViewport,
 } from '@joy-media/timeline-engine';
 import { TimelineCanvas } from '../TimelineCanvas.js';
 import {
   FitWidthIcon,
@@ -31,20 +37,127 @@ export interface MotionStudioTimelineProps {
   readonly playing: boolean;
   readonly selectedLayerIds: readonly MotionLayerId[];
   readonly onSeek: (timeMs: number) => void;
   readonly onTogglePlayback: () => void;
   readonly onSelectLayer: (layerId: MotionLayerId | null) => void;
   readonly onToggleVisibility: (layerId: MotionLayerId) => void;
   readonly onToggleLocked: (layerId: MotionLayerId) => void;
   readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
 }
 
+export interface MotionTimelineKeyframeSelection {
+  readonly property: string;
+  readonly keyframeId: string;
+}
+
+export interface CopiedMotionKeyframes {
+  readonly anchorTimeMs: number;
+  readonly entries: readonly {
+    readonly property: string;
+    readonly keyframe: MotionKeyframe;
+    readonly offsetMs: number;
+  }[];
+}
+
+function selectionKey(selection: MotionTimelineKeyframeSelection): string {
+  return `${selection.property}\0${selection.keyframeId}`;
+}
+
+function snapTimeMs(timeMs: number, snapIntervalMs: number): number {
+  if (!Number.isFinite(snapIntervalMs) || snapIntervalMs <= 0) return Math.max(0, timeMs);
+  return Math.max(0, Math.round(timeMs / snapIntervalMs) * snapIntervalMs);
+}
+
+export function moveMotionKeyframes(
+  animations: readonly MotionAnimation[],
+  selections: readonly MotionTimelineKeyframeSelection[],
+  deltaMs: number,
+  options: { readonly durationMs: number; readonly snapIntervalMs?: number },
+): readonly MotionAnimation[] {
+  const selected = new Set(selections.map(selectionKey));
+  const snap = options.snapIntervalMs ?? 0;
+  return animations.map((animation) => ({
+    ...animation,
+    curve: {
+      ...animation.curve,
+      keyframes: animation.curve.keyframes
+        .map((keyframe) => {
+          if (
+            !selected.has(selectionKey({ property: animation.property, keyframeId: keyframe.id }))
+          ) {
+            return keyframe;
+          }
+          const snapped = snapTimeMs(keyframe.timeMs + deltaMs, snap);
+          return { ...keyframe, timeMs: Math.min(options.durationMs, snapped) };
+        })
+        .sort((a, b) => a.timeMs - b.timeMs),
+    },
+  }));
+}
+
+export function copyMotionKeyframes(
+  animations: readonly MotionAnimation[],
+  selections: readonly MotionTimelineKeyframeSelection[],
+): CopiedMotionKeyframes | undefined {
+  const selected = new Set(selections.map(selectionKey));
+  const entries = animations.flatMap((animation) =>
+    animation.curve.keyframes
+      .filter((keyframe) =>
+        selected.has(selectionKey({ property: animation.property, keyframeId: keyframe.id })),
+      )
+      .map((keyframe) => ({ property: animation.property, keyframe })),
+  );
+  if (entries.length === 0) return undefined;
+  const anchorTimeMs = Math.min(...entries.map((entry) => entry.keyframe.timeMs));
+  return {
+    anchorTimeMs,
+    entries: entries.map((entry) => ({
+      ...entry,
+      offsetMs: entry.keyframe.timeMs - anchorTimeMs,
+    })),
+  };
+}
+
+export function pasteMotionKeyframes(
+  animations: readonly MotionAnimation[],
+  clipboard: CopiedMotionKeyframes,
+  atTimeMs: number,
+  options: { readonly durationMs: number; readonly snapIntervalMs?: number },
+): readonly MotionAnimation[] {
+  const byProperty = new Map<string, MotionAnimation>();
+  for (const animation of animations) byProperty.set(animation.property, animation);
+  const snap = options.snapIntervalMs ?? 0;
+  for (const entry of clipboard.entries) {
+    const existing = byProperty.get(entry.property);
+    const keyframe = {
+      ...entry.keyframe,
+      id: crypto.randomUUID(),
+      timeMs: Math.min(options.durationMs, snapTimeMs(atTimeMs + entry.offsetMs, snap)),
+    };
+    byProperty.set(
+      entry.property,
+      existing === undefined
+        ? { property: entry.property, curve: { keyframes: [keyframe] } }
+        : {
+            ...existing,
+            curve: {
+              ...existing.curve,
+              keyframes: [...existing.curve.keyframes, keyframe].sort(
+                (a, b) => a.timeMs - b.timeMs,
+              ),
+            },
+          },
+    );
+  }
+  return [...byProperty.values()];
+}
+
 /** Visible lane width = scrollport minus fixed 9.5rem track gutter. */
 function measureLaneWidthPx(root: HTMLElement | null): number {
   if (root === null) return 0;
   const scroll = root.querySelector('.timeline-tracks');
   if (!(scroll instanceof HTMLElement)) return 0;
   // Never use .timeline-lane clientWidth — that grows with zoomed content.
   return Math.max(0, scroll.clientWidth - 152);
 }
 
 /**
@@ -125,21 +238,24 @@ export function MotionStudioTimeline({
 
   const applyZoom = (nextPps: number) => {
     setViewport((prev) => ({
       ...prev,
       pixelsPerSecond: clampPixelsPerSecond(nextPps),
     }));
   };
 
   // ── Keyframe rows per selected layer ──
   const selectedLayer = useMemo(
-    () => (selectedLayerIds.length === 1 ? document.layers.find((l) => l.id === selectedLayerIds[0]) : null),
+    () =>
+      selectedLayerIds.length === 1
+        ? document.layers.find((l) => l.id === selectedLayerIds[0])
+        : null,
     [document.layers, selectedLayerIds],
   );
 
   const keyframeRows = useMemo(() => {
     if (!selectedLayer) return [];
     return selectedLayer.animations.map((anim) => ({
       property: anim.property,
       keyframeCount: anim.curve.keyframes.length,
       firstTimeUs: anim.curve.keyframes[0]?.timeMs ?? 0,
       lastTimeUs: anim.curve.keyframes[anim.curve.keyframes.length - 1]?.timeMs ?? 0,
@@ -406,11 +522,11 @@ export function MotionStudioTimeline({
         tracks={tracks}
         selectedClipIds={selectedClipIds}
         onSeek={(timeUs) => onSeek(timeUs / 1000)}
         onSelectClips={(clipIds) => onSelectLayer(clipIds[0] ?? null)}
         markers={markers}
         gutterLabel="Layers"
         gutterIconSrc={UI_ICONS.layers}
       />
     </section>
   );
-}
\ No newline at end of file
+}
diff --git a/apps/editor-web/src/motion-studio/motionScenePlacement.ts b/apps/editor-web/src/motion-studio/motionScenePlacement.ts
new file mode 100644
index 0000000..6fe7756
--- /dev/null
+++ b/apps/editor-web/src/motion-studio/motionScenePlacement.ts
@@ -0,0 +1,128 @@
+import type { CommandTransaction } from '@joy-media/commands';
+import type { JoyProjectV1, SpikeProject, VisualObjectV1 } from '@joy-media/project-schema';
+import type { VisualObjectTransaction } from '@joy-media/property-system';
+
+type TimelineComposition = NonNullable<
+  SpikeProject['compositions'][SpikeProject['rootCompositionId']]
+>;
+
+export interface MotionScenePlacementPlan {
+  readonly objectId: string;
+  readonly clipId: string;
+  readonly visualTransaction: VisualObjectTransaction;
+  readonly timelineTransaction: CommandTransaction;
+}
+
+export function buildMotionScenePlacementPlan(input: {
+  readonly composition: TimelineComposition;
+  readonly visualProject: JoyProjectV1;
+  readonly selectedClipId: string | undefined;
+  readonly motionSceneId: string;
+  readonly nowMs: number;
+}): MotionScenePlacementPlan | undefined {
+  const { composition, visualProject, selectedClipId, motionSceneId, nowMs } = input;
+  if (selectedClipId === undefined || motionSceneId.length === 0) return undefined;
+  const selection = composition.tracks
+    .flatMap((track) => track.clips.map((clip) => ({ clip, track })))
+    .find((item) => item.clip.id === selectedClipId);
+  if (selection === undefined) return undefined;
+
+  const suffix =
+    motionSceneId
+      .replace(/[^A-Za-z0-9._-]/g, '-')
+      .split('.')
+      .pop() || 'motion';
+  const objectId = `motion-scene-${suffix}-${nowMs.toString(36)}`;
+  const clipId = `clip-${objectId}`;
+  const startUs = selection.clip.startUs;
+  const durationUs = selection.clip.durationUs;
+  const sceneCount = Object.values(visualProject.visualObjects).filter(
+    (item) => item.kind === 'motion-scene',
+  ).length;
+
+  const overlaps = (
+    track: TimelineComposition['tracks'][number],
+    spanStart: number,
+    spanDuration: number,
+  ): boolean => {
+    const spanEnd = spanStart + spanDuration;
+    return track.clips.some((clip) => {
+      const clipEnd = clip.startUs + clip.durationUs;
+      return spanStart < clipEnd && spanEnd > clip.startUs;
+    });
+  };
+
+  const targetExisting = composition.tracks
+    .filter(
+      (track) =>
+        track.kind === 'video' &&
+        track.enabled &&
+        track.order > selection.track.order &&
+        !overlaps(track, startUs, durationUs),
+    )
+    .sort((a, b) => a.order - b.order)[0];
+  const order = composition.tracks.reduce((max, track) => Math.max(max, track.order), -1) + 1;
+  const targetTrackId = targetExisting?.id ?? `V${order + 1}`;
+  const insertClipCommand = {
+    type: 'timeline.insertClip' as const,
+    payload: {
+      compositionId: composition.id,
+      trackId: targetTrackId,
+      clip: {
+        id: clipId,
+        kind: 'video' as const,
+        assetId: `motion-scene:${motionSceneId}`,
+        startUs,
+        durationUs,
+        sourceInUs: 0,
+      },
+    },
+  };
+  const timelineCommands =
+    targetExisting === undefined
+      ? [
+          {
+            type: 'timeline.addTrack' as const,
+            payload: {
+              compositionId: composition.id,
+              track: {
+                id: targetTrackId,
+                kind: 'video' as const,
+                order,
+                enabled: true,
+                clips: [],
+              },
+            },
+          },
+          insertClipCommand,
+        ]
+      : [insertClipCommand];
+
+  const object: VisualObjectV1 = {
+    id: objectId,
+    kind: 'motion-scene',
+    motionSceneId,
+    transform: {
+      x: 80 + sceneCount * 40,
+      y: 120,
+      scaleX: 1,
+      scaleY: 1,
+      rotationDeg: 0,
+      opacity: 1,
+      crop: { left: 0, top: 0, right: 0, bottom: 0 },
+    },
+  };
+
+  return {
+    objectId,
+    clipId,
+    visualTransaction: {
+      label: `Add Motion scene ${motionSceneId}`,
+      commands: [{ type: 'motionScene.create', payload: { object } }],
+    },
+    timelineTransaction: {
+      label: `Place Motion scene ${motionSceneId}`,
+      commands: timelineCommands,
+    },
+  };
+}
diff --git a/apps/editor-web/src/motion-studio/state/layerFactory.ts b/apps/editor-web/src/motion-studio/state/layerFactory.ts
index e6712bd..64c72a3 100644
--- a/apps/editor-web/src/motion-studio/state/layerFactory.ts
+++ b/apps/editor-web/src/motion-studio/state/layerFactory.ts
@@ -1,26 +1,35 @@
 import type { MotionLayer, MotionLayerType } from '@joy-media/motion-core';
 import { DEFAULT_TRANSFORM, DEFAULT_TYPOGRAPHY } from '@joy-media/motion-core';
 
 function nextId(): string {
   return crypto.randomUUID();
 }
 
 function base(type: MotionLayerType, name: string): MotionLayer {
   return {
-    id: nextId(), type, name, visible: true, locked: false,
+    id: nextId(),
+    type,
+    name,
+    visible: true,
+    locked: false,
     transform: { ...DEFAULT_TRANSFORM },
-    fills: [], strokes: [], shadows: [], filters: [],
-    blendMode: 'normal', borderRadius: [0, 0, 0, 0] as const,
+    fills: [],
+    strokes: [],
+    shadows: [],
+    filters: [],
+    blendMode: 'normal',
+    borderRadius: [0, 0, 0, 0] as const,
     overflow: 'visible' as const,
     layout: { mode: 'free' as const },
-    children: [], animations: [],
+    children: [],
+    animations: [],
   };
 }
 
 export function createTextLayer(text: string, x = 100, y = 100, w = 400, h = 100): MotionLayer {
   return {
     ...base('text', `Text "${text.slice(0, 12)}"`),
     text,
     typography: { ...DEFAULT_TYPOGRAPHY },
     transform: { ...DEFAULT_TRANSFORM, x, y, width: w, height: h },
     fills: [{ kind: 'solid', color: '#ffffff', opacity: 1 }],
@@ -38,32 +47,67 @@ export function createRectangleLayer(x = 100, y = 100, w = 200, h = 150): Motion
 
 export function createEllipseLayer(x = 100, y = 100, w = 200, h = 200): MotionLayer {
   return {
     ...base('shape', 'Ellipse'),
     transform: { ...DEFAULT_TRANSFORM, x, y, width: w, height: h },
     fills: [{ kind: 'solid', color: '#6fcf97', opacity: 1 }],
     borderRadius: [9999, 9999, 9999, 9999] as const,
   };
 }
 
-export function createImageLayer(assetId: string, name = 'Image', x = 100, y = 100, w = 300, h = 300): MotionLayer {
+export function createImageLayer(
+  assetId: string,
+  name = 'Image',
+  x = 100,
+  y = 100,
+  w = 300,
+  h = 300,
+): MotionLayer {
   return {
     ...base('image', name),
     assetId,
     transform: { ...DEFAULT_TRANSFORM, x, y, width: w, height: h },
   };
 }
 
-export function createVideoLayer(assetId: string, name = 'Video', x = 100, y = 100, w = 480, h = 270): MotionLayer {
+export function createVideoLayer(
+  assetId: string,
+  name = 'Video',
+  x = 100,
+  y = 100,
+  w = 480,
+  h = 270,
+): MotionLayer {
   return {
     ...base('video', name),
     assetId,
     transform: { ...DEFAULT_TRANSFORM, x, y, width: w, height: h },
   };
 }
 
-export function createContainerLayer(name = 'Container', x = 50, y = 50, w = 400, h = 300): MotionLayer {
+export function createSvgLayer(
+  svgContent: string,
+  name = 'SVG',
+  x = 100,
+  y = 100,
+  w = 300,
+  h = 300,
+): MotionLayer {
+  return {
+    ...base('svg', name),
+    svgContent,
+    transform: { ...DEFAULT_TRANSFORM, x, y, width: w, height: h },
+  };
+}
+
+export function createContainerLayer(
+  name = 'Container',
+  x = 50,
+  y = 50,
+  w = 400,
+  h = 300,
+): MotionLayer {
   return {
     ...base('container', name),
     transform: { ...DEFAULT_TRANSFORM, x, y, width: w, height: h },
   };
 }
diff --git a/apps/editor-web/src/motion-studio/state/useSceneEditor.test.ts b/apps/editor-web/src/motion-studio/state/useSceneEditor.test.ts
new file mode 100644
index 0000000..ac36437
--- /dev/null
+++ b/apps/editor-web/src/motion-studio/state/useSceneEditor.test.ts
@@ -0,0 +1,47 @@
+import { describe, expect, it } from 'vitest';
+import { createBlankScene } from '@joy-media/motion-core';
+import { applySceneCommand } from './sceneCommands.js';
+import { createRectangleLayer, createTextLayer } from './layerFactory.js';
+
+describe('Motion Studio scene editor command state', () => {
+  it('builds a single inverse for a transform interaction that undo can replay', () => {
+    const layer = createRectangleLayer(10, 20, 100, 80);
+    const document = { ...createBlankScene('History'), layers: [layer] };
+
+    const moved = applySceneCommand(document, {
+      type: 'scene.setLayerTransform',
+      payload: { layerId: layer.id, transform: { x: 50, y: 75 } },
+    });
+    const undone = applySceneCommand(moved.document, moved.inverse);
+
+    expect(moved.document.layers[0]!.transform).toMatchObject({ x: 50, y: 75 });
+    expect(undone.document.layers[0]!.transform).toEqual(layer.transform);
+  });
+
+  it('groups and ungroups layers without losing child identities', () => {
+    const text = createTextLayer('A', 0, 0, 100, 50);
+    const rect = createRectangleLayer(100, 0, 100, 50);
+    const group = {
+      ...createRectangleLayer(0, 0, 200, 50),
+      id: 'group',
+      type: 'group' as const,
+      children: [text.id, rect.id],
+    };
+    const document = { ...createBlankScene('Group'), layers: [text, rect] };
+    const withGroup = applySceneCommand(document, {
+      type: 'scene.addLayer',
+      payload: { layer: group },
+    }).document;
+    const parented = [text.id, rect.id].reduce(
+      (current, layerId) =>
+        applySceneCommand(current, {
+          type: 'scene.setLayerProperty',
+          payload: { layerId, property: 'parentId', value: group.id },
+        }).document,
+      withGroup,
+    );
+
+    expect(parented.layers.find((layer) => layer.id === text.id)?.parentId).toBe(group.id);
+    expect(parented.layers.find((layer) => layer.id === rect.id)?.parentId).toBe(group.id);
+  });
+});
diff --git a/packages/production-quality/src/preflight.ts b/packages/production-quality/src/preflight.ts
index 44f44fc..63fdc34 100644
--- a/packages/production-quality/src/preflight.ts
+++ b/packages/production-quality/src/preflight.ts
@@ -1,21 +1,22 @@
 import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
 import {
   finding,
   type DeliveryPromiseV1,
   type RenderReportV1,
   type QualityFindingV1,
 } from './types.js';
 
 const CAPTION_BURN_IN_KEY = 'joy.captions.burnIn';
 
-export type PlannedAssetKind = 'video' | 'audio' | 'image' | 'other' | 'html-scene';
+export type PlannedAssetKind =
+  'video' | 'audio' | 'image' | 'other' | 'html-scene' | 'motion-scene';
 
 export interface QualityOpaqueAssetDescriptor {
   readonly id: string;
   readonly kind: PlannedAssetKind;
   readonly displayName?: string;
   readonly opaqueRef: string;
   readonly integrity?: {
     readonly sha256?: string;
     readonly totalBytes?: number;
     readonly mimeType?: string;
@@ -183,20 +184,30 @@ function validateBindings(bundle: QualityRenderBundleV1): readonly QualityFindin
   }
   for (const object of Object.values(project.visualObjects)) {
     if (object.kind === 'html-scene') {
       const id = `html-scene:${object.scenePackageId ?? ''}`;
       if (bundle.assets[id] === undefined) {
         findings.push(
           finding('asset-binding', 'fail', `HTML scene ${id} is unresolved`, { refId: object.id }),
         );
       }
     }
+    if (object.kind === 'motion-scene') {
+      const id = `motion-scene:${object.motionSceneId ?? ''}`;
+      if (bundle.assets[id] === undefined) {
+        findings.push(
+          finding('asset-binding', 'fail', `Motion scene ${id} is unresolved`, {
+            refId: object.id,
+          }),
+        );
+      }
+    }
   }
   for (const composition of Object.values(project.compositions)) {
     for (const track of composition.tracks) {
       for (const clip of track.clips) {
         if (
           clip.kind === 'caption' &&
           project.captionDocuments[clip.captionDocumentId] === undefined
         ) {
           findings.push(
             finding('caption-binding', 'fail', 'caption clip references a missing document', {
diff --git a/packages/project-schema/src/v1.test.ts b/packages/project-schema/src/v1.test.ts
index 3271b8d..94e16b8 100644
--- a/packages/project-schema/src/v1.test.ts
+++ b/packages/project-schema/src/v1.test.ts
@@ -413,20 +413,72 @@ describe('v1 project schema and migration harness', () => {
       },
       visualObjects: {
         'not-a-camera': { id: 'not-a-camera', kind: 'text', transform },
       },
     });
     expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
       '"not-a-camera" is not a camera object',
     );
   });
 
+  it('accepts a published Motion Studio scene object with a durable scene id', () => {
+    const base = migrateV0ToV1(v0Fixture()).project;
+    const transform = {
+      x: 0,
+      y: 0,
+      scaleX: 1,
+      scaleY: 1,
+      rotationDeg: 0,
+      opacity: 1,
+      crop: { left: 0, top: 0, right: 0, bottom: 0 },
+    };
+    expect(
+      validateJoyProjectV1({
+        ...base,
+        visualObjects: {
+          'motion-scene-1': {
+            id: 'motion-scene-1',
+            kind: 'motion-scene',
+            motionSceneId: 'motion-doc-1',
+            transform,
+          },
+        },
+      }),
+    ).toEqual([]);
+  });
+
+  it('reports Motion Studio scene object shape violations', () => {
+    const base = migrateV0ToV1(v0Fixture()).project;
+    const transform = {
+      x: 0,
+      y: 0,
+      scaleX: 1,
+      scaleY: 1,
+      rotationDeg: 0,
+      opacity: 1,
+      crop: { left: 0, top: 0, right: 0, bottom: 0 },
+    };
+    const diagnostics = validateJoyProjectV1({
+      ...base,
+      visualObjects: {
+        'motion-scene-1': { id: 'motion-scene-1', kind: 'motion-scene', transform },
+        text: { id: 'text', kind: 'text', motionSceneId: 'leaked', transform },
+      },
+    });
+    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
+      expect.arrayContaining([
+        'motion-scene objects require a non-empty motionSceneId',
+        'only motion-scene objects may carry motionSceneId',
+      ]),
+    );
+  });
+
   it('accepts a visual object with a valid expressions map (ADR-0015)', () => {
     const base = migrateV0ToV1(v0Fixture()).project;
     const project = {
       ...base,
       visualObjects: {
         'obj-1': {
           id: 'obj-1',
           kind: 'text',
           transform: {
             x: 0,
diff --git a/packages/project-schema/src/v1.ts b/packages/project-schema/src/v1.ts
index 561d7d1..ba0d6b5 100644
--- a/packages/project-schema/src/v1.ts
+++ b/packages/project-schema/src/v1.ts
@@ -11,23 +11,21 @@ export type EffectParamValue =
   | boolean
   | readonly [number, number]
   | readonly [number, number, number]
   | readonly [number, number, number, number];
 
 export interface EffectInstanceV1 {
   readonly id: string;
   readonly effectId: string;
   readonly enabled: boolean;
   readonly params: Readonly<Record<string, EffectParamValue>>;
-  readonly animations?: Readonly<
-    Partial<Record<string, AnimationCurveV1>>
-  >;
+  readonly animations?: Readonly<Partial<Record<string, AnimationCurveV1>>>;
   readonly label?: string;
 }
 
 export interface JoyProjectV1 {
   readonly schemaVersion: 1;
   readonly id: string;
   readonly title: string;
   readonly createdAt: string;
   readonly updatedAt: string;
   readonly rootCompositionId: CompositionId;
@@ -154,26 +152,28 @@ export interface CameraParamsV1 {
   readonly fieldOfViewDeg: number;
 }
 
 /**
  * A visual object. `kind: 'null'` is a controller ("null object"): it renders
  * nothing but contributes a transform that its children inherit (§20.3
  * parenting). `kind: 'camera'` is a depth-only 2.5D camera controller (ADR-0015):
  * it renders nothing but its resolved transform + `camera` params drive
  * perspective projection for a composition's `activeCameraId`. `kind: 'html-scene'`
  * references a first-party or packaged HTML scene (`scenePackageId`) for
- * Monitor/export (P04). `parentId` links an object to its parent for transform
+ * Monitor/export (P04). `kind: 'motion-scene'` references a published Motion
+ * Studio scene (`motionSceneId`) that is captured as timeline media.
+ * `parentId` links an object to its parent for transform
  * inheritance; the graph must stay acyclic.
  */
 export interface VisualObjectV1 {
   readonly id: string;
-  readonly kind: 'image' | 'text' | 'shape' | 'null' | 'camera' | 'html-scene';
+  readonly kind: 'image' | 'text' | 'shape' | 'null' | 'camera' | 'html-scene' | 'motion-scene';
   readonly transform: VisualObjectTransformV1;
   /** Optional per-channel keyframe curves; a present channel overrides the static value (§20.3). */
   readonly animations?: Readonly<Partial<Record<AnimatablePropertyV1, AnimationCurveV1>>>;
   /**
    * Optional per-channel restricted expressions (§20.3, ADR-0015): source text
    * evaluated by `@joy-media/expression-core`. A present channel overrides its
    * keyframe curve/static value when it evaluates cleanly; project-schema only
    * checks the shape here (non-empty string) since it cannot depend on the
    * expression engine (§9.1 — dependency points inward). Compile/cycle
    * validity is enforced at command time (`object.setExpression`); a stored
@@ -186,20 +186,22 @@ export interface VisualObjectV1 {
   /** Parent object id for transform inheritance; must reference an existing, non-cyclic object. */
   readonly parentId?: string;
   readonly motionBlur?: MotionBlurV1;
   readonly assetId?: string;
   readonly text?: string;
   readonly shape?: 'rectangle' | 'ellipse';
   /** Present iff `kind === 'camera'` (ADR-0015). */
   readonly camera?: CameraParamsV1;
   /** Present iff `kind === 'html-scene'` — first-party or package scene id (P04). */
   readonly scenePackageId?: string;
+  /** Present iff `kind === 'motion-scene'` — published Motion Studio scene id (P18). */
+  readonly motionSceneId?: string;
   /** Applied visual effects (P16). Stable per-instance IDs; order = application order. */
   readonly effects?: readonly EffectInstanceV1[];
 }
 
 export interface CompositionV1 {
   readonly id: CompositionId;
   readonly name: string;
   readonly width: number;
   readonly height: number;
   readonly pixelAspectRatio: Rational;
@@ -387,25 +389,21 @@ export interface TransitionV1 {
   readonly trackId: string;
   readonly leftClipId: string;
   readonly rightClipId: string;
   readonly type: string;
   readonly durationUs: TimeUs;
   /** Optional numeric overrides for gl-transition uniforms. */
   readonly params?: Readonly<Record<string, number>>;
 }
 
 export type ExportPresetId =
-  | 'social-h264-aac'
-  | 'reels-1080'
-  | 'shorts-1080'
-  | 'youtube-1080'
-  | 'high-bitrate';
+  'social-h264-aac' | 'reels-1080' | 'shorts-1080' | 'youtube-1080' | 'high-bitrate';
 
 export type JsonValue =
   null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
 
 /** Runtime diagnostics for untrusted JSON; this boundary is intentionally dependency-free. */
 export function validateJoyProjectV1(value: unknown): ProjectDiagnostic[] {
   const diagnostics: ProjectDiagnostic[] = [];
   if (!isRecord(value))
     return [diagnostic('PROJECT_SCHEMA_V1_NOT_OBJECT', 'project must be an object', '')];
   if (value.schemaVersion !== 1)
@@ -747,21 +745,22 @@ function validateVisualObject(
   if (!isRecord(value) || !isNonEmptyString(value.id)) {
     diagnostics.push(diagnostic('PROJECT_SCHEMA_V1_VISUAL_OBJECT', 'object id is required', path));
     return;
   }
   if (
     value.kind !== 'image' &&
     value.kind !== 'text' &&
     value.kind !== 'shape' &&
     value.kind !== 'null' &&
     value.kind !== 'camera' &&
-    value.kind !== 'html-scene'
+    value.kind !== 'html-scene' &&
+    value.kind !== 'motion-scene'
   )
     diagnostics.push(diagnostic('PROJECT_SCHEMA_V1_VISUAL_OBJECT', 'object kind is invalid', path));
   if (value.kind === 'camera') {
     const camera = value.camera;
     if (
       !isRecord(camera) ||
       !Number.isFinite(camera.fieldOfViewDeg) ||
       (camera.fieldOfViewDeg as number) <= 0 ||
       (camera.fieldOfViewDeg as number) > 170
     )
@@ -788,20 +787,38 @@ function validateVisualObject(
       );
   } else if (value.scenePackageId !== undefined) {
     diagnostics.push(
       diagnostic(
         'PROJECT_SCHEMA_V1_HTML_SCENE',
         'only html-scene objects may carry scenePackageId',
         path,
       ),
     );
   }
+  if (value.kind === 'motion-scene') {
+    if (!isNonEmptyString(value.motionSceneId))
+      diagnostics.push(
+        diagnostic(
+          'PROJECT_SCHEMA_V1_MOTION_SCENE',
+          'motion-scene objects require a non-empty motionSceneId',
+          path,
+        ),
+      );
+  } else if (value.motionSceneId !== undefined) {
+    diagnostics.push(
+      diagnostic(
+        'PROJECT_SCHEMA_V1_MOTION_SCENE',
+        'only motion-scene objects may carry motionSceneId',
+        path,
+      ),
+    );
+  }
   if (value.parentId !== undefined && !isNonEmptyString(value.parentId))
     diagnostics.push(
       diagnostic('PROJECT_SCHEMA_V1_VISUAL_OBJECT', 'parentId must be a non-empty string', path),
     );
   if (value.motionBlur !== undefined) {
     const blur = value.motionBlur;
     if (
       !isRecord(blur) ||
       typeof blur.enabled !== 'boolean' ||
       !Number.isFinite(blur.shutterAngleDeg) ||
diff --git a/packages/property-system/src/index.test.ts b/packages/property-system/src/index.test.ts
index f016a30..487b39f 100644
--- a/packages/property-system/src/index.test.ts
+++ b/packages/property-system/src/index.test.ts
@@ -120,11 +120,44 @@ describe('visual property schemas', () => {
       commands: [
         {
           type: 'object.setTransformProperty',
           payload: { objectId: 'title', key: 'x', value: 12 },
         },
       ],
     });
     expect(updated.visualObjects.title!.transform.x).toBe(12);
     expect(project.visualObjects.title!.transform.x).toBe(0);
   });
+
+  it('creates and removes durable Motion Studio scene objects with undo inverses', () => {
+    const migrated = migrateV0ToV1(emptySpikeProject());
+    const object = {
+      id: 'motion-scene-object',
+      kind: 'motion-scene',
+      motionSceneId: 'motion-doc-1',
+      transform: {
+        x: 0,
+        y: 0,
+        scaleX: 1,
+        scaleY: 1,
+        rotationDeg: 0,
+        opacity: 1,
+        crop: { left: 0, top: 0, right: 0, bottom: 0 },
+      },
+    } as const;
+    const project = { ...migrated.project, visualObjects: {} };
+    const created = applyVisualObjectProjectTransaction(project, {
+      label: 'Create motion scene',
+      commands: [{ type: 'motionScene.create', payload: { object } }],
+    });
+
+    expect(created.visualObjects['motion-scene-object']).toMatchObject({
+      kind: 'motion-scene',
+      motionSceneId: 'motion-doc-1',
+    });
+    const removed = applyVisualObjectProjectTransaction(created, {
+      label: 'Remove motion scene',
+      commands: [{ type: 'motionScene.remove', payload: { objectId: object.id } }],
+    });
+    expect(removed.visualObjects['motion-scene-object']).toBeUndefined();
+  });
 });
diff --git a/packages/property-system/src/index.ts b/packages/property-system/src/index.ts
index be04929..0f0eefd 100644
--- a/packages/property-system/src/index.ts
+++ b/packages/property-system/src/index.ts
@@ -116,20 +116,29 @@ export type VisualObjectCommand =
     }
   | {
       /** Adds a `kind: 'html-scene'` object referencing a scene package (P04). */
       readonly type: 'htmlScene.create';
       readonly payload: { readonly object: VisualObjectV1 };
     }
   | {
       readonly type: 'htmlScene.remove';
       readonly payload: { readonly objectId: string };
     }
+  | {
+      /** Adds a `kind: 'motion-scene'` object referencing a published Motion Studio scene (P18). */
+      readonly type: 'motionScene.create';
+      readonly payload: { readonly object: VisualObjectV1 };
+    }
+  | {
+      readonly type: 'motionScene.remove';
+      readonly payload: { readonly objectId: string };
+    }
   | {
       /** Adds a `kind: 'image'` sticker / overlay object (P15). */
       readonly type: 'image.create';
       readonly payload: { readonly object: VisualObjectV1 };
     }
   | {
       readonly type: 'image.remove';
       readonly payload: { readonly objectId: string };
     }
   | CaptionCommand
@@ -336,37 +345,71 @@ export function applyVisualObjectProjectCommand(
         ...project,
         visualObjects: { ...project.visualObjects, [object.id]: object },
       },
       inverse: { type: 'htmlScene.remove', payload: { objectId: object.id } },
     };
   }
   if (command.type === 'htmlScene.remove') {
     const { objectId } = command.payload;
     const scene = project.visualObjects[objectId];
     if (scene === undefined) throw new RangeError(`unknown visual object "${objectId}"`);
-    if (scene.kind !== 'html-scene') throw new RangeError(`object "${objectId}" is not an html-scene`);
+    if (scene.kind !== 'html-scene')
+      throw new RangeError(`object "${objectId}" is not an html-scene`);
     const parentOf = Object.values(project.visualObjects).find(
       (candidate) => candidate.parentId === objectId,
     );
     if (parentOf !== undefined)
       throw new RangeError(`html-scene "${objectId}" is still the parent of "${parentOf.id}"`);
     const remaining = { ...project.visualObjects };
     delete remaining[objectId];
     return {
       project: { ...project, visualObjects: remaining },
       inverse: { type: 'htmlScene.create', payload: { object: scene } },
     };
   }
+  if (command.type === 'motionScene.create') {
+    const { object } = command.payload;
+    if (object.kind !== 'motion-scene')
+      throw new RangeError('motionScene.create requires a motion-scene-kind object');
+    if (typeof object.motionSceneId !== 'string' || object.motionSceneId.length === 0)
+      throw new RangeError('motionScene.create requires motionSceneId');
+    if (project.visualObjects[object.id] !== undefined)
+      throw new RangeError(`visual object "${object.id}" already exists`);
+    return {
+      project: {
+        ...project,
+        visualObjects: { ...project.visualObjects, [object.id]: object },
+      },
+      inverse: { type: 'motionScene.remove', payload: { objectId: object.id } },
+    };
+  }
+  if (command.type === 'motionScene.remove') {
+    const { objectId } = command.payload;
+    const scene = project.visualObjects[objectId];
+    if (scene === undefined) throw new RangeError(`unknown visual object "${objectId}"`);
+    if (scene.kind !== 'motion-scene')
+      throw new RangeError(`object "${objectId}" is not a motion-scene`);
+    const parentOf = Object.values(project.visualObjects).find(
+      (candidate) => candidate.parentId === objectId,
+    );
+    if (parentOf !== undefined)
+      throw new RangeError(`motion-scene "${objectId}" is still the parent of "${parentOf.id}"`);
+    const remaining = { ...project.visualObjects };
+    delete remaining[objectId];
+    return {
+      project: { ...project, visualObjects: remaining },
+      inverse: { type: 'motionScene.create', payload: { object: scene } },
+    };
+  }
   if (command.type === 'image.create') {
     const { object } = command.payload;
-    if (object.kind !== 'image')
-      throw new RangeError('image.create requires an image-kind object');
+    if (object.kind !== 'image') throw new RangeError('image.create requires an image-kind object');
     if (typeof object.assetId !== 'string' || object.assetId.length === 0)
       throw new RangeError('image.create requires assetId');
     if (project.visualObjects[object.id] !== undefined)
       throw new RangeError(`visual object "${object.id}" already exists`);
     return {
       project: {
         ...project,
         visualObjects: { ...project.visualObjects, [object.id]: object },
         assets: {
           ...project.assets,
diff --git a/packages/render-planner/src/plan-frame.ts b/packages/render-planner/src/plan-frame.ts
index d5dc250..d6038b9 100644
--- a/packages/render-planner/src/plan-frame.ts
+++ b/packages/render-planner/src/plan-frame.ts
@@ -259,20 +259,29 @@ function plannedCaptureRequirements(
     }
     if (object.kind === 'html-scene' && object.scenePackageId !== undefined) {
       requirements.push({
         id: `html-scene:${object.id}`,
         kind: 'html-scene',
         objectId: object.id,
         assetId: `html-scene:${object.scenePackageId}`,
         sourceTimeUs: timeUs,
       });
     }
+    if (object.kind === 'motion-scene' && object.motionSceneId !== undefined) {
+      requirements.push({
+        id: `motion-scene:${object.id}`,
+        kind: 'motion-scene',
+        objectId: object.id,
+        assetId: `motion-scene:${object.motionSceneId}`,
+        sourceTimeUs: timeUs,
+      });
+    }
   }
   if (captionNodes.length > 0) {
     requirements.push({ id: 'caption-burn-in', kind: 'caption-burn-in' });
   }
   return requirements;
 }
 
 function plannedAssetRequirements(
   assets: Readonly<Record<string, OpaqueAssetDescriptor>>,
   project: JoyProjectV1,
@@ -292,29 +301,43 @@ function plannedAssetRequirements(
     )
       return;
     const descriptor = assets[assetId];
     requirements.push({
       assetId,
       kind,
       reason,
       ...(descriptor !== undefined ? { descriptor } : {}),
     });
   };
-  for (const sample of videoSamples) push(sample.assetId, 'video', 'video-sample');
+  for (const sample of videoSamples) {
+    const kind = assets[sample.assetId]?.kind ?? 'video';
+    push(
+      sample.assetId,
+      kind,
+      kind === 'motion-scene'
+        ? 'motion-scene'
+        : kind === 'html-scene'
+          ? 'html-scene'
+          : 'video-sample',
+    );
+  }
   for (const sample of audioSamples) push(sample.assetId, 'audio', 'audio-sample');
   for (const object of Object.values(project.visualObjects)) {
     if (object.kind === 'image' && object.assetId !== undefined) {
       push(object.assetId, 'image', 'still-bitmap');
     }
     if (object.kind === 'html-scene' && object.scenePackageId !== undefined) {
       push(`html-scene:${object.scenePackageId}`, 'html-scene', 'html-scene');
     }
+    if (object.kind === 'motion-scene' && object.motionSceneId !== undefined) {
+      push(`motion-scene:${object.motionSceneId}`, 'motion-scene', 'motion-scene');
+    }
   }
   return requirements;
 }
 
 function mediaFindings(
   requirements: readonly PlannedAssetRequirement[],
 ): readonly DeterministicFinding[] {
   return requirements.flatMap((requirement): readonly DeterministicFinding[] => {
     const descriptor = requirement.descriptor;
     if (descriptor === undefined) {
diff --git a/packages/render-planner/src/render-bundle.ts b/packages/render-planner/src/render-bundle.ts
index 450cc06..75a550e 100644
--- a/packages/render-planner/src/render-bundle.ts
+++ b/packages/render-planner/src/render-bundle.ts
@@ -31,29 +31,40 @@ export function assetDescriptorsFromProject(
   for (const asset of Object.values(project.assets)) {
     descriptors[asset.id] = {
       id: asset.id,
       kind: asset.kind,
       displayName: asset.displayName,
       opaqueRef: `asset:${asset.id}`,
       availability: 'ready',
     };
   }
   for (const object of Object.values(project.visualObjects)) {
-    if (object.kind !== 'html-scene' || object.scenePackageId === undefined) continue;
-    const id = `html-scene:${object.scenePackageId}`;
-    descriptors[id] = {
-      id,
-      kind: 'html-scene',
-      displayName: object.scenePackageId,
-      opaqueRef: `html-scene:${object.scenePackageId}`,
-      availability: 'ready',
-    };
+    if (object.kind === 'html-scene' && object.scenePackageId !== undefined) {
+      const id = `html-scene:${object.scenePackageId}`;
+      descriptors[id] = {
+        id,
+        kind: 'html-scene',
+        displayName: object.scenePackageId,
+        opaqueRef: `html-scene:${object.scenePackageId}`,
+        availability: 'ready',
+      };
+    }
+    if (object.kind === 'motion-scene' && object.motionSceneId !== undefined) {
+      const id = `motion-scene:${object.motionSceneId}`;
+      descriptors[id] = {
+        id,
+        kind: 'motion-scene',
+        displayName: object.motionSceneId,
+        opaqueRef: `motion-scene:${object.motionSceneId}`,
+        availability: 'ready',
+      };
+    }
   }
   return descriptors;
 }
 
 function assertOpaqueDescriptors(assets: Readonly<Record<string, OpaqueAssetDescriptor>>): void {
   for (const descriptor of Object.values(assets)) {
     if (looksLikeLocalPath(descriptor.opaqueRef)) {
       throw new Error(
         `asset descriptor "${descriptor.id}" must use an opaque ref, not a local path`,
       );
diff --git a/packages/render-planner/src/types.ts b/packages/render-planner/src/types.ts
index 1410f8d..094e79f 100644
--- a/packages/render-planner/src/types.ts
+++ b/packages/render-planner/src/types.ts
@@ -1,20 +1,20 @@
 import type { RenderFrameIR } from '@joy-media/render-ir';
 import type {
   AssetRecordV1,
   ExportPresetId,
   JoyProjectV1,
   SpikeProject,
   TimeUs,
 } from '@joy-media/project-schema';
 
-export type PlannedAssetKind = AssetRecordV1['kind'] | 'html-scene';
+export type PlannedAssetKind = AssetRecordV1['kind'] | 'html-scene' | 'motion-scene';
 
 export interface OpaqueAssetDescriptor {
   readonly id: string;
   readonly kind: PlannedAssetKind;
   readonly displayName?: string;
   readonly opaqueRef: string;
   readonly integrity?: {
     readonly sha256?: string;
     readonly totalBytes?: number;
     readonly mimeType?: string;
@@ -37,42 +37,42 @@ export interface PlanRenderFrameInput {
   readonly timeUs: TimeUs;
   readonly viewport?: { readonly width: number; readonly height: number };
   readonly imageSizesByObjectId?: Readonly<
     Record<string, { readonly width: number; readonly height: number }>
   >;
 }
 
 export interface PlannedAssetRequirement {
   readonly assetId: string;
   readonly kind: PlannedAssetKind;
-  readonly reason: 'video-sample' | 'still-bitmap' | 'html-scene' | 'audio-sample';
+  readonly reason: 'video-sample' | 'still-bitmap' | 'html-scene' | 'motion-scene' | 'audio-sample';
   readonly descriptor?: OpaqueAssetDescriptor;
 }
 
 export interface PlannedVideoSample {
   readonly clipId: string;
   readonly assetId: string;
   readonly sourceTimeUs: number;
   readonly role: 'primary' | 'transition-left' | 'transition-right';
 }
 
 export interface PlannedAudioSample {
   readonly clipId: string;
   readonly assetId: string;
   readonly sourceTimeUs: number;
   readonly gain: number;
   readonly pan: number;
 }
 
 export interface PlannedCaptureRequirement {
   readonly id: string;
-  readonly kind: 'video-frame' | 'still-bitmap' | 'html-scene' | 'caption-burn-in';
+  readonly kind: 'video-frame' | 'still-bitmap' | 'html-scene' | 'motion-scene' | 'caption-burn-in';
   readonly assetId?: string;
   readonly clipId?: string;
   readonly objectId?: string;
   readonly sourceTimeUs?: number;
 }
 
 export interface DeterministicFinding {
   readonly code: 'missing-media' | 'unavailable-media' | 'expression-fallback' | 'caption-burn-in';
   readonly severity: 'info' | 'warning' | 'error';
   readonly message: string;
diff --git a/packages/visual-object-renderer/src/index.test.ts b/packages/visual-object-renderer/src/index.test.ts
index 7ccfa95..d265a4c 100644
--- a/packages/visual-object-renderer/src/index.test.ts
+++ b/packages/visual-object-renderer/src/index.test.ts
@@ -169,20 +169,37 @@ describe('buildRenderFrameIR', () => {
       }),
     );
     const frame = buildRenderFrameIR('c', 0, 1280, 720, [obj]);
     const node = frame.nodes[0];
     expect(node?.kind).toBe('video-frame');
     if (node?.kind !== 'video-frame') throw new Error('expected html scene video frame');
     expect(node.width).toBe(1280);
     expect(node.height).toBe(720);
   });
 
+  it('sizes Motion Studio scene nodes as captured video frames for preview and export', () => {
+    const obj = resolved(
+      makeObject({
+        id: 'motion-scene',
+        kind: 'motion-scene',
+        motionSceneId: 'motion-doc-1',
+      }),
+    );
+    const frame = buildRenderFrameIR('c', 250_000, 1080, 1920, [obj]);
+    const node = frame.nodes[0];
+    expect(node?.kind).toBe('video-frame');
+    if (node?.kind !== 'video-frame') throw new Error('expected motion scene video frame');
+    expect(node.width).toBe(1080);
+    expect(node.height).toBe(1920);
+    expect(node.id).toBe('motion-scene');
+  });
+
   it('attaches per-object effects and master color grade', () => {
     const obj = resolved(makeObject({ id: 'img', kind: 'image' }));
     const frame = buildRenderFrameIR('c', 0, 100, 100, [obj], {
       colorGrade: { lift: 0.1, gamma: 1.1, gain: 0.9, saturation: 0.8 },
       effectsByObjectId: {
         img: [
           { id: 'e1', effectId: 'blur', enabled: true, params: { amount: 4 } },
           { id: 'e2', effectId: 'grain', enabled: false, params: { amount: 0.2 } },
         ],
       },
diff --git a/packages/visual-object-renderer/src/index.ts b/packages/visual-object-renderer/src/index.ts
index b826e35..5c650e3 100644
--- a/packages/visual-object-renderer/src/index.ts
+++ b/packages/visual-object-renderer/src/index.ts
@@ -53,20 +53,21 @@ export interface BuildRenderFrameOptions {
     Record<string, { readonly width: number; readonly height: number }>
   >;
 }
 
 /**
  * Convert a single resolved object to its render node(s).
  *
  * - `image` → `video-frame` when size known (real RGBA arrives via bitmap map), else placeholder sprite
  * - `text`  → `text` node
  * - `shape` → `sprite` node tinted per shape
+ * - `html-scene` / `motion-scene` → `video-frame` backed by captured RGBA
  * - `null` / `camera` → **undefined** (controllers render nothing)
  *
  * The transform is already resolved through parenting and camera projection by
  * the evaluator; this function only maps the kind to node type + content.
  */
 export function visualObjectToRenderNode(
   resolved: ResolvedObject,
   effects?: readonly EffectInstanceIR[],
   imageSize?: { readonly width: number; readonly height: number },
   frameSize?: { readonly width: number; readonly height: number },
@@ -84,21 +85,21 @@ export function visualObjectToRenderNode(
       id: object.id,
       zIndex: 0,
       opacity,
       transform: renderTransform,
       text: object.text ?? '',
       color: WHITE,
       ...(effectList ? { effects: effectList } : {}),
     };
   }
 
-  if (object.kind === 'html-scene') {
+  if (object.kind === 'html-scene' || object.kind === 'motion-scene') {
     // RGBA pixels arrive out-of-band via Pixi videoBitmaps keyed by object id.
     const viewport = imageSize ?? frameSize ?? { width: 1080, height: 1920 };
     return {
       kind: 'video-frame',
       id: object.id,
       zIndex: 0,
       opacity,
       transform: renderTransform,
       width: viewport.width,
       height: viewport.height,
@@ -316,21 +317,21 @@ function normalizeColorGrade(grade: ColorGradeV1 | ColorGradeIR): ColorGradeIR {
     ...(grade.lutId !== undefined ? { lutId: grade.lutId } : {}),
   };
 }
 
 // ---- palette ----
 const WHITE: Rgba = Object.freeze({ r: 255, g: 255, b: 255, a: 255 });
 const DARK_BG: Rgba = Object.freeze({ r: 12, g: 16, b: 28, a: 255 });
 const EMPTY_CLIP_TIMES: ClipTimingLookup = new Map();
 
 function shapeColor(
-  kind: 'image' | 'text' | 'shape' | 'null' | 'camera' | 'html-scene',
+  kind: 'image' | 'text' | 'shape' | 'null' | 'camera' | 'html-scene' | 'motion-scene',
   shape?: 'rectangle' | 'ellipse',
 ): Rgba {
   switch (kind) {
     case 'shape':
       return shape === 'rectangle'
         ? { r: 247, g: 185, b: 40, a: 255 }
         : { r: 67, g: 137, b: 255, a: 255 };
     case 'image':
       return { r: 180, g: 180, b: 180, a: 255 }; // placeholder gray
     default:
