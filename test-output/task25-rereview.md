# Review package: 5afae4e..977a676

## Commits
977a676 fix(workflows): complete pipeline pack metadata

## Files changed
 packages/workflow-engine/src/first-party.test.ts   |  93 +++++++++-
 packages/workflow-engine/src/first-party.ts        | 202 +++++++++++++--------
 .../workflows/reference-social-cutdown.json        |  20 +-
 3 files changed, 233 insertions(+), 82 deletions(-)

## Diff
diff --git a/packages/workflow-engine/src/first-party.test.ts b/packages/workflow-engine/src/first-party.test.ts
index 85a765a..740db60 100644
--- a/packages/workflow-engine/src/first-party.test.ts
+++ b/packages/workflow-engine/src/first-party.test.ts
@@ -9,20 +9,21 @@ import {
   FIRST_PARTY_WORKFLOW_IDS,
   buildFirstPartyPipelinePacks,
   buildFirstPartyWorkflows,
   buildLongVideoDraftReelsWorkflow,
   buildMultilingualPromoWorkflow,
   buildPodcastCleanupWorkflow,
   buildInterviewDocumentaryAssemblyWorkflow,
   buildReferenceSocialCutdownWorkflow,
   firstPartyDefinitionFiles,
 } from './first-party.js';
+import type { JoyWorkflow } from './definition.js';
 import { runWorkflowHeadless } from './headless.js';
 import type { NodeLibrary } from './library.js';
 import { buildNodeLibrary } from './library.js';
 
 // ---------------------------------------------------------------------------
 // Stub environment: every port records its calls and returns deterministic,
 // self-describing values, so tests can assert both wiring and invocation counts
 // (no duplicated completed work across resumes — §36 Phase 7 exit criterion).
 // ---------------------------------------------------------------------------
 
@@ -36,26 +37,30 @@ function stubEnvironment() {
       return result(args);
     };
   };
   const count = (name: string): number => calls.get(name)?.length ?? 0;
   const argsOf = (name: string): readonly unknown[] => calls.get(name) ?? [];
 
   let branchSeq = 0;
   const library = buildNodeLibrary({
     ports: {
       analysis: {
-        researchBrief: track('researchBrief', (args: { brief: unknown; media: unknown }) => ({
-          researchRef: 'research-1',
-          brief: args.brief,
-          media: args.media,
-          providerRefs: ['provider:fixture-research'],
-        })),
+        researchBrief: track(
+          'researchBrief',
+          (args: { brief: unknown; media: unknown; references?: unknown }) => ({
+            researchRef: 'research-1',
+            brief: args.brief,
+            media: args.media,
+            ...(args.references !== undefined ? { references: args.references } : {}),
+            providerRefs: ['provider:fixture-research'],
+          }),
+        ),
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
@@ -204,20 +209,76 @@ const runHeadless = (
     projectRevision: 'rev-fp',
     ...extras,
   });
 
 const productionInputs = (overrides: Record<string, unknown> = {}) => ({
   brief: 'Make a polished social-ready edit from the selected media.',
   selectedMedia: { assetId: 'asset-long-1' },
   ...overrides,
 });
 
+const PORT_BACKED_NODE_PORTS = new Map<string, string>([
+  ['analysis.researchBrief', 'analysis.researchBrief'],
+  ['analysis.transcribe', 'analysis.transcribe'],
+  ['analysis.silence', 'analysis.detectSilence'],
+  ['analysis.loudness', 'analysis.measureLoudness'],
+  ['analysis.hooks', 'analysis.detectHighlights'],
+  ['analysis.speakers', 'analysis.detectSpeakers'],
+  ['analysis.chapters', 'analysis.generateChapters'],
+  ['transform.trim', 'transform.trim'],
+  ['transform.caption', 'transform.applyCaptionTemplate'],
+  ['transform.reframe', 'transform.reframe'],
+  ['transform.denoise', 'transform.denoise'],
+  ['transform.normalizeAudio', 'transform.normalizeAudio'],
+  ['transform.sceneTemplate', 'transform.instantiateSceneTemplate'],
+  ['transform.contactSheet', 'transform.buildContactSheet'],
+  ['generation.speech', 'generation.synthesizeSpeech'],
+  ['generation.image', 'generation.generateImage'],
+  ['generation.translate', 'generation.translate'],
+  ['generation.script', 'generation.generateScript'],
+  ['generation.shotlist', 'generation.generateShotlist'],
+  ['editor.commandTransaction', 'editor.executeCommandTransaction'],
+  ['editor.createBranch', 'editor.createBranch'],
+  ['render.preview', 'render.render'],
+  ['render.final', 'render.render'],
+  ['render.inspect', 'render.inspect'],
+  ['output.folder', 'output.writeToFolder'],
+  ['output.metadata', 'output.writeMetadataFile'],
+  ['output.deliveryManifest', 'output.writeDeliveryManifest'],
+]);
+
+function isWorkflowLike(value: unknown): value is JoyWorkflow {
+  return (
+    value !== null &&
+    typeof value === 'object' &&
+    Array.isArray((value as { readonly nodes?: unknown }).nodes)
+  );
+}
+
+function collectRequiredPortsFromWorkflow(workflow: JoyWorkflow): readonly string[] {
+  const ports = new Set<string>();
+  const visit = (current: JoyWorkflow) => {
+    for (const node of current.nodes) {
+      const port = PORT_BACKED_NODE_PORTS.get(node.type);
+      if (port !== undefined) {
+        ports.add(port);
+      }
+      const nestedWorkflow = node.params['workflow'];
+      if (isWorkflowLike(nestedWorkflow)) {
+        visit(nestedWorkflow);
+      }
+    }
+  };
+  visit(workflow);
+  return [...ports].sort();
+}
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
@@ -236,20 +297,30 @@ describe('first-party workflow definitions (§23.4)', () => {
     const packs = buildFirstPartyPipelinePacks();
     expect(packs.map((pack) => pack.workflow.id)).toEqual([...FIRST_PARTY_WORKFLOW_IDS]);
     expect(packs).toHaveLength(5);
     for (const pack of packs) {
       expect(pack.provider).toBe('production');
       expect(pack.label).toBe('Production pack');
       expect(pack.requiredPorts.length).toBeGreaterThan(0);
       expect(pack.capabilities.length).toBeGreaterThan(0);
       expect(pack.approvals).toContain('confirm-cost');
       expect(pack.reportRefs.length).toBeGreaterThan(0);
+      const declaredPorts = new Set([...pack.requiredPorts, ...pack.optionalPorts]);
+      const missingPorts = collectRequiredPortsFromWorkflow(pack.workflow).filter(
+        (port) => !declaredPorts.has(port),
+      );
+      expect(missingPorts).toEqual([]);
+      const declaredCapabilities = new Set(pack.capabilities);
+      const missingCapabilities = pack.workflow.permissions
+        .map((permission) => permission.capability)
+        .filter((capability) => !declaredCapabilities.has(capability));
+      expect(missingCapabilities).toEqual([]);
       expect(pack.workflow.nodes.map((node) => node.id)).toEqual(
         expect.arrayContaining([
           'brief',
           'selected-media',
           'research',
           'script',
           'shotlist',
           'candidates',
           'contact-sheet',
           'confirm-cost',
@@ -686,30 +757,32 @@ describe('podcast cleanup', () => {
     expect(count('denoise')).toBe(1);
   });
 });
 
 // ---------------------------------------------------------------------------
 // New production packs.
 // ---------------------------------------------------------------------------
 
 describe('new production pipeline packs', () => {
   it('runs the clean-room reference social cutdown through approval, render, inspect, and manifest', () => {
-    const { library, count } = stubEnvironment();
+    const { library, count, argsOf } = stubEnvironment();
     const workflowJson = workflowToJson(buildReferenceSocialCutdownWorkflow().workflow);
-    const inputs = productionInputs({
-      references: [{ referenceId: 'ref-structure-1', note: 'fast cold open, no copied assets' }],
-    });
+    const references = [
+      { referenceId: 'ref-structure-1', note: 'fast cold open, no copied assets' },
+    ];
+    const inputs = productionInputs({ references });
 
     const first = runHeadless(library, workflowJson, inputs, 'cutdown-run');
     expect(first.ok).toBe(true);
     if (!first.ok) return;
     expect(first.checkpoint.nodes['confirm-cost']?.pendingRequest?.kind).toBe('confirm-cost');
+    expect((argsOf('researchBrief')[0] as { references?: unknown }).references).toEqual(references);
 
     const second = runHeadless(library, workflowJson, inputs, 'cutdown-run', {
       resumeFromJson: JSON.stringify(first.checkpoint),
       humanInputs: { 'confirm-cost': { approved: true } },
       reuseNondeterministic: true,
     });
     expect(second.ok).toBe(true);
     if (!second.ok) return;
     const request = second.checkpoint.nodes['approve-cutdown']?.pendingRequest;
     expect(request?.kind).toBe('choose-candidates');
diff --git a/packages/workflow-engine/src/first-party.ts b/packages/workflow-engine/src/first-party.ts
index 9d364d4..723980b 100644
--- a/packages/workflow-engine/src/first-party.ts
+++ b/packages/workflow-engine/src/first-party.ts
@@ -83,42 +83,124 @@ const CONTENT_INPUTS = {
       description: 'Optional structured rows for promo variants.',
     },
     delivery: {
       type: 'object',
       description: 'Optional delivery promise: aspect, codec, captions, approval requirements.',
     },
   },
   additionalProperties: false,
 } as const;
 
+const REFERENCE_CONTENT_INPUTS = {
+  ...CONTENT_INPUTS,
+  required: ['brief', 'selectedMedia', 'references'],
+} as const;
+
 const MANIFEST_OUTPUTS = {
   type: 'object',
   required: ['manifest'],
   properties: { manifest: { type: 'object' } },
 } as const;
 
+const unique = (...groups: readonly (readonly string[])[]): readonly string[] => [
+  ...new Set(groups.flat()),
+];
+
+const BASE_PIPELINE_REQUIRED_PORTS = [
+  'analysis.researchBrief',
+  'generation.generateScript',
+  'generation.generateShotlist',
+  'analysis.detectHighlights',
+  'transform.buildContactSheet',
+] as const;
+
+const APPROVAL_APPLY_REQUIRED_PORTS = ['editor.executeCommandTransaction'] as const;
+
+const FINAL_DELIVERY_REQUIRED_PORTS = [
+  'render.render',
+  'render.inspect',
+  'output.writeDeliveryManifest',
+] as const;
+
+const RUN_METADATA_REQUIRED_PORTS = ['output.writeMetadataFile'] as const;
+
+const DRAFT_REEL_ITEM_REQUIRED_PORTS = [
+  'editor.createBranch',
+  'transform.reframe',
+  'transform.applyCaptionTemplate',
+  'transform.normalizeAudio',
+  'render.render',
+] as const;
+
+const PROMO_ITEM_REQUIRED_PORTS = [
+  'generation.translate',
+  'generation.synthesizeSpeech',
+  'transform.applyCaptionTemplate',
+  'transform.instantiateSceneTemplate',
+  'render.render',
+  'render.inspect',
+  'output.writeDeliveryManifest',
+] as const;
+
+const PODCAST_REQUIRED_PORTS = [
+  'analysis.detectSpeakers',
+  'analysis.detectSilence',
+  'transform.denoise',
+  'transform.normalizeAudio',
+  'transform.trim',
+  'analysis.transcribe',
+  'analysis.generateChapters',
+  'transform.applyCaptionTemplate',
+  'render.render',
+  'render.inspect',
+  'output.writeDeliveryManifest',
+] as const;
+
+const INTERVIEW_EVIDENCE_REQUIRED_PORTS = [
+  'analysis.transcribe',
+  'analysis.generateChapters',
+] as const;
+
+const BASE_PIPELINE_CAPABILITIES = [
+  'provider.research',
+  'provider.script',
+  'provider.highlights',
+  'provider.cost',
+  'editor.command',
+  'render.final',
+  'render.inspect',
+  'output.write',
+] as const;
+
 function baseContentPipeline(
   builder: WorkflowBuilder,
   options: {
     readonly scriptStyle: string;
     readonly shotlistFormat: string;
     readonly candidateTitle: string;
     readonly candidateCount: number;
     readonly costUsd: number;
+    readonly includeReferences?: boolean;
   },
 ): WorkflowBuilder {
-  return builder
+  let current = builder
     .node('brief', 'input.item', { path: 'brief' })
-    .node('selected-media', 'input.item', { path: 'selectedMedia' })
+    .node('selected-media', 'input.item', { path: 'selectedMedia' });
+  if (options.includeReferences === true) {
+    current = current.node('references', 'input.item', { path: 'references' });
+  }
+
+  current = current
     .node('research', 'analysis.researchBrief', {
       briefFrom: upstream('brief'),
       mediaFrom: upstream('selected-media'),
+      ...(options.includeReferences === true ? { referencesFrom: upstream('references') } : {}),
     })
     .node('script', 'generation.script', {
       style: options.scriptStyle,
       briefFrom: upstream('brief'),
       researchFrom: upstream('research'),
       mediaFrom: upstream('selected-media'),
     })
     .node('shotlist', 'generation.shotlist', {
       format: options.shotlistFormat,
       scriptFrom: upstream('script'),
@@ -144,21 +226,26 @@ function baseContentPipeline(
         candidates: upstream('contact-sheet'),
       },
     })
     .node('confirm-cost', 'decision.approval', {
       kind: 'confirm-cost',
       prompt:
         'Confirm provider cost before candidate review. Respond with {approved: true} to continue.',
       payloadFrom: upstream('cost-brief'),
     })
     .edge('brief', 'research')
-    .edge('selected-media', 'research')
+    .edge('selected-media', 'research');
+  if (options.includeReferences === true) {
+    current = current.edge('references', 'research');
+  }
+
+  return current
     .edge('brief', 'script')
     .edge('research', 'script')
     .edge('selected-media', 'script')
     .edge('script', 'shotlist')
     .edge('selected-media', 'shotlist')
     .edge('selected-media', 'candidates')
     .edge('script', 'candidates')
     .edge('candidates', 'contact-sheet')
     .edge('shotlist', 'contact-sheet')
     .edge('script', 'cost-brief')
@@ -569,29 +656,30 @@ export function buildPodcastCleanupWorkflow(): FirstPartyWorkflow {
     .build();
 }
 
 export function buildReferenceSocialCutdownWorkflow(): FirstPartyWorkflow {
   const { registry } = buildNodeLibrary();
   const builder = baseContentPipeline(
     new WorkflowBuilder(registry, {
       id: 'joy.first-party.reference-social-cutdown',
       version: FIRST_PARTY_WORKFLOWS_VERSION,
       name: 'Reference social cutdown',
-      inputs: CONTENT_INPUTS,
+      inputs: REFERENCE_CONTENT_INPUTS,
       outputs: MANIFEST_OUTPUTS,
     }),
     {
       scriptStyle: 'clean-room social cutdown',
       shotlistFormat: 'reference-driven-cutdown',
       candidateTitle: 'Clean-room reference cutdown contact sheet',
       candidateCount: 6,
       costUsd: 10,
+      includeReferences: true,
     },
   )
     .node('approve-cutdown', 'decision.approval', {
       kind: 'choose-candidates',
       prompt:
         'Choose clean-room social cutdown candidates. Respond with {candidates: [...]} using only reference-derived structure, not copied assets.',
       payloadFrom: upstream('contact-sheet'),
     })
     .node('apply-cutdown', 'editor.commandTransaction', {
       label: 'Create approved reference cutdown artifacts',
@@ -713,126 +801,98 @@ export const FIRST_PARTY_WORKFLOW_IDS = [
 
 export type FirstPartyWorkflowId = (typeof FIRST_PARTY_WORKFLOW_IDS)[number];
 
 const PACK_DESCRIPTORS: readonly PackDescriptor[] = [
   {
     id: 'joy.first-party.long-video-draft-reels',
     fileName: 'long-video-draft-reels.json',
     label: 'Production pack',
     summary:
       'Brief-to-research reel pipeline with contact sheet, approvals, final QA, and manifest.',
-    requiredPorts: [
-      'analysis.researchBrief',
-      'generation.generateScript',
-      'generation.generateShotlist',
-      'analysis.detectHighlights',
-      'transform.buildContactSheet',
-      'editor.executeCommandTransaction',
-      'render.render',
-      'render.inspect',
-      'output.writeDeliveryManifest',
-      'output.writeMetadataFile',
-    ],
-    optionalPorts: ['analysis.transcribe'],
-    capabilities: ['provider.research', 'provider.script', 'provider.highlights', 'render.final'],
+    requiredPorts: unique(
+      BASE_PIPELINE_REQUIRED_PORTS,
+      APPROVAL_APPLY_REQUIRED_PORTS,
+      DRAFT_REEL_ITEM_REQUIRED_PORTS,
+      FINAL_DELIVERY_REQUIRED_PORTS,
+      RUN_METADATA_REQUIRED_PORTS,
+    ),
+    capabilities: BASE_PIPELINE_CAPABILITIES,
     approvals: ['confirm-cost', 'choose-candidates', 'approve-render'],
     reportRefs: ['joy.first-party.long-video-draft-reels.final.qa-report'],
     build: buildLongVideoDraftReelsWorkflow,
   },
   {
     id: 'joy.first-party.multilingual-promo',
     fileName: 'multilingual-promo.json',
     label: 'Production pack',
     summary: 'Localized promo pipeline with copy approval, TTS, final QA, and delivery manifest.',
-    requiredPorts: [
-      'analysis.researchBrief',
-      'generation.generateScript',
-      'generation.generateShotlist',
-      'generation.translate',
-      'generation.synthesizeSpeech',
-      'render.render',
-      'render.inspect',
-      'output.writeDeliveryManifest',
-      'output.writeMetadataFile',
-    ],
-    capabilities: ['provider.translate', 'provider.tts', 'render.final'],
+    requiredPorts: unique(
+      BASE_PIPELINE_REQUIRED_PORTS,
+      APPROVAL_APPLY_REQUIRED_PORTS,
+      PROMO_ITEM_REQUIRED_PORTS,
+      RUN_METADATA_REQUIRED_PORTS,
+    ),
+    capabilities: unique(BASE_PIPELINE_CAPABILITIES, ['provider.translate', 'provider.tts']),
     approvals: ['confirm-cost', 'approve-transcript'],
     reportRefs: ['joy.first-party.multilingual-promo.qa-report'],
     build: buildMultilingualPromoWorkflow,
   },
   {
     id: 'joy.first-party.podcast-cleanup',
     fileName: 'podcast-cleanup.json',
     label: 'Production pack',
     summary:
       'Podcast cleanup with approved speakers/edit list, episode render, clips, QA, and manifest.',
-    requiredPorts: [
-      'analysis.researchBrief',
-      'analysis.detectSpeakers',
-      'analysis.detectSilence',
-      'transform.denoise',
-      'transform.normalizeAudio',
-      'transform.trim',
-      'analysis.transcribe',
-      'analysis.generateChapters',
-      'render.render',
-      'render.inspect',
-      'output.writeDeliveryManifest',
-    ],
-    capabilities: ['provider.audio-cleanup', 'provider.transcribe', 'render.final'],
+    requiredPorts: unique(
+      BASE_PIPELINE_REQUIRED_PORTS,
+      APPROVAL_APPLY_REQUIRED_PORTS,
+      PODCAST_REQUIRED_PORTS,
+    ),
+    capabilities: unique(BASE_PIPELINE_CAPABILITIES, [
+      'provider.audio-cleanup',
+      'provider.transcribe',
+    ]),
     approvals: ['confirm-cost', 'choose-candidates', 'accept-edit-diff'],
     reportRefs: ['joy.first-party.podcast-cleanup.qa-report'],
     build: buildPodcastCleanupWorkflow,
   },
   {
     id: 'joy.first-party.reference-social-cutdown',
     fileName: 'reference-social-cutdown.json',
     label: 'Production pack',
     summary:
       'Clean-room reference-driven social cutdown from brief/media/references to QA delivery.',
-    requiredPorts: [
-      'analysis.researchBrief',
-      'generation.generateScript',
-      'generation.generateShotlist',
-      'analysis.detectHighlights',
-      'transform.buildContactSheet',
-      'editor.executeCommandTransaction',
-      'render.render',
-      'render.inspect',
-      'output.writeDeliveryManifest',
-      'output.writeMetadataFile',
-    ],
-    capabilities: ['provider.reference-analysis', 'provider.script', 'render.final'],
+    requiredPorts: unique(
+      BASE_PIPELINE_REQUIRED_PORTS,
+      APPROVAL_APPLY_REQUIRED_PORTS,
+      FINAL_DELIVERY_REQUIRED_PORTS,
+      RUN_METADATA_REQUIRED_PORTS,
+    ),
+    capabilities: unique(BASE_PIPELINE_CAPABILITIES, ['provider.reference-analysis']),
     approvals: ['confirm-cost', 'choose-candidates'],
     reportRefs: ['joy.first-party.reference-social-cutdown.delivery.qa-report'],
     build: buildReferenceSocialCutdownWorkflow,
   },
   {
     id: 'joy.first-party.interview-documentary-assembly',
     fileName: 'interview-documentary-assembly.json',
     label: 'Production pack',
     summary:
       'Interview/documentary assembly with transcript/chapter evidence, approval, QA, and manifest.',
-    requiredPorts: [
-      'analysis.researchBrief',
-      'generation.generateScript',
-      'generation.generateShotlist',
-      'analysis.transcribe',
-      'analysis.generateChapters',
-      'transform.buildContactSheet',
-      'editor.executeCommandTransaction',
-      'render.render',
-      'render.inspect',
-      'output.writeDeliveryManifest',
-      'output.writeMetadataFile',
-    ],
-    capabilities: ['provider.transcribe', 'provider.script', 'render.final'],
+    requiredPorts: unique(
+      BASE_PIPELINE_REQUIRED_PORTS,
+      INTERVIEW_EVIDENCE_REQUIRED_PORTS,
+      APPROVAL_APPLY_REQUIRED_PORTS,
+      FINAL_DELIVERY_REQUIRED_PORTS,
+      RUN_METADATA_REQUIRED_PORTS,
+    ),
+    capabilities: unique(BASE_PIPELINE_CAPABILITIES, ['provider.transcribe']),
     approvals: ['confirm-cost', 'choose-candidates'],
     reportRefs: ['joy.first-party.interview-documentary-assembly.delivery.qa-report'],
     build: buildInterviewDocumentaryAssemblyWorkflow,
   },
 ];
 
 export function buildFirstPartyPipelinePacks(): readonly FirstPartyPipelinePack[] {
   return PACK_DESCRIPTORS.map((descriptor) => {
     const built = descriptor.build();
     return {
diff --git a/packages/workflow-engine/workflows/reference-social-cutdown.json b/packages/workflow-engine/workflows/reference-social-cutdown.json
index 942b9a1..a873a38 100644
--- a/packages/workflow-engine/workflows/reference-social-cutdown.json
+++ b/packages/workflow-engine/workflows/reference-social-cutdown.json
@@ -1,20 +1,21 @@
 {
   "formatVersion": 1,
   "id": "joy.first-party.reference-social-cutdown",
   "version": "2.0.0",
   "name": "Reference social cutdown",
   "inputs": {
     "type": "object",
     "required": [
       "brief",
-      "selectedMedia"
+      "selectedMedia",
+      "references"
     ],
     "properties": {
       "brief": {
         "type": "string",
         "minLength": 1,
         "description": "Creative brief or client goal for this production run.",
         "default": "Create a polished, on-brand edit from the selected media."
       },
       "selectedMedia": {
         "type": "object",
@@ -64,32 +65,45 @@
     },
     {
       "id": "selected-media",
       "category": "input",
       "type": "input.item",
       "params": {
         "path": "selectedMedia"
       },
       "deterministic": true
     },
+    {
+      "id": "references",
+      "category": "input",
+      "type": "input.item",
+      "params": {
+        "path": "references"
+      },
+      "deterministic": true
+    },
     {
       "id": "research",
       "category": "analysis",
       "type": "analysis.researchBrief",
       "params": {
         "briefFrom": {
           "kind": "upstream",
           "node": "brief"
         },
         "mediaFrom": {
           "kind": "upstream",
           "node": "selected-media"
+        },
+        "referencesFrom": {
+          "kind": "upstream",
+          "node": "references"
         }
       },
       "deterministic": true
     },
     {
       "id": "script",
       "category": "generation",
       "type": "generation.script",
       "params": {
         "style": "clean-room social cutdown",
@@ -397,20 +411,24 @@
   ],
   "edges": [
     {
       "from": "brief",
       "to": "research"
     },
     {
       "from": "selected-media",
       "to": "research"
     },
+    {
+      "from": "references",
+      "to": "research"
+    },
     {
       "from": "brief",
       "to": "script"
     },
     {
       "from": "research",
       "to": "script"
     },
     {
       "from": "selected-media",
