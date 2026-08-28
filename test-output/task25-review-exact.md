# Review package: 359e294..5afae4e

## Commits
5afae4e feat(workflows): ship production pipeline packs

## Files changed
 apps/editor-web/src/WorkflowsPanel.tsx             |  27 +-
 apps/editor-web/src/first-party-handlers.ts        |  54 ++
 apps/editor-web/src/first-party-workflows.ts       |  16 +
 apps/editor-web/src/workflow-runner.test.ts        |  48 +-
 apps/editor-web/src/workflow-runner.ts             |  27 +-
 .../src/wp17-first-party-live-gate.test.ts         |  64 +-
 docs/workflows/PIPELINE-PACKS.md                   |  31 +
 packages/workflow-engine/src/authoring.ts          |   1 +
 packages/workflow-engine/src/first-party.test.ts   | 330 ++++++--
 packages/workflow-engine/src/first-party.ts        | 885 +++++++++++++++------
 packages/workflow-engine/src/index.ts              |  10 +-
 packages/workflow-engine/src/library.ts            | 271 +++++++
 .../workflows/interview-documentary-assembly.json  | 589 ++++++++++++++
 .../workflows/long-video-draft-reels.json          | 401 +++++++++-
 .../workflows/multilingual-promo.json              | 401 +++++++++-
 .../workflow-engine/workflows/podcast-cleanup.json | 448 +++++++++--
 .../workflows/reference-social-cutdown.json        | 533 +++++++++++++
 17 files changed, 3657 insertions(+), 479 deletions(-)

## Diff
diff --git a/apps/editor-web/src/WorkflowsPanel.tsx b/apps/editor-web/src/WorkflowsPanel.tsx
index 30c0753..1f43345 100644
--- a/apps/editor-web/src/WorkflowsPanel.tsx
+++ b/apps/editor-web/src/WorkflowsPanel.tsx
@@ -69,31 +69,35 @@ export function parametersFromSchema(
         defaultValue = selectedClip.clip.startUs;
       else if (name === 'clipDurationUs' && selectedClip !== undefined)
         defaultValue = selectedClip.clip.durationUs;
       else if (name === 'clipSourceInUs') defaultValue = 0;
       else if (name === 'atUs' || name === 'newStartUs') defaultValue = playheadUs;
       else if (name === 'newEndUs' && selectedClip !== undefined)
         defaultValue = selectedClip.clip.startUs + selectedClip.clip.durationUs;
       else if (name === 'newClipId' && selectedClip !== undefined)
         defaultValue = `${selectedClip.clip.id}-split-${selectedClip.clip.startUs}`;
       else if (name === 'asset' || name === 'assetId') defaultValue = 'asset-demo-1';
+      else if (name === 'selectedMedia') defaultValue = 'asset-demo-1';
+      else if (name === 'brief') defaultValue = 'Create a polished edit from the selected media.';
     }
     const schemaType = propertySchema.type;
     const type: 'string' | 'number' =
       schemaType === 'number' || schemaType === 'integer' ? 'number' : 'string';
     return {
       name: name === 'asset' ? 'assetId' : name,
       type,
       description:
         name === 'asset'
           ? ((propertySchema.description as string | undefined) ?? 'Opaque source video asset id')
-          : ((propertySchema.description as string | undefined) ?? name),
+          : name === 'selectedMedia'
+            ? 'Selected media asset id'
+            : ((propertySchema.description as string | undefined) ?? name),
       default: defaultValue,
     };
   });
 }
 
 export function WorkflowsPanel({
   session,
   selectedClipIds,
   playheadUs,
   onRun,
@@ -157,21 +161,21 @@ export function WorkflowsPanel({
           : { approvalRequestedSeq: outcome.approvalRequestedSeq }),
         ...(outcome.approvalExpiresAtSeq === undefined
           ? {}
           : { approvalExpiresAtSeq: outcome.approvalExpiresAtSeq }),
       });
       setStatusMessage(`Awaiting approval: ${outcome.request.kind}`);
       return;
     }
     setApproval(undefined);
     if (outcome.status === 'succeeded') {
-      setStatusMessage(`Workflow ${outcome.workflowId} finished.`);
+      setStatusMessage(`Workflow ${outcome.workflowId} finished; manifest output is recorded.`);
       return;
     }
     setStatusMessage(`Workflow run failed: ${outcome.error}`);
   }
 
   function openRunModal(workflowId: string) {
     const recorded = loadWorkflow(session, workflowId);
     let schema: Record<string, unknown>;
     if (recorded !== undefined) {
       schema = extractWorkflowInputs(recorded.workflow.nodes);
@@ -270,40 +274,47 @@ export function WorkflowsPanel({
     );
   }
 
   function renderSystemRow(entry: {
     readonly workflow: {
       readonly id: string;
       readonly name: string;
       readonly version: string;
       readonly inputs: Record<string, unknown>;
     };
+    readonly label: string;
+    readonly summary: string;
+    readonly requiredPorts: readonly string[];
+    readonly approvals: readonly string[];
   }) {
     const properties =
       (entry.workflow.inputs.properties as Record<string, unknown> | undefined) ?? {};
     const hasInputs = Object.keys(properties).length > 0;
     return (
       <li key={entry.workflow.id} className="workflow-row">
         <div className="workflow-row-main">
           <strong>{entry.workflow.name}</strong>
-          <span>v{entry.workflow.version}</span>
+          <span>
+            {entry.label} · v{entry.workflow.version} · {entry.requiredPorts.length} required ports
+          </span>
+          <span title={entry.approvals.join(', ')}>{entry.summary}</span>
         </div>
         <div className="workflow-row-actions">
           <button
             className="icon-button"
             onClick={() =>
               hasInputs
                 ? openRunModal(entry.workflow.id)
                 : void onRun(entry.workflow.id, {}).then(applyOutcome)
             }
             aria-label={`Run ${entry.workflow.name}`}
-            title={`Run with inputs`}
+            title="Start production workflow run"
           >
             <PlayIcon />
           </button>
         </div>
       </li>
     );
   }
 
   const isEmpty = workflows.length === 0 && systemWorkflows.length === 0;
 
@@ -367,37 +378,37 @@ export function WorkflowsPanel({
             </button>
           </div>
         </div>
       )}
 
       {approval !== undefined && (
         <div className="workflow-run-modal" role="dialog" aria-label="Workflow approval">
           <ContactSheetApproval
             key={`${approval.runId}:${approval.nodeId}:${approval.approvalId ?? 'local'}`}
             request={approval.request}
-            approvalId={approval.approvalId}
             storageKey={`${approval.runId}:${approval.nodeId}:${approval.approvalId ?? 'local'}`}
-            storage={typeof window === 'undefined' ? undefined : window.localStorage}
+            {...(approval.approvalId === undefined ? {} : { approvalId: approval.approvalId })}
+            {...(typeof window === 'undefined' ? {} : { storage: window.localStorage })}
             onSubmit={(decision) => void submitApprovalDecision(decision)}
             onDismiss={() => setApproval(undefined)}
           />
         </div>
       )}
 
       {tab === 'saved' && (
         <ul className="workflow-list">{workflows.map((wf) => renderRecordedRow(wf))}</ul>
       )}
 
       {tab === 'system' && (
         <>
           <div className="workflow-section-header">
-            <h4>Bundled with JOY Media</h4>
-            <span className="system-version-badge" title="FIRST_PARTY_WORKFLOWS_VERSION">
+            <h4>Production pipeline packs</h4>
+            <span className="system-version-badge" title="First-party production pack version">
               v{systemWorkflowVersion}
             </span>
           </div>
           <ul className="workflow-list">{systemWorkflows.map((wf) => renderSystemRow(wf))}</ul>
         </>
       )}
     </PanelShell>
   );
 }
diff --git a/apps/editor-web/src/first-party-handlers.ts b/apps/editor-web/src/first-party-handlers.ts
index 49ba30a..cf72035 100644
--- a/apps/editor-web/src/first-party-handlers.ts
+++ b/apps/editor-web/src/first-party-handlers.ts
@@ -68,20 +68,27 @@ export function createProductionFirstPartyLibrary(): NodeLibrary {
   return buildNodeLibrary();
 }
 
 /** Build a NodeLibrary whose ports are deterministic fixtures suitable for tests. */
 export function createFixtureFirstPartyLibrary(): NodeLibrary {
   let branchSeq = 0;
 
   return buildNodeLibrary({
     ports: {
       analysis: {
+        researchBrief: (args: { readonly brief: unknown; readonly media: unknown }) => ({
+          researchRef: 'fixture-research-brief',
+          brief: args.brief,
+          media: args.media,
+          providerRefs: ['fixture:research'],
+          ...fixtureNote('Fixture research notes for workflow tests; no provider call was made'),
+        }),
         transcribe: () => ({
           language: 'fa',
           segments: [{ text: 'Hello and welcome', startUs: 0 }],
           ...fixtureNote(
             'Fixture transcript for workflow park/resume; use Captions Auto caption for live Whisper',
           ),
         }),
         detectSilence: (args: {
           readonly source: unknown;
           readonly thresholdDb?: number;
@@ -272,20 +279,34 @@ export function createFixtureFirstPartyLibrary(): NodeLibrary {
           readonly templateId: string;
           readonly variables: unknown;
         }) => ({
           sceneInstance: args.templateId,
           variables: args.variables,
           applied: false,
           deferred: true,
           reason:
             'Scene templates are built via html-scene objects in the editor, not silently in this step.',
         }),
+        buildContactSheet: (args: { readonly title: string; readonly candidates: unknown }) => {
+          const candidates =
+            args.candidates !== null &&
+            typeof args.candidates === 'object' &&
+            Array.isArray((args.candidates as { readonly candidates?: unknown }).candidates)
+              ? (args.candidates as { readonly candidates: readonly unknown[] }).candidates
+              : args.candidates;
+          return {
+            title: args.title,
+            candidates,
+            contactSheetRef: 'fixture-contact-sheet',
+            ...fixtureNote('Fixture contact sheet for approval UI; not a rendered review sheet'),
+          };
+        },
       },
       generation: {
         synthesizeSpeech: (args: {
           readonly text: string;
           readonly voiceId: string;
           readonly language?: string;
           readonly engine?: 'edge-tts' | 'piper';
         }) => {
           const language = args.language ?? 'en';
           const engine = args.engine === 'piper' ? 'piper' : 'edge-tts';
@@ -319,52 +340,85 @@ export function createFixtureFirstPartyLibrary(): NodeLibrary {
           };
         },
         translate: (args: { readonly text: string; readonly targetLanguage: string }) => ({
           text: args.text,
           targetLanguage: args.targetLanguage,
           translated: false,
           deferred: true,
           reason:
             'Translation needs a provider gateway; the browser runner does not invent translated text.',
         }),
+        generateScript: (args: { readonly brief: unknown }) => ({
+          scriptRef: 'fixture-script',
+          text: `Fixture script from brief: ${String(args.brief)}`,
+          ...fixtureNote('Fixture script for workflow tests; no LLM provider was called'),
+        }),
+        generateShotlist: () => ({
+          shots: [{ id: 'fixture-shot-1', sourceRef: 'selected-media' }],
+          ...fixtureNote('Fixture shot list for workflow tests; no shot planner was called'),
+        }),
       },
       editor: {
+        executeCommandTransaction: (args: {
+          readonly label: string;
+          readonly commands: readonly unknown[];
+        }) => ({
+          transactionId: `fixture-${args.label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`,
+          commands: args.commands,
+          applied: false,
+          deferredToEditor: true,
+          ...fixtureNote('Fixture command transaction; editor command bus is not mutated here'),
+        }),
         createBranch: (args: { readonly name: string; readonly source: unknown }) => {
           branchSeq += 1;
           return {
             branchId: `deferred-branch-${String(branchSeq)}`,
             name: args.name,
             source: args.source,
             applied: false,
             deferredToEditor: true,
             note: 'In-memory branch IDs are for workflow continuity only; duplicate clips in the editor for real variants.',
           };
         },
       },
       render: {
         render: (args: { readonly mode: 'preview' | 'final'; readonly profile?: string }) => ({
           rendered: false,
           deferred: true,
           mode: args.mode,
           profile: args.profile ?? 'social-h264-aac',
           reason: 'Use the editor Export with an output preset; Worker encoding is not wired yet.',
         }),
+        inspect: (args: { readonly reportRef?: string }) => ({
+          reportRef: args.reportRef ?? 'fixture-render-report',
+          findings: [{ code: 'fixture-inspection', status: 'pass' }],
+          ...fixtureNote('Fixture QA report; no bounded render inspection was run'),
+        }),
       },
       output: {
         writeToFolder: (args: { readonly folderId: string }) => ({
           written: false,
           deferred: true,
           folderId: args.folderId,
           reason: 'The browser runner cannot write host folders; use Export or Jobs.',
         }),
         writeMetadataFile: (args: { readonly fileName: string }) => ({
           written: false,
           deferred: true,
           fileName: args.fileName,
           inMemoryManifest: true,
           reason:
             'The manifest stays in the workflow output; the browser runner does not write the host filesystem.',
         }),
+        writeDeliveryManifest: (args: { readonly fileName: string }) => ({
+          written: false,
+          deferred: true,
+          fileName: args.fileName,
+          inMemoryManifest: true,
+          deliveryRef: `fixture-delivery:${args.fileName}`,
+          reason:
+            'The delivery manifest stays in workflow output; the browser runner does not write the host filesystem.',
+        }),
       },
     },
   });
 }
diff --git a/apps/editor-web/src/first-party-workflows.ts b/apps/editor-web/src/first-party-workflows.ts
index 8cdbe05..cf172f9 100644
--- a/apps/editor-web/src/first-party-workflows.ts
+++ b/apps/editor-web/src/first-party-workflows.ts
@@ -1,42 +1,58 @@
 // apps/editor-web/src/first-party-workflows.ts
 
 import {
+  buildFirstPartyPipelinePacks,
   buildFirstPartyWorkflows,
   firstPartyDefinitionFiles,
   FIRST_PARTY_WORKFLOWS_VERSION,
   FIRST_PARTY_WORKFLOW_IDS,
 } from '@joy-media/workflow-engine';
 import type { JoyWorkflow } from '@joy-media/workflow-engine';
 import type { RecordedWorkflow } from './workflow-recorder.js';
 
 /**
  * First-party workflows loaded from `@joy-media/workflow-engine` (D-W17-1a:
  * bundled via the workspace package — same artifact the CLI/tests pin).
  */
 
 export interface FirstPartyWorkflow {
   readonly workflow: JoyWorkflow;
   readonly fileName: string;
+  readonly label: string;
+  readonly summary: string;
+  readonly requiredPorts: readonly string[];
+  readonly optionalPorts: readonly string[];
+  readonly capabilities: readonly string[];
+  readonly approvals: readonly string[];
+  readonly reportRefs: readonly string[];
 }
 
 let cachedWorkflows: readonly FirstPartyWorkflow[] | undefined;
 
 export function loadFirstPartyWorkflows(): readonly FirstPartyWorkflow[] {
   if (cachedWorkflows !== undefined) return cachedWorkflows;
 
+  const packs = buildFirstPartyPipelinePacks();
   const builtWorkflows = buildFirstPartyWorkflows();
   const definitionFiles = firstPartyDefinitionFiles();
 
   cachedWorkflows = builtWorkflows.map((built, index) => ({
     workflow: built.workflow,
     fileName: definitionFiles[index]?.fileName ?? `${built.workflow.id}.json`,
+    label: packs[index]?.label ?? 'Production pack',
+    summary: packs[index]?.summary ?? built.workflow.name,
+    requiredPorts: packs[index]?.requiredPorts ?? [],
+    optionalPorts: packs[index]?.optionalPorts ?? [],
+    capabilities: packs[index]?.capabilities ?? built.workflow.permissions.map((p) => p.capability),
+    approvals: packs[index]?.approvals ?? [],
+    reportRefs: packs[index]?.reportRefs ?? [],
   }));
 
   return cachedWorkflows;
 }
 
 export function getFirstPartyWorkflow(workflowId: string): FirstPartyWorkflow | undefined {
   return loadFirstPartyWorkflows().find((entry) => entry.workflow.id === workflowId);
 }
 
 export function getFirstPartyWorkflowVersion(): string {
diff --git a/apps/editor-web/src/workflow-runner.test.ts b/apps/editor-web/src/workflow-runner.test.ts
index f9449e3..fd8ef9e 100644
--- a/apps/editor-web/src/workflow-runner.test.ts
+++ b/apps/editor-web/src/workflow-runner.test.ts
@@ -170,61 +170,64 @@ describe('workflow-runner', () => {
       'joy.first-party.long-video-draft-reels',
       { assetId: 'asset-long-1' },
       {
         productionRunStore: firstStore,
         authority: owner,
         firstPartyLibrary: countedLibrary(createFixtureFirstPartyLibrary(), firstCounts),
       },
     );
     expect(first.status).toBe('waiting_for_input');
     if (first.status !== 'waiting_for_input') return;
-    expect(firstCounts['analysis.transcribe']).toBe(1);
+    expect(first.nodeId).toBe('confirm-cost');
+    expect(firstCounts['analysis.researchBrief']).toBe(1);
+    expect(firstCounts['generation.script']).toBe(1);
     expect(firstCounts['analysis.hooks']).toBe(1);
 
     const serialized = JSON.stringify(await firstStore.load(first.runId));
     const revivedStore = productionRunStore(storage, session.timelineProject.id);
     const revived = await revivedStore.load(first.runId);
     expect(revived).toMatchObject({
       state: 'parked',
       checkpointRevision: 1,
       workflowInputs: { assetId: 'asset-long-1' },
       checkpoint: {
         nodes: {
-          transcribe: { state: 'succeeded', output: expect.any(Object) },
-          hooks: { state: 'succeeded', output: expect.any(Object) },
+          research: { state: 'succeeded', output: expect.any(Object) },
+          script: { state: 'succeeded', output: expect.any(Object) },
+          candidates: { state: 'succeeded', output: expect.any(Object) },
         },
       },
-      approvals: [{ nodeId: 'approve-candidates', state: 'pending' }],
+      approvals: [{ nodeId: 'confirm-cost', state: 'pending' }],
     });
     expect(serialized).toContain('"workflowInputs"');
 
-    const payload = first.request.payload as { candidates: readonly { title: string }[] };
     const secondCounts: Record<string, number> = {};
     const second = await resumeWorkflow(
       session,
       first.runId,
-      { 'approve-candidates': { candidates: payload.candidates.slice(0, 2) } },
+      { 'confirm-cost': { approved: true, approvalRef: 'cost-ok' } },
       {
         productionRunStore: revivedStore,
         authority: owner,
         firstPartyLibrary: countedLibrary(createFixtureFirstPartyLibrary(), secondCounts),
         ...approvalResumeOptions(first),
       },
     );
     expect(second.status).toBe('waiting_for_input');
-    expect(secondCounts['analysis.transcribe'] ?? 0).toBe(0);
+    expect(second).toMatchObject({ nodeId: 'approve-candidates' });
+    expect(secondCounts['generation.script'] ?? 0).toBe(0);
     expect(secondCounts['analysis.hooks'] ?? 0).toBe(0);
     await expect(revivedStore.load(first.runId)).resolves.toMatchObject({
       checkpointRevision: 2,
       approvals: [
-        { nodeId: 'approve-candidates', state: 'approved' },
-        { nodeId: 'approve-drafts', state: 'pending' },
+        { nodeId: 'confirm-cost', state: 'approved' },
+        { nodeId: 'approve-candidates', state: 'pending' },
       ],
     });
   });
 
   it('rejects stale two-tab checkpoint updates after another runner advances the run', async () => {
     const storage = memoryStorage();
     const session = new EditorSession(
       storage,
       buildReferenceSpikeProject(),
       INITIAL_EDITOR_PROJECT,
@@ -239,27 +242,26 @@ describe('workflow-runner', () => {
       session,
       'joy.first-party.long-video-draft-reels',
       { assetId: 'asset-long-1' },
       options,
     );
     expect(first.status).toBe('waiting_for_input');
     if (first.status !== 'waiting_for_input') return;
     const staleSnapshot = await store.load(first.runId);
     if (staleSnapshot === undefined) expect.unreachable('run should be persisted');
 
-    const payload = first.request.payload as { candidates: readonly { title: string }[] };
-    const humanInputs = { 'approve-candidates': { candidates: payload.candidates.slice(0, 1) } };
+    const humanInputs = { 'confirm-cost': { approved: true, approvalRef: 'cost-ok' } };
     const current = await resumeWorkflow(session, first.runId, humanInputs, {
       ...options,
       ...approvalResumeOptions(first),
     });
-    expect(current.status).toBe('waiting_for_input');
+    expect(current).toMatchObject({ status: 'waiting_for_input', nodeId: 'approve-candidates' });
 
     const staleStore: ProductionRunStore = {
       load: async () => staleSnapshot,
       create: (record) => store.create(record),
       compareAndSwapCheckpoint: (update) => store.compareAndSwapCheckpoint(update),
       recordApprovalResponse: async () => ({
         ok: true,
         duplicate: false,
         record: staleSnapshot,
       }),
@@ -290,43 +292,42 @@ describe('workflow-runner', () => {
     } as const;
     const first = await runWorkflow(
       session,
       'joy.first-party.long-video-draft-reels',
       { assetId: 'asset-long-1' },
       options,
     );
     expect(first.status).toBe('waiting_for_input');
     if (first.status !== 'waiting_for_input') return;
 
-    const payload = first.request.payload as { candidates: readonly { title: string }[] };
-    const humanInputs = { 'approve-candidates': { candidates: payload.candidates.slice(0, 1) } };
+    const humanInputs = { 'confirm-cost': { approved: true, approvalRef: 'cost-ok' } };
     const current = await resumeWorkflow(session, first.runId, humanInputs, {
       ...options,
       ...approvalResumeOptions(first),
     });
     expect(current).toMatchObject({
       status: 'waiting_for_input',
-      nodeId: 'approve-drafts',
+      nodeId: 'approve-candidates',
     });
 
     const stale = await resumeWorkflow(session, first.runId, humanInputs, {
       ...options,
       ...approvalResumeOptions(first),
     });
     expect(stale).toMatchObject({
       status: 'failed',
       error: expect.stringContaining('approval-conflict'),
     });
     await expect(store.load(first.runId)).resolves.toMatchObject({
       approvals: [
-        { nodeId: 'approve-candidates', state: 'approved' },
-        { nodeId: 'approve-drafts', state: 'pending' },
+        { nodeId: 'confirm-cost', state: 'approved' },
+        { nodeId: 'approve-candidates', state: 'pending' },
       ],
     });
   });
 
   it('does not resume canceled or expired parked approval requests', async () => {
     const storage = memoryStorage();
     const session = new EditorSession(
       storage,
       buildReferenceSpikeProject(),
       INITIAL_EDITOR_PROJECT,
@@ -348,40 +349,40 @@ describe('workflow-runner', () => {
     if (canceled.status !== 'waiting_for_input') return;
     const canceledRecord = await store.load(canceled.runId);
     if (canceledRecord === undefined) expect.unreachable('run should be persisted');
     await store.cancel(canceled.runId, {
       authority: owner,
       expectedUpdatedSeq: canceledRecord.updatedSeq,
     });
     const afterCancel = await resumeWorkflow(
       session,
       canceled.runId,
-      { 'approve-candidates': { candidates: [] } },
+      { 'confirm-cost': { approved: true } },
       options,
     );
     expect(afterCancel).toMatchObject({
       status: 'failed',
       error: expect.stringContaining('canceled'),
     });
 
     const expired = await runWorkflow(
       session,
       'joy.first-party.long-video-draft-reels',
       { assetId: 'asset-long-2' },
       options,
     );
     expect(expired.status).toBe('waiting_for_input');
     if (expired.status !== 'waiting_for_input') return;
     const expiredResult = await resumeWorkflow(
       session,
       expired.runId,
-      { 'approve-candidates': { candidates: [] } },
+      { 'confirm-cost': { approved: true } },
       {
         ...options,
         ...approvalResumeOptions(expired),
         approvalExpiresAtSeq: Math.max(0, (expired.approvalExpiresAtSeq ?? 0) - 1),
       },
     );
     expect(expiredResult).toMatchObject({
       status: 'failed',
       error: expect.stringContaining('approval-expired'),
     });
@@ -431,31 +432,32 @@ describe('workflow-runner', () => {
       'joy.first-party.long-video-draft-reels',
       { assetId: 'asset-long-1' },
       {
         productionRunStore: store,
         authority: owner,
         firstPartyLibrary: createProductionFirstPartyLibrary(),
       },
     );
     expect(result).toMatchObject({
       status: 'failed',
-      error: expect.stringContaining('workflow/port-unavailable:analysis.transcribe'),
+      error: expect.stringContaining('workflow/port-unavailable:analysis.researchBrief'),
     });
     const record = await store.load(result.runId);
     expect(record?.state).toBe('failed');
     expect(record?.nodes).toEqual(
       expect.arrayContaining([
-        expect.objectContaining({ nodeId: 'ingest', state: 'succeeded' }),
+        expect.objectContaining({ nodeId: 'brief', state: 'succeeded' }),
+        expect.objectContaining({ nodeId: 'selected-media', state: 'succeeded' }),
         expect.objectContaining({
-          nodeId: 'transcribe',
+          nodeId: 'research',
           state: 'failed',
-          failureCode: 'workflow/port-unavailable:analysis.transcribe',
+          failureCode: 'workflow/port-unavailable:analysis.researchBrief',
         }),
       ]),
     );
 
     const library = createProductionFirstPartyLibrary();
     const portUnavailableCases = [
       {
         type: 'analysis.silence',
         category: 'analysis',
         failureCode: 'workflow/port-unavailable:analysis.detectSilence',
diff --git a/apps/editor-web/src/workflow-runner.ts b/apps/editor-web/src/workflow-runner.ts
index 6b2b6e8..998f45f 100644
--- a/apps/editor-web/src/workflow-runner.ts
+++ b/apps/editor-web/src/workflow-runner.ts
@@ -181,32 +181,46 @@ function resolveWorkflow(session: EditorSession, workflowId: string): JoyWorkflo
     return system.workflow;
   }
   throw new Error(`Workflow not found: ${workflowId}`);
 }
 
 /** Normalize editor modal inputs into the first-party workflow input shape. */
 export function normalizeFirstPartyInputs(
   workflow: JoyWorkflow,
   inputs: Readonly<Record<string, unknown>>,
 ): unknown {
+  const normalized: Record<string, unknown> = { ...inputs };
+  if (normalized.brief === undefined || normalized.brief === '') {
+    normalized.brief = 'Create a polished, on-brand edit from the selected media.';
+  }
+  if (
+    normalized.selectedMedia === undefined &&
+    typeof normalized.assetId === 'string' &&
+    normalized.assetId.trim() !== ''
+  ) {
+    normalized.selectedMedia = { assetId: normalized.assetId };
+  }
+  if (typeof normalized.selectedMedia === 'string' && normalized.selectedMedia.trim() !== '') {
+    normalized.selectedMedia = { assetId: normalized.selectedMedia };
+  }
   const required = (workflow.inputs.required as string[] | undefined) ?? [];
   if (
     required.includes('asset') &&
-    inputs.asset === undefined &&
-    typeof inputs.assetId === 'string'
+    normalized.asset === undefined &&
+    typeof normalized.assetId === 'string'
   ) {
-    return { ...inputs, asset: { assetId: inputs.assetId, fixture: true } };
+    normalized.asset = { assetId: normalized.assetId };
   }
-  if (typeof inputs.asset === 'string') {
-    return { ...inputs, asset: { assetId: inputs.asset, fixture: true } };
+  if (typeof normalized.asset === 'string') {
+    normalized.asset = { assetId: normalized.asset };
   }
-  return inputs;
+  return normalized;
 }
 
 function findPendingApproval(checkpoint: RunCheckpoint):
   | {
       readonly nodeId: string;
       readonly request: HumanInputRequest;
     }
   | undefined {
   for (const [nodeId, record] of Object.entries(checkpoint.nodes)) {
     if (record.state === 'waiting_for_input' && record.pendingRequest !== undefined) {
@@ -403,20 +417,21 @@ async function executeAndPersistFirstPartyWorkflow(
     readonly humanInputs?: Readonly<Record<string, unknown>>;
   },
 ): Promise<WorkflowRunOutcome> {
   const recorder = new RunRecorder();
   const result = executeWorkflow({
     workflow,
     runId,
     projectRevision,
     workflowInputs,
     handlers: instrumentHandlers(options.library.handlers, recorder),
+    reuseNondeterministic: true,
     ...(options.resumeFrom !== undefined ? { resumeFrom: options.resumeFrom } : {}),
     ...(options.humanInputs !== undefined ? { humanInputs: options.humanInputs } : {}),
   });
   const checkpointRecord = checkpointRecordFor(workflow, result, recorder, authority);
   const update = await store.compareAndSwapCheckpoint({
     runId,
     expectedRevision: options.expectedRevision,
     checkpoint: result.checkpoint,
     dashboard: boardRunFor(checkpointRecord),
     authority,
diff --git a/apps/editor-web/src/wp17-first-party-live-gate.test.ts b/apps/editor-web/src/wp17-first-party-live-gate.test.ts
index ea0ef07..9137e81 100644
--- a/apps/editor-web/src/wp17-first-party-live-gate.test.ts
+++ b/apps/editor-web/src/wp17-first-party-live-gate.test.ts
@@ -17,24 +17,26 @@ import {
   runWorkflow,
 } from './workflow-runner.js';
 import { BrowserProductionRunStore } from './browser-production-run-store.js';
 import { createFixtureFirstPartyLibrary } from './first-party-handlers.js';
 
 afterEach(() => {
   resetFirstPartyLibraryForTests();
 });
 
 describe('WP-17 first-party workflows', () => {
-  it('loads the three system workflows at the pinned version', () => {
+  it('loads the production pipeline packs at the pinned version', () => {
     const loaded = loadFirstPartyWorkflows();
     expect(loaded.map((entry) => entry.workflow.id)).toEqual([...FIRST_PARTY_WORKFLOW_IDS]);
-    expect(getFirstPartyWorkflowVersion()).toBe('1.0.0');
+    expect(loaded).toHaveLength(5);
+    expect(loaded.every((entry) => entry.label === 'Production pack')).toBe(true);
+    expect(getFirstPartyWorkflowVersion()).toBe('2.0.0');
   });
 
   it('detects derived-from lineage on recorded workflows only', () => {
     const storage = new Map<string, string>();
     const session = new EditorSession(
       {
         getItem: (key) => storage.get(key) ?? null,
         setItem: (key, value) => storage.set(key, value),
       },
       buildReferenceSpikeProject(),
@@ -55,27 +57,28 @@ describe('WP-17 first-party workflows', () => {
       session,
       createPlan('Teach long video draft reels caption step', [step]),
     );
     expect(detectDerivedFrom(recorded)).toBe('joy.first-party.long-video-draft-reels');
   });
 
   it('normalizes assetId modal input into the first-party asset object', () => {
     const workflow = loadFirstPartyWorkflows()[0]?.workflow;
     expect(workflow).toBeDefined();
     if (workflow === undefined) return;
-    expect(normalizeFirstPartyInputs(workflow, { assetId: 'asset-long-1' })).toEqual({
+    expect(normalizeFirstPartyInputs(workflow, { assetId: 'asset-long-1' })).toMatchObject({
       assetId: 'asset-long-1',
-      asset: { assetId: 'asset-long-1', fixture: true },
+      brief: 'Create a polished, on-brand edit from the selected media.',
+      selectedMedia: { assetId: 'asset-long-1' },
     });
   });
 
-  it('runs long-video→draft-reels with stubs, parks, resumes, and produces a manifest', async () => {
+  it('runs long-video→draft-reels with explicit fixtures, parks, resumes, and produces a manifest', async () => {
     const storage = new Map<string, string>();
     const session = new EditorSession(
       {
         getItem: (key) => storage.get(key) ?? null,
         setItem: (key, value) => storage.set(key, value),
       },
       buildReferenceSpikeProject(),
       INITIAL_EDITOR_PROJECT,
     );
     const runStore = new BrowserProductionRunStore(
@@ -98,55 +101,76 @@ describe('WP-17 first-party workflows', () => {
       session,
       'joy.first-party.long-video-draft-reels',
       {
         assetId: 'asset-long-1',
       },
       runnerOptions,
     );
     expect(first.status).toBe('waiting_for_input');
     if (first.status !== 'waiting_for_input') return;
 
-    expect(first.request.kind).toBe('choose-candidates');
-    const payload = first.request.payload as { candidates: readonly { title: string }[] };
-    expect(payload.candidates.map((candidate) => candidate.title)).toEqual([
-      'Hook A',
-      'Hook B',
-      'Hook C',
-    ]);
+    expect(first.request.kind).toBe('confirm-cost');
     await expect(runStore.load(first.runId)).resolves.toMatchObject({
       state: 'parked',
       checkpointRevision: 1,
-      approvals: [{ nodeId: 'approve-candidates', state: 'pending' }],
+      approvals: [{ nodeId: 'confirm-cost', state: 'pending' }],
     });
 
     const second = await resumeWorkflow(
       session,
       first.runId,
       {
-        'approve-candidates': { candidates: payload.candidates.slice(0, 2) },
+        'confirm-cost': { approved: true, approvalRef: 'cost-ok' },
       },
       runnerOptions,
     );
     expect(second.status).toBe('waiting_for_input');
     if (second.status !== 'waiting_for_input') return;
-    expect(second.request.kind).toBe('approve-render');
-    expect(second.nodeId).toBe('approve-drafts');
+    expect(second.nodeId).toBe('approve-candidates');
+    expect(second.request.kind).toBe('choose-candidates');
+    const payload = second.request.payload as { candidates: readonly { title: string }[] };
+    expect(payload.candidates.map((candidate) => candidate.title)).toEqual([
+      'Hook A',
+      'Hook B',
+      'Hook C',
+    ]);
+    await expect(runStore.load(first.runId)).resolves.toMatchObject({
+      state: 'parked',
+      checkpointRevision: 2,
+      approvals: [
+        { nodeId: 'confirm-cost', state: 'approved' },
+        { nodeId: 'approve-candidates', state: 'pending' },
+      ],
+    });
 
-    const draftPayload = second.request.payload as { items: readonly unknown[] };
     const third = await resumeWorkflow(
       session,
       second.runId,
+      {
+        'approve-candidates': { candidates: payload.candidates.slice(0, 2) },
+      },
+      runnerOptions,
+    );
+    expect(third.status).toBe('waiting_for_input');
+    if (third.status !== 'waiting_for_input') return;
+    expect(third.request.kind).toBe('approve-render');
+    expect(third.nodeId).toBe('approve-drafts');
+
+    const draftPayload = third.request.payload as { items: readonly unknown[] };
+    const fourth = await resumeWorkflow(
+      session,
+      third.runId,
       {
         'approve-drafts': { approved: draftPayload.items },
       },
       runnerOptions,
     );
-    expect(third.status).toBe('succeeded');
-    if (third.status !== 'succeeded') return;
-    expect(third.outputs).toMatchObject({
+    expect(fourth.status).toBe('succeeded');
+    if (fourth.status !== 'succeeded') return;
+    expect(fourth.outputs).toMatchObject({
       written: false,
       deferred: true,
       fileName: 'long-video-draft-reels-run.json',
       inMemoryManifest: true,
     });
   });
 });
diff --git a/docs/workflows/PIPELINE-PACKS.md b/docs/workflows/PIPELINE-PACKS.md
new file mode 100644
index 0000000..7981de7
--- /dev/null
+++ b/docs/workflows/PIPELINE-PACKS.md
@@ -0,0 +1,31 @@
+# Production Pipeline Packs
+
+JOY Media first-party workflows shown in the editor System tab are production pipeline packs, not demo success paths.
+
+Each pack starts from a creative `brief` and `selectedMedia`, then runs research, script, shot-list, candidates, contact-sheet review, cost approval, editor artifact application, render, QA inspection, and a delivery manifest where the pack requires those stages. Production runs fail closed with `workflow/port-unavailable:*` until the host wires the required API, Worker, provider, render, editor, and output ports.
+
+## Visible Packs
+
+- Long video draft reels
+- Multilingual promo
+- Podcast cleanup
+- Reference social cutdown
+- Interview documentary assembly
+
+## Fixture Boundary
+
+Fixture handlers are explicit test/demo registry entries in `apps/editor-web/src/first-party-handlers.ts`. They return fixture/deferred metadata so UI and tests can exercise parking, approval, resume, artifact, render, inspect, and manifest flow without pretending files were exported or providers ran.
+
+Production construction uses `createProductionFirstPartyLibrary()`, which does not bind fixture ports. Missing ports are non-retryable failures and are visible in the production run record.
+
+## Pack Metadata
+
+Pack metadata is exported by `buildFirstPartyPipelinePacks()` and surfaced by the editor:
+
+- required and optional ports
+- capabilities
+- approval kinds
+- QA/report references
+- pinned JSON definition file
+
+The JSON artifacts in `packages/workflow-engine/workflows/` are generated from the TypeScript builders and pinned by `first-party.test.ts`.
diff --git a/packages/workflow-engine/src/authoring.ts b/packages/workflow-engine/src/authoring.ts
index 771e769..cb63548 100644
--- a/packages/workflow-engine/src/authoring.ts
+++ b/packages/workflow-engine/src/authoring.ts
@@ -24,20 +24,21 @@ export const SUPPORTED_SCHEMA_KEYWORDS: readonly string[] = [
   'additionalProperties',
   'items',
   'enum',
   'const',
   'minimum',
   'maximum',
   'minLength',
   'minItems',
   'description',
   'title',
+  'default',
 ];
 
 const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'] as const;
 
 export interface SchemaIssue {
   /** JSON-pointer-style path into the validated value (or schema for declaration issues). */
   readonly path: string;
   readonly message: string;
 }
 
diff --git a/packages/workflow-engine/src/first-party.test.ts b/packages/workflow-engine/src/first-party.test.ts
index 92f2cfa..85a765a 100644
--- a/packages/workflow-engine/src/first-party.test.ts
+++ b/packages/workflow-engine/src/first-party.test.ts
@@ -1,23 +1,26 @@
 import { describe, expect, it } from 'vitest';
 import { readFileSync } from 'node:fs';
 import { dirname, join } from 'node:path';
 import { fileURLToPath } from 'node:url';
 
 import { WorkflowBuilder, parseWorkflowJson, workflowToJson } from './authoring.js';
 import {
   FIRST_PARTY_WORKFLOWS_VERSION,
   FIRST_PARTY_WORKFLOW_IDS,
+  buildFirstPartyPipelinePacks,
   buildFirstPartyWorkflows,
   buildLongVideoDraftReelsWorkflow,
   buildMultilingualPromoWorkflow,
   buildPodcastCleanupWorkflow,
+  buildInterviewDocumentaryAssemblyWorkflow,
+  buildReferenceSocialCutdownWorkflow,
   firstPartyDefinitionFiles,
 } from './first-party.js';
 import { runWorkflowHeadless } from './headless.js';
 import type { NodeLibrary } from './library.js';
 import { buildNodeLibrary } from './library.js';
 
 // ---------------------------------------------------------------------------
 // Stub environment: every port records its calls and returns deterministic,
 // self-describing values, so tests can assert both wiring and invocation counts
 // (no duplicated completed work across resumes — §36 Phase 7 exit criterion).
@@ -33,20 +36,26 @@ function stubEnvironment() {
       return result(args);
     };
   };
   const count = (name: string): number => calls.get(name)?.length ?? 0;
   const argsOf = (name: string): readonly unknown[] => calls.get(name) ?? [];
 
   let branchSeq = 0;
   const library = buildNodeLibrary({
     ports: {
       analysis: {
+        researchBrief: track('researchBrief', (args: { brief: unknown; media: unknown }) => ({
+          researchRef: 'research-1',
+          brief: args.brief,
+          media: args.media,
+          providerRefs: ['provider:fixture-research'],
+        })),
         transcribe: track('transcribe', () => ({
           language: 'fa',
           segments: [{ text: 'سلام و خوش آمدید', startUs: 0 }],
         })),
         detectSilence: track('detectSilence', () => ({
           ranges: [
             { startUs: 10_000_000, endUs: 12_500_000 },
             { startUs: 40_000_000, endUs: 43_000_000 },
           ],
         })),
@@ -88,82 +97,127 @@ function stubEnvironment() {
             duckMusic: args.duckMusic === true,
           }),
         ),
         instantiateSceneTemplate: track(
           'scene',
           (args: { templateId: string; variables: unknown }) => ({
             sceneInstance: args.templateId,
             variables: args.variables,
           }),
         ),
+        buildContactSheet: track(
+          'contactSheet',
+          (args: { title: string; candidates: unknown }) => ({
+            title: args.title,
+            candidates:
+              args.candidates !== null &&
+              typeof args.candidates === 'object' &&
+              Array.isArray((args.candidates as { candidates?: unknown }).candidates)
+                ? (args.candidates as { candidates: readonly unknown[] }).candidates
+                : args.candidates,
+            contactSheetRef: 'contact-sheet-1',
+          }),
+        ),
       },
       generation: {
         synthesizeSpeech: track('speech', (args: { text: string; voiceId: string }) => ({
           voiceOver: args.text,
           voiceId: args.voiceId,
         })),
         translate: track('translate', (args: { text: string; targetLanguage: string }) => ({
           text: `[${args.targetLanguage}] ${args.text}`,
           targetLanguage: args.targetLanguage,
         })),
+        generateScript: track('script', (args: { brief: unknown }) => ({
+          scriptRef: 'script-1',
+          text: `Script: ${String(args.brief)}`,
+        })),
+        generateShotlist: track('shotlist', () => ({
+          shots: [{ id: 'shot-1', sourceRef: 'asset-long-1' }],
+        })),
       },
       editor: {
+        executeCommandTransaction: (args: {
+          readonly label: string;
+          readonly commands: readonly unknown[];
+        }) => {
+          const list = calls.get('commandTransaction') ?? [];
+          list.push(args);
+          calls.set('commandTransaction', list);
+          return { transactionId: `tx-${args.label.toLowerCase().replaceAll(' ', '-')}` };
+        },
         // Typed by hand: the port's return type is concrete ({branchId}).
         createBranch: (args: { readonly name: string; readonly source: unknown }) => {
           const list = calls.get('createBranch') ?? [];
           list.push(args);
           calls.set('createBranch', list);
           branchSeq += 1;
           return { branchId: `branch-${String(branchSeq)}` };
         },
       },
       render: {
         render: track('render', (args: { mode: 'preview' | 'final'; profile?: string }) => ({
           rendered: args.mode,
           profile: args.profile ?? null,
         })),
+        inspect: track('inspect', (args: { reportRef?: string }) => ({
+          reportRef: args.reportRef ?? 'report-fixture',
+          findings: [{ code: 'fixture-pass', status: 'pass' }],
+        })),
       },
       output: {
         writeToFolder: track('writeToFolder', (args: { folderId: string }) => ({
           written: true,
           folderId: args.folderId,
         })),
         writeMetadataFile: track('writeMetadata', (args: { fileName: string }) => ({
           written: true,
           fileName: args.fileName,
         })),
+        writeDeliveryManifest: track('writeDeliveryManifest', (args: { fileName: string }) => ({
+          written: true,
+          fileName: args.fileName,
+          deliveryRef: `delivery:${args.fileName}`,
+        })),
       },
     },
   });
   return { library, count, argsOf };
 }
 
 const runHeadless = (
   library: NodeLibrary,
   workflowJson: string,
   inputs: unknown,
   runId: string,
   extras: {
     readonly resumeFromJson?: string;
     readonly humanInputs?: Readonly<Record<string, unknown>>;
+    readonly reuseNondeterministic?: boolean;
   } = {},
 ) =>
   runWorkflowHeadless({
     workflowJson,
     inputs,
     handlers: library.handlers,
     registry: library.registry,
     runId,
     projectRevision: 'rev-fp',
     ...extras,
   });
 
+const productionInputs = (overrides: Record<string, unknown> = {}) => ({
+  brief: 'Make a polished social-ready edit from the selected media.',
+  selectedMedia: { assetId: 'asset-long-1' },
+  ...overrides,
+});
+
 // ---------------------------------------------------------------------------
 // Definitions: versioned, registry-validated, pinned to committed artifacts.
 // ---------------------------------------------------------------------------
 
 describe('first-party workflow definitions (§23.4)', () => {
   it('every definition builds, validates against the v1 registry, and is versioned', () => {
     const built = buildFirstPartyWorkflows();
     expect(built.map((entry) => entry.workflow.id)).toEqual([...FIRST_PARTY_WORKFLOW_IDS]);
     const { registry } = buildNodeLibrary();
     for (const { workflow, order } of built) {
@@ -171,20 +225,47 @@ describe('first-party workflow definitions (§23.4)', () => {
       expect(workflow.permissions.length).toBeGreaterThan(0);
       const parsed = parseWorkflowJson(workflowToJson(workflow), { registry });
       expect(parsed.ok).toBe(true);
       if (parsed.ok) {
         expect(parsed.order).toEqual(order);
         expect(parsed.order).toHaveLength(workflow.nodes.length);
       }
     }
   });
 
+  it('declares production pack metadata, ports, approvals, capabilities, and report refs', () => {
+    const packs = buildFirstPartyPipelinePacks();
+    expect(packs.map((pack) => pack.workflow.id)).toEqual([...FIRST_PARTY_WORKFLOW_IDS]);
+    expect(packs).toHaveLength(5);
+    for (const pack of packs) {
+      expect(pack.provider).toBe('production');
+      expect(pack.label).toBe('Production pack');
+      expect(pack.requiredPorts.length).toBeGreaterThan(0);
+      expect(pack.capabilities.length).toBeGreaterThan(0);
+      expect(pack.approvals).toContain('confirm-cost');
+      expect(pack.reportRefs.length).toBeGreaterThan(0);
+      expect(pack.workflow.nodes.map((node) => node.id)).toEqual(
+        expect.arrayContaining([
+          'brief',
+          'selected-media',
+          'research',
+          'script',
+          'shotlist',
+          'candidates',
+          'contact-sheet',
+          'confirm-cost',
+          'manifest',
+        ]),
+      );
+    }
+  });
+
   it('matches the committed workflows/*.json artifacts exactly (§23.7 version diff)', () => {
     const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
     for (const file of firstPartyDefinitionFiles()) {
       const committed = readFileSync(join(dir, file.fileName), 'utf8').replaceAll('\r\n', '\n');
       expect(committed).toBe(file.json);
     }
   });
 });
 
 // ---------------------------------------------------------------------------
@@ -200,20 +281,42 @@ describe('WP-07.4 library extensions', () => {
     );
     expect(() =>
       registry.createNode('s', 'transform.sceneTemplate', { templateId: 'x' }),
     ).toThrowError(/variables/);
     expect(() => registry.createNode('c', 'transform.compose', { fields: { a: 42 } })).toThrowError(
       /value reference/,
     );
     expect(() => registry.createNode('h', 'analysis.hooks', { maxCandidates: 0 })).toThrowError(
       /maxCandidates/,
     );
+    expect(() =>
+      registry.createNode('r', 'analysis.researchBrief', { briefFrom: { kind: 'input' } }),
+    ).toThrowError(/mediaFrom/);
+    expect(() =>
+      registry.createNode('s', 'generation.script', {
+        briefFrom: { kind: 'input', path: 'brief' },
+        mediaFrom: { kind: 'input', path: 'selectedMedia' },
+      }),
+    ).toThrowError(/researchFrom/);
+    expect(() =>
+      registry.createNode('cs', 'transform.contactSheet', {
+        title: 'x',
+        candidatesFrom: { kind: 'input', path: 'candidates' },
+        providerRefs: [1],
+      }),
+    ).toThrowError(/providerRefs/);
+    expect(() =>
+      registry.createNode('dm', 'output.deliveryManifest', {
+        folderId: 'exports',
+        source: { kind: 'input' },
+      }),
+    ).toThrowError(/fileName/);
   });
 
   it('rejects declaring generation.translate deterministic (§23.5)', () => {
     const { registry } = buildNodeLibrary();
     expect(() =>
       registry.createNode(
         't',
         'generation.translate',
         { text: 'x', targetLanguage: 'fa' },
         { deterministic: true },
@@ -264,125 +367,148 @@ describe('WP-07.4 library extensions', () => {
   });
 
   it('port-backed extension nodes fail honestly with coded port-unavailable errors', () => {
     const { registry, handlers } = buildNodeLibrary(); // no ports at all
     const { workflow } = new WorkflowBuilder(registry, {
       id: 'wf-no-ports',
       version: '1.0.0',
       name: 'Missing port test',
     })
       .node('src', 'input.value', { value: { assetId: 'a' } })
-      .node('hooks', 'analysis.hooks', { source: { kind: 'upstream', node: 'src' } })
-      .edge('src', 'hooks')
+      .node('research', 'analysis.researchBrief', {
+        briefFrom: { kind: 'literal', value: 'brief' },
+        mediaFrom: { kind: 'upstream', node: 'src' },
+      })
+      .edge('src', 'research')
       .build();
 
     const result = runWorkflowHeadless({
       workflowJson: workflowToJson(workflow),
       inputs: {},
       handlers,
       registry,
       runId: 'no-ports-run',
       projectRevision: 'rev-1',
     });
     expect(result.ok).toBe(true);
     if (!result.ok) {
       return;
     }
     expect(result.state).toBe('failed');
-    expect(result.checkpoint.nodes['hooks']?.failureCode).toBe(
-      'workflow/port-unavailable:analysis.detectHighlights',
+    expect(result.checkpoint.nodes['research']?.failureCode).toBe(
+      'workflow/port-unavailable:analysis.researchBrief',
     );
   });
 });
 
 // ---------------------------------------------------------------------------
 // Long video → draft reels, end to end (§23.4).
 // ---------------------------------------------------------------------------
 
 describe('long video → draft reels', () => {
-  it('runs candidate approval → per-candidate editable drafts → render approval → finals', () => {
+  it('runs cost approval → contact-sheet candidate approval → editable drafts → render QA → delivery', () => {
     const { library, count, argsOf } = stubEnvironment();
     const workflowJson = workflowToJson(buildLongVideoDraftReelsWorkflow().workflow);
-    const inputs = { asset: { assetId: 'asset-long-1' } };
+    const inputs = productionInputs();
 
-    // 1. Runs to the candidate approval and parks (§23.6) — no Worker resources held.
+    // 1. Research/script/shotlist/contact sheet run, then provider cost parks.
     const first = runHeadless(library, workflowJson, inputs, 'reels-run');
     expect(first.ok).toBe(true);
     if (!first.ok) {
       return;
     }
     expect(first.state).toBe('waiting_for_input');
-    const candidateRequest = first.checkpoint.nodes['approve-candidates']?.pendingRequest;
+    const costRequest = first.checkpoint.nodes['confirm-cost']?.pendingRequest;
+    expect(costRequest?.kind).toBe('confirm-cost');
+    expect(count('researchBrief')).toBe(1);
+    expect(count('script')).toBe(1);
+    expect(count('shotlist')).toBe(1);
+    expect(count('detectHighlights')).toBe(1);
+    expect(count('contactSheet')).toBe(1);
+    expect(count('createBranch')).toBe(0);
+
+    // 2. Cost approval resumes to the contact-sheet candidate approval.
+    const second = runHeadless(library, workflowJson, inputs, 'reels-run', {
+      resumeFromJson: JSON.stringify(first.checkpoint),
+      humanInputs: { 'confirm-cost': { approved: true, approvalRef: 'cost-ok' } },
+      reuseNondeterministic: true,
+    });
+    expect(second.ok).toBe(true);
+    if (!second.ok) {
+      return;
+    }
+    expect(second.state).toBe('waiting_for_input');
+    const candidateRequest = second.checkpoint.nodes['approve-candidates']?.pendingRequest;
     expect(candidateRequest?.kind).toBe('choose-candidates');
     const payload = candidateRequest?.payload as { candidates: readonly { title: string }[] };
     expect(payload.candidates.map((candidate) => candidate.title)).toEqual([
       'Hook A',
       'Hook B',
       'Hook C',
     ]);
-    expect(count('transcribe')).toBe(1);
+    expect(count('script')).toBe(1);
     expect(count('detectHighlights')).toBe(1);
-    expect(count('createBranch')).toBe(0);
 
-    // 2. Resume with two chosen candidates: one editable branch + review proxy each.
+    // 3. Candidate approval applies one command transaction, then builds editable drafts.
     const chosen = payload.candidates.slice(0, 2);
-    const second = runHeadless(library, workflowJson, inputs, 'reels-run', {
-      resumeFromJson: JSON.stringify(first.checkpoint),
+    const third = runHeadless(library, workflowJson, inputs, 'reels-run', {
+      resumeFromJson: JSON.stringify(second.checkpoint),
       humanInputs: { 'approve-candidates': { candidates: chosen } },
+      reuseNondeterministic: true,
     });
-    expect(second.ok).toBe(true);
-    if (!second.ok) {
+    expect(third.ok).toBe(true);
+    if (!third.ok) {
       return;
     }
-    expect(second.state).toBe('waiting_for_input');
-    const draftRequest = second.checkpoint.nodes['approve-drafts']?.pendingRequest;
+    expect(third.state).toBe('waiting_for_input');
+    const draftRequest = third.checkpoint.nodes['approve-drafts']?.pendingRequest;
     expect(draftRequest?.kind).toBe('approve-render');
     expect((draftRequest?.payload as { count: number }).count).toBe(2);
-    // One input batch generated multiple *editable* project variants (§36 Phase 7).
+    expect(count('commandTransaction')).toBe(1);
     expect(count('createBranch')).toBe(2);
     expect(count('reframe')).toBe(2);
     expect(argsOf('reframe').map((args) => (args as { aspect: string }).aspect)).toEqual([
       '9:16',
       '9:16',
     ]);
     expect(count('caption')).toBe(2);
     expect(count('normalizeAudio')).toBe(2);
     expect(argsOf('render').map((args) => (args as { mode: string }).mode)).toEqual([
       'preview',
       'preview',
     ]);
-    // Resuming did not duplicate completed work (§36 Phase 7).
-    expect(count('transcribe')).toBe(1);
+    expect(count('script')).toBe(1);
     expect(count('detectHighlights')).toBe(1);
 
-    // 3. Resume with render approval: finals render and outputs are written once.
+    // 4. Render approval creates final renders, bounded QA reports, delivery manifests, and run report.
     const approved = (draftRequest?.payload as { items: readonly unknown[] }).items;
-    const third = runHeadless(library, workflowJson, inputs, 'reels-run', {
-      resumeFromJson: JSON.stringify(second.checkpoint),
+    const fourth = runHeadless(library, workflowJson, inputs, 'reels-run', {
+      resumeFromJson: JSON.stringify(third.checkpoint),
       humanInputs: { 'approve-drafts': { approved } },
+      reuseNondeterministic: true,
     });
-    expect(third.ok).toBe(true);
-    if (!third.ok) {
+    expect(fourth.ok).toBe(true);
+    if (!fourth.ok) {
       return;
     }
-    expect(third.state).toBe('succeeded');
-    expect(third.outputIssues).toEqual([]);
-    expect(Object.keys(third.outputs)).toEqual(['manifest']);
+    expect(fourth.state).toBe('succeeded');
+    expect(fourth.outputIssues).toEqual([]);
+    expect(Object.keys(fourth.outputs)).toEqual(['manifest']);
     const renderModes = argsOf('render').map((args) => (args as { mode: string }).mode);
     expect(renderModes).toEqual(['preview', 'preview', 'final', 'final']);
-    expect(count('writeToFolder')).toBe(2);
+    expect(count('inspect')).toBe(2);
+    expect(count('writeDeliveryManifest')).toBe(2);
     expect(count('writeMetadata')).toBe(1);
     expect((argsOf('writeMetadata')[0] as { fileName: string }).fileName).toBe(
       'long-video-draft-reels-run.json',
     );
-    // Earlier stages still ran exactly once across all three sessions.
-    expect(count('transcribe')).toBe(1);
+    expect(count('script')).toBe(1);
     expect(count('createBranch')).toBe(2);
   });
 });
 
 // ---------------------------------------------------------------------------
 // Multilingual restaurant promo, end to end (§23.4).
 // ---------------------------------------------------------------------------
 
 describe('multilingual restaurant promo', () => {
   it('approves copy once, then renders one translated, voiced promo per row/language', () => {
@@ -397,44 +523,59 @@ describe('multilingual restaurant promo', () => {
         copy: 'کباب کوبیده تازه',
       },
       {
         name: 'Koobideh',
         priceText: '€12',
         image: { assetId: 'img-koobideh' },
         language: 'en',
         copy: 'Fresh koobideh kebab',
       },
     ];
-    const inputs = { rows };
+    const inputs = productionInputs({ rows });
 
     const first = runHeadless(library, workflowJson, inputs, 'promo-run');
     expect(first.ok).toBe(true);
     if (!first.ok) {
       return;
     }
     expect(first.state).toBe('waiting_for_input');
-    const request = first.checkpoint.nodes['approve-copy']?.pendingRequest;
-    expect(request?.kind).toBe('approve-transcript');
-    expect(request?.payload).toEqual(rows);
+    const costRequest = first.checkpoint.nodes['confirm-cost']?.pendingRequest;
+    expect(costRequest?.kind).toBe('confirm-cost');
     expect(count('translate')).toBe(0);
 
     const second = runHeadless(library, workflowJson, inputs, 'promo-run', {
       resumeFromJson: JSON.stringify(first.checkpoint),
-      humanInputs: { 'approve-copy': { rows } },
+      humanInputs: { 'confirm-cost': { approved: true, approvalRef: 'cost-ok' } },
+      reuseNondeterministic: true,
     });
     expect(second.ok).toBe(true);
     if (!second.ok) {
       return;
     }
-    expect(second.state).toBe('succeeded');
-    expect(second.outputIssues).toEqual([]);
-    expect(Object.keys(second.outputs)).toEqual(['manifest']);
+    expect(second.state).toBe('waiting_for_input');
+    const request = second.checkpoint.nodes['approve-copy']?.pendingRequest;
+    expect(request?.kind).toBe('approve-transcript');
+    expect(request?.payload).toMatchObject({ contactSheetRef: 'contact-sheet-1' });
+    expect(count('translate')).toBe(0);
+
+    const third = runHeadless(library, workflowJson, inputs, 'promo-run', {
+      resumeFromJson: JSON.stringify(second.checkpoint),
+      humanInputs: { 'approve-copy': { rows } },
+      reuseNondeterministic: true,
+    });
+    expect(third.ok).toBe(true);
+    if (!third.ok) {
+      return;
+    }
+    expect(third.state).toBe('succeeded');
+    expect(third.outputIssues).toEqual([]);
+    expect(Object.keys(third.outputs)).toEqual(['manifest']);
 
     // Approved copy was translated per row language, then voiced from the translation.
     expect(
       argsOf('translate').map((args) => (args as { targetLanguage: string }).targetLanguage),
     ).toEqual(['fa', 'en']);
     expect(argsOf('speech').map((args) => (args as { text: string }).text)).toEqual([
       '[fa] کباب کوبیده تازه',
       '[en] Fresh koobideh kebab',
     ]);
     // Each row instantiated the Product Card scene with the assembled variables.
@@ -444,102 +585,183 @@ describe('multilingual restaurant promo', () => {
     }[];
     expect(sceneCalls).toHaveLength(2);
     for (const [index, call] of sceneCalls.entries()) {
       expect(call.templateId).toBe('joy.scene.product-card');
       expect(call.variables.row).toEqual(rows[index]);
     }
     expect(argsOf('render').map((args) => (args as { mode: string }).mode)).toEqual([
       'final',
       'final',
     ]);
-    expect(count('writeToFolder')).toBe(2);
+    expect(count('inspect')).toBe(2);
+    expect(count('writeDeliveryManifest')).toBe(2);
     expect(count('writeMetadata')).toBe(1);
   });
 });
 
 // ---------------------------------------------------------------------------
 // Podcast cleanup, end to end (§23.4).
 // ---------------------------------------------------------------------------
 
 describe('podcast cleanup', () => {
   it('parks both approvals while the independent audio branch keeps running', () => {
     const { library, count } = stubEnvironment();
     const workflowJson = workflowToJson(buildPodcastCleanupWorkflow().workflow);
-    const inputs = { source: { assetId: 'asset-episode-1' } };
+    const inputs = productionInputs({ selectedMedia: { assetId: 'asset-episode-1' } });
 
     const first = runHeadless(library, workflowJson, inputs, 'podcast-run-park');
     expect(first.ok).toBe(true);
     if (!first.ok) {
       return;
     }
     expect(first.state).toBe('waiting_for_input');
+    expect(first.checkpoint.nodes['confirm-cost']?.pendingRequest?.kind).toBe('confirm-cost');
     expect(first.checkpoint.nodes['confirm-speakers']?.pendingRequest?.kind).toBe(
       'choose-candidates',
     );
     expect(first.checkpoint.nodes['approve-edit-list']?.pendingRequest?.kind).toBe(
       'accept-edit-diff',
     );
     // The speaker approval parked, but the independent audio branch ran on (§23.6):
     expect(count('denoise')).toBe(1);
     expect(count('normalizeAudio')).toBe(1);
     expect(count('detectSilence')).toBe(1);
     // Nothing past the edit-list approval executed.
     expect(count('trim')).toBe(0);
     expect(count('transcribe')).toBe(0);
   });
 
   it('applies exactly the human-approved edit list, then exports the episode plus clips', () => {
     const { library, count, argsOf } = stubEnvironment();
     const workflowJson = workflowToJson(buildPodcastCleanupWorkflow().workflow);
-    const inputs = { source: { assetId: 'asset-episode-1' } };
+    const inputs = productionInputs({ selectedMedia: { assetId: 'asset-episode-1' } });
 
     const first = runHeadless(library, workflowJson, inputs, 'podcast-run');
     expect(first.ok).toBe(true);
     if (!first.ok) {
       return;
     }
 
     // The human drops the second detected silence: the approved list is authoritative.
     const approvedRanges = [{ startUs: 10_000_000, endUs: 12_500_000 }];
     const speakers = [{ id: 'spk-1', name: 'Host' }];
     const second = runHeadless(library, workflowJson, inputs, 'podcast-run', {
       resumeFromJson: JSON.stringify(first.checkpoint),
       humanInputs: {
+        'confirm-cost': { approved: true, approvalRef: 'cost-ok' },
         'confirm-speakers': { speakers },
         'approve-edit-list': { ranges: approvedRanges },
       },
+      reuseNondeterministic: true,
     });
     expect(second.ok).toBe(true);
     if (!second.ok) {
       return;
     }
     expect(second.state).toBe('succeeded');
     expect(second.outputIssues).toEqual([]);
-    expect(Object.keys(second.outputs).sort()).toEqual(['manifest', 'save-episode']);
+    expect(Object.keys(second.outputs)).toEqual(['manifest']);
 
     expect(count('trim')).toBe(1);
     expect((argsOf('trim')[0] as { ranges: unknown }).ranges).toEqual(approvedRanges);
     // Transcript/chapters run on the trimmed episode; episode + one clip per chapter render.
     expect(count('transcribe')).toBe(1);
     expect(count('generateChapters')).toBe(1);
     expect(
       argsOf('render')
         .map((args) => (args as { profile: string | null }).profile)
         .sort(),
     ).toEqual(['podcast-clip', 'podcast-clip', 'podcast-episode']);
-    expect(count('writeToFolder')).toBe(3);
-    // The audit manifest records the human decisions and generated structure.
-    const metadata = (
-      argsOf('writeMetadata')[0] as {
-        metadata: { speakers: unknown; editList: unknown; chapters: unknown; clips: unknown };
-      }
-    ).metadata;
-    expect(metadata.speakers).toEqual({ speakers });
-    expect(metadata.editList).toEqual({ ranges: approvedRanges });
-    expect(metadata.chapters).toBeDefined();
-    expect(metadata.clips).toBeDefined();
+    expect(count('inspect')).toBe(3);
+    expect(count('writeDeliveryManifest')).toBe(3);
+    const topLevelManifest = argsOf('writeDeliveryManifest').find(
+      (args) => (args as { fileName: string }).fileName === 'podcast-cleanup-run.json',
+    ) as { approvals: { speakers: unknown; editList: unknown; chapters: unknown; clips: unknown } };
+    expect(topLevelManifest.approvals.speakers).toEqual({ speakers });
+    expect(topLevelManifest.approvals.editList).toEqual({ ranges: approvedRanges });
+    expect(topLevelManifest.approvals.chapters).toBeDefined();
+    expect(topLevelManifest.approvals.clips).toBeDefined();
     // No duplicated completed work across the resume (§36 Phase 7).
     expect(count('detectSpeakers')).toBe(1);
     expect(count('detectSilence')).toBe(1);
     expect(count('denoise')).toBe(1);
   });
 });
+
+// ---------------------------------------------------------------------------
+// New production packs.
+// ---------------------------------------------------------------------------
+
+describe('new production pipeline packs', () => {
+  it('runs the clean-room reference social cutdown through approval, render, inspect, and manifest', () => {
+    const { library, count } = stubEnvironment();
+    const workflowJson = workflowToJson(buildReferenceSocialCutdownWorkflow().workflow);
+    const inputs = productionInputs({
+      references: [{ referenceId: 'ref-structure-1', note: 'fast cold open, no copied assets' }],
+    });
+
+    const first = runHeadless(library, workflowJson, inputs, 'cutdown-run');
+    expect(first.ok).toBe(true);
+    if (!first.ok) return;
+    expect(first.checkpoint.nodes['confirm-cost']?.pendingRequest?.kind).toBe('confirm-cost');
+
+    const second = runHeadless(library, workflowJson, inputs, 'cutdown-run', {
+      resumeFromJson: JSON.stringify(first.checkpoint),
+      humanInputs: { 'confirm-cost': { approved: true } },
+      reuseNondeterministic: true,
+    });
+    expect(second.ok).toBe(true);
+    if (!second.ok) return;
+    const request = second.checkpoint.nodes['approve-cutdown']?.pendingRequest;
+    expect(request?.kind).toBe('choose-candidates');
+    const payload = request?.payload as { candidates: readonly unknown[] };
+
+    const third = runHeadless(library, workflowJson, inputs, 'cutdown-run', {
+      resumeFromJson: JSON.stringify(second.checkpoint),
+      humanInputs: { 'approve-cutdown': { candidates: payload.candidates.slice(0, 1) } },
+      reuseNondeterministic: true,
+    });
+    expect(third.ok).toBe(true);
+    if (!third.ok) return;
+    expect(third.state).toBe('succeeded');
+    expect(third.outputIssues).toEqual([]);
+    expect(count('commandTransaction')).toBe(1);
+    expect(count('inspect')).toBe(1);
+    expect(count('writeDeliveryManifest')).toBe(1);
+    expect(count('writeMetadata')).toBe(1);
+  });
+
+  it('runs the interview/documentary assembly pack with transcript and chapter evidence', () => {
+    const { library, count, argsOf } = stubEnvironment();
+    const workflowJson = workflowToJson(buildInterviewDocumentaryAssemblyWorkflow().workflow);
+    const inputs = productionInputs({ selectedMedia: { assetId: 'interview-roll-1' } });
+
+    const first = runHeadless(library, workflowJson, inputs, 'doc-run');
+    expect(first.ok).toBe(true);
+    if (!first.ok) return;
+    const second = runHeadless(library, workflowJson, inputs, 'doc-run', {
+      resumeFromJson: JSON.stringify(first.checkpoint),
+      humanInputs: { 'confirm-cost': { approved: true } },
+      reuseNondeterministic: true,
+    });
+    expect(second.ok).toBe(true);
+    if (!second.ok) return;
+    const request = second.checkpoint.nodes['approve-assembly']?.pendingRequest;
+    expect(request?.kind).toBe('choose-candidates');
+    const payload = request?.payload as { candidates: readonly unknown[] };
+
+    const third = runHeadless(library, workflowJson, inputs, 'doc-run', {
+      resumeFromJson: JSON.stringify(second.checkpoint),
+      humanInputs: { 'approve-assembly': { candidates: payload.candidates.slice(0, 1) } },
+      reuseNondeterministic: true,
+    });
+    expect(third.ok).toBe(true);
+    if (!third.ok) return;
+    expect(third.state).toBe('succeeded');
+    expect(third.outputIssues).toEqual([]);
+    expect(count('transcribe')).toBe(1);
+    expect(count('generateChapters')).toBe(1);
+    expect((argsOf('writeMetadata')[0] as { fileName: string }).fileName).toBe(
+      'interview-documentary-assembly-run.json',
+    );
+  });
+});
diff --git a/packages/workflow-engine/src/first-party.ts b/packages/workflow-engine/src/first-party.ts
index ec2b643..9d364d4 100644
--- a/packages/workflow-engine/src/first-party.ts
+++ b/packages/workflow-engine/src/first-party.ts
@@ -1,212 +1,344 @@
 /**
- * P07 WP-07.4 — first-party workflows (§23.4): long-video→draft-reels,
- * multilingual promo, and podcast cleanup as tested, versioned definitions.
+ * Production first-party workflow packs.
  *
- * Each definition is authored in code through `WorkflowBuilder` against the v1
- * node registry, so params are validated at authoring time and `build()` re-runs
- * full definition + registry validation. The serialized JSON artifacts live in
- * `packages/workflow-engine/workflows/*.json` (diffable, CLI-runnable via
- * `joy-workflow`); a test pins them byte-for-byte to the builder output, so any
- * definition change shows up as a reviewable JSON diff.
- *
- * Regenerate the JSON artifacts after `pnpm --filter @joy-media/workflow-engine build`:
- *
- *   node -e "import('./packages/workflow-engine/dist/first-party.js').then(m => { const fs = require('node:fs'); for (const f of m.firstPartyDefinitionFiles()) fs.writeFileSync('packages/workflow-engine/workflows/' + f.fileName, f.json); })"
+ * The visible catalog is intentionally production-shaped: each pack declares the
+ * ports/capabilities it needs and every effectful step is backed by a port that
+ * fails closed when the host has not wired a real adapter. Fixture-only ports
+ * live in the editor test/demo registry, not in these definitions.
  */
 
 import { WorkflowBuilder, workflowToJson } from './authoring.js';
 import type { JoyWorkflow } from './definition.js';
 import type { ValueRef } from './library.js';
 import { buildNodeLibrary } from './library.js';
 
-/** Version of every first-party definition; bump when any definition changes. */
-export const FIRST_PARTY_WORKFLOWS_VERSION = '1.0.0';
+/** Version of every production pipeline pack; bump when any definition changes. */
+export const FIRST_PARTY_WORKFLOWS_VERSION = '2.0.0';
 
-/** Caption template applied by all first-party workflows (P03 JOY templates). */
 const CAPTION_TEMPLATE_ID = 'joy.caption.clean';
-
-/** Opaque export-folder reference (§44: never a filesystem path). */
 const EXPORT_FOLDER_ID = 'exports';
+const FINAL_RENDER_RETRY = { maxAttempts: 2, backoffMs: 1000 } as const;
+const DEFAULT_PROVIDER_REFS = ['provider:analysis', 'provider:generation', 'provider:render'];
 
 const input = (path?: string): ValueRef =>
   path === undefined ? { kind: 'input' } : { kind: 'input', path };
 
 const upstream = (node: string, path?: string): ValueRef =>
   path === undefined ? { kind: 'upstream', node } : { kind: 'upstream', node, path };
 
-const FINAL_RENDER_RETRY = { maxAttempts: 2, backoffMs: 1000 } as const;
+const literal = (value: unknown): ValueRef => ({ kind: 'literal', value });
 
 export interface FirstPartyWorkflow {
   readonly workflow: JoyWorkflow;
   /** Deterministic topological execution order, from validation. */
   readonly order: readonly string[];
 }
 
-// ---------------------------------------------------------------------------
-// 1. Long video → draft reels (§23.4).
-// ---------------------------------------------------------------------------
+export interface FirstPartyPipelinePack extends FirstPartyWorkflow {
+  readonly label: string;
+  readonly summary: string;
+  readonly provider: 'production';
+  readonly requiredPorts: readonly string[];
+  readonly optionalPorts: readonly string[];
+  readonly capabilities: readonly string[];
+  readonly approvals: readonly string[];
+  readonly reportRefs: readonly string[];
+}
+
+interface PackDescriptor {
+  readonly id: FirstPartyWorkflowId;
+  readonly fileName: string;
+  readonly label: string;
+  readonly summary: string;
+  readonly requiredPorts: readonly string[];
+  readonly optionalPorts?: readonly string[];
+  readonly capabilities: readonly string[];
+  readonly approvals: readonly string[];
+  readonly reportRefs: readonly string[];
+  readonly build: () => FirstPartyWorkflow;
+}
+
+const CONTENT_INPUTS = {
+  type: 'object',
+  required: ['brief', 'selectedMedia'],
+  properties: {
+    brief: {
+      type: 'string',
+      minLength: 1,
+      description: 'Creative brief or client goal for this production run.',
+      default: 'Create a polished, on-brand edit from the selected media.',
+    },
+    selectedMedia: {
+      type: 'object',
+      description: 'Opaque selected media references; never paths or URLs.',
+    },
+    references: {
+      type: 'array',
+      items: { type: 'object' },
+      description: 'Optional clean-room reference notes or media fingerprints.',
+    },
+    rows: {
+      type: 'array',
+      items: { type: 'object' },
+      description: 'Optional structured rows for promo variants.',
+    },
+    delivery: {
+      type: 'object',
+      description: 'Optional delivery promise: aspect, codec, captions, approval requirements.',
+    },
+  },
+  additionalProperties: false,
+} as const;
+
+const MANIFEST_OUTPUTS = {
+  type: 'object',
+  required: ['manifest'],
+  properties: { manifest: { type: 'object' } },
+} as const;
+
+function baseContentPipeline(
+  builder: WorkflowBuilder,
+  options: {
+    readonly scriptStyle: string;
+    readonly shotlistFormat: string;
+    readonly candidateTitle: string;
+    readonly candidateCount: number;
+    readonly costUsd: number;
+  },
+): WorkflowBuilder {
+  return builder
+    .node('brief', 'input.item', { path: 'brief' })
+    .node('selected-media', 'input.item', { path: 'selectedMedia' })
+    .node('research', 'analysis.researchBrief', {
+      briefFrom: upstream('brief'),
+      mediaFrom: upstream('selected-media'),
+    })
+    .node('script', 'generation.script', {
+      style: options.scriptStyle,
+      briefFrom: upstream('brief'),
+      researchFrom: upstream('research'),
+      mediaFrom: upstream('selected-media'),
+    })
+    .node('shotlist', 'generation.shotlist', {
+      format: options.shotlistFormat,
+      scriptFrom: upstream('script'),
+      mediaFrom: upstream('selected-media'),
+    })
+    .node('candidates', 'analysis.hooks', {
+      source: upstream('selected-media'),
+      transcriptFrom: upstream('script'),
+      maxCandidates: options.candidateCount,
+    })
+    .node('contact-sheet', 'transform.contactSheet', {
+      title: options.candidateTitle,
+      candidatesFrom: upstream('candidates'),
+      shotlistFrom: upstream('shotlist'),
+      providerRefs: DEFAULT_PROVIDER_REFS,
+    })
+    .node('cost-brief', 'transform.compose', {
+      fields: {
+        estimatedUsd: literal(options.costUsd),
+        providerRefs: literal(DEFAULT_PROVIDER_REFS),
+        script: upstream('script'),
+        shotlist: upstream('shotlist'),
+        candidates: upstream('contact-sheet'),
+      },
+    })
+    .node('confirm-cost', 'decision.approval', {
+      kind: 'confirm-cost',
+      prompt:
+        'Confirm provider cost before candidate review. Respond with {approved: true} to continue.',
+      payloadFrom: upstream('cost-brief'),
+    })
+    .edge('brief', 'research')
+    .edge('selected-media', 'research')
+    .edge('brief', 'script')
+    .edge('research', 'script')
+    .edge('selected-media', 'script')
+    .edge('script', 'shotlist')
+    .edge('selected-media', 'shotlist')
+    .edge('selected-media', 'candidates')
+    .edge('script', 'candidates')
+    .edge('candidates', 'contact-sheet')
+    .edge('shotlist', 'contact-sheet')
+    .edge('script', 'cost-brief')
+    .edge('shotlist', 'cost-brief')
+    .edge('contact-sheet', 'cost-brief')
+    .edge('cost-brief', 'confirm-cost');
+}
+
+function addPackPermissions(builder: WorkflowBuilder): WorkflowBuilder {
+  return builder
+    .permission('provider.research')
+    .permission('provider.script')
+    .permission('provider.highlights')
+    .permission('provider.cost')
+    .permission('editor.command')
+    .permission('render.final')
+    .permission('render.inspect')
+    .permission('output.write');
+}
+
+function buildApprovalApplyCommand(label: string): readonly unknown[] {
+  return [
+    {
+      tool: 'artifact.create',
+      arguments: {
+        kind: 'workflow-approval',
+        label,
+        sourceRef: 'approval.response',
+      },
+    },
+  ];
+}
+
+function buildFinalDeliveryWorkflow(id: string, name: string, profile: string): JoyWorkflow {
+  const { registry } = buildNodeLibrary();
+  return new WorkflowBuilder(registry, {
+    id,
+    version: FIRST_PARTY_WORKFLOWS_VERSION,
+    name,
+    inputs: { type: 'object', description: 'One approved render source.' },
+    outputs: { type: 'object' },
+  })
+    .node('render', 'render.final', { profile, source: input() }, { retry: FINAL_RENDER_RETRY })
+    .node('inspect', 'render.inspect', {
+      source: upstream('render'),
+      reportRef: `${id}.qa-report`,
+    })
+    .node('manifest', 'output.deliveryManifest', {
+      folderId: EXPORT_FOLDER_ID,
+      fileName: `${id.split('.').pop() ?? 'delivery'}.json`,
+      source: upstream('render'),
+      inspectionFrom: upstream('inspect'),
+      providerRefs: DEFAULT_PROVIDER_REFS,
+    })
+    .edge('render', 'inspect')
+    .edge('render', 'manifest')
+    .edge('inspect', 'manifest')
+    .build().workflow;
+}
 
-/**
- * Per-candidate sub-workflow: branch → reframe(9:16) → caption → normalize/duck
- * → review proxy. Map items are approved hook candidates and must be
- * self-contained: each carries its `source` and `subjectHints`.
- */
 function buildDraftReelItemWorkflow(): JoyWorkflow {
   const { registry } = buildNodeLibrary();
   return new WorkflowBuilder(registry, {
     id: 'joy.first-party.long-video-draft-reels.item',
     version: FIRST_PARTY_WORKFLOWS_VERSION,
     name: 'Draft reel per approved candidate',
-    inputs: {
-      type: 'object',
-      description:
-        'One approved hook candidate; must carry its own source reference and subjectHints.',
-    },
+    inputs: { type: 'object', description: 'One approved hook candidate.' },
     outputs: { type: 'object' },
   })
     .node('branch', 'editor.createBranch', { name: 'draft-reel', source: input() })
     .node('reframe', 'transform.reframe', {
       aspect: '9:16',
       source: upstream('branch'),
-      subjectHintsFrom: input('subjectHints'),
     })
     .node('caption', 'transform.caption', {
       templateId: CAPTION_TEMPLATE_ID,
       source: upstream('reframe'),
     })
     .node('mix', 'transform.normalizeAudio', {
       targetLufs: -14,
       duckMusic: true,
       source: upstream('caption'),
     })
     .node('preview', 'render.preview', { profile: 'review-proxy', source: upstream('mix') })
     .edge('branch', 'reframe')
     .edge('reframe', 'caption')
     .edge('caption', 'mix')
     .edge('mix', 'preview')
     .build().workflow;
 }
 
-/** Per-approved-draft sub-workflow: final render → export folder. */
-function buildFinalReelItemWorkflow(): JoyWorkflow {
-  const { registry } = buildNodeLibrary();
-  return new WorkflowBuilder(registry, {
-    id: 'joy.first-party.long-video-draft-reels.final',
-    version: FIRST_PARTY_WORKFLOWS_VERSION,
-    name: 'Final reel per approved draft',
-    inputs: { type: 'object', description: 'One approved draft (self-contained render source).' },
-    outputs: { type: 'object' },
-  })
-    .node(
-      'final',
-      'render.final',
-      { profile: 'reel-vertical', source: input() },
-      { retry: FINAL_RENDER_RETRY },
-    )
-    .node('save', 'output.folder', { folderId: EXPORT_FOLDER_ID, source: upstream('final') })
-    .edge('final', 'save')
-    .build().workflow;
-}
-
-/**
- * §23.4 "Long video to draft reels": transcribe → hook candidates → human
- * candidate choice (parks, §23.6) → one editable branch + captioned 9:16 review
- * proxy per candidate (map) → human render approval (parks) → finals + manifest.
- */
 export function buildLongVideoDraftReelsWorkflow(): FirstPartyWorkflow {
   const { registry } = buildNodeLibrary();
-  return new WorkflowBuilder(registry, {
-    id: 'joy.first-party.long-video-draft-reels',
-    version: FIRST_PARTY_WORKFLOWS_VERSION,
-    name: 'Long video → draft reels',
-    inputs: {
-      type: 'object',
-      required: ['asset'],
-      properties: {
-        asset: { type: 'object', description: 'Opaque source video asset reference.' },
-      },
-      additionalProperties: false,
-    },
-    outputs: {
-      type: 'object',
-      required: ['manifest'],
-      properties: { manifest: { type: 'object' } },
+  const builder = baseContentPipeline(
+    new WorkflowBuilder(registry, {
+      id: 'joy.first-party.long-video-draft-reels',
+      version: FIRST_PARTY_WORKFLOWS_VERSION,
+      name: 'Long video draft reels',
+      inputs: CONTENT_INPUTS,
+      outputs: MANIFEST_OUTPUTS,
+    }),
+    {
+      scriptStyle: 'short-form hook script',
+      shotlistFormat: 'vertical-reels',
+      candidateTitle: 'Draft reel contact sheet',
+      candidateCount: 5,
+      costUsd: 8,
     },
-  })
-    .node('ingest', 'input.item', { path: 'asset' })
-    .node('transcribe', 'analysis.transcribe', { source: upstream('ingest') })
-    .node('hooks', 'analysis.hooks', {
-      source: upstream('ingest'),
-      transcriptFrom: upstream('transcribe'),
-      maxCandidates: 5,
-    })
+  )
     .node('approve-candidates', 'decision.approval', {
       kind: 'choose-candidates',
       prompt:
-        'Choose which hook candidates become draft reels. Respond with {candidates: [...]}; each candidate must carry its source and subjectHints.',
-      payloadFrom: upstream('hooks'),
+        'Choose hook candidates for editable draft reels. Respond with {candidates: [...]} where each candidate is self-contained.',
+      payloadFrom: upstream('contact-sheet'),
+    })
+    .node('apply-approved-candidates', 'editor.commandTransaction', {
+      label: 'Create draft-reel approval artifacts',
+      commands: buildApprovalApplyCommand('Approved draft reel candidates'),
     })
     .node('draft-reels', 'control.map', {
       workflow: buildDraftReelItemWorkflow(),
       itemsFrom: upstream('approve-candidates', 'response.candidates'),
     })
     .node('approve-drafts', 'decision.approval', {
       kind: 'approve-render',
       prompt:
-        'Review the draft previews. Respond with {approved: [...]} listing the drafts to render as finals; each entry must be a self-contained render source.',
+        'Review draft proxies. Respond with {approved: [...]} listing the drafts to render as finals.',
       payloadFrom: upstream('draft-reels'),
     })
     .node('final-reels', 'control.map', {
-      workflow: buildFinalReelItemWorkflow(),
+      workflow: buildFinalDeliveryWorkflow(
+        'joy.first-party.long-video-draft-reels.final',
+        'Final reel delivery per approved draft',
+        'reel-vertical',
+      ),
       itemsFrom: upstream('approve-drafts', 'response.approved'),
     })
+    .node('run-report', 'transform.compose', {
+      fields: {
+        providerRefs: literal(DEFAULT_PROVIDER_REFS),
+        costApproval: upstream('confirm-cost', 'response'),
+        candidateApproval: upstream('approve-candidates', 'response'),
+        renderApproval: upstream('approve-drafts', 'response'),
+        deliveries: upstream('final-reels'),
+      },
+    })
     .node('manifest', 'output.metadata', {
       folderId: EXPORT_FOLDER_ID,
       fileName: 'long-video-draft-reels-run.json',
-      source: upstream('final-reels'),
+      source: upstream('run-report'),
     })
-    .edge('ingest', 'transcribe')
-    .edge('ingest', 'hooks')
-    .edge('transcribe', 'hooks')
-    .edge('hooks', 'approve-candidates')
+    .edge('contact-sheet', 'approve-candidates')
+    .edge('confirm-cost', 'approve-candidates')
+    .edge('approve-candidates', 'apply-approved-candidates')
     .edge('approve-candidates', 'draft-reels')
+    .edge('apply-approved-candidates', 'draft-reels')
     .edge('draft-reels', 'approve-drafts')
     .edge('approve-drafts', 'final-reels')
-    .edge('final-reels', 'manifest')
-    .permission('provider.transcribe')
-    .permission('provider.highlights')
-    .permission('render.final')
-    .permission('output.write')
-    .build();
+    .edge('confirm-cost', 'run-report')
+    .edge('approve-candidates', 'run-report')
+    .edge('approve-drafts', 'run-report')
+    .edge('final-reels', 'run-report')
+    .edge('run-report', 'manifest');
+  return addPackPermissions(builder).build();
 }
 
-// ---------------------------------------------------------------------------
-// 2. Multilingual restaurant promo (§23.4).
-// ---------------------------------------------------------------------------
-
-/**
- * Per-row sub-workflow: translate approved copy → voice-over → aligned captions
- * → compose scene variables → Product Card scene instance → final render →
- * export. Map items are approved rows; each carries name, priceText, image,
- * language, and copy.
- */
 function buildPromoItemWorkflow(): JoyWorkflow {
   const { registry } = buildNodeLibrary();
   return new WorkflowBuilder(registry, {
     id: 'joy.first-party.multilingual-promo.item',
     version: FIRST_PARTY_WORKFLOWS_VERSION,
-    name: 'Promo render per menu row and language',
-    inputs: {
-      type: 'object',
-      description: 'One approved menu row: name, priceText, image, language, copy.',
-    },
+    name: 'Promo render per approved row and language',
+    inputs: { type: 'object', description: 'One approved row: copy, language, image, offer.' },
     outputs: { type: 'object' },
   })
     .node('translate', 'generation.translate', {
       textFrom: input('copy'),
       targetLanguageFrom: input('language'),
     })
     .node('voice', 'generation.speech', {
       voiceId: 'joy.voice.promo',
       textFrom: upstream('translate', 'text'),
     })
@@ -219,267 +351,520 @@ function buildPromoItemWorkflow(): JoyWorkflow {
         row: input(),
         translation: upstream('translate'),
         voiceOver: upstream('voice'),
         captions: upstream('captions'),
       },
     })
     .node('scene', 'transform.sceneTemplate', {
       templateId: 'joy.scene.product-card',
       variablesFrom: upstream('assemble'),
     })
-    .node(
-      'render',
-      'render.final',
-      { profile: 'promo-vertical', source: upstream('scene') },
-      { retry: FINAL_RENDER_RETRY },
-    )
-    .node('save', 'output.folder', { folderId: EXPORT_FOLDER_ID, source: upstream('render') })
+    .node('render', 'render.final', { profile: 'promo-vertical', source: upstream('scene') })
+    .node('inspect', 'render.inspect', {
+      source: upstream('render'),
+      reportRef: 'joy.first-party.multilingual-promo.qa-report',
+    })
+    .node('manifest', 'output.deliveryManifest', {
+      folderId: EXPORT_FOLDER_ID,
+      fileName: 'promo-delivery.json',
+      source: upstream('render'),
+      inspectionFrom: upstream('inspect'),
+      providerRefs: DEFAULT_PROVIDER_REFS,
+    })
     .edge('translate', 'voice')
     .edge('voice', 'captions')
     .edge('translate', 'assemble')
     .edge('voice', 'assemble')
     .edge('captions', 'assemble')
     .edge('assemble', 'scene')
     .edge('scene', 'render')
-    .edge('render', 'save')
+    .edge('render', 'inspect')
+    .edge('render', 'manifest')
+    .edge('inspect', 'manifest')
     .build().workflow;
 }
 
-/**
- * §23.4 "Multilingual restaurant promo": rows in → human copy approval (parks,
- * §23.6; the response carries the final per-row copy) → one translated, voiced,
- * captioned Product Card render per row/language (map) → manifest.
- */
 export function buildMultilingualPromoWorkflow(): FirstPartyWorkflow {
   const { registry } = buildNodeLibrary();
-  return new WorkflowBuilder(registry, {
-    id: 'joy.first-party.multilingual-promo',
-    version: FIRST_PARTY_WORKFLOWS_VERSION,
-    name: 'Multilingual restaurant promo',
-    inputs: {
-      type: 'object',
-      required: ['rows'],
-      properties: {
-        rows: {
-          type: 'array',
-          minItems: 1,
-          items: { type: 'object' },
-          description: 'Menu rows: name, priceText, image, language, copy.',
-        },
-      },
-      additionalProperties: false,
-    },
-    outputs: {
-      type: 'object',
-      required: ['manifest'],
-      properties: { manifest: { type: 'object' } },
+  const builder = baseContentPipeline(
+    new WorkflowBuilder(registry, {
+      id: 'joy.first-party.multilingual-promo',
+      version: FIRST_PARTY_WORKFLOWS_VERSION,
+      name: 'Multilingual promo',
+      inputs: CONTENT_INPUTS,
+      outputs: MANIFEST_OUTPUTS,
+    }),
+    {
+      scriptStyle: 'localized promo script',
+      shotlistFormat: 'menu-promo',
+      candidateTitle: 'Promo variant contact sheet',
+      candidateCount: 4,
+      costUsd: 12,
     },
-  })
-    .node('rows', 'input.item', { path: 'rows' })
+  )
     .node('approve-copy', 'decision.approval', {
       kind: 'approve-transcript',
       prompt:
-        'Approve the promo copy for every row. Respond with {rows: [...]} where each row carries its final copy plus name, priceText, image, and language.',
-      payloadFrom: upstream('rows'),
+        'Approve localized promo rows. Respond with {rows: [...]} where each row has final copy and language.',
+      payloadFrom: upstream('contact-sheet'),
+    })
+    .node('apply-approved-copy', 'editor.commandTransaction', {
+      label: 'Create approved promo copy artifacts',
+      commands: buildApprovalApplyCommand('Approved multilingual promo copy'),
     })
     .node('per-language', 'control.map', {
       workflow: buildPromoItemWorkflow(),
       itemsFrom: upstream('approve-copy', 'response.rows'),
     })
+    .node('run-report', 'transform.compose', {
+      fields: {
+        providerRefs: literal(DEFAULT_PROVIDER_REFS),
+        costApproval: upstream('confirm-cost', 'response'),
+        copyApproval: upstream('approve-copy', 'response'),
+        deliveries: upstream('per-language'),
+      },
+    })
     .node('manifest', 'output.metadata', {
       folderId: EXPORT_FOLDER_ID,
       fileName: 'multilingual-promo-run.json',
-      source: upstream('per-language'),
+      source: upstream('run-report'),
     })
-    .edge('rows', 'approve-copy')
+    .edge('contact-sheet', 'approve-copy')
+    .edge('confirm-cost', 'approve-copy')
+    .edge('approve-copy', 'apply-approved-copy')
     .edge('approve-copy', 'per-language')
-    .edge('per-language', 'manifest')
+    .edge('apply-approved-copy', 'per-language')
+    .edge('confirm-cost', 'run-report')
+    .edge('approve-copy', 'run-report')
+    .edge('per-language', 'run-report')
+    .edge('run-report', 'manifest');
+  return addPackPermissions(builder)
     .permission('provider.translate')
     .permission('provider.tts')
-    .permission('render.final')
-    .permission('output.write')
     .build();
 }
 
-// ---------------------------------------------------------------------------
-// 3. Podcast cleanup (§23.4).
-// ---------------------------------------------------------------------------
-
-/** Per-chapter sub-workflow: final clip render → export folder. */
 function buildPodcastClipItemWorkflow(): JoyWorkflow {
-  const { registry } = buildNodeLibrary();
-  return new WorkflowBuilder(registry, {
-    id: 'joy.first-party.podcast-cleanup.clip',
-    version: FIRST_PARTY_WORKFLOWS_VERSION,
-    name: 'Podcast clip per chapter',
-    inputs: { type: 'object', description: 'One chapter (self-contained renderable reference).' },
-    outputs: { type: 'object' },
-  })
-    .node(
-      'clip',
-      'render.final',
-      { profile: 'podcast-clip', source: input() },
-      { retry: FINAL_RENDER_RETRY },
-    )
-    .node('save', 'output.folder', { folderId: EXPORT_FOLDER_ID, source: upstream('clip') })
-    .edge('clip', 'save')
-    .build().workflow;
+  return buildFinalDeliveryWorkflow(
+    'joy.first-party.podcast-cleanup.clip',
+    'Podcast clip delivery per chapter',
+    'podcast-clip',
+  );
 }
 
-/**
- * §23.4 "Podcast cleanup": ingest → speaker detection + confirmation (parks;
- * the independent audio branch keeps running, §23.6) → denoise → normalize →
- * silence detection → human-approved edit list (parks; the approved ranges are
- * authoritative) → trim → transcript, chapters, captions → episode final render
- * + one clip per chapter (map) → audit manifest.
- */
 export function buildPodcastCleanupWorkflow(): FirstPartyWorkflow {
   const { registry } = buildNodeLibrary();
-  return new WorkflowBuilder(registry, {
-    id: 'joy.first-party.podcast-cleanup',
-    version: FIRST_PARTY_WORKFLOWS_VERSION,
-    name: 'Podcast cleanup',
-    inputs: {
-      type: 'object',
-      required: ['source'],
-      properties: {
-        source: { type: 'object', description: 'Opaque episode audio/video asset reference.' },
-      },
-      additionalProperties: false,
-    },
-    outputs: {
-      type: 'object',
-      required: ['save-episode', 'manifest'],
-      properties: { 'save-episode': { type: 'object' }, manifest: { type: 'object' } },
+  const builder = baseContentPipeline(
+    new WorkflowBuilder(registry, {
+      id: 'joy.first-party.podcast-cleanup',
+      version: FIRST_PARTY_WORKFLOWS_VERSION,
+      name: 'Podcast cleanup',
+      inputs: CONTENT_INPUTS,
+      outputs: MANIFEST_OUTPUTS,
+      policy: { failure: 'continue-independent' },
+    }),
+    {
+      scriptStyle: 'podcast cleanup plan',
+      shotlistFormat: 'chaptered-audio',
+      candidateTitle: 'Podcast chapter contact sheet',
+      candidateCount: 3,
+      costUsd: 6,
     },
-  })
-    .node('ingest', 'input.item', { path: 'source' })
-    .node('speakers', 'analysis.speakers', { source: upstream('ingest') })
+  )
+    .node('speakers', 'analysis.speakers', { source: upstream('selected-media') })
     .node('confirm-speakers', 'decision.approval', {
       kind: 'choose-candidates',
-      prompt: 'Confirm or correct the detected speakers. Respond with {speakers: [...]}.',
+      prompt: 'Confirm or correct detected speakers. Respond with {speakers: [...]}.',
       payloadFrom: upstream('speakers'),
     })
-    .node('denoise', 'transform.denoise', { source: upstream('ingest') })
+    .node('denoise', 'transform.denoise', { source: upstream('selected-media') })
     .node('normalize', 'transform.normalizeAudio', { targetLufs: -16, source: upstream('denoise') })
     .node('silence', 'analysis.silence', {
       thresholdDb: -40,
       minSilenceMs: 1500,
       source: upstream('normalize'),
     })
     .node('approve-edit-list', 'decision.approval', {
       kind: 'accept-edit-diff',
       prompt:
-        'Approve the silence-removal edit list. Respond with {ranges: [...]}; exactly the approved ranges are removed.',
+        'Approve the silence-removal edit list. Respond with {ranges: [...]}; exactly those ranges are removed.',
       payloadFrom: upstream('silence'),
     })
+    .node('apply-approved-edits', 'editor.commandTransaction', {
+      label: 'Create approved podcast edit artifacts',
+      commands: buildApprovalApplyCommand('Approved podcast cleanup edits'),
+    })
     .node('trim', 'transform.trim', {
       source: upstream('normalize'),
       rangesFrom: upstream('approve-edit-list', 'response.ranges'),
     })
     .node('transcribe', 'analysis.transcribe', { source: upstream('trim') })
     .node('chapters', 'analysis.chapters', {
       source: upstream('trim'),
       transcriptFrom: upstream('transcribe'),
     })
     .node('captions', 'transform.caption', {
       templateId: CAPTION_TEMPLATE_ID,
       source: upstream('transcribe'),
     })
-    .node(
-      'render-episode',
-      'render.final',
-      { profile: 'podcast-episode', source: upstream('captions') },
-      { retry: FINAL_RENDER_RETRY },
-    )
-    .node('save-episode', 'output.folder', {
-      folderId: EXPORT_FOLDER_ID,
-      fileName: 'episode',
+    .node('render-episode', 'render.final', {
+      profile: 'podcast-episode',
+      source: upstream('captions'),
+    })
+    .node('inspect-episode', 'render.inspect', {
       source: upstream('render-episode'),
+      reportRef: 'joy.first-party.podcast-cleanup.qa-report',
     })
     .node('clips', 'control.map', {
       workflow: buildPodcastClipItemWorkflow(),
       itemsFrom: upstream('chapters', 'chapters'),
     })
-    .node('audit', 'transform.compose', {
+    .node('run-report', 'transform.compose', {
       fields: {
+        providerRefs: literal(DEFAULT_PROVIDER_REFS),
+        costApproval: upstream('confirm-cost', 'response'),
         speakers: upstream('confirm-speakers', 'response'),
         editList: upstream('approve-edit-list', 'response'),
         chapters: upstream('chapters'),
+        episodeInspection: upstream('inspect-episode'),
         clips: upstream('clips'),
       },
     })
-    .node('manifest', 'output.metadata', {
+    .node('manifest', 'output.deliveryManifest', {
       folderId: EXPORT_FOLDER_ID,
       fileName: 'podcast-cleanup-run.json',
-      source: upstream('audit'),
+      source: upstream('render-episode'),
+      inspectionFrom: upstream('inspect-episode'),
+      approvalsFrom: upstream('run-report'),
+      providerRefs: DEFAULT_PROVIDER_REFS,
     })
-    .edge('ingest', 'speakers')
+    .edge('selected-media', 'speakers')
     .edge('speakers', 'confirm-speakers')
-    .edge('ingest', 'denoise')
+    .edge('selected-media', 'denoise')
     .edge('denoise', 'normalize')
     .edge('normalize', 'silence')
     .edge('silence', 'approve-edit-list')
+    .edge('approve-edit-list', 'apply-approved-edits')
     .edge('normalize', 'trim')
     .edge('approve-edit-list', 'trim')
+    .edge('apply-approved-edits', 'trim')
     .edge('trim', 'transcribe')
     .edge('trim', 'chapters')
     .edge('transcribe', 'chapters')
     .edge('transcribe', 'captions')
     .edge('captions', 'render-episode')
-    .edge('render-episode', 'save-episode')
+    .edge('render-episode', 'inspect-episode')
     .edge('chapters', 'clips')
-    .edge('confirm-speakers', 'audit')
-    .edge('approve-edit-list', 'audit')
-    .edge('chapters', 'audit')
-    .edge('clips', 'audit')
-    .edge('audit', 'manifest')
+    .edge('confirm-cost', 'run-report')
+    .edge('confirm-speakers', 'run-report')
+    .edge('approve-edit-list', 'run-report')
+    .edge('chapters', 'run-report')
+    .edge('inspect-episode', 'run-report')
+    .edge('clips', 'run-report')
+    .edge('render-episode', 'manifest')
+    .edge('inspect-episode', 'manifest')
+    .edge('run-report', 'manifest');
+  return addPackPermissions(builder)
     .permission('provider.audio-cleanup')
     .permission('provider.transcribe')
-    .permission('render.final')
-    .permission('output.write')
     .build();
 }
 
-// ---------------------------------------------------------------------------
-// Catalog + serialized artifacts.
-// ---------------------------------------------------------------------------
+export function buildReferenceSocialCutdownWorkflow(): FirstPartyWorkflow {
+  const { registry } = buildNodeLibrary();
+  const builder = baseContentPipeline(
+    new WorkflowBuilder(registry, {
+      id: 'joy.first-party.reference-social-cutdown',
+      version: FIRST_PARTY_WORKFLOWS_VERSION,
+      name: 'Reference social cutdown',
+      inputs: CONTENT_INPUTS,
+      outputs: MANIFEST_OUTPUTS,
+    }),
+    {
+      scriptStyle: 'clean-room social cutdown',
+      shotlistFormat: 'reference-driven-cutdown',
+      candidateTitle: 'Clean-room reference cutdown contact sheet',
+      candidateCount: 6,
+      costUsd: 10,
+    },
+  )
+    .node('approve-cutdown', 'decision.approval', {
+      kind: 'choose-candidates',
+      prompt:
+        'Choose clean-room social cutdown candidates. Respond with {candidates: [...]} using only reference-derived structure, not copied assets.',
+      payloadFrom: upstream('contact-sheet'),
+    })
+    .node('apply-cutdown', 'editor.commandTransaction', {
+      label: 'Create approved reference cutdown artifacts',
+      commands: buildApprovalApplyCommand('Approved clean-room social cutdown'),
+    })
+    .node('finals', 'control.map', {
+      workflow: buildFinalDeliveryWorkflow(
+        'joy.first-party.reference-social-cutdown.delivery',
+        'Reference social cutdown delivery',
+        'social-cutdown-vertical',
+      ),
+      itemsFrom: upstream('approve-cutdown', 'response.candidates'),
+    })
+    .node('run-report', 'transform.compose', {
+      fields: {
+        providerRefs: literal(DEFAULT_PROVIDER_REFS),
+        costApproval: upstream('confirm-cost', 'response'),
+        creativeApproval: upstream('approve-cutdown', 'response'),
+        deliveries: upstream('finals'),
+      },
+    })
+    .node('manifest', 'output.metadata', {
+      folderId: EXPORT_FOLDER_ID,
+      fileName: 'reference-social-cutdown-run.json',
+      source: upstream('run-report'),
+    })
+    .edge('contact-sheet', 'approve-cutdown')
+    .edge('confirm-cost', 'approve-cutdown')
+    .edge('approve-cutdown', 'apply-cutdown')
+    .edge('approve-cutdown', 'finals')
+    .edge('apply-cutdown', 'finals')
+    .edge('confirm-cost', 'run-report')
+    .edge('approve-cutdown', 'run-report')
+    .edge('finals', 'run-report')
+    .edge('run-report', 'manifest');
+  return addPackPermissions(builder).permission('provider.reference-analysis').build();
+}
+
+export function buildInterviewDocumentaryAssemblyWorkflow(): FirstPartyWorkflow {
+  const { registry } = buildNodeLibrary();
+  const builder = baseContentPipeline(
+    new WorkflowBuilder(registry, {
+      id: 'joy.first-party.interview-documentary-assembly',
+      version: FIRST_PARTY_WORKFLOWS_VERSION,
+      name: 'Interview documentary assembly',
+      inputs: CONTENT_INPUTS,
+      outputs: MANIFEST_OUTPUTS,
+    }),
+    {
+      scriptStyle: 'documentary assembly treatment',
+      shotlistFormat: 'interview-documentary',
+      candidateTitle: 'Documentary assembly contact sheet',
+      candidateCount: 5,
+      costUsd: 14,
+    },
+  )
+    .node('transcribe', 'analysis.transcribe', { source: upstream('selected-media') })
+    .node('chapters', 'analysis.chapters', {
+      source: upstream('selected-media'),
+      transcriptFrom: upstream('transcribe'),
+    })
+    .node('approve-assembly', 'decision.approval', {
+      kind: 'choose-candidates',
+      prompt:
+        'Choose the interview/documentary assembly structure. Respond with {candidates: [...]} for renderable assemblies.',
+      payloadFrom: upstream('contact-sheet'),
+    })
+    .node('apply-assembly', 'editor.commandTransaction', {
+      label: 'Create approved documentary assembly artifacts',
+      commands: buildApprovalApplyCommand('Approved interview documentary assembly'),
+    })
+    .node('finals', 'control.map', {
+      workflow: buildFinalDeliveryWorkflow(
+        'joy.first-party.interview-documentary-assembly.delivery',
+        'Interview documentary delivery',
+        'documentary-assembly',
+      ),
+      itemsFrom: upstream('approve-assembly', 'response.candidates'),
+    })
+    .node('run-report', 'transform.compose', {
+      fields: {
+        providerRefs: literal(DEFAULT_PROVIDER_REFS),
+        costApproval: upstream('confirm-cost', 'response'),
+        assemblyApproval: upstream('approve-assembly', 'response'),
+        transcript: upstream('transcribe'),
+        chapters: upstream('chapters'),
+        deliveries: upstream('finals'),
+      },
+    })
+    .node('manifest', 'output.metadata', {
+      folderId: EXPORT_FOLDER_ID,
+      fileName: 'interview-documentary-assembly-run.json',
+      source: upstream('run-report'),
+    })
+    .edge('selected-media', 'transcribe')
+    .edge('transcribe', 'chapters')
+    .edge('selected-media', 'chapters')
+    .edge('contact-sheet', 'approve-assembly')
+    .edge('confirm-cost', 'approve-assembly')
+    .edge('approve-assembly', 'apply-assembly')
+    .edge('approve-assembly', 'finals')
+    .edge('apply-assembly', 'finals')
+    .edge('confirm-cost', 'run-report')
+    .edge('approve-assembly', 'run-report')
+    .edge('transcribe', 'run-report')
+    .edge('chapters', 'run-report')
+    .edge('finals', 'run-report')
+    .edge('run-report', 'manifest');
+  return addPackPermissions(builder).permission('provider.transcribe').build();
+}
 
 export const FIRST_PARTY_WORKFLOW_IDS = [
   'joy.first-party.long-video-draft-reels',
   'joy.first-party.multilingual-promo',
   'joy.first-party.podcast-cleanup',
+  'joy.first-party.reference-social-cutdown',
+  'joy.first-party.interview-documentary-assembly',
 ] as const;
 
+export type FirstPartyWorkflowId = (typeof FIRST_PARTY_WORKFLOW_IDS)[number];
+
+const PACK_DESCRIPTORS: readonly PackDescriptor[] = [
+  {
+    id: 'joy.first-party.long-video-draft-reels',
+    fileName: 'long-video-draft-reels.json',
+    label: 'Production pack',
+    summary:
+      'Brief-to-research reel pipeline with contact sheet, approvals, final QA, and manifest.',
+    requiredPorts: [
+      'analysis.researchBrief',
+      'generation.generateScript',
+      'generation.generateShotlist',
+      'analysis.detectHighlights',
+      'transform.buildContactSheet',
+      'editor.executeCommandTransaction',
+      'render.render',
+      'render.inspect',
+      'output.writeDeliveryManifest',
+      'output.writeMetadataFile',
+    ],
+    optionalPorts: ['analysis.transcribe'],
+    capabilities: ['provider.research', 'provider.script', 'provider.highlights', 'render.final'],
+    approvals: ['confirm-cost', 'choose-candidates', 'approve-render'],
+    reportRefs: ['joy.first-party.long-video-draft-reels.final.qa-report'],
+    build: buildLongVideoDraftReelsWorkflow,
+  },
+  {
+    id: 'joy.first-party.multilingual-promo',
+    fileName: 'multilingual-promo.json',
+    label: 'Production pack',
+    summary: 'Localized promo pipeline with copy approval, TTS, final QA, and delivery manifest.',
+    requiredPorts: [
+      'analysis.researchBrief',
+      'generation.generateScript',
+      'generation.generateShotlist',
+      'generation.translate',
+      'generation.synthesizeSpeech',
+      'render.render',
+      'render.inspect',
+      'output.writeDeliveryManifest',
+      'output.writeMetadataFile',
+    ],
+    capabilities: ['provider.translate', 'provider.tts', 'render.final'],
+    approvals: ['confirm-cost', 'approve-transcript'],
+    reportRefs: ['joy.first-party.multilingual-promo.qa-report'],
+    build: buildMultilingualPromoWorkflow,
+  },
+  {
+    id: 'joy.first-party.podcast-cleanup',
+    fileName: 'podcast-cleanup.json',
+    label: 'Production pack',
+    summary:
+      'Podcast cleanup with approved speakers/edit list, episode render, clips, QA, and manifest.',
+    requiredPorts: [
+      'analysis.researchBrief',
+      'analysis.detectSpeakers',
+      'analysis.detectSilence',
+      'transform.denoise',
+      'transform.normalizeAudio',
+      'transform.trim',
+      'analysis.transcribe',
+      'analysis.generateChapters',
+      'render.render',
+      'render.inspect',
+      'output.writeDeliveryManifest',
+    ],
+    capabilities: ['provider.audio-cleanup', 'provider.transcribe', 'render.final'],
+    approvals: ['confirm-cost', 'choose-candidates', 'accept-edit-diff'],
+    reportRefs: ['joy.first-party.podcast-cleanup.qa-report'],
+    build: buildPodcastCleanupWorkflow,
+  },
+  {
+    id: 'joy.first-party.reference-social-cutdown',
+    fileName: 'reference-social-cutdown.json',
+    label: 'Production pack',
+    summary:
+      'Clean-room reference-driven social cutdown from brief/media/references to QA delivery.',
+    requiredPorts: [
+      'analysis.researchBrief',
+      'generation.generateScript',
+      'generation.generateShotlist',
+      'analysis.detectHighlights',
+      'transform.buildContactSheet',
+      'editor.executeCommandTransaction',
+      'render.render',
+      'render.inspect',
+      'output.writeDeliveryManifest',
+      'output.writeMetadataFile',
+    ],
+    capabilities: ['provider.reference-analysis', 'provider.script', 'render.final'],
+    approvals: ['confirm-cost', 'choose-candidates'],
+    reportRefs: ['joy.first-party.reference-social-cutdown.delivery.qa-report'],
+    build: buildReferenceSocialCutdownWorkflow,
+  },
+  {
+    id: 'joy.first-party.interview-documentary-assembly',
+    fileName: 'interview-documentary-assembly.json',
+    label: 'Production pack',
+    summary:
+      'Interview/documentary assembly with transcript/chapter evidence, approval, QA, and manifest.',
+    requiredPorts: [
+      'analysis.researchBrief',
+      'generation.generateScript',
+      'generation.generateShotlist',
+      'analysis.transcribe',
+      'analysis.generateChapters',
+      'transform.buildContactSheet',
+      'editor.executeCommandTransaction',
+      'render.render',
+      'render.inspect',
+      'output.writeDeliveryManifest',
+      'output.writeMetadataFile',
+    ],
+    capabilities: ['provider.transcribe', 'provider.script', 'render.final'],
+    approvals: ['confirm-cost', 'choose-candidates'],
+    reportRefs: ['joy.first-party.interview-documentary-assembly.delivery.qa-report'],
+    build: buildInterviewDocumentaryAssemblyWorkflow,
+  },
+];
+
+export function buildFirstPartyPipelinePacks(): readonly FirstPartyPipelinePack[] {
+  return PACK_DESCRIPTORS.map((descriptor) => {
+    const built = descriptor.build();
+    return {
+      ...built,
+      label: descriptor.label,
+      summary: descriptor.summary,
+      provider: 'production',
+      requiredPorts: descriptor.requiredPorts,
+      optionalPorts: descriptor.optionalPorts ?? [],
+      capabilities: descriptor.capabilities,
+      approvals: descriptor.approvals,
+      reportRefs: descriptor.reportRefs,
+    };
+  });
+}
+
 /** Builds every first-party workflow (registry-validated). */
 export function buildFirstPartyWorkflows(): readonly FirstPartyWorkflow[] {
-  return [
-    buildLongVideoDraftReelsWorkflow(),
-    buildMultilingualPromoWorkflow(),
-    buildPodcastCleanupWorkflow(),
-  ];
+  return buildFirstPartyPipelinePacks().map(({ workflow, order }) => ({ workflow, order }));
 }
 
 export interface FirstPartyDefinitionFile {
   /** File name under `packages/workflow-engine/workflows/`. */
   readonly fileName: string;
   /** Stable `workflowToJson` serialization (diffable, `joy-workflow` CLI-runnable). */
   readonly json: string;
 }
 
 /** The committed JSON artifacts; a test pins the files byte-for-byte to these. */
 export function firstPartyDefinitionFiles(): readonly FirstPartyDefinitionFile[] {
-  return [
-    {
-      fileName: 'long-video-draft-reels.json',
-      json: workflowToJson(buildLongVideoDraftReelsWorkflow().workflow),
-    },
-    {
-      fileName: 'multilingual-promo.json',
-      json: workflowToJson(buildMultilingualPromoWorkflow().workflow),
-    },
-    {
-      fileName: 'podcast-cleanup.json',
-      json: workflowToJson(buildPodcastCleanupWorkflow().workflow),
-    },
-  ];
+  return PACK_DESCRIPTORS.map((descriptor) => ({
+    fileName: descriptor.fileName,
+    json: workflowToJson(descriptor.build().workflow),
+  }));
 }
diff --git a/packages/workflow-engine/src/index.ts b/packages/workflow-engine/src/index.ts
index 49ed2b6..a055b36 100644
--- a/packages/workflow-engine/src/index.ts
+++ b/packages/workflow-engine/src/index.ts
@@ -161,17 +161,25 @@ export type {
   RecordProductionApprovalResponseResult,
 } from './production-run.js';
 
 export { runWorkflowHeadless } from './headless.js';
 export type { HeadlessRunOptions, HeadlessRunResult } from './headless.js';
 
 // WP-07.4 — first-party workflows (§23.4)
 export {
   FIRST_PARTY_WORKFLOWS_VERSION,
   FIRST_PARTY_WORKFLOW_IDS,
+  buildFirstPartyPipelinePacks,
   buildFirstPartyWorkflows,
+  buildInterviewDocumentaryAssemblyWorkflow,
   buildLongVideoDraftReelsWorkflow,
   buildMultilingualPromoWorkflow,
   buildPodcastCleanupWorkflow,
+  buildReferenceSocialCutdownWorkflow,
   firstPartyDefinitionFiles,
 } from './first-party.js';
-export type { FirstPartyDefinitionFile, FirstPartyWorkflow } from './first-party.js';
+export type {
+  FirstPartyDefinitionFile,
+  FirstPartyPipelinePack,
+  FirstPartyWorkflow,
+  FirstPartyWorkflowId,
+} from './first-party.js';
diff --git a/packages/workflow-engine/src/library.ts b/packages/workflow-engine/src/library.ts
index bc618c4..91edd40 100644
--- a/packages/workflow-engine/src/library.ts
+++ b/packages/workflow-engine/src/library.ts
@@ -141,20 +141,40 @@ function validateOptionalRef(
   params: Readonly<Record<string, unknown>>,
   key: string,
   issues: NodeParamIssue[],
 ): void {
   const value = params[key];
   if (value !== undefined && !isValueRef(value)) {
     issues.push(paramIssue(key, 'must be a value reference ({kind: literal|input|upstream})'));
   }
 }
 
+function validateRequiredRef(
+  params: Readonly<Record<string, unknown>>,
+  key: string,
+  issues: NodeParamIssue[],
+): void {
+  if (!isValueRef(params[key])) {
+    issues.push(paramIssue(key, 'must be a value reference'));
+  }
+}
+
+function optionalStringArrayParam(
+  ctx: NodeExecutionContext,
+  key: string,
+): readonly string[] | undefined {
+  const value = ctx.node.params[key];
+  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
+    ? value
+    : undefined;
+}
+
 // ---------------------------------------------------------------------------
 // Typed conditions (§23.2 decision: "typed conditions").
 // ---------------------------------------------------------------------------
 
 export type WorkflowCondition =
   | {
       readonly op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';
       readonly left: ValueRef;
       readonly right: ValueRef;
     }
@@ -286,20 +306,25 @@ export function evaluateCondition(
       return condition.conditions.some((item) => evaluateCondition(item, ctx));
   }
 }
 
 // ---------------------------------------------------------------------------
 // Ports (§45.2 dependency inversion): effectful capabilities the library adapts.
 // Missing ports produce coded non-retryable failures — capabilities are discovered.
 // ---------------------------------------------------------------------------
 
 export interface AnalysisPorts {
+  readonly researchBrief?: (args: {
+    readonly brief: unknown;
+    readonly media: unknown;
+    readonly references?: unknown;
+  }) => unknown;
   readonly transcribe?: (args: { readonly source: unknown; readonly language?: string }) => unknown;
   readonly detectSilence?: (args: {
     readonly source: unknown;
     readonly thresholdDb?: number;
     readonly minSilenceMs?: number;
   }) => unknown;
   readonly measureLoudness?: (args: { readonly source: unknown }) => unknown;
   /**
    * Proposes topic/hook candidates for short-form drafts (§23.4). Returned
    * candidates should be self-contained (carry their source and subject hints)
@@ -341,66 +366,96 @@ export interface TransformPorts {
   readonly normalizeAudio?: (args: {
     readonly source: unknown;
     readonly targetLufs?: number;
     readonly duckMusic?: boolean;
   }) => unknown;
   /** Instantiates an HTML scene template (§20.4) with bound variables. */
   readonly instantiateSceneTemplate?: (args: {
     readonly templateId: string;
     readonly variables: unknown;
   }) => unknown;
+  readonly buildContactSheet?: (args: {
+    readonly title: string;
+    readonly candidates: unknown;
+    readonly shotlist?: unknown;
+    readonly providerRefs?: readonly string[];
+  }) => unknown;
 }
 
 export interface GenerationPorts {
   readonly synthesizeSpeech?: (args: {
     readonly text: string;
     readonly voiceId: string;
     readonly language?: string;
   }) => unknown;
   readonly generateImage?: (args: { readonly prompt: string }) => unknown;
   readonly translate?: (args: {
     readonly text: string;
     readonly targetLanguage: string;
     readonly sourceLanguage?: string;
   }) => unknown;
+  readonly generateScript?: (args: {
+    readonly brief: unknown;
+    readonly research: unknown;
+    readonly media: unknown;
+    readonly style?: string;
+  }) => unknown;
+  readonly generateShotlist?: (args: {
+    readonly script: unknown;
+    readonly media: unknown;
+    readonly format?: string;
+  }) => unknown;
 }
 
 export interface EditorPorts {
   /** Executes one command-bus transaction; never mutates project JSON directly (§44). */
   readonly executeCommandTransaction?: (args: {
     readonly label: string;
     readonly commands: readonly unknown[];
   }) => { readonly transactionId: string };
   readonly createBranch?: (args: { readonly name: string; readonly source: unknown }) => {
     readonly branchId: string;
   };
 }
 
 export interface RenderPorts {
   readonly render?: (args: {
     readonly mode: 'preview' | 'final';
     readonly source: unknown;
     readonly profile?: string;
   }) => unknown;
+  readonly inspect?: (args: {
+    readonly source: unknown;
+    readonly deliveryPromise?: unknown;
+    readonly reportRef?: string;
+  }) => unknown;
 }
 
 export interface OutputPorts {
   readonly writeToFolder?: (args: {
     readonly folderId: string;
     readonly artifact: unknown;
     readonly fileName?: string;
   }) => unknown;
   readonly writeMetadataFile?: (args: {
     readonly folderId: string;
     readonly fileName: string;
     readonly metadata: unknown;
   }) => unknown;
+  readonly writeDeliveryManifest?: (args: {
+    readonly folderId: string;
+    readonly fileName: string;
+    readonly artifact: unknown;
+    readonly inspection?: unknown;
+    readonly approvals?: unknown;
+    readonly providerRefs?: readonly string[];
+  }) => unknown;
 }
 
 /** Persists partial map/batch progress across parent-run resumes, keyed by node run key. */
 export interface MapStateStore {
   get(runKey: string): MapBatchState | undefined;
   set(runKey: string, state: MapBatchState): void;
 }
 
 export class InMemoryMapStateStore implements MapStateStore {
   private readonly states = new Map<string, MapBatchState>();
@@ -591,20 +646,55 @@ export function buildNodeLibrary(options: BuildNodeLibraryOptions = {}): NodeLib
       const issues: NodeParamIssue[] = [];
       requireString(params, 'projectId', issues);
       return issues;
     },
     guarded((ctx) =>
       okResult({ projectId: stringParam(ctx, 'projectId'), revision: ctx.projectRevision }),
     ),
   );
 
   // --- analysis -----------------------------------------------------------
+  register(
+    'analysis.researchBrief',
+    'analysis',
+    'Researches a creative brief against selected media and reference material for production packs.',
+    true,
+    (params) => {
+      const issues: NodeParamIssue[] = [];
+      validateRequiredRef(params, 'briefFrom', issues);
+      validateRequiredRef(params, 'mediaFrom', issues);
+      validateOptionalRef(params, 'referencesFrom', issues);
+      return issues;
+    },
+    portBacked(ports.analysis?.researchBrief, 'analysis.researchBrief', (port, ctx) => {
+      const briefRef = ctx.node.params['briefFrom'];
+      const mediaRef = ctx.node.params['mediaFrom'];
+      const referencesRef = ctx.node.params['referencesFrom'];
+      if (!isValueRef(briefRef) || !isValueRef(mediaRef)) {
+        throw new NodeLibraryError(
+          'workflow/invalid-params',
+          'briefFrom and mediaFrom must be value references',
+        );
+      }
+      const references = isValueRef(referencesRef)
+        ? resolveValueRef(referencesRef, ctx)
+        : undefined;
+      return okResult(
+        port({
+          brief: resolveValueRef(briefRef, ctx),
+          media: resolveValueRef(mediaRef, ctx),
+          ...(references !== undefined ? { references } : {}),
+        }),
+      );
+    }),
+  );
+
   register(
     'analysis.transcribe',
     'analysis',
     'Transcribes the source via the analysis port (local-first adapters, §21.6).',
     true,
     (params) => {
       const issues: NodeParamIssue[] = [];
       optionalString(params, 'language', issues);
       validateOptionalRef(params, 'source', issues);
       return issues;
@@ -900,20 +990,61 @@ export function buildNodeLibrary(options: BuildNodeLibraryOptions = {}): NodeLib
       (port, ctx) => {
         const varsRef = ctx.node.params['variablesFrom'];
         const variables = isValueRef(varsRef)
           ? resolveValueRef(varsRef, ctx)
           : ctx.node.params['variables'];
         return okResult(port({ templateId: stringParam(ctx, 'templateId'), variables }));
       },
     ),
   );
 
+  register(
+    'transform.contactSheet',
+    'transform',
+    'Builds a reviewable contact sheet from candidates and shot-list context.',
+    true,
+    (params) => {
+      const issues: NodeParamIssue[] = [];
+      requireString(params, 'title', issues);
+      validateRequiredRef(params, 'candidatesFrom', issues);
+      validateOptionalRef(params, 'shotlistFrom', issues);
+      const providerRefs = params['providerRefs'];
+      if (
+        providerRefs !== undefined &&
+        (!Array.isArray(providerRefs) || providerRefs.some((entry) => typeof entry !== 'string'))
+      ) {
+        issues.push(paramIssue('providerRefs', 'must be an array of strings when present'));
+      }
+      return issues;
+    },
+    portBacked(ports.transform?.buildContactSheet, 'transform.buildContactSheet', (port, ctx) => {
+      const candidatesRef = ctx.node.params['candidatesFrom'];
+      if (!isValueRef(candidatesRef)) {
+        throw new NodeLibraryError(
+          'workflow/invalid-params',
+          'candidatesFrom must be a value reference',
+        );
+      }
+      const shotlistRef = ctx.node.params['shotlistFrom'];
+      const shotlist = isValueRef(shotlistRef) ? resolveValueRef(shotlistRef, ctx) : undefined;
+      const providerRefs = optionalStringArrayParam(ctx, 'providerRefs');
+      return okResult(
+        port({
+          title: stringParam(ctx, 'title'),
+          candidates: resolveValueRef(candidatesRef, ctx),
+          ...(shotlist !== undefined ? { shotlist } : {}),
+          ...(providerRefs !== undefined ? { providerRefs } : {}),
+        }),
+      );
+    }),
+  );
+
   register(
     'transform.compose',
     'transform',
     'Builds one object from named value references — pure fan-in for multi-input downstream nodes.',
     true,
     (params) => {
       const fields = params['fields'];
       if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
         return [paramIssue('fields', 'must be an object of value references')];
       }
@@ -1039,20 +1170,91 @@ export function buildNodeLibrary(options: BuildNodeLibraryOptions = {}): NodeLib
       return okResult(
         port({
           text,
           targetLanguage,
           ...(sourceLanguage !== undefined ? { sourceLanguage } : {}),
         }),
       );
     }),
   );
 
+  register(
+    'generation.script',
+    'generation',
+    'Generates a production script from a brief, selected media, and research notes.',
+    false,
+    (params) => {
+      const issues: NodeParamIssue[] = [];
+      validateRequiredRef(params, 'briefFrom', issues);
+      validateRequiredRef(params, 'researchFrom', issues);
+      validateRequiredRef(params, 'mediaFrom', issues);
+      optionalString(params, 'style', issues);
+      return issues;
+    },
+    portBacked(ports.generation?.generateScript, 'generation.generateScript', (port, ctx) => {
+      const briefRef = ctx.node.params['briefFrom'];
+      const researchRef = ctx.node.params['researchFrom'];
+      const mediaRef = ctx.node.params['mediaFrom'];
+      if (!isValueRef(briefRef) || !isValueRef(researchRef) || !isValueRef(mediaRef)) {
+        throw new NodeLibraryError(
+          'workflow/invalid-params',
+          'briefFrom, researchFrom, and mediaFrom must be value references',
+        );
+      }
+      return okResult(
+        port({
+          brief: resolveValueRef(briefRef, ctx),
+          research: resolveValueRef(researchRef, ctx),
+          media: resolveValueRef(mediaRef, ctx),
+          ...(() => {
+            const style = optionalStringParam(ctx, 'style');
+            return style === undefined ? {} : { style };
+          })(),
+        }),
+      );
+    }),
+  );
+
+  register(
+    'generation.shotlist',
+    'generation',
+    'Generates an editable shot list from the approved/scripted treatment and media.',
+    false,
+    (params) => {
+      const issues: NodeParamIssue[] = [];
+      validateRequiredRef(params, 'scriptFrom', issues);
+      validateRequiredRef(params, 'mediaFrom', issues);
+      optionalString(params, 'format', issues);
+      return issues;
+    },
+    portBacked(ports.generation?.generateShotlist, 'generation.generateShotlist', (port, ctx) => {
+      const scriptRef = ctx.node.params['scriptFrom'];
+      const mediaRef = ctx.node.params['mediaFrom'];
+      if (!isValueRef(scriptRef) || !isValueRef(mediaRef)) {
+        throw new NodeLibraryError(
+          'workflow/invalid-params',
+          'scriptFrom and mediaFrom must be value references',
+        );
+      }
+      return okResult(
+        port({
+          script: resolveValueRef(scriptRef, ctx),
+          media: resolveValueRef(mediaRef, ctx),
+          ...(() => {
+            const format = optionalStringParam(ctx, 'format');
+            return format === undefined ? {} : { format };
+          })(),
+        }),
+      );
+    }),
+  );
+
   // --- decision -------------------------------------------------------------
   register(
     'decision.condition',
     'decision',
     'Evaluates a typed condition; output is {passed: boolean}.',
     true,
     (params) =>
       isWorkflowCondition(params['condition'])
         ? []
         : [paramIssue('condition', 'must be a typed workflow condition')],
@@ -1170,20 +1372,47 @@ export function buildNodeLibrary(options: BuildNodeLibraryOptions = {}): NodeLib
     renderHandler('preview'),
   );
   register(
     'render.final',
     'render',
     'Renders the final export through the deterministic render path.',
     true,
     renderValidate,
     renderHandler('final'),
   );
+  register(
+    'render.inspect',
+    'render',
+    'Inspects a rendered artifact against a delivery promise and returns a bounded QA report.',
+    true,
+    (params) => {
+      const issues: NodeParamIssue[] = [];
+      validateOptionalRef(params, 'source', issues);
+      validateOptionalRef(params, 'deliveryPromiseFrom', issues);
+      optionalString(params, 'reportRef', issues);
+      return issues;
+    },
+    portBacked(ports.render?.inspect, 'render.inspect', (port, ctx) => {
+      const deliveryPromiseRef = ctx.node.params['deliveryPromiseFrom'];
+      const deliveryPromise = isValueRef(deliveryPromiseRef)
+        ? resolveValueRef(deliveryPromiseRef, ctx)
+        : undefined;
+      const reportRef = optionalStringParam(ctx, 'reportRef');
+      return okResult(
+        port({
+          source: resolveSource(ctx, 'source'),
+          ...(deliveryPromise !== undefined ? { deliveryPromise } : {}),
+          ...(reportRef !== undefined ? { reportRef } : {}),
+        }),
+      );
+    }),
+  );
 
   // --- output ---------------------------------------------------------------
   register(
     'output.folder',
     'output',
     'Writes the artifact to a local folder reference (opaque id, not a path).',
     true,
     (params) => {
       const issues: NodeParamIssue[] = [];
       requireString(params, 'folderId', issues);
@@ -1219,20 +1448,62 @@ export function buildNodeLibrary(options: BuildNodeLibraryOptions = {}): NodeLib
       okResult(
         port({
           folderId: stringParam(ctx, 'folderId'),
           fileName: stringParam(ctx, 'fileName'),
           metadata: resolveSource(ctx, 'source'),
         }),
       ),
     ),
   );
 
+  register(
+    'output.deliveryManifest',
+    'output',
+    'Writes a delivery manifest tying the final artifact to QA, approval, and provider references.',
+    true,
+    (params) => {
+      const issues: NodeParamIssue[] = [];
+      requireString(params, 'folderId', issues);
+      requireString(params, 'fileName', issues);
+      validateOptionalRef(params, 'source', issues);
+      validateOptionalRef(params, 'inspectionFrom', issues);
+      validateOptionalRef(params, 'approvalsFrom', issues);
+      const providerRefs = params['providerRefs'];
+      if (
+        providerRefs !== undefined &&
+        (!Array.isArray(providerRefs) || providerRefs.some((entry) => typeof entry !== 'string'))
+      ) {
+        issues.push(paramIssue('providerRefs', 'must be an array of strings when present'));
+      }
+      return issues;
+    },
+    portBacked(ports.output?.writeDeliveryManifest, 'output.writeDeliveryManifest', (port, ctx) => {
+      const inspectionRef = ctx.node.params['inspectionFrom'];
+      const approvalsRef = ctx.node.params['approvalsFrom'];
+      const inspection = isValueRef(inspectionRef)
+        ? resolveValueRef(inspectionRef, ctx)
+        : undefined;
+      const approvals = isValueRef(approvalsRef) ? resolveValueRef(approvalsRef, ctx) : undefined;
+      const providerRefs = optionalStringArrayParam(ctx, 'providerRefs');
+      return okResult(
+        port({
+          folderId: stringParam(ctx, 'folderId'),
+          fileName: stringParam(ctx, 'fileName'),
+          artifact: resolveSource(ctx, 'source'),
+          ...(inspection !== undefined ? { inspection } : {}),
+          ...(approvals !== undefined ? { approvals } : {}),
+          ...(providerRefs !== undefined ? { providerRefs } : {}),
+        }),
+      );
+    }),
+  );
+
   // --- control ----------------------------------------------------------------
   register(
     'control.delay',
     'control',
     'Records an intended delay for schedulers; passes its input through unchanged.',
     true,
     (params) => {
       const delayMs = params['delayMs'];
       return typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs >= 0
         ? []
diff --git a/packages/workflow-engine/workflows/interview-documentary-assembly.json b/packages/workflow-engine/workflows/interview-documentary-assembly.json
new file mode 100644
index 0000000..bff5d43
--- /dev/null
+++ b/packages/workflow-engine/workflows/interview-documentary-assembly.json
@@ -0,0 +1,589 @@
+{
+  "formatVersion": 1,
+  "id": "joy.first-party.interview-documentary-assembly",
+  "version": "2.0.0",
+  "name": "Interview documentary assembly",
+  "inputs": {
+    "type": "object",
+    "required": [
+      "brief",
+      "selectedMedia"
+    ],
+    "properties": {
+      "brief": {
+        "type": "string",
+        "minLength": 1,
+        "description": "Creative brief or client goal for this production run.",
+        "default": "Create a polished, on-brand edit from the selected media."
+      },
+      "selectedMedia": {
+        "type": "object",
+        "description": "Opaque selected media references; never paths or URLs."
+      },
+      "references": {
+        "type": "array",
+        "items": {
+          "type": "object"
+        },
+        "description": "Optional clean-room reference notes or media fingerprints."
+      },
+      "rows": {
+        "type": "array",
+        "items": {
+          "type": "object"
+        },
+        "description": "Optional structured rows for promo variants."
+      },
+      "delivery": {
+        "type": "object",
+        "description": "Optional delivery promise: aspect, codec, captions, approval requirements."
+      }
+    },
+    "additionalProperties": false
+  },
+  "outputs": {
+    "type": "object",
+    "required": [
+      "manifest"
+    ],
+    "properties": {
+      "manifest": {
+        "type": "object"
+      }
+    }
+  },
+  "nodes": [
+    {
+      "id": "brief",
+      "category": "input",
+      "type": "input.item",
+      "params": {
+        "path": "brief"
+      },
+      "deterministic": true
+    },
+    {
+      "id": "selected-media",
+      "category": "input",
+      "type": "input.item",
+      "params": {
+        "path": "selectedMedia"
+      },
+      "deterministic": true
+    },
+    {
+      "id": "research",
+      "category": "analysis",
+      "type": "analysis.researchBrief",
+      "params": {
+        "briefFrom": {
+          "kind": "upstream",
+          "node": "brief"
+        },
+        "mediaFrom": {
+          "kind": "upstream",
+          "node": "selected-media"
+        }
+      },
+      "deterministic": true
+    },
+    {
+      "id": "script",
+      "category": "generation",
+      "type": "generation.script",
+      "params": {
+        "style": "documentary assembly treatment",
+        "briefFrom": {
+          "kind": "upstream",
+          "node": "brief"
+        },
+        "researchFrom": {
+          "kind": "upstream",
+          "node": "research"
+        },
+        "mediaFrom": {
+          "kind": "upstream",
+          "node": "selected-media"
+        }
+      },
+      "deterministic": false
+    },
+    {
+      "id": "shotlist",
+      "category": "generation",
+      "type": "generation.shotlist",
+      "params": {
+        "format": "interview-documentary",
+        "scriptFrom": {
+          "kind": "upstream",
+          "node": "script"
+        },
+        "mediaFrom": {
+          "kind": "upstream",
+          "node": "selected-media"
+        }
+      },
+      "deterministic": false
+    },
+    {
+      "id": "candidates",
+      "category": "analysis",
+      "type": "analysis.hooks",
+      "params": {
+        "source": {
+          "kind": "upstream",
+          "node": "selected-media"
+        },
+        "transcriptFrom": {
+          "kind": "upstream",
+          "node": "script"
+        },
+        "maxCandidates": 5
+      },
+      "deterministic": true
+    },
+    {
+      "id": "contact-sheet",
+      "category": "transform",
+      "type": "transform.contactSheet",
+      "params": {
+        "title": "Documentary assembly contact sheet",
+        "candidatesFrom": {
+          "kind": "upstream",
+          "node": "candidates"
+        },
+        "shotlistFrom": {
+          "kind": "upstream",
+          "node": "shotlist"
+        },
+        "providerRefs": [
+          "provider:analysis",
+          "provider:generation",
+          "provider:render"
+        ]
+      },
+      "deterministic": true
+    },
+    {
+      "id": "cost-brief",
+      "category": "transform",
+      "type": "transform.compose",
+      "params": {
+        "fields": {
+          "estimatedUsd": {
+            "kind": "literal",
+            "value": 14
+          },
+          "providerRefs": {
+            "kind": "literal",
+            "value": [
+              "provider:analysis",
+              "provider:generation",
+              "provider:render"
+            ]
+          },
+          "script": {
+            "kind": "upstream",
+            "node": "script"
+          },
+          "shotlist": {
+            "kind": "upstream",
+            "node": "shotlist"
+          },
+          "candidates": {
+            "kind": "upstream",
+            "node": "contact-sheet"
+          }
+        }
+      },
+      "deterministic": true
+    },
+    {
+      "id": "confirm-cost",
+      "category": "decision",
+      "type": "decision.approval",
+      "params": {
+        "kind": "confirm-cost",
+        "prompt": "Confirm provider cost before candidate review. Respond with {approved: true} to continue.",
+        "payloadFrom": {
+          "kind": "upstream",
+          "node": "cost-brief"
+        }
+      },
+      "deterministic": false
+    },
+    {
+      "id": "transcribe",
+      "category": "analysis",
+      "type": "analysis.transcribe",
+      "params": {
+        "source": {
+          "kind": "upstream",
+          "node": "selected-media"
+        }
+      },
+      "deterministic": true
+    },
+    {
+      "id": "chapters",
+      "category": "analysis",
+      "type": "analysis.chapters",
+      "params": {
+        "source": {
+          "kind": "upstream",
+          "node": "selected-media"
+        },
+        "transcriptFrom": {
+          "kind": "upstream",
+          "node": "transcribe"
+        }
+      },
+      "deterministic": true
+    },
+    {
+      "id": "approve-assembly",
+      "category": "decision",
+      "type": "decision.approval",
+      "params": {
+        "kind": "choose-candidates",
+        "prompt": "Choose the interview/documentary assembly structure. Respond with {candidates: [...]} for renderable assemblies.",
+        "payloadFrom": {
+          "kind": "upstream",
+          "node": "contact-sheet"
+        }
+      },
+      "deterministic": false
+    },
+    {
+      "id": "apply-assembly",
+      "category": "editor",
+      "type": "editor.commandTransaction",
+      "params": {
+        "label": "Create approved documentary assembly artifacts",
+        "commands": [
+          {
+            "tool": "artifact.create",
+            "arguments": {
+              "kind": "workflow-approval",
+              "label": "Approved interview documentary assembly",
+              "sourceRef": "approval.response"
+            }
+          }
+        ]
+      },
+      "deterministic": true
+    },
+    {
+      "id": "finals",
+      "category": "control",
+      "type": "control.map",
+      "params": {
+        "workflow": {
+          "formatVersion": 1,
+          "id": "joy.first-party.interview-documentary-assembly.delivery",
+          "version": "2.0.0",
+          "name": "Interview documentary delivery",
+          "inputs": {
+            "type": "object",
+            "description": "One approved render source."
+          },
+          "outputs": {
+            "type": "object"
+          },
+          "nodes": [
+            {
+              "id": "render",
+              "category": "render",
+              "type": "render.final",
+              "params": {
+                "profile": "documentary-assembly",
+                "source": {
+                  "kind": "input"
+                }
+              },
+              "deterministic": true,
+              "retry": {
+                "maxAttempts": 2,
+                "backoffMs": 1000
+              }
+            },
+            {
+              "id": "inspect",
+              "category": "render",
+              "type": "render.inspect",
+              "params": {
+                "source": {
+                  "kind": "upstream",
+                  "node": "render"
+                },
+                "reportRef": "joy.first-party.interview-documentary-assembly.delivery.qa-report"
+              },
+              "deterministic": true
+            },
+            {
+              "id": "manifest",
+              "category": "output",
+              "type": "output.deliveryManifest",
+              "params": {
+                "folderId": "exports",
+                "fileName": "delivery.json",
+                "source": {
+                  "kind": "upstream",
+                  "node": "render"
+                },
+                "inspectionFrom": {
+                  "kind": "upstream",
+                  "node": "inspect"
+                },
+                "providerRefs": [
+                  "provider:analysis",
+                  "provider:generation",
+                  "provider:render"
+                ]
+              },
+              "deterministic": true
+            }
+          ],
+          "edges": [
+            {
+              "from": "render",
+              "to": "inspect"
+            },
+            {
+              "from": "render",
+              "to": "manifest"
+            },
+            {
+              "from": "inspect",
+              "to": "manifest"
+            }
+          ],
+          "permissions": [],
+          "policy": {
+            "concurrency": 1,
+            "failure": "stop",
+            "defaultRetry": {
+              "maxAttempts": 1,
+              "backoffMs": 0
+            }
+          }
+        },
+        "itemsFrom": {
+          "kind": "upstream",
+          "node": "approve-assembly",
+          "path": "response.candidates"
+        }
+      },
+      "deterministic": true
+    },
+    {
+      "id": "run-report",
+      "category": "transform",
+      "type": "transform.compose",
+      "params": {
+        "fields": {
+          "providerRefs": {
+            "kind": "literal",
+            "value": [
+              "provider:analysis",
+              "provider:generation",
+              "provider:render"
+            ]
+          },
+          "costApproval": {
+            "kind": "upstream",
+            "node": "confirm-cost",
+            "path": "response"
+          },
+          "assemblyApproval": {
+            "kind": "upstream",
+            "node": "approve-assembly",
+            "path": "response"
+          },
+          "transcript": {
+            "kind": "upstream",
+            "node": "transcribe"
+          },
+          "chapters": {
+            "kind": "upstream",
+            "node": "chapters"
+          },
+          "deliveries": {
+            "kind": "upstream",
+            "node": "finals"
+          }
+        }
+      },
+      "deterministic": true
+    },
+    {
+      "id": "manifest",
+      "category": "output",
+      "type": "output.metadata",
+      "params": {
+        "folderId": "exports",
+        "fileName": "interview-documentary-assembly-run.json",
+        "source": {
+          "kind": "upstream",
+          "node": "run-report"
+        }
+      },
+      "deterministic": true
+    }
+  ],
+  "edges": [
+    {
+      "from": "brief",
+      "to": "research"
+    },
+    {
+      "from": "selected-media",
+      "to": "research"
+    },
+    {
+      "from": "brief",
+      "to": "script"
+    },
+    {
+      "from": "research",
+      "to": "script"
+    },
+    {
+      "from": "selected-media",
+      "to": "script"
+    },
+    {
+      "from": "script",
+      "to": "shotlist"
+    },
+    {
+      "from": "selected-media",
+      "to": "shotlist"
+    },
+    {
+      "from": "selected-media",
+      "to": "candidates"
+    },
+    {
+      "from": "script",
+      "to": "candidates"
+    },
+    {
+      "from": "candidates",
+      "to": "contact-sheet"
+    },
+    {
+      "from": "shotlist",
+      "to": "contact-sheet"
+    },
+    {
+      "from": "script",
+      "to": "cost-brief"
+    },
+    {
+      "from": "shotlist",
+      "to": "cost-brief"
+    },
+    {
+      "from": "contact-sheet",
+      "to": "cost-brief"
+    },
+    {
+      "from": "cost-brief",
+      "to": "confirm-cost"
+    },
+    {
+      "from": "selected-media",
+      "to": "transcribe"
+    },
+    {
+      "from": "transcribe",
+      "to": "chapters"
+    },
+    {
+      "from": "selected-media",
+      "to": "chapters"
+    },
+    {
+      "from": "contact-sheet",
+      "to": "approve-assembly"
+    },
+    {
+      "from": "confirm-cost",
+      "to": "approve-assembly"
+    },
+    {
+      "from": "approve-assembly",
+      "to": "apply-assembly"
+    },
+    {
+      "from": "approve-assembly",
+      "to": "finals"
+    },
+    {
+      "from": "apply-assembly",
+      "to": "finals"
+    },
+    {
+      "from": "confirm-cost",
+      "to": "run-report"
+    },
+    {
+      "from": "approve-assembly",
+      "to": "run-report"
+    },
+    {
+      "from": "transcribe",
+      "to": "run-report"
+    },
+    {
+      "from": "chapters",
+      "to": "run-report"
+    },
+    {
+      "from": "finals",
+      "to": "run-report"
+    },
+    {
+      "from": "run-report",
+      "to": "manifest"
+    }
+  ],
+  "permissions": [
+    {
+      "capability": "provider.research"
+    },
+    {
+      "capability": "provider.script"
+    },
+    {
+      "capability": "provider.highlights"
+    },
+    {
+      "capability": "provider.cost"
+    },
+    {
+      "capability": "editor.command"
+    },
+    {
+      "capability": "render.final"
+    },
+    {
+      "capability": "render.inspect"
+    },
+    {
+      "capability": "output.write"
+    },
+    {
+      "capability": "provider.transcribe"
+    }
+  ],
+  "policy": {
+    "concurrency": 1,
+    "failure": "stop",
+    "defaultRetry": {
+      "maxAttempts": 1,
+      "backoffMs": 0
+    }
+  }
+}
diff --git a/packages/workflow-engine/workflows/long-video-draft-reels.json b/packages/workflow-engine/workflows/long-video-draft-reels.json
index 99fa24e..3b129ca 100644
--- a/packages/workflow-engine/workflows/long-video-draft-reels.json
+++ b/packages/workflow-engine/workflows/long-video-draft-reels.json
@@ -1,105 +1,270 @@
 {
   "formatVersion": 1,
   "id": "joy.first-party.long-video-draft-reels",
-  "version": "1.0.0",
-  "name": "Long video → draft reels",
+  "version": "2.0.0",
+  "name": "Long video draft reels",
   "inputs": {
     "type": "object",
     "required": [
-      "asset"
+      "brief",
+      "selectedMedia"
     ],
     "properties": {
-      "asset": {
+      "brief": {
+        "type": "string",
+        "minLength": 1,
+        "description": "Creative brief or client goal for this production run.",
+        "default": "Create a polished, on-brand edit from the selected media."
+      },
+      "selectedMedia": {
+        "type": "object",
+        "description": "Opaque selected media references; never paths or URLs."
+      },
+      "references": {
+        "type": "array",
+        "items": {
+          "type": "object"
+        },
+        "description": "Optional clean-room reference notes or media fingerprints."
+      },
+      "rows": {
+        "type": "array",
+        "items": {
+          "type": "object"
+        },
+        "description": "Optional structured rows for promo variants."
+      },
+      "delivery": {
         "type": "object",
-        "description": "Opaque source video asset reference."
+        "description": "Optional delivery promise: aspect, codec, captions, approval requirements."
       }
     },
     "additionalProperties": false
   },
   "outputs": {
     "type": "object",
     "required": [
       "manifest"
     ],
     "properties": {
       "manifest": {
         "type": "object"
       }
     }
   },
   "nodes": [
     {
-      "id": "ingest",
+      "id": "brief",
+      "category": "input",
+      "type": "input.item",
+      "params": {
+        "path": "brief"
+      },
+      "deterministic": true
+    },
+    {
+      "id": "selected-media",
       "category": "input",
       "type": "input.item",
       "params": {
-        "path": "asset"
+        "path": "selectedMedia"
       },
       "deterministic": true
     },
     {
-      "id": "transcribe",
+      "id": "research",
       "category": "analysis",
-      "type": "analysis.transcribe",
+      "type": "analysis.researchBrief",
       "params": {
-        "source": {
+        "briefFrom": {
           "kind": "upstream",
-          "node": "ingest"
+          "node": "brief"
+        },
+        "mediaFrom": {
+          "kind": "upstream",
+          "node": "selected-media"
         }
       },
       "deterministic": true
     },
     {
-      "id": "hooks",
+      "id": "script",
+      "category": "generation",
+      "type": "generation.script",
+      "params": {
+        "style": "short-form hook script",
+        "briefFrom": {
+          "kind": "upstream",
+          "node": "brief"
+        },
+        "researchFrom": {
+          "kind": "upstream",
+          "node": "research"
+        },
+        "mediaFrom": {
+          "kind": "upstream",
+          "node": "selected-media"
+        }
+      },
+      "deterministic": false
+    },
+    {
+      "id": "shotlist",
+      "category": "generation",
+      "type": "generation.shotlist",
+      "params": {
+        "format": "vertical-reels",
+        "scriptFrom": {
+          "kind": "upstream",
+          "node": "script"
+        },
+        "mediaFrom": {
+          "kind": "upstream",
+          "node": "selected-media"
+        }
+      },
+      "deterministic": false
+    },
+    {
+      "id": "candidates",
       "category": "analysis",
       "type": "analysis.hooks",
       "params": {
         "source": {
           "kind": "upstream",
-          "node": "ingest"
+          "node": "selected-media"
         },
         "transcriptFrom": {
           "kind": "upstream",
-          "node": "transcribe"
+          "node": "script"
         },
         "maxCandidates": 5
       },
       "deterministic": true
     },
+    {
+      "id": "contact-sheet",
+      "category": "transform",
+      "type": "transform.contactSheet",
+      "params": {
+        "title": "Draft reel contact sheet",
+        "candidatesFrom": {
+          "kind": "upstream",
+          "node": "candidates"
+        },
+        "shotlistFrom": {
+          "kind": "upstream",
+          "node": "shotlist"
+        },
+        "providerRefs": [
+          "provider:analysis",
+          "provider:generation",
+          "provider:render"
+        ]
+      },
+      "deterministic": true
+    },
+    {
+      "id": "cost-brief",
+      "category": "transform",
+      "type": "transform.compose",
+      "params": {
+        "fields": {
+          "estimatedUsd": {
+            "kind": "literal",
+            "value": 8
+          },
+          "providerRefs": {
+            "kind": "literal",
+            "value": [
+              "provider:analysis",
+              "provider:generation",
+              "provider:render"
+            ]
+          },
+          "script": {
+            "kind": "upstream",
+            "node": "script"
+          },
+          "shotlist": {
+            "kind": "upstream",
+            "node": "shotlist"
+          },
+          "candidates": {
+            "kind": "upstream",
+            "node": "contact-sheet"
+          }
+        }
+      },
+      "deterministic": true
+    },
+    {
+      "id": "confirm-cost",
+      "category": "decision",
+      "type": "decision.approval",
+      "params": {
+        "kind": "confirm-cost",
+        "prompt": "Confirm provider cost before candidate review. Respond with {approved: true} to continue.",
+        "payloadFrom": {
+          "kind": "upstream",
+          "node": "cost-brief"
+        }
+      },
+      "deterministic": false
+    },
     {
       "id": "approve-candidates",
       "category": "decision",
       "type": "decision.approval",
       "params": {
         "kind": "choose-candidates",
-        "prompt": "Choose which hook candidates become draft reels. Respond with {candidates: [...]}; each candidate must carry its source and subjectHints.",
+        "prompt": "Choose hook candidates for editable draft reels. Respond with {candidates: [...]} where each candidate is self-contained.",
         "payloadFrom": {
           "kind": "upstream",
-          "node": "hooks"
+          "node": "contact-sheet"
         }
       },
       "deterministic": false
     },
+    {
+      "id": "apply-approved-candidates",
+      "category": "editor",
+      "type": "editor.commandTransaction",
+      "params": {
+        "label": "Create draft-reel approval artifacts",
+        "commands": [
+          {
+            "tool": "artifact.create",
+            "arguments": {
+              "kind": "workflow-approval",
+              "label": "Approved draft reel candidates",
+              "sourceRef": "approval.response"
+            }
+          }
+        ]
+      },
+      "deterministic": true
+    },
     {
       "id": "draft-reels",
       "category": "control",
       "type": "control.map",
       "params": {
         "workflow": {
           "formatVersion": 1,
           "id": "joy.first-party.long-video-draft-reels.item",
-          "version": "1.0.0",
+          "version": "2.0.0",
           "name": "Draft reel per approved candidate",
           "inputs": {
             "type": "object",
-            "description": "One approved hook candidate; must carry its own source reference and subjectHints."
+            "description": "One approved hook candidate."
           },
           "outputs": {
             "type": "object"
           },
           "nodes": [
             {
               "id": "branch",
               "category": "editor",
               "type": "editor.createBranch",
               "params": {
@@ -112,24 +277,20 @@
             },
             {
               "id": "reframe",
               "category": "transform",
               "type": "transform.reframe",
               "params": {
                 "aspect": "9:16",
                 "source": {
                   "kind": "upstream",
                   "node": "branch"
-                },
-                "subjectHintsFrom": {
-                  "kind": "input",
-                  "path": "subjectHints"
                 }
               },
               "deterministic": true
             },
             {
               "id": "caption",
               "category": "transform",
               "type": "transform.caption",
               "params": {
                 "templateId": "joy.caption.clean",
@@ -203,159 +364,315 @@
         }
       },
       "deterministic": true
     },
     {
       "id": "approve-drafts",
       "category": "decision",
       "type": "decision.approval",
       "params": {
         "kind": "approve-render",
-        "prompt": "Review the draft previews. Respond with {approved: [...]} listing the drafts to render as finals; each entry must be a self-contained render source.",
+        "prompt": "Review draft proxies. Respond with {approved: [...]} listing the drafts to render as finals.",
         "payloadFrom": {
           "kind": "upstream",
           "node": "draft-reels"
         }
       },
       "deterministic": false
     },
     {
       "id": "final-reels",
       "category": "control",
       "type": "control.map",
       "params": {
         "workflow": {
           "formatVersion": 1,
           "id": "joy.first-party.long-video-draft-reels.final",
-          "version": "1.0.0",
-          "name": "Final reel per approved draft",
+          "version": "2.0.0",
+          "name": "Final reel delivery per approved draft",
           "inputs": {
             "type": "object",
-            "description": "One approved draft (self-contained render source)."
+            "description": "One approved render source."
           },
           "outputs": {
             "type": "object"
           },
           "nodes": [
             {
-              "id": "final",
+              "id": "render",
               "category": "render",
               "type": "render.final",
               "params": {
                 "profile": "reel-vertical",
                 "source": {
                   "kind": "input"
                 }
               },
               "deterministic": true,
               "retry": {
                 "maxAttempts": 2,
                 "backoffMs": 1000
               }
             },
             {
-              "id": "save",
+              "id": "inspect",
+              "category": "render",
+              "type": "render.inspect",
+              "params": {
+                "source": {
+                  "kind": "upstream",
+                  "node": "render"
+                },
+                "reportRef": "joy.first-party.long-video-draft-reels.final.qa-report"
+              },
+              "deterministic": true
+            },
+            {
+              "id": "manifest",
               "category": "output",
-              "type": "output.folder",
+              "type": "output.deliveryManifest",
               "params": {
                 "folderId": "exports",
+                "fileName": "final.json",
                 "source": {
                   "kind": "upstream",
-                  "node": "final"
-                }
+                  "node": "render"
+                },
+                "inspectionFrom": {
+                  "kind": "upstream",
+                  "node": "inspect"
+                },
+                "providerRefs": [
+                  "provider:analysis",
+                  "provider:generation",
+                  "provider:render"
+                ]
               },
               "deterministic": true
             }
           ],
           "edges": [
             {
-              "from": "final",
-              "to": "save"
+              "from": "render",
+              "to": "inspect"
+            },
+            {
+              "from": "render",
+              "to": "manifest"
+            },
+            {
+              "from": "inspect",
+              "to": "manifest"
             }
           ],
           "permissions": [],
           "policy": {
             "concurrency": 1,
             "failure": "stop",
             "defaultRetry": {
               "maxAttempts": 1,
               "backoffMs": 0
             }
           }
         },
         "itemsFrom": {
           "kind": "upstream",
           "node": "approve-drafts",
           "path": "response.approved"
         }
       },
       "deterministic": true
     },
+    {
+      "id": "run-report",
+      "category": "transform",
+      "type": "transform.compose",
+      "params": {
+        "fields": {
+          "providerRefs": {
+            "kind": "literal",
+            "value": [
+              "provider:analysis",
+              "provider:generation",
+              "provider:render"
+            ]
+          },
+          "costApproval": {
+            "kind": "upstream",
+            "node": "confirm-cost",
+            "path": "response"
+          },
+          "candidateApproval": {
+            "kind": "upstream",
+            "node": "approve-candidates",
+            "path": "response"
+          },
+          "renderApproval": {
+            "kind": "upstream",
+            "node": "approve-drafts",
+            "path": "response"
+          },
+          "deliveries": {
+            "kind": "upstream",
+            "node": "final-reels"
+          }
+        }
+      },
+      "deterministic": true
+    },
     {
       "id": "manifest",
       "category": "output",
       "type": "output.metadata",
       "params": {
         "folderId": "exports",
         "fileName": "long-video-draft-reels-run.json",
         "source": {
           "kind": "upstream",
-          "node": "final-reels"
+          "node": "run-report"
         }
       },
       "deterministic": true
     }
   ],
   "edges": [
     {
-      "from": "ingest",
-      "to": "transcribe"
+      "from": "brief",
+      "to": "research"
+    },
+    {
+      "from": "selected-media",
+      "to": "research"
+    },
+    {
+      "from": "brief",
+      "to": "script"
     },
     {
-      "from": "ingest",
-      "to": "hooks"
+      "from": "research",
+      "to": "script"
     },
     {
-      "from": "transcribe",
-      "to": "hooks"
+      "from": "selected-media",
+      "to": "script"
     },
     {
-      "from": "hooks",
+      "from": "script",
+      "to": "shotlist"
+    },
+    {
+      "from": "selected-media",
+      "to": "shotlist"
+    },
+    {
+      "from": "selected-media",
+      "to": "candidates"
+    },
+    {
+      "from": "script",
+      "to": "candidates"
+    },
+    {
+      "from": "candidates",
+      "to": "contact-sheet"
+    },
+    {
+      "from": "shotlist",
+      "to": "contact-sheet"
+    },
+    {
+      "from": "script",
+      "to": "cost-brief"
+    },
+    {
+      "from": "shotlist",
+      "to": "cost-brief"
+    },
+    {
+      "from": "contact-sheet",
+      "to": "cost-brief"
+    },
+    {
+      "from": "cost-brief",
+      "to": "confirm-cost"
+    },
+    {
+      "from": "contact-sheet",
+      "to": "approve-candidates"
+    },
+    {
+      "from": "confirm-cost",
       "to": "approve-candidates"
     },
     {
       "from": "approve-candidates",
+      "to": "apply-approved-candidates"
+    },
+    {
+      "from": "approve-candidates",
+      "to": "draft-reels"
+    },
+    {
+      "from": "apply-approved-candidates",
       "to": "draft-reels"
     },
     {
       "from": "draft-reels",
       "to": "approve-drafts"
     },
     {
       "from": "approve-drafts",
       "to": "final-reels"
     },
+    {
+      "from": "confirm-cost",
+      "to": "run-report"
+    },
+    {
+      "from": "approve-candidates",
+      "to": "run-report"
+    },
+    {
+      "from": "approve-drafts",
+      "to": "run-report"
+    },
     {
       "from": "final-reels",
+      "to": "run-report"
+    },
+    {
+      "from": "run-report",
       "to": "manifest"
     }
   ],
   "permissions": [
     {
-      "capability": "provider.transcribe"
+      "capability": "provider.research"
+    },
+    {
+      "capability": "provider.script"
     },
     {
       "capability": "provider.highlights"
     },
+    {
+      "capability": "provider.cost"
+    },
+    {
+      "capability": "editor.command"
+    },
     {
       "capability": "render.final"
     },
+    {
+      "capability": "render.inspect"
+    },
     {
       "capability": "output.write"
     }
   ],
   "policy": {
     "concurrency": 1,
     "failure": "stop",
     "defaultRetry": {
       "maxAttempts": 1,
       "backoffMs": 0
diff --git a/packages/workflow-engine/workflows/multilingual-promo.json b/packages/workflow-engine/workflows/multilingual-promo.json
index 8afba83..e6b2838 100644
--- a/packages/workflow-engine/workflows/multilingual-promo.json
+++ b/packages/workflow-engine/workflows/multilingual-promo.json
@@ -1,80 +1,270 @@
 {
   "formatVersion": 1,
   "id": "joy.first-party.multilingual-promo",
-  "version": "1.0.0",
-  "name": "Multilingual restaurant promo",
+  "version": "2.0.0",
+  "name": "Multilingual promo",
   "inputs": {
     "type": "object",
     "required": [
-      "rows"
+      "brief",
+      "selectedMedia"
     ],
     "properties": {
+      "brief": {
+        "type": "string",
+        "minLength": 1,
+        "description": "Creative brief or client goal for this production run.",
+        "default": "Create a polished, on-brand edit from the selected media."
+      },
+      "selectedMedia": {
+        "type": "object",
+        "description": "Opaque selected media references; never paths or URLs."
+      },
+      "references": {
+        "type": "array",
+        "items": {
+          "type": "object"
+        },
+        "description": "Optional clean-room reference notes or media fingerprints."
+      },
       "rows": {
         "type": "array",
-        "minItems": 1,
         "items": {
           "type": "object"
         },
-        "description": "Menu rows: name, priceText, image, language, copy."
+        "description": "Optional structured rows for promo variants."
+      },
+      "delivery": {
+        "type": "object",
+        "description": "Optional delivery promise: aspect, codec, captions, approval requirements."
       }
     },
     "additionalProperties": false
   },
   "outputs": {
     "type": "object",
     "required": [
       "manifest"
     ],
     "properties": {
       "manifest": {
         "type": "object"
       }
     }
   },
   "nodes": [
     {
-      "id": "rows",
+      "id": "brief",
       "category": "input",
       "type": "input.item",
       "params": {
-        "path": "rows"
+        "path": "brief"
+      },
+      "deterministic": true
+    },
+    {
+      "id": "selected-media",
+      "category": "input",
+      "type": "input.item",
+      "params": {
+        "path": "selectedMedia"
+      },
+      "deterministic": true
+    },
+    {
+      "id": "research",
+      "category": "analysis",
+      "type": "analysis.researchBrief",
+      "params": {
+        "briefFrom": {
+          "kind": "upstream",
+          "node": "brief"
+        },
+        "mediaFrom": {
+          "kind": "upstream",
+          "node": "selected-media"
+        }
+      },
+      "deterministic": true
+    },
+    {
+      "id": "script",
+      "category": "generation",
+      "type": "generation.script",
+      "params": {
+        "style": "localized promo script",
+        "briefFrom": {
+          "kind": "upstream",
+          "node": "brief"
+        },
+        "researchFrom": {
+          "kind": "upstream",
+          "node": "research"
+        },
+        "mediaFrom": {
+          "kind": "upstream",
+          "node": "selected-media"
+        }
+      },
+      "deterministic": false
+    },
+    {
+      "id": "shotlist",
+      "category": "generation",
+      "type": "generation.shotlist",
+      "params": {
+        "format": "menu-promo",
+        "scriptFrom": {
+          "kind": "upstream",
+          "node": "script"
+        },
+        "mediaFrom": {
+          "kind": "upstream",
+          "node": "selected-media"
+        }
+      },
+      "deterministic": false
+    },
+    {
+      "id": "candidates",
+      "category": "analysis",
+      "type": "analysis.hooks",
+      "params": {
+        "source": {
+          "kind": "upstream",
+          "node": "selected-media"
+        },
+        "transcriptFrom": {
+          "kind": "upstream",
+          "node": "script"
+        },
+        "maxCandidates": 4
+      },
+      "deterministic": true
+    },
+    {
+      "id": "contact-sheet",
+      "category": "transform",
+      "type": "transform.contactSheet",
+      "params": {
+        "title": "Promo variant contact sheet",
+        "candidatesFrom": {
+          "kind": "upstream",
+          "node": "candidates"
+        },
+        "shotlistFrom": {
+          "kind": "upstream",
+          "node": "shotlist"
+        },
+        "providerRefs": [
+          "provider:analysis",
+          "provider:generation",
+          "provider:render"
+        ]
+      },
+      "deterministic": true
+    },
+    {
+      "id": "cost-brief",
+      "category": "transform",
+      "type": "transform.compose",
+      "params": {
+        "fields": {
+          "estimatedUsd": {
+            "kind": "literal",
+            "value": 12
+          },
+          "providerRefs": {
+            "kind": "literal",
+            "value": [
+              "provider:analysis",
+              "provider:generation",
+              "provider:render"
+            ]
+          },
+          "script": {
+            "kind": "upstream",
+            "node": "script"
+          },
+          "shotlist": {
+            "kind": "upstream",
+            "node": "shotlist"
+          },
+          "candidates": {
+            "kind": "upstream",
+            "node": "contact-sheet"
+          }
+        }
       },
       "deterministic": true
     },
+    {
+      "id": "confirm-cost",
+      "category": "decision",
+      "type": "decision.approval",
+      "params": {
+        "kind": "confirm-cost",
+        "prompt": "Confirm provider cost before candidate review. Respond with {approved: true} to continue.",
+        "payloadFrom": {
+          "kind": "upstream",
+          "node": "cost-brief"
+        }
+      },
+      "deterministic": false
+    },
     {
       "id": "approve-copy",
       "category": "decision",
       "type": "decision.approval",
       "params": {
         "kind": "approve-transcript",
-        "prompt": "Approve the promo copy for every row. Respond with {rows: [...]} where each row carries its final copy plus name, priceText, image, and language.",
+        "prompt": "Approve localized promo rows. Respond with {rows: [...]} where each row has final copy and language.",
         "payloadFrom": {
           "kind": "upstream",
-          "node": "rows"
+          "node": "contact-sheet"
         }
       },
       "deterministic": false
     },
+    {
+      "id": "apply-approved-copy",
+      "category": "editor",
+      "type": "editor.commandTransaction",
+      "params": {
+        "label": "Create approved promo copy artifacts",
+        "commands": [
+          {
+            "tool": "artifact.create",
+            "arguments": {
+              "kind": "workflow-approval",
+              "label": "Approved multilingual promo copy",
+              "sourceRef": "approval.response"
+            }
+          }
+        ]
+      },
+      "deterministic": true
+    },
     {
       "id": "per-language",
       "category": "control",
       "type": "control.map",
       "params": {
         "workflow": {
           "formatVersion": 1,
           "id": "joy.first-party.multilingual-promo.item",
-          "version": "1.0.0",
-          "name": "Promo render per menu row and language",
+          "version": "2.0.0",
+          "name": "Promo render per approved row and language",
           "inputs": {
             "type": "object",
-            "description": "One approved menu row: name, priceText, image, language, copy."
+            "description": "One approved row: copy, language, image, offer."
           },
           "outputs": {
             "type": "object"
           },
           "nodes": [
             {
               "id": "translate",
               "category": "generation",
               "type": "generation.translate",
               "params": {
@@ -158,36 +348,55 @@
               "id": "render",
               "category": "render",
               "type": "render.final",
               "params": {
                 "profile": "promo-vertical",
                 "source": {
                   "kind": "upstream",
                   "node": "scene"
                 }
               },
-              "deterministic": true,
-              "retry": {
-                "maxAttempts": 2,
-                "backoffMs": 1000
-              }
+              "deterministic": true
             },
             {
-              "id": "save",
+              "id": "inspect",
+              "category": "render",
+              "type": "render.inspect",
+              "params": {
+                "source": {
+                  "kind": "upstream",
+                  "node": "render"
+                },
+                "reportRef": "joy.first-party.multilingual-promo.qa-report"
+              },
+              "deterministic": true
+            },
+            {
+              "id": "manifest",
               "category": "output",
-              "type": "output.folder",
+              "type": "output.deliveryManifest",
               "params": {
                 "folderId": "exports",
+                "fileName": "promo-delivery.json",
                 "source": {
                   "kind": "upstream",
                   "node": "render"
-                }
+                },
+                "inspectionFrom": {
+                  "kind": "upstream",
+                  "node": "inspect"
+                },
+                "providerRefs": [
+                  "provider:analysis",
+                  "provider:generation",
+                  "provider:render"
+                ]
               },
               "deterministic": true
             }
           ],
           "edges": [
             {
               "from": "translate",
               "to": "voice"
             },
             {
@@ -209,82 +418,224 @@
             {
               "from": "assemble",
               "to": "scene"
             },
             {
               "from": "scene",
               "to": "render"
             },
             {
               "from": "render",
-              "to": "save"
+              "to": "inspect"
+            },
+            {
+              "from": "render",
+              "to": "manifest"
+            },
+            {
+              "from": "inspect",
+              "to": "manifest"
             }
           ],
           "permissions": [],
           "policy": {
             "concurrency": 1,
             "failure": "stop",
             "defaultRetry": {
               "maxAttempts": 1,
               "backoffMs": 0
             }
           }
         },
         "itemsFrom": {
           "kind": "upstream",
           "node": "approve-copy",
           "path": "response.rows"
         }
       },
       "deterministic": true
     },
+    {
+      "id": "run-report",
+      "category": "transform",
+      "type": "transform.compose",
+      "params": {
+        "fields": {
+          "providerRefs": {
+            "kind": "literal",
+            "value": [
+              "provider:analysis",
+              "provider:generation",
+              "provider:render"
+            ]
+          },
+          "costApproval": {
+            "kind": "upstream",
+            "node": "confirm-cost",
+            "path": "response"
+          },
+          "copyApproval": {
+            "kind": "upstream",
+            "node": "approve-copy",
+            "path": "response"
+          },
+          "deliveries": {
+            "kind": "upstream",
+            "node": "per-language"
+          }
+        }
+      },
+      "deterministic": true
+    },
     {
       "id": "manifest",
       "category": "output",
       "type": "output.metadata",
       "params": {
         "folderId": "exports",
         "fileName": "multilingual-promo-run.json",
         "source": {
           "kind": "upstream",
-          "node": "per-language"
+          "node": "run-report"
         }
       },
       "deterministic": true
     }
   ],
   "edges": [
     {
-      "from": "rows",
+      "from": "brief",
+      "to": "research"
+    },
+    {
+      "from": "selected-media",
+      "to": "research"
+    },
+    {
+      "from": "brief",
+      "to": "script"
+    },
+    {
+      "from": "research",
+      "to": "script"
+    },
+    {
+      "from": "selected-media",
+      "to": "script"
+    },
+    {
+      "from": "script",
+      "to": "shotlist"
+    },
+    {
+      "from": "selected-media",
+      "to": "shotlist"
+    },
+    {
+      "from": "selected-media",
+      "to": "candidates"
+    },
+    {
+      "from": "script",
+      "to": "candidates"
+    },
+    {
+      "from": "candidates",
+      "to": "contact-sheet"
+    },
+    {
+      "from": "shotlist",
+      "to": "contact-sheet"
+    },
+    {
+      "from": "script",
+      "to": "cost-brief"
+    },
+    {
+      "from": "shotlist",
+      "to": "cost-brief"
+    },
+    {
+      "from": "contact-sheet",
+      "to": "cost-brief"
+    },
+    {
+      "from": "cost-brief",
+      "to": "confirm-cost"
+    },
+    {
+      "from": "contact-sheet",
+      "to": "approve-copy"
+    },
+    {
+      "from": "confirm-cost",
       "to": "approve-copy"
     },
+    {
+      "from": "approve-copy",
+      "to": "apply-approved-copy"
+    },
     {
       "from": "approve-copy",
       "to": "per-language"
     },
+    {
+      "from": "apply-approved-copy",
+      "to": "per-language"
+    },
+    {
+      "from": "confirm-cost",
+      "to": "run-report"
+    },
+    {
+      "from": "approve-copy",
+      "to": "run-report"
+    },
     {
       "from": "per-language",
+      "to": "run-report"
+    },
+    {
+      "from": "run-report",
       "to": "manifest"
     }
   ],
   "permissions": [
     {
-      "capability": "provider.translate"
+      "capability": "provider.research"
     },
     {
-      "capability": "provider.tts"
+      "capability": "provider.script"
+    },
+    {
+      "capability": "provider.highlights"
+    },
+    {
+      "capability": "provider.cost"
+    },
+    {
+      "capability": "editor.command"
     },
     {
       "capability": "render.final"
     },
+    {
+      "capability": "render.inspect"
+    },
     {
       "capability": "output.write"
+    },
+    {
+      "capability": "provider.translate"
+    },
+    {
+      "capability": "provider.tts"
     }
   ],
   "policy": {
     "concurrency": 1,
     "failure": "stop",
     "defaultRetry": {
       "maxAttempts": 1,
       "backoffMs": 0
     }
   }
diff --git a/packages/workflow-engine/workflows/podcast-cleanup.json b/packages/workflow-engine/workflows/podcast-cleanup.json
index 15d24b1..3b7fb6c 100644
--- a/packages/workflow-engine/workflows/podcast-cleanup.json
+++ b/packages/workflow-engine/workflows/podcast-cleanup.json
@@ -1,87 +1,258 @@
 {
   "formatVersion": 1,
   "id": "joy.first-party.podcast-cleanup",
-  "version": "1.0.0",
+  "version": "2.0.0",
   "name": "Podcast cleanup",
   "inputs": {
     "type": "object",
     "required": [
-      "source"
+      "brief",
+      "selectedMedia"
     ],
     "properties": {
-      "source": {
+      "brief": {
+        "type": "string",
+        "minLength": 1,
+        "description": "Creative brief or client goal for this production run.",
+        "default": "Create a polished, on-brand edit from the selected media."
+      },
+      "selectedMedia": {
+        "type": "object",
+        "description": "Opaque selected media references; never paths or URLs."
+      },
+      "references": {
+        "type": "array",
+        "items": {
+          "type": "object"
+        },
+        "description": "Optional clean-room reference notes or media fingerprints."
+      },
+      "rows": {
+        "type": "array",
+        "items": {
+          "type": "object"
+        },
+        "description": "Optional structured rows for promo variants."
+      },
+      "delivery": {
         "type": "object",
-        "description": "Opaque episode audio/video asset reference."
+        "description": "Optional delivery promise: aspect, codec, captions, approval requirements."
       }
     },
     "additionalProperties": false
   },
   "outputs": {
     "type": "object",
     "required": [
-      "save-episode",
       "manifest"
     ],
     "properties": {
-      "save-episode": {
-        "type": "object"
-      },
       "manifest": {
         "type": "object"
       }
     }
   },
   "nodes": [
     {
-      "id": "ingest",
+      "id": "brief",
       "category": "input",
       "type": "input.item",
       "params": {
-        "path": "source"
+        "path": "brief"
+      },
+      "deterministic": true
+    },
+    {
+      "id": "selected-media",
+      "category": "input",
+      "type": "input.item",
+      "params": {
+        "path": "selectedMedia"
+      },
+      "deterministic": true
+    },
+    {
+      "id": "research",
+      "category": "analysis",
+      "type": "analysis.researchBrief",
+      "params": {
+        "briefFrom": {
+          "kind": "upstream",
+          "node": "brief"
+        },
+        "mediaFrom": {
+          "kind": "upstream",
+          "node": "selected-media"
+        }
+      },
+      "deterministic": true
+    },
+    {
+      "id": "script",
+      "category": "generation",
+      "type": "generation.script",
+      "params": {
+        "style": "podcast cleanup plan",
+        "briefFrom": {
+          "kind": "upstream",
+          "node": "brief"
+        },
+        "researchFrom": {
+          "kind": "upstream",
+          "node": "research"
+        },
+        "mediaFrom": {
+          "kind": "upstream",
+          "node": "selected-media"
+        }
+      },
+      "deterministic": false
+    },
+    {
+      "id": "shotlist",
+      "category": "generation",
+      "type": "generation.shotlist",
+      "params": {
+        "format": "chaptered-audio",
+        "scriptFrom": {
+          "kind": "upstream",
+          "node": "script"
+        },
+        "mediaFrom": {
+          "kind": "upstream",
+          "node": "selected-media"
+        }
+      },
+      "deterministic": false
+    },
+    {
+      "id": "candidates",
+      "category": "analysis",
+      "type": "analysis.hooks",
+      "params": {
+        "source": {
+          "kind": "upstream",
+          "node": "selected-media"
+        },
+        "transcriptFrom": {
+          "kind": "upstream",
+          "node": "script"
+        },
+        "maxCandidates": 3
+      },
+      "deterministic": true
+    },
+    {
+      "id": "contact-sheet",
+      "category": "transform",
+      "type": "transform.contactSheet",
+      "params": {
+        "title": "Podcast chapter contact sheet",
+        "candidatesFrom": {
+          "kind": "upstream",
+          "node": "candidates"
+        },
+        "shotlistFrom": {
+          "kind": "upstream",
+          "node": "shotlist"
+        },
+        "providerRefs": [
+          "provider:analysis",
+          "provider:generation",
+          "provider:render"
+        ]
+      },
+      "deterministic": true
+    },
+    {
+      "id": "cost-brief",
+      "category": "transform",
+      "type": "transform.compose",
+      "params": {
+        "fields": {
+          "estimatedUsd": {
+            "kind": "literal",
+            "value": 6
+          },
+          "providerRefs": {
+            "kind": "literal",
+            "value": [
+              "provider:analysis",
+              "provider:generation",
+              "provider:render"
+            ]
+          },
+          "script": {
+            "kind": "upstream",
+            "node": "script"
+          },
+          "shotlist": {
+            "kind": "upstream",
+            "node": "shotlist"
+          },
+          "candidates": {
+            "kind": "upstream",
+            "node": "contact-sheet"
+          }
+        }
       },
       "deterministic": true
     },
+    {
+      "id": "confirm-cost",
+      "category": "decision",
+      "type": "decision.approval",
+      "params": {
+        "kind": "confirm-cost",
+        "prompt": "Confirm provider cost before candidate review. Respond with {approved: true} to continue.",
+        "payloadFrom": {
+          "kind": "upstream",
+          "node": "cost-brief"
+        }
+      },
+      "deterministic": false
+    },
     {
       "id": "speakers",
       "category": "analysis",
       "type": "analysis.speakers",
       "params": {
         "source": {
           "kind": "upstream",
-          "node": "ingest"
+          "node": "selected-media"
         }
       },
       "deterministic": true
     },
     {
       "id": "confirm-speakers",
       "category": "decision",
       "type": "decision.approval",
       "params": {
         "kind": "choose-candidates",
-        "prompt": "Confirm or correct the detected speakers. Respond with {speakers: [...]}.",
+        "prompt": "Confirm or correct detected speakers. Respond with {speakers: [...]}.",
         "payloadFrom": {
           "kind": "upstream",
           "node": "speakers"
         }
       },
       "deterministic": false
     },
     {
       "id": "denoise",
       "category": "transform",
       "type": "transform.denoise",
       "params": {
         "source": {
           "kind": "upstream",
-          "node": "ingest"
+          "node": "selected-media"
         }
       },
       "deterministic": true
     },
     {
       "id": "normalize",
       "category": "transform",
       "type": "transform.normalizeAudio",
       "params": {
         "targetLufs": -16,
@@ -105,28 +276,47 @@
         }
       },
       "deterministic": true
     },
     {
       "id": "approve-edit-list",
       "category": "decision",
       "type": "decision.approval",
       "params": {
         "kind": "accept-edit-diff",
-        "prompt": "Approve the silence-removal edit list. Respond with {ranges: [...]}; exactly the approved ranges are removed.",
+        "prompt": "Approve the silence-removal edit list. Respond with {ranges: [...]}; exactly those ranges are removed.",
         "payloadFrom": {
           "kind": "upstream",
           "node": "silence"
         }
       },
       "deterministic": false
     },
+    {
+      "id": "apply-approved-edits",
+      "category": "editor",
+      "type": "editor.commandTransaction",
+      "params": {
+        "label": "Create approved podcast edit artifacts",
+        "commands": [
+          {
+            "tool": "artifact.create",
+            "arguments": {
+              "kind": "workflow-approval",
+              "label": "Approved podcast cleanup edits",
+              "sourceRef": "approval.response"
+            }
+          }
+        ]
+      },
+      "deterministic": true
+    },
     {
       "id": "trim",
       "category": "transform",
       "type": "transform.trim",
       "params": {
         "source": {
           "kind": "upstream",
           "node": "normalize"
         },
         "rangesFrom": {
@@ -182,92 +372,118 @@
       "id": "render-episode",
       "category": "render",
       "type": "render.final",
       "params": {
         "profile": "podcast-episode",
         "source": {
           "kind": "upstream",
           "node": "captions"
         }
       },
-      "deterministic": true,
-      "retry": {
-        "maxAttempts": 2,
-        "backoffMs": 1000
-      }
+      "deterministic": true
     },
     {
-      "id": "save-episode",
-      "category": "output",
-      "type": "output.folder",
+      "id": "inspect-episode",
+      "category": "render",
+      "type": "render.inspect",
       "params": {
-        "folderId": "exports",
-        "fileName": "episode",
         "source": {
           "kind": "upstream",
           "node": "render-episode"
-        }
+        },
+        "reportRef": "joy.first-party.podcast-cleanup.qa-report"
       },
       "deterministic": true
     },
     {
       "id": "clips",
       "category": "control",
       "type": "control.map",
       "params": {
         "workflow": {
           "formatVersion": 1,
           "id": "joy.first-party.podcast-cleanup.clip",
-          "version": "1.0.0",
-          "name": "Podcast clip per chapter",
+          "version": "2.0.0",
+          "name": "Podcast clip delivery per chapter",
           "inputs": {
             "type": "object",
-            "description": "One chapter (self-contained renderable reference)."
+            "description": "One approved render source."
           },
           "outputs": {
             "type": "object"
           },
           "nodes": [
             {
-              "id": "clip",
+              "id": "render",
               "category": "render",
               "type": "render.final",
               "params": {
                 "profile": "podcast-clip",
                 "source": {
                   "kind": "input"
                 }
               },
               "deterministic": true,
               "retry": {
                 "maxAttempts": 2,
                 "backoffMs": 1000
               }
             },
             {
-              "id": "save",
+              "id": "inspect",
+              "category": "render",
+              "type": "render.inspect",
+              "params": {
+                "source": {
+                  "kind": "upstream",
+                  "node": "render"
+                },
+                "reportRef": "joy.first-party.podcast-cleanup.clip.qa-report"
+              },
+              "deterministic": true
+            },
+            {
+              "id": "manifest",
               "category": "output",
-              "type": "output.folder",
+              "type": "output.deliveryManifest",
               "params": {
                 "folderId": "exports",
+                "fileName": "clip.json",
                 "source": {
                   "kind": "upstream",
-                  "node": "clip"
-                }
+                  "node": "render"
+                },
+                "inspectionFrom": {
+                  "kind": "upstream",
+                  "node": "inspect"
+                },
+                "providerRefs": [
+                  "provider:analysis",
+                  "provider:generation",
+                  "provider:render"
+                ]
               },
               "deterministic": true
             }
           ],
           "edges": [
             {
-              "from": "clip",
-              "to": "save"
+              "from": "render",
+              "to": "inspect"
+            },
+            {
+              "from": "render",
+              "to": "manifest"
+            },
+            {
+              "from": "inspect",
+              "to": "manifest"
             }
           ],
           "permissions": [],
           "policy": {
             "concurrency": 1,
             "failure": "stop",
             "defaultRetry": {
               "maxAttempts": 1,
               "backoffMs": 0
             }
@@ -275,95 +491,193 @@
         },
         "itemsFrom": {
           "kind": "upstream",
           "node": "chapters",
           "path": "chapters"
         }
       },
       "deterministic": true
     },
     {
-      "id": "audit",
+      "id": "run-report",
       "category": "transform",
       "type": "transform.compose",
       "params": {
         "fields": {
+          "providerRefs": {
+            "kind": "literal",
+            "value": [
+              "provider:analysis",
+              "provider:generation",
+              "provider:render"
+            ]
+          },
+          "costApproval": {
+            "kind": "upstream",
+            "node": "confirm-cost",
+            "path": "response"
+          },
           "speakers": {
             "kind": "upstream",
             "node": "confirm-speakers",
             "path": "response"
           },
           "editList": {
             "kind": "upstream",
             "node": "approve-edit-list",
             "path": "response"
           },
           "chapters": {
             "kind": "upstream",
             "node": "chapters"
           },
+          "episodeInspection": {
+            "kind": "upstream",
+            "node": "inspect-episode"
+          },
           "clips": {
             "kind": "upstream",
             "node": "clips"
           }
         }
       },
       "deterministic": true
     },
     {
       "id": "manifest",
       "category": "output",
-      "type": "output.metadata",
+      "type": "output.deliveryManifest",
       "params": {
         "folderId": "exports",
         "fileName": "podcast-cleanup-run.json",
         "source": {
           "kind": "upstream",
-          "node": "audit"
-        }
+          "node": "render-episode"
+        },
+        "inspectionFrom": {
+          "kind": "upstream",
+          "node": "inspect-episode"
+        },
+        "approvalsFrom": {
+          "kind": "upstream",
+          "node": "run-report"
+        },
+        "providerRefs": [
+          "provider:analysis",
+          "provider:generation",
+          "provider:render"
+        ]
       },
       "deterministic": true
     }
   ],
   "edges": [
     {
-      "from": "ingest",
+      "from": "brief",
+      "to": "research"
+    },
+    {
+      "from": "selected-media",
+      "to": "research"
+    },
+    {
+      "from": "brief",
+      "to": "script"
+    },
+    {
+      "from": "research",
+      "to": "script"
+    },
+    {
+      "from": "selected-media",
+      "to": "script"
+    },
+    {
+      "from": "script",
+      "to": "shotlist"
+    },
+    {
+      "from": "selected-media",
+      "to": "shotlist"
+    },
+    {
+      "from": "selected-media",
+      "to": "candidates"
+    },
+    {
+      "from": "script",
+      "to": "candidates"
+    },
+    {
+      "from": "candidates",
+      "to": "contact-sheet"
+    },
+    {
+      "from": "shotlist",
+      "to": "contact-sheet"
+    },
+    {
+      "from": "script",
+      "to": "cost-brief"
+    },
+    {
+      "from": "shotlist",
+      "to": "cost-brief"
+    },
+    {
+      "from": "contact-sheet",
+      "to": "cost-brief"
+    },
+    {
+      "from": "cost-brief",
+      "to": "confirm-cost"
+    },
+    {
+      "from": "selected-media",
       "to": "speakers"
     },
     {
       "from": "speakers",
       "to": "confirm-speakers"
     },
     {
-      "from": "ingest",
+      "from": "selected-media",
       "to": "denoise"
     },
     {
       "from": "denoise",
       "to": "normalize"
     },
     {
       "from": "normalize",
       "to": "silence"
     },
     {
       "from": "silence",
       "to": "approve-edit-list"
     },
+    {
+      "from": "approve-edit-list",
+      "to": "apply-approved-edits"
+    },
     {
       "from": "normalize",
       "to": "trim"
     },
     {
       "from": "approve-edit-list",
       "to": "trim"
     },
+    {
+      "from": "apply-approved-edits",
+      "to": "trim"
+    },
     {
       "from": "trim",
       "to": "transcribe"
     },
     {
       "from": "trim",
       "to": "chapters"
     },
     {
       "from": "transcribe",
@@ -372,60 +686,94 @@
     {
       "from": "transcribe",
       "to": "captions"
     },
     {
       "from": "captions",
       "to": "render-episode"
     },
     {
       "from": "render-episode",
-      "to": "save-episode"
+      "to": "inspect-episode"
     },
     {
       "from": "chapters",
       "to": "clips"
     },
+    {
+      "from": "confirm-cost",
+      "to": "run-report"
+    },
     {
       "from": "confirm-speakers",
-      "to": "audit"
+      "to": "run-report"
     },
     {
       "from": "approve-edit-list",
-      "to": "audit"
+      "to": "run-report"
     },
     {
       "from": "chapters",
-      "to": "audit"
+      "to": "run-report"
+    },
+    {
+      "from": "inspect-episode",
+      "to": "run-report"
     },
     {
       "from": "clips",
-      "to": "audit"
+      "to": "run-report"
+    },
+    {
+      "from": "render-episode",
+      "to": "manifest"
+    },
+    {
+      "from": "inspect-episode",
+      "to": "manifest"
     },
     {
-      "from": "audit",
+      "from": "run-report",
       "to": "manifest"
     }
   ],
   "permissions": [
     {
-      "capability": "provider.audio-cleanup"
+      "capability": "provider.research"
     },
     {
-      "capability": "provider.transcribe"
+      "capability": "provider.script"
+    },
+    {
+      "capability": "provider.highlights"
+    },
+    {
+      "capability": "provider.cost"
+    },
+    {
+      "capability": "editor.command"
     },
     {
       "capability": "render.final"
     },
+    {
+      "capability": "render.inspect"
+    },
     {
       "capability": "output.write"
+    },
+    {
+      "capability": "provider.audio-cleanup"
+    },
+    {
+      "capability": "provider.transcribe"
     }
   ],
   "policy": {
     "concurrency": 1,
-    "failure": "stop",
+    "failure": "continue-independent",
     "defaultRetry": {
       "maxAttempts": 1,
       "backoffMs": 0
     }
   }
 }
diff --git a/packages/workflow-engine/workflows/reference-social-cutdown.json b/packages/workflow-engine/workflows/reference-social-cutdown.json
new file mode 100644
index 0000000..942b9a1
--- /dev/null
+++ b/packages/workflow-engine/workflows/reference-social-cutdown.json
@@ -0,0 +1,533 @@
+{
+  "formatVersion": 1,
+  "id": "joy.first-party.reference-social-cutdown",
+  "version": "2.0.0",
+  "name": "Reference social cutdown",
+  "inputs": {
+    "type": "object",
+    "required": [
+      "brief",
+      "selectedMedia"
+    ],
+    "properties": {
+      "brief": {
+        "type": "string",
+        "minLength": 1,
+        "description": "Creative brief or client goal for this production run.",
+        "default": "Create a polished, on-brand edit from the selected media."
+      },
+      "selectedMedia": {
+        "type": "object",
+        "description": "Opaque selected media references; never paths or URLs."
+      },
+      "references": {
+        "type": "array",
+        "items": {
+          "type": "object"
+        },
+        "description": "Optional clean-room reference notes or media fingerprints."
+      },
+      "rows": {
+        "type": "array",
+        "items": {
+          "type": "object"
+        },
+        "description": "Optional structured rows for promo variants."
+      },
+      "delivery": {
+        "type": "object",
+        "description": "Optional delivery promise: aspect, codec, captions, approval requirements."
+      }
+    },
+    "additionalProperties": false
+  },
+  "outputs": {
+    "type": "object",
+    "required": [
+      "manifest"
+    ],
+    "properties": {
+      "manifest": {
+        "type": "object"
+      }
+    }
+  },
+  "nodes": [
+    {
+      "id": "brief",
+      "category": "input",
+      "type": "input.item",
+      "params": {
+        "path": "brief"
+      },
+      "deterministic": true
+    },
+    {
+      "id": "selected-media",
+      "category": "input",
+      "type": "input.item",
+      "params": {
+        "path": "selectedMedia"
+      },
+      "deterministic": true
+    },
+    {
+      "id": "research",
+      "category": "analysis",
+      "type": "analysis.researchBrief",
+      "params": {
+        "briefFrom": {
+          "kind": "upstream",
+          "node": "brief"
+        },
+        "mediaFrom": {
+          "kind": "upstream",
+          "node": "selected-media"
+        }
+      },
+      "deterministic": true
+    },
+    {
+      "id": "script",
+      "category": "generation",
+      "type": "generation.script",
+      "params": {
+        "style": "clean-room social cutdown",
+        "briefFrom": {
+          "kind": "upstream",
+          "node": "brief"
+        },
+        "researchFrom": {
+          "kind": "upstream",
+          "node": "research"
+        },
+        "mediaFrom": {
+          "kind": "upstream",
+          "node": "selected-media"
+        }
+      },
+      "deterministic": false
+    },
+    {
+      "id": "shotlist",
+      "category": "generation",
+      "type": "generation.shotlist",
+      "params": {
+        "format": "reference-driven-cutdown",
+        "scriptFrom": {
+          "kind": "upstream",
+          "node": "script"
+        },
+        "mediaFrom": {
+          "kind": "upstream",
+          "node": "selected-media"
+        }
+      },
+      "deterministic": false
+    },
+    {
+      "id": "candidates",
+      "category": "analysis",
+      "type": "analysis.hooks",
+      "params": {
+        "source": {
+          "kind": "upstream",
+          "node": "selected-media"
+        },
+        "transcriptFrom": {
+          "kind": "upstream",
+          "node": "script"
+        },
+        "maxCandidates": 6
+      },
+      "deterministic": true
+    },
+    {
+      "id": "contact-sheet",
+      "category": "transform",
+      "type": "transform.contactSheet",
+      "params": {
+        "title": "Clean-room reference cutdown contact sheet",
+        "candidatesFrom": {
+          "kind": "upstream",
+          "node": "candidates"
+        },
+        "shotlistFrom": {
+          "kind": "upstream",
+          "node": "shotlist"
+        },
+        "providerRefs": [
+          "provider:analysis",
+          "provider:generation",
+          "provider:render"
+        ]
+      },
+      "deterministic": true
+    },
+    {
+      "id": "cost-brief",
+      "category": "transform",
+      "type": "transform.compose",
+      "params": {
+        "fields": {
+          "estimatedUsd": {
+            "kind": "literal",
+            "value": 10
+          },
+          "providerRefs": {
+            "kind": "literal",
+            "value": [
+              "provider:analysis",
+              "provider:generation",
+              "provider:render"
+            ]
+          },
+          "script": {
+            "kind": "upstream",
+            "node": "script"
+          },
+          "shotlist": {
+            "kind": "upstream",
+            "node": "shotlist"
+          },
+          "candidates": {
+            "kind": "upstream",
+            "node": "contact-sheet"
+          }
+        }
+      },
+      "deterministic": true
+    },
+    {
+      "id": "confirm-cost",
+      "category": "decision",
+      "type": "decision.approval",
+      "params": {
+        "kind": "confirm-cost",
+        "prompt": "Confirm provider cost before candidate review. Respond with {approved: true} to continue.",
+        "payloadFrom": {
+          "kind": "upstream",
+          "node": "cost-brief"
+        }
+      },
+      "deterministic": false
+    },
+    {
+      "id": "approve-cutdown",
+      "category": "decision",
+      "type": "decision.approval",
+      "params": {
+        "kind": "choose-candidates",
+        "prompt": "Choose clean-room social cutdown candidates. Respond with {candidates: [...]} using only reference-derived structure, not copied assets.",
+        "payloadFrom": {
+          "kind": "upstream",
+          "node": "contact-sheet"
+        }
+      },
+      "deterministic": false
+    },
+    {
+      "id": "apply-cutdown",
+      "category": "editor",
+      "type": "editor.commandTransaction",
+      "params": {
+        "label": "Create approved reference cutdown artifacts",
+        "commands": [
+          {
+            "tool": "artifact.create",
+            "arguments": {
+              "kind": "workflow-approval",
+              "label": "Approved clean-room social cutdown",
+              "sourceRef": "approval.response"
+            }
+          }
+        ]
+      },
+      "deterministic": true
+    },
+    {
+      "id": "finals",
+      "category": "control",
+      "type": "control.map",
+      "params": {
+        "workflow": {
+          "formatVersion": 1,
+          "id": "joy.first-party.reference-social-cutdown.delivery",
+          "version": "2.0.0",
+          "name": "Reference social cutdown delivery",
+          "inputs": {
+            "type": "object",
+            "description": "One approved render source."
+          },
+          "outputs": {
+            "type": "object"
+          },
+          "nodes": [
+            {
+              "id": "render",
+              "category": "render",
+              "type": "render.final",
+              "params": {
+                "profile": "social-cutdown-vertical",
+                "source": {
+                  "kind": "input"
+                }
+              },
+              "deterministic": true,
+              "retry": {
+                "maxAttempts": 2,
+                "backoffMs": 1000
+              }
+            },
+            {
+              "id": "inspect",
+              "category": "render",
+              "type": "render.inspect",
+              "params": {
+                "source": {
+                  "kind": "upstream",
+                  "node": "render"
+                },
+                "reportRef": "joy.first-party.reference-social-cutdown.delivery.qa-report"
+              },
+              "deterministic": true
+            },
+            {
+              "id": "manifest",
+              "category": "output",
+              "type": "output.deliveryManifest",
+              "params": {
+                "folderId": "exports",
+                "fileName": "delivery.json",
+                "source": {
+                  "kind": "upstream",
+                  "node": "render"
+                },
+                "inspectionFrom": {
+                  "kind": "upstream",
+                  "node": "inspect"
+                },
+                "providerRefs": [
+                  "provider:analysis",
+                  "provider:generation",
+                  "provider:render"
+                ]
+              },
+              "deterministic": true
+            }
+          ],
+          "edges": [
+            {
+              "from": "render",
+              "to": "inspect"
+            },
+            {
+              "from": "render",
+              "to": "manifest"
+            },
+            {
+              "from": "inspect",
+              "to": "manifest"
+            }
+          ],
+          "permissions": [],
+          "policy": {
+            "concurrency": 1,
+            "failure": "stop",
+            "defaultRetry": {
+              "maxAttempts": 1,
+              "backoffMs": 0
+            }
+          }
+        },
+        "itemsFrom": {
+          "kind": "upstream",
+          "node": "approve-cutdown",
+          "path": "response.candidates"
+        }
+      },
+      "deterministic": true
+    },
+    {
+      "id": "run-report",
+      "category": "transform",
+      "type": "transform.compose",
+      "params": {
+        "fields": {
+          "providerRefs": {
+            "kind": "literal",
+            "value": [
+              "provider:analysis",
+              "provider:generation",
+              "provider:render"
+            ]
+          },
+          "costApproval": {
+            "kind": "upstream",
+            "node": "confirm-cost",
+            "path": "response"
+          },
+          "creativeApproval": {
+            "kind": "upstream",
+            "node": "approve-cutdown",
+            "path": "response"
+          },
+          "deliveries": {
+            "kind": "upstream",
+            "node": "finals"
+          }
+        }
+      },
+      "deterministic": true
+    },
+    {
+      "id": "manifest",
+      "category": "output",
+      "type": "output.metadata",
+      "params": {
+        "folderId": "exports",
+        "fileName": "reference-social-cutdown-run.json",
+        "source": {
+          "kind": "upstream",
+          "node": "run-report"
+        }
+      },
+      "deterministic": true
+    }
+  ],
+  "edges": [
+    {
+      "from": "brief",
+      "to": "research"
+    },
+    {
+      "from": "selected-media",
+      "to": "research"
+    },
+    {
+      "from": "brief",
+      "to": "script"
+    },
+    {
+      "from": "research",
+      "to": "script"
+    },
+    {
+      "from": "selected-media",
+      "to": "script"
+    },
+    {
+      "from": "script",
+      "to": "shotlist"
+    },
+    {
+      "from": "selected-media",
+      "to": "shotlist"
+    },
+    {
+      "from": "selected-media",
+      "to": "candidates"
+    },
+    {
+      "from": "script",
+      "to": "candidates"
+    },
+    {
+      "from": "candidates",
+      "to": "contact-sheet"
+    },
+    {
+      "from": "shotlist",
+      "to": "contact-sheet"
+    },
+    {
+      "from": "script",
+      "to": "cost-brief"
+    },
+    {
+      "from": "shotlist",
+      "to": "cost-brief"
+    },
+    {
+      "from": "contact-sheet",
+      "to": "cost-brief"
+    },
+    {
+      "from": "cost-brief",
+      "to": "confirm-cost"
+    },
+    {
+      "from": "contact-sheet",
+      "to": "approve-cutdown"
+    },
+    {
+      "from": "confirm-cost",
+      "to": "approve-cutdown"
+    },
+    {
+      "from": "approve-cutdown",
+      "to": "apply-cutdown"
+    },
+    {
+      "from": "approve-cutdown",
+      "to": "finals"
+    },
+    {
+      "from": "apply-cutdown",
+      "to": "finals"
+    },
+    {
+      "from": "confirm-cost",
+      "to": "run-report"
+    },
+    {
+      "from": "approve-cutdown",
+      "to": "run-report"
+    },
+    {
+      "from": "finals",
+      "to": "run-report"
+    },
+    {
+      "from": "run-report",
+      "to": "manifest"
+    }
+  ],
+  "permissions": [
+    {
+      "capability": "provider.research"
+    },
+    {
+      "capability": "provider.script"
+    },
+    {
+      "capability": "provider.highlights"
+    },
+    {
+      "capability": "provider.cost"
+    },
+    {
+      "capability": "editor.command"
+    },
+    {
+      "capability": "render.final"
+    },
+    {
+      "capability": "render.inspect"
+    },
+    {
+      "capability": "output.write"
+    },
+    {
+      "capability": "provider.reference-analysis"
+    }
+  ],
+  "policy": {
+    "concurrency": 1,
+    "failure": "stop",
+    "defaultRetry": {
+      "maxAttempts": 1,
+      "backoffMs": 0
+    }
+  }
+}
