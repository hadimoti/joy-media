# Review package: b0193f1..8763cca

## Commits
8763cca feat(templates): apply and manage templates atomically

## Files changed
 apps/editor-web/src/TemplatesPanel.test.tsx        |  50 +++++
 apps/editor-web/src/TemplatesPanel.tsx             | 225 ++++++++++++++++++---
 .../src/content-template-transaction.test.ts       | 108 +++++++---
 .../editor-web/src/content-template-transaction.ts |  38 +++-
 apps/editor-web/src/editor-session.test.ts         |  95 +++++++++
 apps/editor-web/src/template-catalog.ts            |  33 +--
 6 files changed, 473 insertions(+), 76 deletions(-)

## Diff
diff --git a/apps/editor-web/src/TemplatesPanel.test.tsx b/apps/editor-web/src/TemplatesPanel.test.tsx
new file mode 100644
index 0000000..d3d5529
--- /dev/null
+++ b/apps/editor-web/src/TemplatesPanel.test.tsx
@@ -0,0 +1,50 @@
+import { describe, expect, it } from 'vitest';
+import {
+  createTemplateEntry,
+  duplicateTemplate,
+  filterTemplateEntries,
+  listTemplates,
+  removeTemplate,
+  saveTemplate,
+} from './template-catalog.js';
+
+function memoryStorage() {
+  const values = new Map<string, string>();
+  return {
+    getItem: (key: string) => values.get(key) ?? null,
+    setItem: (key: string, value: string) => values.set(key, value),
+  };
+}
+
+describe('TemplatesPanel surface', () => {
+  const entries = [
+    { label: 'JOY Title', description: 'Main title', category: 'Titles' },
+    { label: 'Lower Third', description: 'Name bar', category: 'Lower Thirds' },
+  ] as const;
+
+  it('filters by search text and category without changing source order', () => {
+    expect(filterTemplateEntries(entries, 'title')).toEqual([entries[0]]);
+    expect(filterTemplateEntries(entries, '', 'Lower Thirds')).toEqual([entries[1]]);
+    expect(filterTemplateEntries(entries, 'missing')).toEqual([]);
+  });
+
+  it('persists, duplicates, and deletes Mine entries without changing action payloads', () => {
+    const storage = memoryStorage();
+    const original = createTemplateEntry(
+      'Saved title',
+      [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
+      'Saved from selection',
+      'My Templates',
+      '2026-01-01T00:00:00.000Z',
+    );
+    saveTemplate(storage, original);
+
+    const duplicate = duplicateTemplate(storage, original.id, { label: 'Saved title copy' });
+    expect(duplicate?.id).not.toBe(original.id);
+    expect(duplicate?.actions).toEqual(original.actions);
+    expect(listTemplates(storage)).toHaveLength(2);
+
+    removeTemplate(storage, original.id);
+    expect(listTemplates(storage).map((entry) => entry.id)).toEqual([duplicate!.id]);
+  });
+});
diff --git a/apps/editor-web/src/TemplatesPanel.tsx b/apps/editor-web/src/TemplatesPanel.tsx
index 6dd9f6b..085be5a 100644
--- a/apps/editor-web/src/TemplatesPanel.tsx
+++ b/apps/editor-web/src/TemplatesPanel.tsx
@@ -1,109 +1,210 @@
 import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
 import { PanelShell } from './PanelShell.js';
 import { panelTabIconUrl } from './panel-tab-icons.js';
 import { iconUrl } from './icon-assets.js';
 import { CONTENT_TEMPLATES, contentTemplateById } from './content-template-catalog.js';
 import {
   listTemplates,
+  createTemplateEntry,
+  duplicateTemplate,
+  filterTemplateEntries,
   removeTemplate,
+  saveTemplate,
   type TemplateCatalogEntry,
 } from './template-catalog.js';
-import type { SeededContentTemplate, ContentTemplateV1, FirstPartySceneId } from './content-template-types.js';
+import type {
+  SeededContentTemplate,
+  ContentTemplateV1,
+  FirstPartySceneId,
+} from './content-template-types.js';
 import type { EditorSession } from './editor-session.js';
+import { readClipObjectMap } from './sticker-bindings.js';
 import { getFirstPartySceneThumbUrl } from './html-scene-thumbs.js';
-import { createScenePreviewHost, defaultVariablesForScene, type ScenePreviewHost } from '@joy-media/html-scene-runtime/browser';
-import { findFirstPartyScene, type FirstPartyScenePackage } from '@joy-media/html-scene-runtime/first-party';
+import {
+  createScenePreviewHost,
+  defaultVariablesForScene,
+  type ScenePreviewHost,
+} from '@joy-media/html-scene-runtime/browser';
+import {
+  findFirstPartyScene,
+  type FirstPartyScenePackage,
+} from '@joy-media/html-scene-runtime/first-party';
 
 interface TemplatesPanelProps {
   readonly session: EditorSession;
   readonly selectedClipIds: readonly string[];
   readonly playheadUs: number;
   readonly onApplyTemplate: (seeded: SeededContentTemplate) => void;
   readonly showToast: (message: string, kind: 'info' | 'success' | 'error') => void;
 }
 
-type TemplateView = 'library' | 'mine' | 'Titles' | 'Lower Thirds' | 'Utility' | 'Effects' | 'Social';
+type TemplateView =
+  'library' | 'mine' | 'Titles' | 'Lower Thirds' | 'Utility' | 'Effects' | 'Social';
+
+export { filterTemplateEntries } from './template-catalog.js';
 
 const SIDEBAR_VIEWS: readonly { readonly id: TemplateView; readonly iconUrl: string }[] = [
   { id: 'library', iconUrl: iconUrl('24_library.png') },
   { id: 'mine', iconUrl: iconUrl('24_my-media.png') },
   { id: 'Titles', iconUrl: iconUrl('24_titles.png') },
   { id: 'Lower Thirds', iconUrl: iconUrl('24_lowerthird.png') },
   { id: 'Social', iconUrl: iconUrl('24_socials.png') },
   { id: 'Utility', iconUrl: iconUrl('24_utility.png') },
   { id: 'Effects', iconUrl: iconUrl('ui/motion_24x24.png') },
 ];
 
 export function TemplatesPanel({
   session,
-  selectedClipIds: _selectedClipIds,
+  selectedClipIds,
   playheadUs,
   onApplyTemplate,
   showToast,
 }: TemplatesPanelProps) {
   const [view, setView] = useState<TemplateView>('library');
+  const [query, setQuery] = useState('');
+  const [catalogTick, setCatalogTick] = useState(0);
+  const [mineCatalog, setMineCatalog] = useState<{
+    readonly status: 'ready' | 'loading' | 'error';
+    readonly entries: readonly TemplateCatalogEntry[];
+  }>({ status: 'ready', entries: [] });
+  const operationSequenceRef = useRef(0);
+  const nextOperationId = useCallback((templateId: string) => {
+    operationSequenceRef.current += 1;
+    return `${templateId}-${operationSequenceRef.current}`;
+  }, []);
 
   const handleApplyLibraryTemplate = useCallback(
     (templateId: string) => {
       const template = contentTemplateById(templateId);
       if (template === undefined) return;
-      const seed = Date.now().toString(36).slice(-5);
+      const seed = nextOperationId(template.id);
       onApplyTemplate({ template, seed, scopeLabel: template.category });
       showToast(`Template "${template.label}" applied`, 'success');
     },
-    [onApplyTemplate, showToast],
+    [nextOperationId, onApplyTemplate, showToast],
   );
 
   const handleApplyCatalogTemplate = useCallback(
     (entry: TemplateCatalogEntry) => {
-      const seed = Date.now().toString(36).slice(-5);
+      const seed = nextOperationId(entry.id);
       const template = {
         id: entry.id,
         label: entry.label,
         description: entry.description,
         category: entry.category,
-        actions: entry.actions as unknown as Parameters<typeof onApplyTemplate>[0]['template']['actions'],
+        actions: entry.actions as unknown as Parameters<
+          typeof onApplyTemplate
+        >[0]['template']['actions'],
       };
       onApplyTemplate({ template, seed, scopeLabel: entry.category });
       showToast(`Template "${entry.label}" applied`, 'success');
     },
-    [onApplyTemplate, showToast],
+    [nextOperationId, onApplyTemplate, showToast],
   );
 
   const handleDeleteTemplate = useCallback(
     (id: string) => {
       removeTemplate(window.localStorage, id);
+      setCatalogTick((tick) => tick + 1);
       showToast('Template deleted', 'info');
     },
-    [session, showToast],
+    [showToast],
   );
 
+  const handleDuplicateTemplate = useCallback(
+    (id: string) => {
+      duplicateTemplate(window.localStorage, id);
+      setCatalogTick((tick) => tick + 1);
+      showToast('Template duplicated', 'info');
+    },
+    [showToast],
+  );
+
+  const handleSaveSelection = useCallback(() => {
+    if (selectedClipIds.length === 0) {
+      showToast('Select an HTML scene clip to save it as a template', 'error');
+      return;
+    }
+    const clipObjects = readClipObjectMap(session.visualProject);
+    const selectedScene = selectedClipIds
+      .map((clipId) => session.visualProject.visualObjects[clipObjects[clipId] ?? ''])
+      .find(
+        (object) =>
+          object?.kind === 'html-scene' &&
+          typeof object.scenePackageId === 'string' &&
+          findFirstPartyScene(object.scenePackageId as FirstPartySceneId) !== undefined,
+      );
+    if (selectedScene?.kind !== 'html-scene') {
+      showToast('The current selection has no first-party HTML scene to save', 'error');
+      return;
+    }
+    const sceneId = selectedScene.scenePackageId;
+    if (typeof sceneId !== 'string') {
+      showToast('The selected HTML scene is missing its scene package', 'error');
+      return;
+    }
+    const entry = createTemplateEntry(
+      `Saved ${sceneId}`,
+      [{ kind: 'html-scene', sceneId }],
+      'Saved from the current selection',
+    );
+    saveTemplate(window.localStorage, entry);
+    setCatalogTick((tick) => tick + 1);
+    setView('mine');
+    showToast('Selection saved to My Templates', 'success');
+  }, [selectedClipIds, session, showToast]);
+
+  useEffect(() => {
+    if (view !== 'mine') return;
+    setMineCatalog({ status: 'loading', entries: [] });
+    try {
+      setMineCatalog({ status: 'ready', entries: listTemplates(window.localStorage) });
+    } catch {
+      setMineCatalog({ status: 'error', entries: [] });
+    }
+  }, [catalogTick, view]);
+
   const filteredTemplates = useMemo(() => {
-    if (view === 'library') return CONTENT_TEMPLATES;
-    if (view === 'mine') return listTemplates(window.localStorage);
-    return CONTENT_TEMPLATES.filter((tpl) => tpl.category === view);
-  }, [view]);
+    const entries = view === 'mine' ? mineCatalog.entries : CONTENT_TEMPLATES;
+    return filterTemplateEntries<ContentTemplateV1 | TemplateCatalogEntry>(
+      entries,
+      query,
+      view === 'library' || view === 'mine' ? undefined : view,
+    );
+  }, [mineCatalog.entries, query, view]);
 
   const isMine = view === 'mine';
 
   const body = useMemo(() => {
-    if (filteredTemplates.length === 0) {
+    if (isMine && mineCatalog.status === 'loading') {
       return (
-        <p className="empty-hint">
-          {isMine ? 'No saved templates yet.' : 'No templates found.'}
+        <p role="status" className="empty-hint">
+          Loading saved templates…
         </p>
       );
     }
+    if (isMine && mineCatalog.status === 'error') {
+      return (
+        <p role="alert" className="empty-hint">
+          Unable to load saved templates. Try again.
+        </p>
+      );
+    }
+    if (filteredTemplates.length === 0) {
+      return (
+        <p className="empty-hint">{isMine ? 'No saved templates yet.' : 'No templates found.'}</p>
+      );
+    }
     return (
       <div className="templates-grid">
-        {filteredTemplates.map((tpl: typeof CONTENT_TEMPLATES[number] | TemplateCatalogEntry) => (
+        {filteredTemplates.map((tpl: (typeof CONTENT_TEMPLATES)[number] | TemplateCatalogEntry) => (
           <div
             key={tpl.id}
             className="template-card"
             title={'description' in tpl ? tpl.description : undefined}
           >
             <TemplatePreviewThumb template={tpl} />
             <span className="template-card-name">{tpl.label}</span>
             <span className="template-card-category">{tpl.category}</span>
             <button
               type="button"
@@ -113,109 +214,172 @@ export function TemplatesPanel({
                 e.stopPropagation();
                 if (isMine) {
                   handleApplyCatalogTemplate(tpl as TemplateCatalogEntry);
                 } else {
                   handleApplyLibraryTemplate(tpl.id);
                 }
               }}
             >
               Apply
             </button>
+            {isMine && (
+              <button
+                type="button"
+                className="icon-button template-card-duplicate"
+                aria-label={`Duplicate ${tpl.label}`}
+                title="Duplicate template"
+                onClick={(e) => {
+                  e.stopPropagation();
+                  handleDuplicateTemplate(tpl.id);
+                }}
+              >
+                Duplicate
+              </button>
+            )}
             {isMine && (
               <button
                 type="button"
                 className="icon-button template-card-delete"
                 aria-label={`Delete ${tpl.label}`}
                 title="Delete template"
                 onClick={(e) => {
                   e.stopPropagation();
                   handleDeleteTemplate(tpl.id);
                 }}
               >
                 Delete
               </button>
             )}
           </div>
         ))}
       </div>
     );
-  }, [filteredTemplates, isMine, handleApplyLibraryTemplate, handleApplyCatalogTemplate, handleDeleteTemplate]);
+  }, [
+    filteredTemplates,
+    isMine,
+    handleApplyLibraryTemplate,
+    handleApplyCatalogTemplate,
+    handleDeleteTemplate,
+    handleDuplicateTemplate,
+    mineCatalog.status,
+  ]);
 
   return (
     <PanelShell
       title="Templates"
       iconUrl={panelTabIconUrl('templates')}
       className="templates-panel"
     >
       <div className="templates-content">
         <aside className="templates-sidebar" aria-label="Template views">
           <div className="templates-sidebar-tabs" role="tablist" aria-label="Template views">
             {SIDEBAR_VIEWS.map((item) => (
               <button
                 key={item.id}
                 type="button"
                 role="tab"
                 className="templates-sidebar-tab"
-                aria-label={item.id === 'library' ? 'Library' : item.id === 'mine' ? 'My Templates' : item.id}
-                title={item.id === 'library' ? 'Library' : item.id === 'mine' ? 'My Templates' : item.id}
+                aria-label={
+                  item.id === 'library' ? 'Library' : item.id === 'mine' ? 'My Templates' : item.id
+                }
+                title={
+                  item.id === 'library' ? 'Library' : item.id === 'mine' ? 'My Templates' : item.id
+                }
                 aria-selected={view === item.id}
                 onClick={() => setView(item.id)}
               >
                 <span
                   className="templates-sidebar-tab-icon"
                   style={{
                     maskImage: `url(${item.iconUrl})`,
                     WebkitMaskImage: `url(${item.iconUrl})`,
                   }}
                   aria-hidden="true"
                 />
               </button>
             ))}
           </div>
         </aside>
         <div className="templates-main">
+          <label className="templates-search">
+            <span className="sr-only">Search templates</span>
+            <input
+              type="search"
+              value={query}
+              onChange={(event) => setQuery(event.target.value)}
+              placeholder="Search templates"
+              aria-label="Search templates"
+            />
+          </label>
+          <button
+            type="button"
+            className="templates-save-selection"
+            onClick={handleSaveSelection}
+            disabled={selectedClipIds.length === 0}
+            title={
+              selectedClipIds.length === 0
+                ? 'Select an HTML scene clip first'
+                : 'Save current selection as a template'
+            }
+          >
+            Save selection
+          </button>
           {body}
         </div>
       </div>
     </PanelShell>
   );
 }
 
-function TemplatePreviewThumb({ template }: { readonly template: ContentTemplateV1 | TemplateCatalogEntry }) {
-  const firstSceneId = 'actions' in template
-    ? (template.actions.find((a) => a.kind === 'html-scene') as { readonly kind: 'html-scene'; readonly sceneId: FirstPartySceneId } | undefined)?.sceneId
+function TemplatePreviewThumb({
+  template,
+}: {
+  readonly template: ContentTemplateV1 | TemplateCatalogEntry;
+}) {
+  const firstSceneId =
+    'actions' in template
+      ? (
+          template.actions.find((a) => a.kind === 'html-scene') as
+            { readonly kind: 'html-scene'; readonly sceneId: FirstPartySceneId } | undefined
+        )?.sceneId
+      : undefined;
+  const scene: FirstPartyScenePackage | undefined = firstSceneId
+    ? findFirstPartyScene(firstSceneId)
     : undefined;
-  const scene: FirstPartyScenePackage | undefined = firstSceneId ? findFirstPartyScene(firstSceneId) : undefined;
   const [url, setUrl] = useState<string | undefined>(undefined);
   const [hovering, setHovering] = useState(false);
   const mountRef = useRef<HTMLDivElement | null>(null);
   const hostRef = useRef<ScenePreviewHost | undefined>(undefined);
   const rafRef = useRef<number | undefined>(undefined);
+  const previewSequenceRef = useRef(0);
 
   useEffect(() => {
     if (!firstSceneId) return;
     let cancelled = false;
     void getFirstPartySceneThumbUrl(firstSceneId, 120).then((next) => {
       if (!cancelled) setUrl(next);
     });
-    return () => { cancelled = true; };
+    return () => {
+      cancelled = true;
+    };
   }, [firstSceneId]);
 
   useEffect(() => {
     if (!hovering || !scene || !mountRef.current) return;
     const mount = mountRef.current;
     let cancelled = false;
     const variables = defaultVariablesForScene(scene.id);
     const durationUs = scene.manifest.durationUs;
 
+    previewSequenceRef.current += 1;
     const host = createScenePreviewHost({
-      instanceId: `template-live-${scene.id}-${Date.now()}`,
+      instanceId: `template-live-${scene.id}-${previewSequenceRef.current}`,
       scene,
       parent: mount,
       placement: 'inline',
     });
     host.iframe.style.width = '100%';
     host.iframe.style.height = '100%';
     host.iframe.style.border = 'none';
     host.iframe.style.pointerEvents = 'none';
     host.iframe.setAttribute('tabindex', '-1');
     host.iframe.setAttribute('aria-hidden', 'true');
@@ -224,21 +388,24 @@ function TemplatePreviewThumb({ template }: { readonly template: ContentTemplate
     const loop = () => {
       if (cancelled) return;
       const elapsed = performance.now() - start;
       const t = (elapsed % 3200) / 3200;
       const timeUs = Math.floor(t * durationUs);
       host.update(timeUs, variables);
       rafRef.current = requestAnimationFrame(loop);
     };
 
     void host.ready.then(() => {
-      if (cancelled) { host.destroy(); return; }
+      if (cancelled) {
+        host.destroy();
+        return;
+      }
       hostRef.current = host;
       start = performance.now();
       rafRef.current = requestAnimationFrame(loop);
     });
 
     return () => {
       cancelled = true;
       if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
       host.destroy();
       hostRef.current = undefined;
diff --git a/apps/editor-web/src/content-template-transaction.test.ts b/apps/editor-web/src/content-template-transaction.test.ts
index 847f640..2741364 100644
--- a/apps/editor-web/src/content-template-transaction.test.ts
+++ b/apps/editor-web/src/content-template-transaction.test.ts
@@ -35,35 +35,36 @@ function emptyVisualProject(): JoyProjectV1 {
     },
     assets: {},
     variables: {},
     markers: [],
     visualObjects: {},
     captionDocuments: {},
     pluginData: {},
   };
 }
 
-function makeMockSession(
-  timelineProject: SpikeProject,
-  visualProject: JoyProjectV1,
-) {
+function makeMockSession(timelineProject: SpikeProject, visualProject: JoyProjectV1) {
   const dispatchTimeline = vi.fn<(tx: CommandTransaction) => SpikeProject>();
   const dispatchVisualObjects = vi.fn<(tx: VisualObjectTransaction) => JoyProjectV1>();
   const replaceVisualProject = vi.fn<(p: JoyProjectV1) => JoyProjectV1>();
 
   return {
     dispatchTimeline,
     dispatchVisualObjects,
     replaceVisualProject,
     session: {
-      get timelineProject() { return timelineProject; },
-      get visualProject() { return visualProject; },
+      get timelineProject() {
+        return timelineProject;
+      },
+      get visualProject() {
+        return visualProject;
+      },
       dispatchTimeline,
       dispatchVisualObjects,
       replaceVisualProject,
     } as unknown as import('./editor-session.js').EditorSession,
   };
 }
 
 const PLAYHEAD_US = 0;
 
 describe('buildContentTemplateTransaction', () => {
@@ -86,28 +87,61 @@ describe('buildContentTemplateTransaction', () => {
     buildContentTemplateTransaction(seeded, {
       session,
       selectedClipIds: [],
       playheadUs: PLAYHEAD_US,
     });
 
     expect(dispatchVisualObjects).toHaveBeenCalledTimes(1);
     const voCall = dispatchVisualObjects.mock.calls[0]![0];
     expect(voCall.commands).toHaveLength(1);
     expect(voCall.commands[0]!.type).toBe('htmlScene.create');
-    expect((voCall.commands[0] as { payload: { object: { id: string } } }).payload.object.id).toBe('joy.title-0-abc');
+    expect((voCall.commands[0] as { payload: { object: { id: string } } }).payload.object.id).toBe(
+      'joy.title-0-abc',
+    );
 
     expect(dispatchTimeline).toHaveBeenCalledTimes(1);
     const tlCall = dispatchTimeline.mock.calls[0]![0];
     expect(tlCall.commands).toHaveLength(1);
     expect(tlCall.commands[0]!.type).toBe('timeline.insertClip');
   });
 
+  it('uses one compound dispatch when the session supports atomic document changes', () => {
+    const { session } = makeMockSession(emptyTimelineProject(), emptyVisualProject());
+    const dispatchCompound = vi.fn();
+    Object.assign(session as object, { dispatchCompound });
+    const seeded: SeededContentTemplate = {
+      template: {
+        id: 'joy.title',
+        label: 'JOY Title',
+        description: 'Main title',
+        category: 'Titles',
+        actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
+      },
+      seed: 'compound-seed',
+    };
+
+    buildContentTemplateTransaction(seeded, {
+      session,
+      selectedClipIds: [],
+      playheadUs: PLAYHEAD_US,
+    });
+
+    expect(dispatchCompound).toHaveBeenCalledTimes(1);
+    expect(dispatchCompound.mock.calls[0]![0]).toBe('Apply template JOY Title');
+    expect(dispatchCompound.mock.calls[0]![1]).toEqual(
+      expect.objectContaining({
+        document: expect.objectContaining({ pluginData: expect.any(Object) }),
+        timeline: expect.objectContaining({ commands: expect.any(Array) }),
+      }),
+    );
+  });
+
   it('binds the created clip to the visual object via replaceVisualProject', () => {
     const { session, replaceVisualProject } = makeMockSession(
       emptyTimelineProject(),
       emptyVisualProject(),
     );
     const seeded: SeededContentTemplate = {
       template: {
         id: 'joy.title',
         label: 'JOY Title',
         description: 'Main title',
@@ -141,29 +175,37 @@ describe('buildContentTemplateTransaction', () => {
       template: {
         id: 'joy.title',
         label: 'JOY Title',
         description: 'Main title',
         category: 'Titles',
         actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
       },
       seed: 'abc',
     };
 
-    buildContentTemplateTransaction(seeded, { session: s1, selectedClipIds: [], playheadUs: PLAYHEAD_US });
-    buildContentTemplateTransaction(seeded, { session: s2, selectedClipIds: [], playheadUs: PLAYHEAD_US });
+    buildContentTemplateTransaction(seeded, {
+      session: s1,
+      selectedClipIds: [],
+      playheadUs: PLAYHEAD_US,
+    });
+    buildContentTemplateTransaction(seeded, {
+      session: s2,
+      selectedClipIds: [],
+      playheadUs: PLAYHEAD_US,
+    });
 
-    const ids1 = (dv1.mock.calls[0]![0].commands as unknown as Array<{ payload: { object: { id: string } } }>).map(
-      (c) => c.payload.object.id,
-    );
-    const ids2 = (dv2.mock.calls[0]![0].commands as unknown as Array<{ payload: { object: { id: string } } }>).map(
-      (c) => c.payload.object.id,
-    );
+    const ids1 = (
+      dv1.mock.calls[0]![0].commands as unknown as Array<{ payload: { object: { id: string } } }>
+    ).map((c) => c.payload.object.id);
+    const ids2 = (
+      dv2.mock.calls[0]![0].commands as unknown as Array<{ payload: { object: { id: string } } }>
+    ).map((c) => c.payload.object.id);
     expect(ids1).toEqual(ids2);
   });
 
   it('different seed produces different IDs from same template', () => {
     const { session: s1, dispatchVisualObjects: dv1 } = makeMockSession(
       emptyTimelineProject(),
       emptyVisualProject(),
     );
     const { session: s2, dispatchVisualObjects: dv2 } = makeMockSession(
       emptyTimelineProject(),
@@ -173,29 +215,37 @@ describe('buildContentTemplateTransaction', () => {
       template: {
         id: 'joy.title',
         label: 'JOY Title',
         description: 'Main title',
         category: 'Titles',
         actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
       },
       seed,
     });
 
-    buildContentTemplateTransaction(makeSeeded('abc'), { session: s1, selectedClipIds: [], playheadUs: PLAYHEAD_US });
-    buildContentTemplateTransaction(makeSeeded('xyz'), { session: s2, selectedClipIds: [], playheadUs: PLAYHEAD_US });
+    buildContentTemplateTransaction(makeSeeded('abc'), {
+      session: s1,
+      selectedClipIds: [],
+      playheadUs: PLAYHEAD_US,
+    });
+    buildContentTemplateTransaction(makeSeeded('xyz'), {
+      session: s2,
+      selectedClipIds: [],
+      playheadUs: PLAYHEAD_US,
+    });
 
-    const ids1 = (dv1.mock.calls[0]![0].commands as unknown as Array<{ payload: { object: { id: string } } }>).map(
-      (c) => c.payload.object.id,
-    );
-    const ids2 = (dv2.mock.calls[0]![0].commands as unknown as Array<{ payload: { object: { id: string } } }>).map(
-      (c) => c.payload.object.id,
-    );
+    const ids1 = (
+      dv1.mock.calls[0]![0].commands as unknown as Array<{ payload: { object: { id: string } } }>
+    ).map((c) => c.payload.object.id);
+    const ids2 = (
+      dv2.mock.calls[0]![0].commands as unknown as Array<{ payload: { object: { id: string } } }>
+    ).map((c) => c.payload.object.id);
     expect(ids1).not.toEqual(ids2);
   });
 
   it('adds a new track when no suitable existing track is available', () => {
     const { session, dispatchTimeline } = makeMockSession(
       emptySpikeProject({ trackCount: 0 }),
       emptyVisualProject(),
     );
     const seeded: SeededContentTemplate = {
       template: {
@@ -230,22 +280,30 @@ describe('buildContentTemplateTransaction', () => {
         id: 'joy.title',
         label: 'JOY Title',
         description: 'Main title',
         category: 'Titles',
         actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
       },
       seed: 'abc',
     };
 
     expect(() => {
-      buildContentTemplateTransaction(seeded, { session, selectedClipIds: [], playheadUs: PLAYHEAD_US });
-      buildContentTemplateTransaction(seeded, { session, selectedClipIds: [], playheadUs: PLAYHEAD_US });
+      buildContentTemplateTransaction(seeded, {
+        session,
+        selectedClipIds: [],
+        playheadUs: PLAYHEAD_US,
+      });
+      buildContentTemplateTransaction(seeded, {
+        session,
+        selectedClipIds: [],
+        playheadUs: PLAYHEAD_US,
+      });
     }).not.toThrow();
 
     expect(dispatchVisualObjects).toHaveBeenCalledTimes(2);
     expect(dispatchTimeline).toHaveBeenCalledTimes(2);
   });
 
   it('places two clips with correct duration (5 seconds each)', () => {
     const { session, dispatchTimeline } = makeMockSession(
       emptyTimelineProject(),
       emptyVisualProject(),
diff --git a/apps/editor-web/src/content-template-transaction.ts b/apps/editor-web/src/content-template-transaction.ts
index 8890adf..178eb31 100644
--- a/apps/editor-web/src/content-template-transaction.ts
+++ b/apps/editor-web/src/content-template-transaction.ts
@@ -2,43 +2,47 @@
  * Content template transaction builder (ADR-0027a).
  *
  * Mirrors `addHtmlSceneToSelectedClip` (App.tsx:1162-1273) but generates
  * deterministic IDs from seed, requires no selection, and batches all
  * commands into single dispatch calls per domain.
  */
 import { bindClipToObject } from './sticker-bindings.js';
 import type { EditorSession } from './editor-session.js';
 import type { SeededContentTemplate } from './content-template-types.js';
 import type { SpikeCommand } from '@joy-media/commands';
+import { applyVisualObjectProjectTransaction } from '@joy-media/property-system';
 
 export function buildContentTemplateTransaction(
   seeded: SeededContentTemplate,
   deps: {
     readonly session: EditorSession;
     readonly selectedClipIds: readonly string[];
     readonly playheadUs: number;
   },
 ): void {
   const composition = deps.session.timelineProject.compositions.root;
   if (composition === undefined) return;
 
   const voCommands: Array<{
     type: 'htmlScene.create';
     payload: {
       object: {
         id: string;
         kind: 'html-scene';
         scenePackageId: string;
         transform: {
-          x: number; y: number;
-          scaleX: number; scaleY: number;
-          rotationDeg: number; opacity: number;
+          x: number;
+          y: number;
+          scaleX: number;
+          scaleY: number;
+          rotationDeg: number;
+          opacity: number;
           crop: { left: number; top: number; right: number; bottom: number };
         };
       };
     };
   }> = [];
   const tlCommands: SpikeCommand[] = [];
   const bindings: Array<[string, string]> = [];
 
   const { actions } = seeded.template;
   const usedTrackIds = new Set<string>();
@@ -127,24 +131,42 @@ export function buildContentTemplateTransaction(
           sourceInUs: 0,
         },
       },
     });
 
     bindings.push([clipId, objectId]);
   });
 
   if (voCommands.length === 0) return;
 
-  deps.session.dispatchVisualObjects({
+  const visualTransaction = {
     label: `Apply template ${seeded.template.label}`,
     commands: voCommands,
-  });
-  deps.session.dispatchTimeline({
+  } as const;
+  const timelineTransaction = {
     label: `Apply template ${seeded.template.label}`,
     commands: tlCommands,
-  });
-  let project = deps.session.visualProject;
+  } as const;
+  let project = applyVisualObjectProjectTransaction(deps.session.visualProject, visualTransaction);
   for (const [clipId, objectId] of bindings) {
     project = bindClipToObject(project, clipId, objectId);
   }
+  const dispatchCompound = (
+    deps.session as unknown as {
+      dispatchCompound?: (
+        label: string,
+        parts: { readonly document: typeof project; readonly timeline: typeof timelineTransaction },
+      ) => void;
+    }
+  ).dispatchCompound;
+  if (dispatchCompound !== undefined) {
+    dispatchCompound.call(deps.session, `Apply template ${seeded.template.label}`, {
+      document: project,
+      timeline: timelineTransaction,
+    });
+    return;
+  }
+  // Compatibility fallback for lightweight callers that predate compound dispatch.
+  deps.session.dispatchVisualObjects(visualTransaction);
+  deps.session.dispatchTimeline(timelineTransaction);
   deps.session.replaceVisualProject(project);
 }
diff --git a/apps/editor-web/src/editor-session.test.ts b/apps/editor-web/src/editor-session.test.ts
index b23fbe6..1524698 100644
--- a/apps/editor-web/src/editor-session.test.ts
+++ b/apps/editor-web/src/editor-session.test.ts
@@ -135,11 +135,106 @@ describe('EditorSession', () => {
     expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(50);
     expect(session.historyCursorSequence).toBe(entries[1]!.sequence);
     expect(session.historyEntries.find((e) => e.direction === 'current')?.label).toBe('Move title');
 
     session.jumpToHistory(0);
     expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(0);
 
     session.jumpToHistory(entries[2]!.sequence);
     expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(90);
   });
+
+  it('records a compound template apply as one undo step and restores both buses', () => {
+    const session = new EditorSession(
+      memoryStorage(),
+      buildReferenceSpikeProject(),
+      INITIAL_EDITOR_PROJECT,
+    );
+    const beforeEntries = session.historyEntries.length;
+    const nextDocument = {
+      ...session.visualProject,
+      visualObjects: {
+        ...session.visualProject.visualObjects,
+        'intro-title': {
+          ...session.visualProject.visualObjects['intro-title']!,
+          transform: {
+            ...session.visualProject.visualObjects['intro-title']!.transform,
+            x: 321,
+          },
+        },
+      },
+    };
+
+    session.dispatchCompound('Apply saved title', {
+      document: nextDocument,
+      timeline: {
+        label: 'Apply saved title',
+        commands: [
+          {
+            type: 'timeline.trimClipEnd',
+            payload: {
+              compositionId: 'root',
+              trackId: 'track-0',
+              clipId: 'intro',
+              newEndUs: 9_000_000,
+            },
+          },
+        ],
+      },
+    });
+
+    expect(session.historyEntries).toHaveLength(beforeEntries + 1);
+    expect(session.historyEntries.at(-1)?.source).toBe('compound');
+    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(321);
+    expect(session.timelineProject.compositions.root?.tracks[0]?.clips[0]?.durationUs).toBe(
+      9_000_000,
+    );
+
+    session.undo();
+    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(0);
+    expect(session.timelineProject.compositions.root?.tracks[0]?.clips[0]?.durationUs).toBe(
+      10_000_000,
+    );
+
+    session.redo();
+    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(321);
+    expect(session.timelineProject.compositions.root?.tracks[0]?.clips[0]?.durationUs).toBe(
+      9_000_000,
+    );
+  });
+
+  it('validates every part before writing a compound transaction', () => {
+    const session = new EditorSession(
+      memoryStorage(),
+      buildReferenceSpikeProject(),
+      INITIAL_EDITOR_PROJECT,
+    );
+    const beforeDocument = session.visualProject;
+    const beforeEntries = session.historyEntries.length;
+    const nextDocument = {
+      ...beforeDocument,
+      title: 'must not commit',
+    };
+
+    expect(() =>
+      session.dispatchCompound('Invalid template apply', {
+        document: nextDocument,
+        timeline: {
+          label: 'Invalid template apply',
+          commands: [
+            {
+              type: 'timeline.trimClipEnd',
+              payload: {
+                compositionId: 'root',
+                trackId: 'track-0',
+                clipId: 'missing-clip',
+                newEndUs: 1,
+              },
+            },
+          ],
+        },
+      }),
+    ).toThrow();
+    expect(session.visualProject).toBe(beforeDocument);
+    expect(session.historyEntries).toHaveLength(beforeEntries);
+  });
 });
diff --git a/apps/editor-web/src/template-catalog.ts b/apps/editor-web/src/template-catalog.ts
index 4b8c7f7..78478bd 100644
--- a/apps/editor-web/src/template-catalog.ts
+++ b/apps/editor-web/src/template-catalog.ts
@@ -8,20 +8,35 @@
  * The catalog does NOT store the full template definition — only the user's
  * customizations (label, description, category). The actions are stored as
  * references to first-party scene IDs or, in the future, custom compositions.
  */
 
 import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
 import type { ContentTemplateV1 } from './content-template-types.js';
 
 export const TEMPLATE_CATALOG_KEY = 'joy-media.template-catalog.v1';
 
+export function filterTemplateEntries<
+  T extends {
+    readonly label: string;
+    readonly description?: string;
+    readonly category: string;
+  },
+>(entries: readonly T[], query: string, category?: string): readonly T[] {
+  const needle = query.trim().toLocaleLowerCase();
+  return entries.filter((entry) => {
+    if (category !== undefined && entry.category !== category) return false;
+    if (needle.length === 0) return true;
+    return `${entry.label} ${entry.description ?? ''}`.toLocaleLowerCase().includes(needle);
+  });
+}
+
 export interface TemplateCatalogEntry {
   readonly id: string;
   readonly label: string;
   readonly description: string;
   readonly category: string;
   readonly previewAssetId?: string;
   /** Ordered list of action kinds + references to apply */
   readonly actions: readonly ContentTemplateActionRef[];
   readonly createdAt: string;
   readonly updatedAt: string;
@@ -29,54 +44,44 @@ export interface TemplateCatalogEntry {
 
 export type ContentTemplateActionRef =
   | { readonly kind: 'html-scene'; readonly sceneId: string }
   | { readonly kind: 'sticker-pack'; readonly assetIds: readonly string[] };
 
 interface CatalogDatabase {
   readonly version: 1;
   readonly templates: Readonly<Record<string, TemplateCatalogEntry>>;
 }
 
-export function listTemplates(
-  storage: BrowserKeyValueStore,
-): readonly TemplateCatalogEntry[] {
+export function listTemplates(storage: BrowserKeyValueStore): readonly TemplateCatalogEntry[] {
   const db = readCatalog(storage);
-  return Object.values(db.templates).sort(
-    (a, b) => b.updatedAt.localeCompare(a.updatedAt),
-  );
+  return Object.values(db.templates).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
 }
 
 export function getTemplate(
   storage: BrowserKeyValueStore,
   id: string,
 ): TemplateCatalogEntry | undefined {
   return readCatalog(storage).templates[id];
 }
 
-export function saveTemplate(
-  storage: BrowserKeyValueStore,
-  entry: TemplateCatalogEntry,
-): void {
+export function saveTemplate(storage: BrowserKeyValueStore, entry: TemplateCatalogEntry): void {
   if (!isTemplateCatalogEntry(entry)) {
     throw new TypeError('Invalid template catalog entry');
   }
   const db = readCatalog(storage);
   writeCatalog(storage, {
     version: 1,
     templates: { ...db.templates, [entry.id]: entry },
   });
 }
 
-export function removeTemplate(
-  storage: BrowserKeyValueStore,
-  id: string,
-): void {
+export function removeTemplate(storage: BrowserKeyValueStore, id: string): void {
   const db = readCatalog(storage);
   if (db.templates[id] === undefined) return;
   const templates = { ...db.templates };
   delete templates[id];
   writeCatalog(storage, { version: 1, templates });
 }
 
 export function duplicateTemplate(
   storage: BrowserKeyValueStore,
   id: string,
