# Review package: c3d042a..8a9d629

## Commits
8a9d629 fix(editor): page through production board runs

## Files changed
 apps/editor-web/src/ProductionBoardPanel.test.tsx | 41 ++++++++++++++++++++++-
 apps/editor-web/src/ProductionBoardPanel.tsx      | 33 +++++++++++++++---
 2 files changed, 68 insertions(+), 6 deletions(-)

## Diff
diff --git a/apps/editor-web/src/ProductionBoardPanel.test.tsx b/apps/editor-web/src/ProductionBoardPanel.test.tsx
index ef946a5..4168a69 100644
--- a/apps/editor-web/src/ProductionBoardPanel.test.tsx
+++ b/apps/editor-web/src/ProductionBoardPanel.test.tsx
@@ -1,15 +1,15 @@
 import { renderToStaticMarkup } from 'react-dom/server';
 import { describe, expect, it } from 'vitest';
 import type { ArtifactStore } from '@joy-media/commands';
 import type { ProductionRunRecordV1 } from '@joy-media/workflow-engine';
-import { ProductionBoardPanelView } from './ProductionBoardPanel.js';
+import { loadProductionBoardRecords, ProductionBoardPanelView } from './ProductionBoardPanel.js';
 import { buildProductionBoardModel } from './production-board-model.js';
 
 const emptyArtifacts: ArtifactStore = { artifacts: {}, versions: {} };
 
 describe('ProductionBoardPanel', () => {
   it('renders loading, error, and empty states', () => {
     expect(renderToStaticMarkup(<ProductionBoardPanelView loadState="loading" />)).toContain(
       'Loading runs',
     );
     expect(
@@ -138,20 +138,59 @@ describe('ProductionBoardPanel', () => {
       <ProductionBoardPanelView loadState="loaded" model={model} />,
     );
 
     expect(markup).toContain('Stale project revision');
     expect(markup).toContain('Project revision changed since this run parked');
     expect(markup).toContain('Provider provider-1');
     expect(markup).toContain('Report report-1');
     expect(markup).toContain('Artifact Verified delivery');
     expect(markup).toContain('Generated lane');
   });
+
+  it('loads every paged store result before applying newest-updated ordering', async () => {
+    const records = Array.from({ length: 101 }, (_, index) =>
+      run({
+        runId: `run-${String(index + 1).padStart(3, '0')}`,
+        createdSeq: index + 1,
+        updatedSeq: index + 1,
+      }),
+    );
+    const newest = run({
+      runId: 'newest-second-page',
+      createdSeq: 102,
+      updatedSeq: 10_000,
+      state: 'running',
+    });
+    const pagedRecords = [...records, newest];
+
+    const loaded = await loadProductionBoardRecords({
+      async list(options = {}) {
+        const limit = options.limit ?? 25;
+        const offset = options.cursor === undefined ? 0 : Number(options.cursor);
+        const runs = pagedRecords.slice(offset, offset + limit);
+        const nextOffset = offset + runs.length;
+        return {
+          runs,
+          ...(nextOffset < pagedRecords.length ? { nextCursor: String(nextOffset) } : {}),
+        };
+      },
+    });
+    const model = buildProductionBoardModel({
+      records: loaded,
+      currentProjectRevision: 'rev-1',
+      artifacts: emptyArtifacts,
+      dataLanes: [],
+    });
+
+    expect(loaded).toHaveLength(102);
+    expect(model.runs[0]?.runId).toBe('newest-second-page');
+  });
 });
 
 function run(overrides: Partial<ProductionRunRecordV1> = {}): ProductionRunRecordV1 {
   const state = overrides.state ?? 'parked';
   return {
     recordVersion: 1,
     runId: 'run-1',
     workflowId: 'joy.workflow.production',
     workflowVersion: '1.0.0',
     projectRevision: 'rev-1',
diff --git a/apps/editor-web/src/ProductionBoardPanel.tsx b/apps/editor-web/src/ProductionBoardPanel.tsx
index 9263ef1..914a341 100644
--- a/apps/editor-web/src/ProductionBoardPanel.tsx
+++ b/apps/editor-web/src/ProductionBoardPanel.tsx
@@ -14,23 +14,24 @@ import {
   productionBoardPrimaryRunId,
   type ProductionBoardModel,
   type ProductionBoardRunProjection,
   type ProductionBoardSectionId,
 } from './production-board-model.js';
 import { CheckIcon, CloseIcon, RefreshIcon } from './icons.js';
 import { PanelShell, type PanelTabSpec } from './PanelShell.js';
 import { panelTabIconUrl } from './panel-tab-icons.js';
 
 export interface ProductionBoardRunStore {
-  list(options?: {
-    readonly limit?: number;
-  }): Promise<{ readonly runs: readonly ProductionRunRecordV1[] }>;
+  list(options?: { readonly limit?: number; readonly cursor?: string }): Promise<{
+    readonly runs: readonly ProductionRunRecordV1[];
+    readonly nextCursor?: string;
+  }>;
   respondToApproval?(
     runId: string,
     response: RecordProductionApprovalResponseInput & {
       readonly expectedApprovalId?: string;
       readonly expectedRequestedSeq?: number;
     },
   ): Promise<
     RecordProductionApprovalResponseResult | { readonly ok: false; readonly reason: string }
   >;
   cancel?(
@@ -77,22 +78,21 @@ export function ProductionBoardPanel({
   assets = [],
   onRetryRun,
   onOpenLink,
 }: ProductionBoardPanelProps) {
   const [loadState, setLoadState] = useState<BoardLoadState>({ kind: 'loading' });
   const [status, setStatus] = useState<string | undefined>(undefined);
 
   const refresh = useCallback(async () => {
     setLoadState({ kind: 'loading' });
     try {
-      const result = await store.list({ limit: 100 });
-      setLoadState({ kind: 'loaded', records: result.runs });
+      setLoadState({ kind: 'loaded', records: await loadProductionBoardRecords(store) });
       setStatus(undefined);
     } catch (error) {
       setLoadState({ kind: 'error', message: message(error) });
     }
   }, [store]);
 
   useEffect(() => {
     void refresh();
   }, [refresh]);
 
@@ -157,20 +157,43 @@ export function ProductionBoardPanel({
       onApprove={(run) => void approve(run, true)}
       onReject={(run) => void approve(run, false)}
       onCancel={(run) => void cancel(run)}
       onRetry={(run) => void retry(run)}
       retryAvailable={onRetryRun !== undefined}
       onOpenLink={onOpenLink}
     />
   );
 }
 
+export async function loadProductionBoardRecords(
+  store: ProductionBoardRunStore,
+): Promise<readonly ProductionRunRecordV1[]> {
+  const records: ProductionRunRecordV1[] = [];
+  const seenCursors = new Set<string>();
+  let cursor: string | undefined;
+
+  do {
+    if (cursor !== undefined) {
+      if (seenCursors.has(cursor)) throw new Error('Production Board pagination loop detected');
+      seenCursors.add(cursor);
+    }
+    const page = await store.list({
+      limit: 100,
+      ...(cursor === undefined ? {} : { cursor }),
+    });
+    records.push(...page.runs);
+    cursor = page.nextCursor;
+  } while (cursor !== undefined);
+
+  return records;
+}
+
 export function ProductionBoardPanelView({
   loadState,
   errorMessage,
   model,
   status,
   retryAvailable = false,
   onRefresh,
   onApprove,
   onReject,
   onCancel,
