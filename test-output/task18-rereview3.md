# Review package: 455f7fc..8bef9a7

## Commits
8bef9a7 fix(workflows): preserve json semantics in approval dedupe

## Files changed
 apps/api/src/production-runs.test.ts               | 46 ++++++++++++++++++++++
 apps/api/src/production-runs.ts                    | 12 ++++--
 .../workflow-engine/src/production-run.test.ts     | 28 +++++++++++++
 packages/workflow-engine/src/production-run.ts     | 12 ++++--
 4 files changed, 92 insertions(+), 6 deletions(-)

## Diff
diff --git a/apps/api/src/production-runs.test.ts b/apps/api/src/production-runs.test.ts
index f93466d..f714b8e 100644
--- a/apps/api/src/production-runs.test.ts
+++ b/apps/api/src/production-runs.test.ts
@@ -287,20 +287,66 @@ describe('Postgres production runs', () => {
           response: { nested: { b: 2, a: 1 }, approved: true },
           authority,
           now: 501,
         },
       ),
     ).resolves.toMatchObject({ duplicate: true, record: { updatedSeq: 3 } });
 
     await pool.end();
   });
 
+  it('matches JSON serialization semantics for undefined and omitted API response values', async () => {
+    const { pool, controlPlane } = await initializedControlPlane();
+    await controlPlane.createProject(owner, 'project-approval-json-semantics', 'Approvals');
+    const parked = parkedRecord('run-approval-json-semantics', 'approval-1');
+    await controlPlane.createProductionRun(owner, 'project-approval-json-semantics', {
+      runKey: 'run-key-approval-json-semantics',
+      record: parked,
+      authority,
+      now: 100,
+    });
+
+    await expect(
+      controlPlane.respondToProductionApproval(
+        owner,
+        'project-approval-json-semantics',
+        'run-approval-json-semantics',
+        {
+          approvalId: 'approval-1',
+          approved: true,
+          responseRef: 'response-json-semantics',
+          response: { keep: 1, omit: undefined, list: [undefined, 2] },
+          authority,
+          now: 500,
+        },
+      ),
+    ).resolves.toMatchObject({ duplicate: false, record: { updatedSeq: 3 } });
+
+    await expect(
+      controlPlane.respondToProductionApproval(
+        owner,
+        'project-approval-json-semantics',
+        'run-approval-json-semantics',
+        {
+          approvalId: 'approval-1',
+          approved: true,
+          responseRef: 'response-json-semantics',
+          response: { list: [null, 2], keep: 1 },
+          authority,
+          now: 501,
+        },
+      ),
+    ).resolves.toMatchObject({ duplicate: true, record: { updatedSeq: 3 } });
+
+    await pool.end();
+  });
+
   it('cancels with optimistic revisions and rejects private paths, raw media, and oversized logs', async () => {
     const { pool, controlPlane } = await initializedControlPlane();
     await controlPlane.createProject(owner, 'project-cancel', 'Cancellation');
     await controlPlane.createProductionRun(owner, 'project-cancel', {
       runKey: 'run-key-cancel',
       record: queuedRecord('run-cancel'),
       authority,
     });
 
     await expect(
diff --git a/apps/api/src/production-runs.ts b/apps/api/src/production-runs.ts
index bb934d1..3b22a26 100644
--- a/apps/api/src/production-runs.ts
+++ b/apps/api/src/production-runs.ts
@@ -713,26 +713,32 @@ function validateApprovals(record: ProductionRunRecordV1): void {
     if (approval.authority !== undefined) validateAuthorityShape(approval.authority);
     if (seen.has(approval.approvalId)) invalidRun('approval IDs must be unique');
     seen.add(approval.approvalId);
   }
 }
 
 function jsonEqual(left: unknown, right: unknown): boolean {
   return canonicalJson(left) === canonicalJson(right);
 }
 
-function canonicalJson(value: unknown): string {
-  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
+function canonicalJson(value: unknown): string | undefined {
+  const serialized = JSON.stringify(value);
+  if (serialized === undefined) return undefined;
+  return canonicalJsonValue(JSON.parse(serialized) as unknown);
+}
+
+function canonicalJsonValue(value: unknown): string {
+  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(',')}]`;
   if (value !== null && typeof value === 'object') {
     return `{${Object.entries(value as Record<string, unknown>)
       .sort(([left], [right]) => left.localeCompare(right))
-      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
+      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJsonValue(child)}`)
       .join(',')}}`;
   }
   return JSON.stringify(value);
 }
 
 function validateNodes(record: ProductionRunRecordV1): void {
   for (const node of record.nodes) {
     validateOpaque(node.nodeId, 'node id');
     validateSafeString(node.type, 'node type');
     validateSafeString(node.category, 'node category');
diff --git a/packages/workflow-engine/src/production-run.test.ts b/packages/workflow-engine/src/production-run.test.ts
index 8677368..50c2f5d 100644
--- a/packages/workflow-engine/src/production-run.test.ts
+++ b/packages/workflow-engine/src/production-run.test.ts
@@ -308,20 +308,48 @@ describe('production run records', () => {
     const duplicate = recordProductionApprovalResponse(first.record, {
       approvalId,
       approved: true,
       responseRef: 'approval-response-reordered',
       response: { nested: { b: 2, a: 1 }, approved: true },
       authority,
     });
     expect(duplicate).toEqual({ ok: true, duplicate: true, record: first.record });
   });
 
+  it('matches JSON serialization semantics for undefined and omitted response values', () => {
+    const parked = runProductionCase('run-approval-json-semantics', () => ({
+      waiting: true,
+      request: { kind: 'approve-render', prompt: 'Approve final?' },
+    }));
+    const approvalId = parked.approvals[0]?.approvalId;
+    if (approvalId === undefined) expect.unreachable('approval should exist');
+
+    const first = recordProductionApprovalResponse(parked, {
+      approvalId,
+      approved: true,
+      responseRef: 'approval-response-json-semantics',
+      response: { keep: 1, omit: undefined, list: [undefined, 2] },
+      authority,
+    });
+    expect(first).toMatchObject({ ok: true, duplicate: false });
+    if (!first.ok) expect.unreachable('first approval should apply');
+
+    const duplicate = recordProductionApprovalResponse(first.record, {
+      approvalId,
+      approved: true,
+      responseRef: 'approval-response-json-semantics',
+      response: { list: [null, 2], keep: 1 },
+      authority,
+    });
+    expect(duplicate).toEqual({ ok: true, duplicate: true, record: first.record });
+  });
+
   it('projects production records into a board snapshot', () => {
     const parked = runProductionCase('run-board-parked', () => ({
       waiting: true,
       request: { kind: 'approve-render', prompt: 'Approve board?' },
     }));
     const succeeded = runProductionCase('run-board-succeeded', () => ({
       ok: true,
       output: { artifactId: 'artifact-final' },
     }));
 
diff --git a/packages/workflow-engine/src/production-run.ts b/packages/workflow-engine/src/production-run.ts
index 65ce81b..19b97da 100644
--- a/packages/workflow-engine/src/production-run.ts
+++ b/packages/workflow-engine/src/production-run.ts
@@ -552,26 +552,32 @@ function mergeProductionApprovals(
     approval.state === 'pending' ? (nextById.get(approval.approvalId) ?? approval) : approval,
   );
   const currentIds = new Set(current.map((approval) => approval.approvalId));
   return [...merged, ...next.filter((approval) => !currentIds.has(approval.approvalId))];
 }
 
 function jsonEqual(left: unknown, right: unknown): boolean {
   return canonicalJson(left) === canonicalJson(right);
 }
 
-function canonicalJson(value: unknown): string {
-  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
+function canonicalJson(value: unknown): string | undefined {
+  const serialized = JSON.stringify(value);
+  if (serialized === undefined) return undefined;
+  return canonicalJsonValue(JSON.parse(serialized) as unknown);
+}
+
+function canonicalJsonValue(value: unknown): string {
+  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(',')}]`;
   if (value !== null && typeof value === 'object') {
     return `{${Object.entries(value as Record<string, unknown>)
       .sort(([left], [right]) => left.localeCompare(right))
-      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
+      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJsonValue(child)}`)
       .join(',')}}`;
   }
   return JSON.stringify(value);
 }
 
 function createProductionRunEvent(
   seq: number,
   input: AppendProductionRunEventInput,
   fallbackCheckpointRevision: number,
 ): ProductionRunEventV1 {
