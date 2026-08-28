# Review package: 8763cca..4b9ef1a

## Commits
4b9ef1a fix(templates): make compound applies durable and collision-safe

## Files changed
 .../src/content-template-transaction.test.ts       |  45 +++++++++
 .../editor-web/src/content-template-transaction.ts |  26 ++++-
 apps/editor-web/src/editor-session.test.ts         |  61 +++++++++++-
 apps/editor-web/src/editor-session.ts              | 106 +++++++++++++++------
 4 files changed, 205 insertions(+), 33 deletions(-)

## Diff
diff --git a/apps/editor-web/src/content-template-transaction.test.ts b/apps/editor-web/src/content-template-transaction.test.ts
index 2741364..7728ac6 100644
--- a/apps/editor-web/src/content-template-transaction.test.ts
+++ b/apps/editor-web/src/content-template-transaction.test.ts
@@ -1,18 +1,28 @@
 import { describe, expect, it, vi, beforeEach } from 'vitest';
 import type { SpikeProject } from '@joy-media/project-schema';
 import type { JoyProjectV1 } from '@joy-media/project-schema';
 import type { CommandTransaction } from '@joy-media/commands';
 import type { VisualObjectTransaction } from '@joy-media/property-system';
 import { emptySpikeProject } from '@joy-media/test-fixtures';
 import { buildContentTemplateTransaction } from './content-template-transaction.js';
 import type { SeededContentTemplate } from './content-template-types.js';
+import { EditorSession } from './editor-session.js';
+import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
+
+function memoryStorage() {
+  const values = new Map<string, string>();
+  return {
+    getItem: (key: string) => values.get(key) ?? null,
+    setItem: (key: string, value: string) => values.set(key, value),
+  };
+}
 
 function emptyTimelineProject(): SpikeProject {
   return emptySpikeProject();
 }
 
 function emptyVisualProject(): JoyProjectV1 {
   return {
     schemaVersion: 1,
     id: 'p',
     title: 't',
@@ -296,20 +306,55 @@ describe('buildContentTemplateTransaction', () => {
         session,
         selectedClipIds: [],
         playheadUs: PLAYHEAD_US,
       });
     }).not.toThrow();
 
     expect(dispatchVisualObjects).toHaveBeenCalledTimes(2);
     expect(dispatchTimeline).toHaveBeenCalledTimes(2);
   });
 
+  it('resolves a repeated caller seed against durable objects after apply and reopen', () => {
+    const storage = memoryStorage();
+    const seeded: SeededContentTemplate = {
+      template: {
+        id: 'joy.title',
+        label: 'JOY Title',
+        description: 'Main title',
+        category: 'Titles',
+        actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
+      },
+      seed: 'durable-seed',
+    };
+    const session = new EditorSession(storage, emptyTimelineProject(), INITIAL_EDITOR_PROJECT);
+
+    buildContentTemplateTransaction(seeded, { session, selectedClipIds: [], playheadUs: 0 });
+    buildContentTemplateTransaction(seeded, { session, selectedClipIds: [], playheadUs: 0 });
+    const firstIds = Object.keys(session.visualProject.visualObjects).filter((id) =>
+      id.startsWith('joy.title-0-durable-seed'),
+    );
+    expect(firstIds).toHaveLength(2);
+    expect(new Set(firstIds).size).toBe(2);
+
+    const reopened = new EditorSession(storage, emptyTimelineProject(), INITIAL_EDITOR_PROJECT);
+    buildContentTemplateTransaction(seeded, {
+      session: reopened,
+      selectedClipIds: [],
+      playheadUs: 0,
+    });
+    const reopenedIds = Object.keys(reopened.visualProject.visualObjects).filter((id) =>
+      id.startsWith('joy.title-0-durable-seed'),
+    );
+    expect(reopenedIds).toHaveLength(3);
+    expect(new Set(reopenedIds).size).toBe(3);
+  });
+
   it('places two clips with correct duration (5 seconds each)', () => {
     const { session, dispatchTimeline } = makeMockSession(
       emptyTimelineProject(),
       emptyVisualProject(),
     );
     const seeded: SeededContentTemplate = {
       template: {
         id: 'joy.title',
         label: 'JOY Title',
         description: 'Main title',
diff --git a/apps/editor-web/src/content-template-transaction.ts b/apps/editor-web/src/content-template-transaction.ts
index 178eb31..ee57d91 100644
--- a/apps/editor-web/src/content-template-transaction.ts
+++ b/apps/editor-web/src/content-template-transaction.ts
@@ -38,27 +38,28 @@ export function buildContentTemplateTransaction(
           opacity: number;
           crop: { left: number; top: number; right: number; bottom: number };
         };
       };
     };
   }> = [];
   const tlCommands: SpikeCommand[] = [];
   const bindings: Array<[string, string]> = [];
 
   const { actions } = seeded.template;
+  const resolvedSeed = nextAvailableSeed(seeded, deps.session.visualProject, composition);
   const usedTrackIds = new Set<string>();
 
   actions.forEach((action, index) => {
     if (action.kind !== 'html-scene') return;
 
     const sceneId = action.sceneId;
-    const objectId = `${seeded.template.id}-${index}-${seeded.seed}`;
+    const objectId = `${seeded.template.id}-${index}-${resolvedSeed}`;
     const clipId = `clip-${objectId}`;
     const startUs = deps.playheadUs;
     const durationUs = 5_000_000;
 
     const overlaps = (
       track: (typeof composition.tracks)[number],
       spanStart: number,
       spanDuration: number,
     ): boolean => {
       const spanEnd = spanStart + spanDuration;
@@ -163,10 +164,33 @@ export function buildContentTemplateTransaction(
       document: project,
       timeline: timelineTransaction,
     });
     return;
   }
   // Compatibility fallback for lightweight callers that predate compound dispatch.
   deps.session.dispatchVisualObjects(visualTransaction);
   deps.session.dispatchTimeline(timelineTransaction);
   deps.session.replaceVisualProject(project);
 }
+
+function nextAvailableSeed(
+  seeded: SeededContentTemplate,
+  project: EditorSession['visualProject'],
+  composition: NonNullable<EditorSession['timelineProject']['compositions']['root']>,
+): string {
+  const objectIds = new Set(Object.keys(project.visualObjects));
+  const clipIds = new Set(
+    composition.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
+  );
+  for (let attempt = 0; ; attempt += 1) {
+    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
+    const candidate = `${seeded.seed}${suffix}`;
+    const collides = seeded.template.actions.some((action, index) => {
+      if (action.kind !== 'html-scene') return false;
+      return (
+        objectIds.has(`${seeded.template.id}-${index}-${candidate}`) ||
+        clipIds.has(`clip-${seeded.template.id}-${index}-${candidate}`)
+      );
+    });
+    if (!collides) return candidate;
+  }
+}
diff --git a/apps/editor-web/src/editor-session.test.ts b/apps/editor-web/src/editor-session.test.ts
index 1524698..d77f230 100644
--- a/apps/editor-web/src/editor-session.test.ts
+++ b/apps/editor-web/src/editor-session.test.ts
@@ -1,20 +1,30 @@
 import { describe, expect, it } from 'vitest';
 import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
 import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
 import { EditorSession } from './editor-session.js';
 
 function memoryStorage() {
   const values = new Map<string, string>();
+  let failKey: string | undefined;
   return {
     getItem: (key: string) => values.get(key) ?? null,
-    setItem: (key: string, value: string) => values.set(key, value),
+    setItem: (key: string, value: string) => {
+      if (key === failKey) {
+        failKey = undefined;
+        throw new Error(`injected write failure for ${key}`);
+      }
+      values.set(key, value);
+    },
+    failNextWrite: (key: string) => {
+      failKey = key;
+    },
   };
 }
 
 describe('EditorSession', () => {
   it('recovers the same durable project revision and advances it for either document slice', () => {
     const storage = memoryStorage();
     const session = new EditorSession(
       storage,
       buildReferenceSpikeProject(),
       INITIAL_EDITOR_PROJECT,
@@ -230,11 +240,60 @@ describe('EditorSession', () => {
                 newEndUs: 1,
               },
             },
           ],
         },
       }),
     ).toThrow();
     expect(session.visualProject).toBe(beforeDocument);
     expect(session.historyEntries).toHaveLength(beforeEntries);
   });
+
+  it('leaves both durable buses unchanged when a compound snapshot write fails', () => {
+    const storage = memoryStorage();
+    const session = new EditorSession(
+      storage,
+      buildReferenceSpikeProject(),
+      INITIAL_EDITOR_PROJECT,
+    );
+    const beforeDocument = session.visualProject;
+    const beforeTimeline = session.timelineProject;
+    const beforeEntries = session.historyEntries.length;
+    const nextDocument = {
+      ...beforeDocument,
+      title: 'must roll back',
+    };
+    storage.failNextWrite('joy-media.visual-object-project-log.v1');
+
+    expect(() =>
+      session.dispatchCompound('Injected failure', {
+        document: nextDocument,
+        timeline: {
+          label: 'Injected failure',
+          commands: [
+            {
+              type: 'timeline.trimClipEnd',
+              payload: {
+                compositionId: 'root',
+                trackId: 'track-0',
+                clipId: 'intro',
+                newEndUs: 9_000_000,
+              },
+            },
+          ],
+        },
+      }),
+    ).toThrow('injected write failure');
+
+    expect(session.visualProject).toBe(beforeDocument);
+    expect(session.timelineProject).toBe(beforeTimeline);
+    expect(session.historyEntries).toHaveLength(beforeEntries);
+
+    const reopened = new EditorSession(
+      storage,
+      buildReferenceSpikeProject(),
+      INITIAL_EDITOR_PROJECT,
+    );
+    expect(reopened.visualProject).toEqual(beforeDocument);
+    expect(reopened.timelineProject).toEqual(beforeTimeline);
+  });
 });
diff --git a/apps/editor-web/src/editor-session.ts b/apps/editor-web/src/editor-session.ts
index ff4424e..f43e0fa 100644
--- a/apps/editor-web/src/editor-session.ts
+++ b/apps/editor-web/src/editor-session.ts
@@ -46,26 +46,21 @@ export interface HistoryEntry {
   readonly direction: 'undo' | 'redo' | 'current';
   readonly commandCount: number;
   readonly sequence: number;
 }
 
 /**
  * `document-snapshot` exists because a whole-document replacement has no
  * command form and therefore no inverse the object history can compute. The
  * session keeps the before/after pair itself so it can still be undone.
  */
-type EditorOperation =
-  | 'timeline'
-  | 'visual-object'
-  | 'document-snapshot'
-  | 'graph'
-  | 'artifact';
+type EditorOperation = 'timeline' | 'visual-object' | 'document-snapshot' | 'graph' | 'artifact';
 
 /**
  * The graph needs an id to share the persistence adapter shape, and the adapter
  * needs a schema version; wrapping it keeps both without inventing an id field
  * on `WorkflowGraphV2`, which is a value, not a document.
  */
 interface PersistedGraphDocument {
   readonly id: string;
   readonly graph: WorkflowGraphV2;
 }
@@ -174,24 +169,21 @@ export class EditorSession {
     this.#timelinePersistence = new LocalProjectPersistence(
       new BrowserProjectStore(storage, 'joy-media.timeline-project-log.v1'),
       timelineAdapter,
     );
     this.#visualObjectPersistence = new LocalProjectPersistence(
       new BrowserProjectStore(storage, 'joy-media.visual-object-project-log.v1'),
       visualObjectAdapter,
     );
     const timeline = recoverOrInitialize(this.#timelinePersistence, initialTimeline);
     // Stored projects may still carry the pre-v7 1920×1080 default; normalize on open.
-    const visualObjects = recoverOrInitialize(
-      this.#visualObjectPersistence,
-      initialVisualProject,
-    );
+    const visualObjects = recoverOrInitialize(this.#visualObjectPersistence, initialVisualProject);
     this.#timelineRevision = timeline.revision;
     this.#visualObjectRevision = visualObjects.revision;
     this.#timeline = new EditorCommandController(timeline.project);
     this.#visualObjects = new VisualObjectProjectHistory(
       withDefaultPortraitComposition(visualObjects.project),
     );
     this.agentIdempotency = new BrowserAgentIdempotencyStore(storage, initialTimeline.id);
 
     this.graphEnabled = readDualLensFlags(storage).graphEnabled;
     const emptyGraphDocument: PersistedGraphDocument = {
@@ -282,23 +274,21 @@ export class EditorSession {
       source: 'document',
       label: 'Document',
       direction: cursorSequence === 0 ? 'current' : 'undo',
       commandCount: 0,
       sequence: 0,
     };
     const pastRows: HistoryEntry[] = this.#undo.map((e, index) => {
       const isTip = index === this.#undo.length - 1;
       return this.#toEntry(e, isTip ? 'current' : 'undo');
     });
-    const futureRows = [...this.#redo]
-      .reverse()
-      .map((e) => this.#toEntry(e, 'redo'));
+    const futureRows = [...this.#redo].reverse().map((e) => this.#toEntry(e, 'redo'));
     if (cursorSequence === 0) {
       return [document, ...futureRows];
     }
     return [document, ...pastRows, ...futureRows];
   }
 
   /** Sequence of the present state (0 = empty document / no commits). */
   get historyCursorSequence(): number {
     const tip = this.#undo[this.#undo.length - 1];
     return tip?.sequence ?? 0;
@@ -318,24 +308,21 @@ export class EditorSession {
     let guard = this.#undo.length + this.#redo.length + 2;
     while (this.historyCursorSequence > sequence && this.canUndo && guard-- > 0) {
       this.undo();
     }
     guard = this.#undo.length + this.#redo.length + 2;
     while (this.historyCursorSequence < sequence && this.canRedo && guard-- > 0) {
       this.redo();
     }
   }
 
-  #toEntry(
-    entry: HistoryStackEntry,
-    direction: 'undo' | 'redo' | 'current',
-  ): HistoryEntry {
+  #toEntry(entry: HistoryStackEntry, direction: 'undo' | 'redo' | 'current'): HistoryEntry {
     return {
       id: `history-${entry.sequence}`,
       source:
         entry.operations.length > 1
           ? 'compound'
           : entry.operations[0] === 'document-snapshot'
             ? 'visual-object'
             : (entry.operations[0] ?? 'timeline'),
       label: entry.label,
       direction,
@@ -422,54 +409,111 @@ export class EditorSession {
     const operations: EditorOperation[] = [];
     let commandCount = 0;
 
     // Everything that can fail is checked before anything is written. Applying
     // the document and then throwing on the artifacts would leave a change that
     // is persisted, unrecorded, and therefore impossible to undo — the exact
     // split this method exists to prevent.
     if (parts.artifacts !== undefined && !this.graphEnabled) {
       throw new Error('creative artifacts are disabled; enable the Dual Lens graph flag');
     }
+    const beforeDocument = this.#visualObjects.present;
+    const beforeTimeline = this.#timeline.project;
+    const beforeArtifacts = this.#artifactDocument;
+    if (parts.document !== undefined) {
+      const documentErrors = validateJoyProjectV1(parts.document);
+      if (documentErrors.length > 0) {
+        throw new RangeError(
+          `compound document is invalid: ${documentErrors.map((error) => error.message).join('; ')}`,
+        );
+      }
+    }
     const artifactResult =
       parts.artifacts === undefined
         ? undefined
         : applyArtifactTransaction(this.#artifactDocument.store, parts.artifacts);
-    if (parts.timeline !== undefined) {
-      // Pure: throws on an invalid command without touching the live project.
-      applyTransaction(this.#timeline.project, parts.timeline);
+    const timelineResult =
+      parts.timeline === undefined
+        ? undefined
+        : applyTransaction(this.#timeline.project, parts.timeline);
+
+    // Persist each prepared result before mutating any live history object. If a
+    // later bus rejects its write, the already-written buses are restored from
+    // their pre-state snapshots and the caller sees no compound history entry.
+    let documentPersisted = false;
+    let timelinePersisted = false;
+    let artifactPersisted = false;
+    try {
+      if (parts.document !== undefined) {
+        this.#visualObjectPersistence.saveSnapshot(parts.document, false);
+        documentPersisted = true;
+      }
+      if (parts.timeline !== undefined) {
+        this.#timelinePersistence.saveTransaction(beforeTimeline, parts.timeline, false);
+        timelinePersisted = true;
+      }
+      if (parts.artifacts !== undefined && artifactResult !== undefined) {
+        this.#artifactPersistence?.saveTransaction(beforeArtifacts, parts.artifacts, false);
+        artifactPersisted = true;
+      }
+    } catch (error) {
+      const rollbackErrors: unknown[] = [];
+      if (artifactPersisted) {
+        try {
+          this.#artifactPersistence?.saveSnapshot(beforeArtifacts, false);
+          this.#artifactRevision += 1;
+        } catch (rollbackError) {
+          rollbackErrors.push(rollbackError);
+        }
+      }
+      if (timelinePersisted) {
+        try {
+          this.#timelinePersistence.saveSnapshot(beforeTimeline, false);
+          this.#timelineRevision += 1;
+        } catch (rollbackError) {
+          rollbackErrors.push(rollbackError);
+        }
+      }
+      if (documentPersisted) {
+        try {
+          this.#visualObjectPersistence.saveSnapshot(beforeDocument, false);
+          this.#visualObjectRevision += 1;
+        } catch (rollbackError) {
+          rollbackErrors.push(rollbackError);
+        }
+      }
+      if (rollbackErrors.length > 0) {
+        throw new AggregateError(
+          [error, ...rollbackErrors],
+          'compound transaction failed and durable rollback was incomplete',
+        );
+      }
+      throw error;
     }
 
-    if (parts.timeline !== undefined) {
-      const before = this.#timeline.project;
+    if (timelineResult !== undefined && parts.timeline !== undefined) {
       this.#timeline.dispatch(parts.timeline);
-      this.#timelinePersistence.saveTransaction(before, parts.timeline, false);
       this.#timelineRevision += 1;
       operations.push('timeline');
       commandCount += parts.timeline.commands.length;
     }
 
     if (parts.document !== undefined) {
-      const before = this.#visualObjects.present;
       this.#visualObjects.replacePresent(parts.document);
-      // A replacement has no command form, so it persists as a snapshot; an
-      // empty transaction would replay to the old document on reload.
-      this.#visualObjectPersistence.saveSnapshot(parts.document, false);
       this.#visualObjectRevision += 1;
-      this.#snapshotUndo.push({ before, after: parts.document });
+      this.#snapshotUndo.push({ before: beforeDocument, after: parts.document });
       this.#snapshotRedo.length = 0;
       operations.push('document-snapshot');
     }
 
     if (parts.artifacts !== undefined && artifactResult !== undefined) {
-      const before = this.#artifactDocument;
-      this.#artifactDocument = { ...before, store: artifactResult.store };
-      this.#artifactPersistence?.saveTransaction(before, parts.artifacts, false);
+      this.#artifactDocument = { ...beforeArtifacts, store: artifactResult.store };
       this.#artifactRevision += 1;
       this.#artifactUndo.push(artifactResult.record);
       this.#artifactRedo.length = 0;
       operations.push('artifact');
       commandCount += parts.artifacts.commands.length;
     }
 
     if (operations.length === 0) return;
     this.#recordCompound(operations, label, commandCount);
   }
