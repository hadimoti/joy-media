# Review package: bd35ab8..ebc9012

## Commits
ebc9012 fix(workflows): preserve approval responses across transports

## Files changed
 apps/api/src/http-server.test.ts                   | 12 +++++++-
 apps/api/src/http-server.ts                        | 10 +++++++
 apps/api/src/production-runs.test.ts               | 15 +++++++++-
 apps/api/src/production-runs.ts                    | 20 +++++++++++++-
 apps/editor-web/src/ContactSheetApproval.test.tsx  | 17 ++++++++++++
 apps/editor-web/src/ContactSheetApproval.tsx       | 32 ++++++++++++++--------
 apps/editor-web/src/ProductionBoardPanel.test.tsx  | 13 ++++++---
 apps/editor-web/src/control-plane-client.test.ts   |  4 +++
 .../workflow-engine/src/production-run.test.ts     |  4 ++-
 9 files changed, 107 insertions(+), 20 deletions(-)

## Diff
diff --git a/apps/api/src/http-server.test.ts b/apps/api/src/http-server.test.ts
index 8e11d7a..d12defc 100644
--- a/apps/api/src/http-server.test.ts
+++ b/apps/api/src/http-server.test.ts
@@ -541,44 +541,52 @@ describe('control-plane HTTP transport', () => {
       body: { data: { runId: 'run-api', approvals: [{ approvalId: 'approval-api' }] } },
     });
     expect(
       await request(
         origin,
         'POST',
         '/v1/projects/p/production-runs/run-api/approvals/approval-api/respond',
         {
           approved: true,
           responseRef: 'response-api',
+          response: { approved: [{ assetId: 'asset-1' }] },
           authority,
           expectedUpdatedSeq: 2,
         },
       ),
     ).toMatchObject({
       status: 200,
       body: {
         data: {
           duplicate: false,
           record: {
             updatedSeq: 3,
-            approvals: [{ state: 'approved', responseRef: 'response-api' }],
+            approvals: [
+              {
+                state: 'approved',
+                responseRef: 'response-api',
+                response: { approved: [{ assetId: 'asset-1' }] },
+              },
+            ],
           },
         },
       },
     });
     expect(
       await request(
         origin,
         'POST',
         '/v1/projects/p/production-runs/run-api/approvals/approval-api/respond',
         {
           approved: true,
           responseRef: 'response-api',
+          response: { approved: [{ assetId: 'asset-1' }] },
           authority,
           expectedUpdatedSeq: 2,
         },
       ),
     ).toMatchObject({
       status: 200,
       body: {
         data: {
           duplicate: true,
           record: {
@@ -588,20 +596,21 @@ describe('control-plane HTTP transport', () => {
       },
     });
     expect(
       await request(
         origin,
         'POST',
         '/v1/projects/p/production-runs/run-api/approvals/approval-api/respond',
         {
           approved: true,
           responseRef: 'response-api-role-mismatch',
+          response: { approved: true },
           authority: { principalId: 'owner', role: 'reviewer' },
         },
       ),
     ).toMatchObject({ status: 409, body: { error: { code: 'AUTHORITY_INVALID' } } });
     expect(
       await request(origin, 'POST', '/v1/projects/p/production-runs/run-api/cancel', {
         authority,
         expectedUpdatedSeq: 2,
       }),
     ).toMatchObject({ status: 409, body: { error: { code: 'REVISION_CONFLICT' } } });
@@ -939,20 +948,21 @@ function parkedRecord(
         message: 'approve-render',
       },
     ],
     approvals: [
       {
         approvalVersion: 1,
         approvalId,
         nodeId: 'review',
         kind: 'approve-render',
         prompt: 'Approve final?',
+        requestPayload: { diffRef: 'asset-diff-1' },
         state: 'pending',
         requestedSeq: 2,
       },
     ],
     nodes: [
       {
         nodeId: 'review',
         type: 'render.review',
         category: 'review',
         state: 'waiting_for_input',
diff --git a/apps/api/src/http-server.ts b/apps/api/src/http-server.ts
index 23f85ff..180bc04 100644
--- a/apps/api/src/http-server.ts
+++ b/apps/api/src/http-server.ts
@@ -466,20 +466,26 @@ async function route(
     const expectedUpdatedSeq = optionalNonNegativeInteger(body, 'expectedUpdatedSeq');
     respondJson(response, 200, {
       data: await productionRunStore(options.controlPlane).respondToProductionApproval(
         actor,
         decodeURIComponent(productionRunApprovalMatch[1]!),
         decodeURIComponent(productionRunApprovalMatch[2]!),
         {
           approvalId: decodeURIComponent(productionRunApprovalMatch[3]!),
           approved: requiredBoolean(body, 'approved'),
           responseRef: requiredString(body, 'responseRef'),
+          ...(!('response' in body) ? {} : { response: body.response }),
+          ...(typeof body.rejectionReason === 'string'
+            ? { rejectionReason: body.rejectionReason }
+            : body.rejectionReason === undefined
+              ? {}
+              : invalidRequest('rejectionReason must be a string')),
           authority: requiredProductionRunAuthority(body, 'authority'),
           ...(expectedUpdatedSeq === undefined ? {} : { expectedUpdatedSeq }),
         },
       ),
     });
     return;
   }
 
   const productionRunCancelMatch =
     /^\/v1\/projects\/([^/]+)\/production-runs\/([^/]+)\/cancel$/.exec(url.pathname);
@@ -1419,20 +1425,24 @@ function requiredSha256(body: Record<string, unknown>, field: string): string {
     throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a SHA-256 hex digest`);
   return value;
 }
 
 function requiredPositiveInteger(body: Record<string, unknown>, field: string): number {
   const value = optionalPositiveInteger(body, field);
   if (value === undefined) throw new ControlPlaneError('REQUEST_INVALID', `${field} is required`);
   return value;
 }
 
+function invalidRequest(message: string): never {
+  throw new ControlPlaneError('REQUEST_INVALID', message);
+}
+
 function requiredObject(body: Record<string, unknown>, field: string): Record<string, unknown> {
   const value = body[field];
   if (value === null || typeof value !== 'object' || Array.isArray(value))
     throw new ControlPlaneError('REQUEST_INVALID', `${field} must be an object`);
   return value as Record<string, unknown>;
 }
 
 function respondJson(response: ServerResponse, status: number, payload: unknown): void {
   response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
   response.end(JSON.stringify(payload));
diff --git a/apps/api/src/production-runs.test.ts b/apps/api/src/production-runs.test.ts
index c2ce14a..456db06 100644
--- a/apps/api/src/production-runs.test.ts
+++ b/apps/api/src/production-runs.test.ts
@@ -159,72 +159,84 @@ describe('Postgres production runs', () => {
     ).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
 
     const applied = await controlPlane.respondToProductionApproval(
       owner,
       'project-approval',
       'run-approval',
       {
         approvalId: 'approval-1',
         approved: true,
         responseRef: 'response-1',
+        response: { approved: [{ assetId: 'asset-1' }] },
         authority,
         expectedUpdatedSeq: 2,
         now: 500,
       },
     );
     expect(applied).toMatchObject({
       duplicate: false,
       record: {
         updatedSeq: 3,
-        approvals: [{ state: 'approved', responseRef: 'response-1', respondedSeq: 3 }],
+        approvals: [
+          {
+            state: 'approved',
+            responseRef: 'response-1',
+            respondedSeq: 3,
+            response: { approved: [{ assetId: 'asset-1' }] },
+          },
+        ],
         events: [
           { seq: 1, type: 'run.parked' },
           { seq: 2, type: 'approval.requested' },
           { seq: 3, type: 'approval.responded' },
         ],
       },
     });
     expect(JSON.stringify(applied.record)).not.toContain('private');
 
     await expect(
       controlPlane.respondToProductionApproval(owner, 'project-approval', 'run-approval', {
         approvalId: 'approval-1',
         approved: true,
         responseRef: 'response-1',
+        response: { approved: [{ assetId: 'asset-1' }] },
         authority,
         expectedUpdatedSeq: 2,
         now: 501,
       }),
     ).resolves.toMatchObject({ duplicate: true, record: { updatedSeq: 3 } });
     await expect(
       controlPlane.respondToProductionApproval(owner, 'project-approval', 'run-approval', {
         approvalId: 'approval-1',
         approved: true,
         responseRef: 'response-1',
+        response: { approved: [{ assetId: 'asset-1' }] },
         authority,
         now: 502,
       }),
     ).resolves.toMatchObject({ duplicate: true, record: { updatedSeq: 3 } });
     await expect(
       controlPlane.respondToProductionApproval(owner, 'project-approval', 'run-approval', {
         approvalId: 'approval-1',
         approved: true,
         responseRef: 'response-role-mismatch',
         authority: { principalId: owner.id, role: 'reviewer' },
         now: 502,
       }),
     ).rejects.toMatchObject({ code: 'AUTHORITY_INVALID' });
     await expect(
       controlPlane.respondToProductionApproval(owner, 'project-approval', 'run-approval', {
         approvalId: 'approval-1',
         approved: false,
         responseRef: 'response-2',
+        response: { approved: false },
+        rejectionReason: 'Needs a safer ending',
         authority,
         now: 503,
       }),
     ).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
 
     await pool.end();
   });
 
   it('cancels with optimistic revisions and rejects private paths, raw media, and oversized logs', async () => {
     const { pool, controlPlane } = await initializedControlPlane();
@@ -502,20 +514,21 @@ function parkedRecord(runId: string, approvalId: string): ProductionRunRecordV1
         message: 'approve-render',
       },
     ],
     approvals: [
       {
         approvalVersion: 1,
         approvalId,
         nodeId: 'review',
         kind: 'approve-render',
         prompt: 'Approve final?',
+        requestPayload: { diffRef: 'asset-diff-1' },
         state: 'pending',
         requestedSeq: 2,
       },
     ],
     nodes: [{ ...nodeProjection('review'), pendingApprovalId: approvalId }],
     updatedSeq: 2,
   });
 }
 
 function nodeProjection(nodeId: string): ProductionRunRecordV1['nodes'][number] {
diff --git a/apps/api/src/production-runs.ts b/apps/api/src/production-runs.ts
index 06a9514..0e64dce 100644
--- a/apps/api/src/production-runs.ts
+++ b/apps/api/src/production-runs.ts
@@ -42,24 +42,27 @@ export interface ProductionRunEventV1 {
   readonly failureCode?: string;
   readonly message?: string;
 }
 
 export interface ProductionApprovalV1 {
   readonly approvalVersion: 1;
   readonly approvalId: string;
   readonly nodeId: string;
   readonly kind: string;
   readonly prompt: string;
+  readonly requestPayload?: unknown;
   readonly state: ProductionApprovalStateV1;
   readonly requestedSeq: number;
   readonly respondedSeq?: number;
   readonly responseRef?: string;
+  readonly response?: unknown;
+  readonly rejectionReason?: string;
   readonly authority?: ProductionRunAuthority;
 }
 
 export interface ProductionRunPublicLogEntryV1 {
   readonly seq: number;
   readonly nodeId: string;
   readonly attempt: number;
   readonly level: 'debug' | 'info' | 'warn' | 'error';
   readonly message: string;
 }
@@ -111,20 +114,22 @@ export interface ListProductionRunsOptions {
 
 export interface ProductionRunPage {
   readonly runs: readonly ProductionRunRecordV1[];
   readonly nextCursor?: string;
 }
 
 export interface RespondToProductionApprovalInput {
   readonly approvalId: string;
   readonly approved: boolean;
   readonly responseRef: string;
+  readonly response?: unknown;
+  readonly rejectionReason?: string;
   readonly authority: ProductionRunAuthority;
   readonly expectedUpdatedSeq?: number;
   readonly now?: number;
 }
 
 export interface CancelProductionRunInput {
   readonly authority: ProductionRunAuthority;
   readonly expectedUpdatedSeq?: number;
   readonly now?: number;
 }
@@ -407,31 +412,38 @@ export class PostgresProductionRunStore implements ProductionRunStore {
 function applyApprovalResponse(
   record: ProductionRunRecordV1,
   input: RespondToProductionApprovalInput,
 ):
   | { readonly ok: true; readonly duplicate: boolean; readonly record: ProductionRunRecordV1 }
   | { readonly ok: false; readonly reason: 'approval-not-found' | 'approval-conflict' } {
   const approval = record.approvals.find((candidate) => candidate.approvalId === input.approvalId);
   if (approval === undefined) return { ok: false, reason: 'approval-not-found' };
   const nextState = input.approved ? 'approved' : 'rejected';
   if (approval.state !== 'pending') {
-    if (approval.state === nextState && approval.responseRef === input.responseRef) {
+    if (
+      approval.state === nextState &&
+      approval.responseRef === input.responseRef &&
+      jsonEqual(approval.response, input.response) &&
+      approval.rejectionReason === input.rejectionReason
+    ) {
       return { ok: true, duplicate: true, record };
     }
     return { ok: false, reason: 'approval-conflict' };
   }
   const seq = (record.events.at(-1)?.seq ?? 0) + 1;
   const updatedApproval: ProductionApprovalV1 = {
     ...approval,
     state: nextState,
     respondedSeq: seq,
     responseRef: input.responseRef,
+    ...(input.response === undefined ? {} : { response: input.response }),
+    ...(input.rejectionReason === undefined ? {} : { rejectionReason: input.rejectionReason }),
     authority: input.authority,
   };
   const event: ProductionRunEventV1 = {
     eventVersion: 1,
     seq,
     type: 'approval.responded',
     state: record.state,
     actor: input.authority,
     nodeId: approval.nodeId,
     approvalId: approval.approvalId,
@@ -689,26 +701,32 @@ function validateApprovals(record: ProductionRunRecordV1): void {
     if (!Number.isSafeInteger(approval.requestedSeq) || approval.requestedSeq < 1)
       invalidRun('approval requested sequence is invalid');
     if (
       approval.respondedSeq !== undefined &&
       (!Number.isSafeInteger(approval.respondedSeq) ||
         approval.respondedSeq <= approval.requestedSeq)
     ) {
       invalidRun('approval responded sequence is invalid');
     }
     if (approval.responseRef !== undefined) validateOpaque(approval.responseRef, 'response ref');
+    if (approval.rejectionReason !== undefined)
+      validateSafeString(approval.rejectionReason, 'rejection reason');
     if (approval.authority !== undefined) validateAuthorityShape(approval.authority);
     if (seen.has(approval.approvalId)) invalidRun('approval IDs must be unique');
     seen.add(approval.approvalId);
   }
 }
 
+function jsonEqual(left: unknown, right: unknown): boolean {
+  return JSON.stringify(left) === JSON.stringify(right);
+}
+
 function validateNodes(record: ProductionRunRecordV1): void {
   for (const node of record.nodes) {
     validateOpaque(node.nodeId, 'node id');
     validateSafeString(node.type, 'node type');
     validateSafeString(node.category, 'node category');
     validateSafeString(node.state, 'node state');
     if (!Number.isSafeInteger(node.attempts) || node.attempts < 0)
       invalidRun('node attempts are invalid');
     if (typeof node.deterministic !== 'boolean' || typeof node.reused !== 'boolean')
       invalidRun('node booleans are invalid');
diff --git a/apps/editor-web/src/ContactSheetApproval.test.tsx b/apps/editor-web/src/ContactSheetApproval.test.tsx
index a022c27..150bc7a 100644
--- a/apps/editor-web/src/ContactSheetApproval.test.tsx
+++ b/apps/editor-web/src/ContactSheetApproval.test.tsx
@@ -126,20 +126,37 @@ describe('ContactSheetApproval', () => {
         approvalId: 'approval-1',
         selectedItems: [],
         rejectionReason: '   ',
       }),
     ).toEqual({
       ok: false,
       validation: 'Add a rejection reason before rejecting.',
     });
   });
 
+  it('allows non-visual approvals to approve with no selected items', () => {
+    expect(
+      contactSheetApprovalDecisionFor('approve', {
+        kind: 'confirm-cost',
+        approvalId: 'approval-2',
+        selectedItems: [],
+      }),
+    ).toEqual({
+      ok: true,
+      decision: {
+        approved: true,
+        response: { approved: true },
+        responseId: contactSheetResponseIdFor('approval-2', { approved: true }),
+      },
+    });
+  });
+
   it('binds response ids to exact approved and rejected payloads', () => {
     const selectedItems = contactSheetApprovalItemsFor(chooseCandidatesRequest()).slice(0, 2);
     const approved = contactSheetApprovalDecisionFor('approve', {
       kind: 'choose-candidates',
       approvalId: 'approval-42',
       selectedItems,
     });
     expect(approved).toMatchObject({
       ok: true,
       decision: {
diff --git a/apps/editor-web/src/ContactSheetApproval.tsx b/apps/editor-web/src/ContactSheetApproval.tsx
index 7054882..496c3a6 100644
--- a/apps/editor-web/src/ContactSheetApproval.tsx
+++ b/apps/editor-web/src/ContactSheetApproval.tsx
@@ -195,26 +195,30 @@ export function ContactSheetApproval({
             );
           })}
         </div>
       )}
 
       {request.kind === 'approve-render' && activeItem !== undefined && (
         <div className="contact-sheet-compare">
           <button
             type="button"
             className="icon-button icon-button-labeled"
-            onClick={() => setCompareKey(compareKey === activeItem.key ? undefined : activeItem.key)}
+            onClick={() =>
+              setCompareKey(compareKey === activeItem.key ? undefined : activeItem.key)
+            }
           >
             Compare
           </button>
           {comparedItem !== undefined && (
-            <pre aria-label="Render diff">{JSON.stringify(comparedItem.diff ?? comparedItem.raw, null, 2)}</pre>
+            <pre aria-label="Render diff">
+              {JSON.stringify(comparedItem.diff ?? comparedItem.raw, null, 2)}
+            </pre>
           )}
         </div>
       )}
 
       <label className="contact-sheet-reason">
         Rejection reason
         <textarea
           value={rejectionReason}
           onChange={(event) => {
             setRejectionReason(event.currentTarget.value);
@@ -223,25 +227,21 @@ export function ContactSheetApproval({
         />
       </label>
 
       {validation !== undefined && (
         <p className="workflow-status-hint" role="alert">
           {validation}
         </p>
       )}
 
       <div className="workflow-run-actions">
-        <button
-          type="button"
-          className="icon-button icon-button-labeled"
-          onClick={submitApproved}
-        >
+        <button type="button" className="icon-button icon-button-labeled" onClick={submitApproved}>
           Approve selected
         </button>
         <button type="button" className="icon-button icon-button-labeled" onClick={submitRejected}>
           Reject
         </button>
         {onDismiss !== undefined && (
           <button type="button" className="icon-button" onClick={onDismiss}>
             Dismiss
           </button>
         )}
@@ -367,34 +367,35 @@ export function initialContactSheetSelectedKeys(
     : items.map((item) => item.key);
 }
 
 export function contactSheetResponseFor(
   kind: HumanInputRequest['kind'],
   selectedItems: readonly ContactSheetApprovalItem[],
 ): unknown {
   const selected = selectedItems.map((item) => item.raw);
   if (kind === 'choose-candidates') return { candidates: selected };
   if (kind === 'approve-render') return { approved: selected };
-  return { approved: true, items: selected };
+  return { approved: true };
 }
 
 export function contactSheetApprovalDecisionFor(
   action: ContactSheetApprovalAction,
   input: {
     readonly kind: HumanInputRequest['kind'];
     readonly approvalId?: string;
     readonly selectedItems: readonly ContactSheetApprovalItem[];
     readonly rejectionReason?: string;
   },
 ): ContactSheetApprovalDecisionResult {
   if (action === 'approve') {
-    if (input.selectedItems.length === 0) {
+    const requiresSelection = input.kind === 'choose-candidates' || input.kind === 'approve-render';
+    if (requiresSelection && input.selectedItems.length === 0) {
       return {
         ok: false,
         validation: 'Select at least one item to approve, or reject with a reason.',
       };
     }
     const response = contactSheetResponseFor(input.kind, input.selectedItems);
     return {
       ok: true,
       decision: {
         approved: true,
@@ -463,21 +464,24 @@ function formatTimeRange(item: ContactSheetApprovalItem): string {
   return `${formatUs(item.startUs ?? 0)}-${formatUs(item.endUs ?? item.startUs ?? 0)}`;
 }
 
 function formatUs(value: number): string {
   const totalSeconds = Math.max(0, Math.round(value / 1_000_000));
   const minutes = Math.floor(totalSeconds / 60);
   const seconds = totalSeconds % 60;
   return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
 }
 
-export function contactSheetResponseIdFor(approvalId: string | undefined, response: unknown): string {
+export function contactSheetResponseIdFor(
+  approvalId: string | undefined,
+  response: unknown,
+): string {
   return `approval-response:${approvalId ?? 'unbound'}:${hashString(canonicalJson(response))}`;
 }
 
 function canonicalJson(value: unknown): string {
   if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
   if (value !== null && typeof value === 'object') {
     return `{${Object.entries(value as Record<string, unknown>)
       .sort(([left], [right]) => left.localeCompare(right))
       .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
       .join(',')}}`;
@@ -526,25 +530,29 @@ function asRecord(value: unknown): Record<string, unknown> | undefined {
 
 function asArray(value: unknown): readonly unknown[] {
   return Array.isArray(value) ? value : [];
 }
 
 function firstString(...values: readonly unknown[]): string | undefined {
   return values.find((value): value is string => typeof value === 'string' && value.length > 0);
 }
 
 function firstNumber(...values: readonly unknown[]): number | undefined {
-  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
+  return values.find(
+    (value): value is number => typeof value === 'number' && Number.isFinite(value),
+  );
 }
 
 function millisToMicros(value: unknown): number | undefined {
-  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1_000) : undefined;
+  return typeof value === 'number' && Number.isFinite(value)
+    ? Math.round(value * 1_000)
+    : undefined;
 }
 
 function microsFromDuration(startUs: number | undefined, durationUs: unknown): number | undefined {
   return startUs !== undefined && typeof durationUs === 'number' && Number.isFinite(durationUs)
     ? startUs + durationUs
     : undefined;
 }
 
 function millisToMicrosFromDuration(
   startUs: number | undefined,
diff --git a/apps/editor-web/src/ProductionBoardPanel.test.tsx b/apps/editor-web/src/ProductionBoardPanel.test.tsx
index 4168a69..7913374 100644
--- a/apps/editor-web/src/ProductionBoardPanel.test.tsx
+++ b/apps/editor-web/src/ProductionBoardPanel.test.tsx
@@ -25,32 +25,37 @@ describe('ProductionBoardPanel', () => {
             records: [],
             currentProjectRevision: 'rev-1',
             artifacts: emptyArtifacts,
             dataLanes: [],
           })}
         />,
       ),
     ).toContain('Start a Workflow');
   });
 
-  it('renders status groups, authority badge, sections, and action availability', () => {
+  it('renders status groups, authority badge, tabs, and action availability', () => {
     const model = buildProductionBoardModel({
       records: [
         run({
           state: 'parked',
           approvals: [
             {
               approvalVersion: 1,
               approvalId: 'approval-1',
               nodeId: 'scene-candidates',
               kind: 'choose-candidates',
               prompt: 'Choose candidates',
+              requestPayload: {
+                candidates: [
+                  { id: 'candidate-1', title: 'Opening shot', thumbnailRef: 'thumb.jpg' },
+                ],
+              },
               state: 'pending',
               requestedSeq: 2,
             },
           ],
           nodes: [
             node({
               nodeId: 'scene-candidates',
               type: 'scene.candidates',
               category: 'scene',
               state: 'waiting_for_input',
@@ -64,23 +69,23 @@ describe('ProductionBoardPanel', () => {
       dataLanes: [],
     });
 
     const markup = renderToStaticMarkup(
       <ProductionBoardPanelView loadState="loaded" model={model} retryAvailable />,
     );
 
     expect(markup).toContain('Needs review');
     expect(markup).toContain('Producer · owner');
     expect(markup).toContain('Brief/Input');
-    expect(markup).toContain('Approve');
-    expect(markup).toContain('>Approve</button>');
-    expect(markup).toContain('>Reject</button>');
+    expect(markup).toContain('aria-label="Approvals"');
+    expect(markup).toContain('>Retry</button>');
+    expect(markup).toContain('>Cancel</button>');
     expect(markup).toContain('disabled=""><svg');
   });
 
   it('renders stale revision conflicts and artifact/provider/report links', () => {
     const artifacts: ArtifactStore = {
       artifacts: {
         'artifact-1': {
           id: 'artifact-1',
           kind: 'renderOutput',
           schemaVersion: 1,
diff --git a/apps/editor-web/src/control-plane-client.test.ts b/apps/editor-web/src/control-plane-client.test.ts
index 6b6531e..4621410 100644
--- a/apps/editor-web/src/control-plane-client.test.ts
+++ b/apps/editor-web/src/control-plane-client.test.ts
@@ -288,20 +288,22 @@ describe('BrowserControlPlaneClient', () => {
           projectRevision: 'project-revision-1',
           state: 'succeeded',
           nodes: {},
         },
         authority: { principalId: 'owner-1', role: 'owner' },
       });
       await client.respondToProductionRunApproval('project-1', 'run-1', {
         approvalId: 'approval-1',
         approved: true,
         responseRef: 'decision:approval-1',
+        response: { approved: true },
+        rejectionReason: 'not used on approval',
         expectedUpdatedSeq: 2,
         authority: { principalId: 'owner-1', role: 'owner' },
       });
       await client.cancelProductionRun('project-1', 'run-1', {
         authority: { principalId: 'owner-1', role: 'owner' },
         expectedUpdatedSeq: 3,
       });
     } finally {
       globalThis.fetch = original;
     }
@@ -311,20 +313,22 @@ describe('BrowserControlPlaneClient', () => {
       'https://media.joyteam.ir/api/v1/projects/project-1/production-runs?limit=25&cursor=next&state=queued',
       'https://media.joyteam.ir/api/v1/projects/project-1/production-runs/run-1',
       'https://media.joyteam.ir/api/v1/projects/project-1/production-runs/run-1/checkpoint',
       'https://media.joyteam.ir/api/v1/projects/project-1/production-runs/run-1/approvals/approval-1/respond',
       'https://media.joyteam.ir/api/v1/projects/project-1/production-runs/run-1/cancel',
     ]);
     expect(requests[0]?.body).toContain('"runKey":"run-key-1"');
     expect(requests[0]?.body).toContain('"authority":{"principalId":"owner-1","role":"owner"}');
     expect(requests[0]?.body).toContain('"artifactIds":["asset:clip"]');
     expect(requests[4]?.body).toContain('"expectedUpdatedSeq":2');
+    expect(requests[4]?.body).toContain('"response":{"approved":true}');
+    expect(requests[4]?.body).toContain('"rejectionReason":"not used on approval"');
     expect(requests[5]?.body).toContain('"expectedUpdatedSeq":3');
     expect(JSON.stringify(requests)).not.toContain('C:\\');
     expect(JSON.stringify(requests)).not.toContain('bytesBase64');
   });
 });
 
 function json(status: number, value: unknown): Response {
   return new Response(JSON.stringify(value), {
     status,
     headers: { 'content-type': 'application/json' },
diff --git a/packages/workflow-engine/src/production-run.test.ts b/packages/workflow-engine/src/production-run.test.ts
index 68887af..d0a8a41 100644
--- a/packages/workflow-engine/src/production-run.test.ts
+++ b/packages/workflow-engine/src/production-run.test.ts
@@ -247,25 +247,26 @@ describe('production run records', () => {
       approvalId: approvalId as string,
       approved: true,
       responseRef: 'approval-response-1',
       authority,
     });
     expect(first).toMatchObject({ ok: true, duplicate: false });
     if (!first.ok) {
       expect.unreachable('approval response should apply');
     }
     expect(first.record.approvals[0]).toMatchObject({
+      requestPayload: { private: 'diff' },
       state: 'approved',
       responseRef: 'approval-response-1',
       respondedSeq: 3,
     });
-    expect(JSON.stringify(first.record)).not.toContain('diff');
+    expect(JSON.stringify(first.record)).toContain('"requestPayload":{"private":"diff"}');
 
     const duplicate = recordProductionApprovalResponse(first.record, {
       approvalId: approvalId as string,
       approved: true,
       responseRef: 'approval-response-1',
       authority,
     });
     expect(duplicate).toMatchObject({ ok: true, duplicate: true, record: first.record });
 
     const conflict = recordProductionApprovalResponse(first.record, {
@@ -295,20 +296,21 @@ describe('production run records', () => {
     expect(snapshot.runs.map((run) => [run.runId, run.state])).toEqual([
       ['run-board-parked', 'parked'],
       ['run-board-succeeded', 'succeeded'],
     ]);
     expect(snapshot.runs[0]?.approvals).toEqual([
       {
         approvalId: parked.approvals[0]?.approvalId,
         nodeId: 'task',
         kind: 'approve-render',
         prompt: 'Approve board?',
+        requestedSeq: 2,
         state: 'pending',
       },
     ]);
     expect(snapshot.runs[1]?.nodes[0]).toMatchObject({
       nodeId: 'task',
       state: 'succeeded',
       attempts: 1,
     });
   });
 });
