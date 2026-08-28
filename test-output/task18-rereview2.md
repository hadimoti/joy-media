# Review package: ebc9012..455f7fc

## Commits
455f7fc fix(workflows): canonicalize duplicate approval comparison

## Files changed
 apps/api/src/production-runs.test.ts               | 56 ++++++++++++++++++++++
 apps/api/src/production-runs.ts                    | 13 ++++-
 .../workflow-engine/src/production-run.test.ts     | 37 ++++++++++++++
 packages/workflow-engine/src/production-run.ts     | 13 ++++-
 4 files changed, 117 insertions(+), 2 deletions(-)

## Diff
diff --git a/apps/api/src/production-runs.test.ts b/apps/api/src/production-runs.test.ts
index 456db06..f93466d 100644
--- a/apps/api/src/production-runs.test.ts
+++ b/apps/api/src/production-runs.test.ts
@@ -207,20 +207,30 @@ describe('Postgres production runs', () => {
     await expect(
       controlPlane.respondToProductionApproval(owner, 'project-approval', 'run-approval', {
         approvalId: 'approval-1',
         approved: true,
         responseRef: 'response-1',
         response: { approved: [{ assetId: 'asset-1' }] },
         authority,
         now: 502,
       }),
     ).resolves.toMatchObject({ duplicate: true, record: { updatedSeq: 3 } });
+    await expect(
+      controlPlane.respondToProductionApproval(owner, 'project-approval', 'run-approval', {
+        approvalId: 'approval-1',
+        approved: true,
+        responseRef: 'response-1',
+        response: { approved: [{ nested: { z: 2, a: 1 }, assetId: 'asset-1' }] },
+        authority,
+        now: 502,
+      }),
+    ).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
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
@@ -231,20 +241,66 @@ describe('Postgres production runs', () => {
         response: { approved: false },
         rejectionReason: 'Needs a safer ending',
         authority,
         now: 503,
       }),
     ).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
 
     await pool.end();
   });
 
+  it('treats reordered response object keys as a duplicate API approval', async () => {
+    const { pool, controlPlane } = await initializedControlPlane();
+    await controlPlane.createProject(owner, 'project-approval-reordered', 'Approvals');
+    const parked = parkedRecord('run-approval-reordered', 'approval-1');
+    await controlPlane.createProductionRun(owner, 'project-approval-reordered', {
+      runKey: 'run-key-approval-reordered',
+      record: parked,
+      authority,
+      now: 100,
+    });
+
+    await expect(
+      controlPlane.respondToProductionApproval(
+        owner,
+        'project-approval-reordered',
+        'run-approval-reordered',
+        {
+          approvalId: 'approval-1',
+          approved: true,
+          responseRef: 'response-reordered',
+          response: { approved: true, nested: { a: 1, b: 2 } },
+          authority,
+          now: 500,
+        },
+      ),
+    ).resolves.toMatchObject({ duplicate: false, record: { updatedSeq: 3 } });
+
+    await expect(
+      controlPlane.respondToProductionApproval(
+        owner,
+        'project-approval-reordered',
+        'run-approval-reordered',
+        {
+          approvalId: 'approval-1',
+          approved: true,
+          responseRef: 'response-reordered',
+          response: { nested: { b: 2, a: 1 }, approved: true },
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
index 0e64dce..bb934d1 100644
--- a/apps/api/src/production-runs.ts
+++ b/apps/api/src/production-runs.ts
@@ -710,21 +710,32 @@ function validateApprovals(record: ProductionRunRecordV1): void {
     if (approval.responseRef !== undefined) validateOpaque(approval.responseRef, 'response ref');
     if (approval.rejectionReason !== undefined)
       validateSafeString(approval.rejectionReason, 'rejection reason');
     if (approval.authority !== undefined) validateAuthorityShape(approval.authority);
     if (seen.has(approval.approvalId)) invalidRun('approval IDs must be unique');
     seen.add(approval.approvalId);
   }
 }
 
 function jsonEqual(left: unknown, right: unknown): boolean {
-  return JSON.stringify(left) === JSON.stringify(right);
+  return canonicalJson(left) === canonicalJson(right);
+}
+
+function canonicalJson(value: unknown): string {
+  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
+  if (value !== null && typeof value === 'object') {
+    return `{${Object.entries(value as Record<string, unknown>)
+      .sort(([left], [right]) => left.localeCompare(right))
+      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
+      .join(',')}}`;
+  }
+  return JSON.stringify(value);
 }
 
 function validateNodes(record: ProductionRunRecordV1): void {
   for (const node of record.nodes) {
     validateOpaque(node.nodeId, 'node id');
     validateSafeString(node.type, 'node type');
     validateSafeString(node.category, 'node category');
     validateSafeString(node.state, 'node state');
     if (!Number.isSafeInteger(node.attempts) || node.attempts < 0)
       invalidRun('node attempts are invalid');
diff --git a/packages/workflow-engine/src/production-run.test.ts b/packages/workflow-engine/src/production-run.test.ts
index d0a8a41..8677368 100644
--- a/packages/workflow-engine/src/production-run.test.ts
+++ b/packages/workflow-engine/src/production-run.test.ts
@@ -262,29 +262,66 @@ describe('production run records', () => {
     expect(JSON.stringify(first.record)).toContain('"requestPayload":{"private":"diff"}');
 
     const duplicate = recordProductionApprovalResponse(first.record, {
       approvalId: approvalId as string,
       approved: true,
       responseRef: 'approval-response-1',
       authority,
     });
     expect(duplicate).toMatchObject({ ok: true, duplicate: true, record: first.record });
 
+    const duplicateWithReorderedKeys = recordProductionApprovalResponse(first.record, {
+      approvalId: approvalId as string,
+      approved: true,
+      responseRef: 'approval-response-2',
+      response: { nested: { b: 2, a: 1 }, approved: true },
+      authority,
+    });
+    expect(duplicateWithReorderedKeys).toEqual({ ok: false, reason: 'approval-conflict' });
+
     const conflict = recordProductionApprovalResponse(first.record, {
       approvalId: approvalId as string,
       approved: false,
       responseRef: 'approval-response-2',
       authority,
     });
     expect(conflict).toEqual({ ok: false, reason: 'approval-conflict' });
   });
 
+  it('treats reordered response object keys as duplicate approvals', () => {
+    const parked = runProductionCase('run-approval-reordered', () => ({
+      waiting: true,
+      request: { kind: 'approve-render', prompt: 'Approve final?' },
+    }));
+    const approvalId = parked.approvals[0]?.approvalId;
+    if (approvalId === undefined) expect.unreachable('approval should exist');
+
+    const first = recordProductionApprovalResponse(parked, {
+      approvalId,
+      approved: true,
+      responseRef: 'approval-response-reordered',
+      response: { approved: true, nested: { a: 1, b: 2 } },
+      authority,
+    });
+    expect(first).toMatchObject({ ok: true, duplicate: false });
+    if (!first.ok) expect.unreachable('first approval should apply');
+
+    const duplicate = recordProductionApprovalResponse(first.record, {
+      approvalId,
+      approved: true,
+      responseRef: 'approval-response-reordered',
+      response: { nested: { b: 2, a: 1 }, approved: true },
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
index 83fa726..65ce81b 100644
--- a/packages/workflow-engine/src/production-run.ts
+++ b/packages/workflow-engine/src/production-run.ts
@@ -549,21 +549,32 @@ function mergeProductionApprovals(
 ): readonly ProductionApprovalV1[] {
   const nextById = new Map(next.map((approval) => [approval.approvalId, approval]));
   const merged = current.map((approval) =>
     approval.state === 'pending' ? (nextById.get(approval.approvalId) ?? approval) : approval,
   );
   const currentIds = new Set(current.map((approval) => approval.approvalId));
   return [...merged, ...next.filter((approval) => !currentIds.has(approval.approvalId))];
 }
 
 function jsonEqual(left: unknown, right: unknown): boolean {
-  return JSON.stringify(left) === JSON.stringify(right);
+  return canonicalJson(left) === canonicalJson(right);
+}
+
+function canonicalJson(value: unknown): string {
+  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
+  if (value !== null && typeof value === 'object') {
+    return `{${Object.entries(value as Record<string, unknown>)
+      .sort(([left], [right]) => left.localeCompare(right))
+      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
+      .join(',')}}`;
+  }
+  return JSON.stringify(value);
 }
 
 function createProductionRunEvent(
   seq: number,
   input: AppendProductionRunEventInput,
   fallbackCheckpointRevision: number,
 ): ProductionRunEventV1 {
   return {
     eventVersion: PRODUCTION_RUN_EVENT_VERSION,
     seq,
