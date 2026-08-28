# Review package: 8bef9a7..6ff590b

## Commits
6ff590b feat(providers): persist explained decisions and budget reconciliation

## Files changed
 packages/agent-tools/src/context.ts         |  85 ++++++-
 packages/agent-tools/src/estimation.test.ts |  73 ++++++
 packages/agent-tools/src/estimation.ts      |  89 ++++++-
 packages/agent-tools/src/index.ts           |   7 +-
 packages/provider-sdk/src/budget.test.ts    | 146 +++++++++++
 packages/provider-sdk/src/budget.ts         | 237 ++++++++++++++++++
 packages/provider-sdk/src/decision.test.ts  | 173 +++++++++++++
 packages/provider-sdk/src/decision.ts       | 364 ++++++++++++++++++++++++++++
 packages/provider-sdk/src/index.ts          |  27 ++-
 packages/provider-sdk/src/provenance.ts     |  17 +-
 packages/provider-sdk/src/resolution.ts     |  12 +
 packages/provider-sdk/src/types.ts          |  69 ++++++
 12 files changed, 1278 insertions(+), 21 deletions(-)

## Diff
diff --git a/packages/agent-tools/src/context.ts b/packages/agent-tools/src/context.ts
index ef3dc13..9fe4103 100644
--- a/packages/agent-tools/src/context.ts
+++ b/packages/agent-tools/src/context.ts
@@ -1,12 +1,27 @@
 import type { Composition, JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
 import type { SpikeCommand } from '@joy-media/commands';
+import type {
+  AnyProvider,
+  CapabilityId,
+  PricingDescriptor,
+  ResourceEstimate,
+} from '@joy-media/provider-sdk';
+import {
+  getCapabilityDeclaration,
+  getCapabilityIds,
+  getDataLeavesDevice,
+  getExecution,
+  getProviderId,
+  isLocalExecution,
+  isV2Provider,
+} from '@joy-media/provider-sdk';
 
 /**
  * The live seam between an edit tool and the real, undoable command bus the
  * human editor uses (WP-15.1). When bound, `EditTool.execute` dispatches a
  * genuine `SpikeCommand` transaction instead of fabricating a preview diff;
  * a real validation failure (unknown target, overlap, duplicate id, …) comes
  * back as `success: false` with the underlying command's own error. When
  * absent — planning/estimation/test contexts that never had a live project —
  * tools fall back to their historical preview-shaped result.
  */
@@ -84,61 +99,81 @@ export interface AudioContext {
   readonly hasDialogue: boolean;
   readonly peakLevelDb?: number;
   readonly loudnessLufs?: number;
 }
 
 export interface ProviderContext {
   readonly availableProviders: readonly ProviderSummary[];
   readonly localOnly: boolean;
 }
 
+export interface ProviderCapabilitySummary {
+  readonly capability: CapabilityId;
+  readonly pricing?: PricingDescriptor;
+  readonly estimatedResources?: ResourceEstimate;
+}
+
+export interface ProviderPriceSummary {
+  readonly capability: CapabilityId;
+  readonly pricing: PricingDescriptor;
+}
+
 export interface ProviderSummary {
   readonly id: string;
   readonly displayName: string;
   readonly execution: 'worker-local' | 'remote-api' | 'server' | 'browser';
   readonly capabilities: readonly string[];
   readonly dataLeavesDevice: boolean;
+  readonly capabilityDetails?: readonly ProviderCapabilitySummary[];
+  readonly prices?: readonly ProviderPriceSummary[];
 }
 
 export interface ExportTargetContext {
   readonly format: string;
   readonly resolution: string;
   readonly codec: string;
 }
 
 export interface ContextOptions {
   readonly maxTimelineSummaryItems?: number;
   readonly maxHistoryItems?: number;
   readonly maxCaptionExcerptWords?: number;
   readonly includeProviderDetails?: boolean;
 }
 
 export function buildEditorContext(
   projectState: unknown,
   options?: ContextOptions,
   dispatch?: CommandDispatcher,
-  extras?: { readonly liveAudio?: import('@joy-media/commands').AudioState },
+  extras?: {
+    readonly liveAudio?: import('@joy-media/commands').AudioState;
+    readonly providers?: readonly AnyProvider[];
+  },
 ): EditorContext {
   const opts = {
     maxTimelineSummaryItems: 10,
     maxHistoryItems: 5,
     maxCaptionExcerptWords: 50,
     includeProviderDetails: true,
     ...options,
   };
 
   const project = extractProjectSummary(projectState);
   const selection = extractSelectionContext(projectState);
   const timeline = extractTimelineContext(projectState, opts.maxTimelineSummaryItems);
   const captions = extractCaptionContext(projectState, opts.maxCaptionExcerptWords);
   const audio = extractAudioContext(projectState);
-  const providers = extractProviderContext(projectState, opts.includeProviderDetails);
+  const providers = extractProviderContext(
+    projectState,
+    opts.includeProviderDetails,
+    extras?.providers ?? [],
+  );
 
   return {
     project,
     selection,
     timeline,
     ...(captions && { captions }),
     audio,
     ...(extras?.liveAudio !== undefined ? { liveAudio: extras.liveAudio } : {}),
     providers,
     availableTools: [],
@@ -268,24 +303,64 @@ function extractCaptionContext(state: unknown, _maxWords: number): CaptionContex
 }
 
 function extractAudioContext(_state: unknown): AudioContext {
   return {
     clipCount: 0,
     busCount: 0,
     hasDialogue: false,
   };
 }
 
-function extractProviderContext(_state: unknown, _includeDetails: boolean): ProviderContext {
+function extractProviderContext(
+  _state: unknown,
+  includeDetails: boolean,
+  providers: readonly AnyProvider[],
+): ProviderContext {
+  if (!includeDetails || providers.length === 0) {
+    return {
+      availableProviders: [],
+      localOnly: true,
+    };
+  }
+
+  const availableProviders = providers.map((provider) => summarizeProvider(provider));
+  return {
+    availableProviders,
+    localOnly: providers.every((provider) => isLocalExecution(getExecution(provider))),
+  };
+}
+
+function summarizeProvider(provider: AnyProvider): ProviderSummary {
+  const capabilities = getCapabilityIds(provider);
+  const capabilityDetails = capabilities.map((capability) => {
+    const declaration = getCapabilityDeclaration(provider, capability);
+    const pricing = declaration?.pricing;
+    const estimatedResources = declaration?.estimatedResources;
+    return {
+      capability,
+      ...(pricing === undefined ? {} : { pricing }),
+      ...(estimatedResources === undefined ? {} : { estimatedResources }),
+    };
+  });
+  const prices = capabilityDetails.flatMap((detail) =>
+    detail.pricing === undefined
+      ? []
+      : [{ capability: detail.capability, pricing: detail.pricing }],
+  );
   return {
-    availableProviders: [],
-    localOnly: true,
+    id: getProviderId(provider),
+    displayName: isV2Provider(provider) ? provider.manifest.displayName : provider.manifest.id,
+    execution: getExecution(provider),
+    capabilities,
+    dataLeavesDevice: getDataLeavesDevice(provider) !== false,
+    capabilityDetails,
+    prices,
   };
 }
 
 function isProject(value: unknown): value is SpikeProject {
   return (
     typeof value === 'object' &&
     value !== null &&
     'schemaVersion' in value &&
     (value as { schemaVersion: unknown }).schemaVersion === 0
   );
diff --git a/packages/agent-tools/src/estimation.test.ts b/packages/agent-tools/src/estimation.test.ts
new file mode 100644
index 0000000..17bc713
--- /dev/null
+++ b/packages/agent-tools/src/estimation.test.ts
@@ -0,0 +1,73 @@
+import { describe, expect, it } from 'vitest';
+import { createMockProvider } from '@joy-media/provider-sdk';
+import { buildEditorContext } from './context.js';
+import { estimateStep } from './estimation.js';
+import { createToolRegistry } from './registry.js';
+import type { AgentPlanStep } from './plan.js';
+
+describe('provider-aware agent estimation', () => {
+  const provider = createMockProvider('remote-speech', ['speech.transcribe'], {
+    execution: 'remote-api',
+    privacy: { dataLeavesDevice: true },
+  });
+  const pricedProvider = {
+    ...provider,
+    manifest: {
+      ...provider.manifest,
+      capabilities: [
+        {
+          ...provider.manifest.capabilities[0]!,
+          pricing: { model: 'per-request' as const, rate: '0.42', currency: 'USD' },
+          estimatedResources: { estimatedDurationMs: 1500 },
+        },
+      ],
+    },
+  };
+
+  const step: AgentPlanStep = {
+    id: 'step-1',
+    description: 'Transcribe selected clip',
+    mode: 'job',
+    tool: 'speechTranscribe',
+    arguments: {},
+    dependsOn: [],
+    expectedChange: 'caption document',
+    preconditions: [],
+    requiresConfirmation: true,
+  };
+
+  it('builds planning context from configured providers with capabilities and prices', () => {
+    const context = buildEditorContext({}, undefined, undefined, { providers: [pricedProvider] });
+
+    expect(context.providers.localOnly).toBe(false);
+    expect(context.providers.availableProviders).toEqual([
+      expect.objectContaining({
+        id: 'remote-speech',
+        capabilities: ['speech.transcribe'],
+        prices: [
+          {
+            capability: 'speech.transcribe',
+            pricing: { model: 'per-request', rate: '0.42', currency: 'USD' },
+          },
+        ],
+      }),
+    ]);
+  });
+
+  it('estimates provider cost and privacy from configured capability pricing', () => {
+    const context = buildEditorContext({}, undefined, undefined, { providers: [pricedProvider] });
+
+    const estimation = estimateStep(step, createToolRegistry(), context);
+
+    expect(estimation.cost).toEqual({
+      localOnly: false,
+      providerCost: { amount: '0.42', currency: 'USD' },
+      workerTimeMs: 1500,
+    });
+    expect(estimation.privacy).toEqual({
+      dataLeavesDevice: true,
+      providerId: 'remote-speech',
+      dataTypes: ['audio data'],
+    });
+  });
+});
diff --git a/packages/agent-tools/src/estimation.ts b/packages/agent-tools/src/estimation.ts
index 94fe8da..8353a66 100644
--- a/packages/agent-tools/src/estimation.ts
+++ b/packages/agent-tools/src/estimation.ts
@@ -1,12 +1,13 @@
 import type { ToolRegistry } from './registry.js';
-import type { EditorContext } from './context.js';
+import type { EditorContext, ProviderSummary } from './context.js';
+import type { CapabilityId } from '@joy-media/provider-sdk';
 import type {
   AgentEditPlan,
   AgentPlanStep,
   PrivacyImpact,
   Money,
   MoneyRange,
   DurationRange,
 } from './plan.js';
 import type { CostEstimate } from './types.js';
 
@@ -81,56 +82,60 @@ export function estimatePlan(
     totalWorkerTimeMs,
     privacyImpacts,
     dataLeavesDevice,
     remoteProviders: [...remoteProviders],
     confidence,
   };
 }
 
 export function estimateStep(
   step: AgentPlanStep,
-  _registry: ToolRegistry,
-  _context: EditorContext,
+  registry: ToolRegistry,
+  context: EditorContext,
 ): { cost?: CostEstimate; privacy?: PrivacyImpact } {
-  const cost = step.estimatedCost;
+  const inferredCapability = inferProviderCapability(step.tool);
+  const provider = pickProvider(context, inferredCapability);
+  const providerEstimate =
+    step.estimatedCost === undefined && provider !== undefined && inferredCapability !== undefined
+      ? estimateProviderCost(provider, inferredCapability)
+      : undefined;
+  const cost = step.estimatedCost ?? providerEstimate;
 
   let privacy: PrivacyImpact | undefined;
   if (cost) {
-    const providerId = cost.localOnly ? undefined : _context.providers.availableProviders[0]?.id;
+    const providerId = cost.localOnly ? undefined : provider?.id;
     privacy = {
       dataLeavesDevice: !cost.localOnly,
       ...(providerId !== undefined && { providerId }),
       dataTypes: inferDataTypes(step.tool),
     };
   } else {
-    const tool = _registry.getTool(step.tool);
+    const tool = registry.getTool(step.tool);
     if (!tool) {
       return {};
     }
 
     const toolDef = 'definition' in tool ? tool.definition : null;
     const requiresProvider =
       toolDef?.scope.capabilities.includes('provider.generate') === true ||
       toolDef?.scope.capabilities.includes('provider.spend') === true;
 
     if (requiresProvider) {
-      const provider = _context.providers.availableProviders[0];
-
       if (provider) {
         privacy = {
           dataLeavesDevice: provider.dataLeavesDevice,
           providerId: provider.id,
           dataTypes: inferDataTypes(step.tool),
         };
       } else {
         privacy = {
-          dataLeavesDevice: !_context.providers.localOnly,
+          dataLeavesDevice: !context.providers.localOnly,
           dataTypes: inferDataTypes(step.tool),
         };
       }
     } else {
       privacy = {
         dataLeavesDevice: false,
         dataTypes: [],
       };
     }
   }
@@ -158,20 +163,86 @@ export function isPlanLocalOnly(
 function sumMoney(costs: Money[], _type: 'min' | 'max'): Money {
   if (costs.length === 0) {
     return { amount: '0.00', currency: 'USD' };
   }
 
   const currency = costs[0]?.currency ?? 'USD';
   const total = costs.reduce((sum, c) => sum + parseFloat(c.amount), 0);
   return { amount: total.toFixed(2), currency };
 }
 
+function pickProvider(
+  context: EditorContext,
+  capability: CapabilityId | undefined,
+): ProviderSummary | undefined {
+  if (capability === undefined) {
+    return context.providers.availableProviders[0];
+  }
+  return (
+    context.providers.availableProviders.find((provider) =>
+      provider.capabilities.includes(capability),
+    ) ?? context.providers.availableProviders[0]
+  );
+}
+
+function estimateProviderCost(
+  provider: ProviderSummary,
+  capability: CapabilityId,
+): CostEstimate | undefined {
+  const detail = provider.capabilityDetails?.find(
+    (candidate) => candidate.capability === capability,
+  );
+  if (detail === undefined) return undefined;
+  const providerCost =
+    detail.pricing === undefined
+      ? undefined
+      : { amount: detail.pricing.rate, currency: detail.pricing.currency };
+  const workerTimeMs = detail.estimatedResources?.estimatedDurationMs;
+  const localOnly = provider.execution === 'worker-local' || provider.execution === 'browser';
+  if (providerCost === undefined && workerTimeMs === undefined) {
+    return { localOnly };
+  }
+  return {
+    localOnly,
+    ...(providerCost === undefined ? {} : { providerCost }),
+    ...(workerTimeMs === undefined ? {} : { workerTimeMs }),
+  };
+}
+
+function inferProviderCapability(toolName: string): CapabilityId | undefined {
+  const lower = toolName.toLowerCase();
+  if (lower.includes('transcri')) return 'speech.transcribe';
+  if (lower.includes('align')) return 'speech.align';
+  if (lower.includes('diar')) return 'speech.diarize';
+  if (lower.includes('synth') || lower.includes('tts')) return 'speech.synthesize';
+  if (lower.includes('voice') && lower.includes('clone')) return 'voice.clone';
+  if (lower.includes('denoise')) return 'audio.denoise';
+  if (lower.includes('separate') || lower.includes('stem')) return 'audio.separate';
+  if (lower.includes('music')) return 'music.generate';
+  if (lower.includes('upscale')) return 'image.upscale';
+  if (lower.includes('background') && lower.includes('remove') && lower.includes('image')) {
+    return 'image.removeBackground';
+  }
+  if (lower.includes('image') && lower.includes('edit')) return 'image.edit';
+  if (lower.includes('image')) return 'image.generate';
+  if (lower.includes('interpolate')) return 'video.interpolate';
+  if (lower.includes('animate')) return 'video.animate';
+  if (lower.includes('background') && lower.includes('remove') && lower.includes('video')) {
+    return 'video.removeBackground';
+  }
+  if (lower.includes('video')) return 'video.generate';
+  if (lower.includes('embedding')) return 'embedding.create';
+  if (lower.includes('vision')) return 'vision.analyze';
+  if (lower.includes('llm') || lower.includes('complete')) return 'llm.complete';
+  return undefined;
+}
+
 function inferDataTypes(toolName: string): readonly string[] {
   const lower = toolName.toLowerCase();
   if (lower.includes('transcri') || lower.includes('speech')) {
     return ['audio data'];
   }
   if (lower.includes('voice') || lower.includes('clone')) {
     return ['audio samples', 'voice profile'];
   }
   if (lower.includes('image')) {
     return ['image data'];
diff --git a/packages/agent-tools/src/index.ts b/packages/agent-tools/src/index.ts
index 653fc7f..9f0575b 100644
--- a/packages/agent-tools/src/index.ts
+++ b/packages/agent-tools/src/index.ts
@@ -14,20 +14,22 @@ export type {
 
 export type {
   EditorContext,
   ProjectSummary,
   SelectionContext,
   TimelineContext,
   CompositionSummary,
   CaptionContext,
   AudioContext,
   ProviderContext,
+  ProviderCapabilitySummary,
+  ProviderPriceSummary,
   ProviderSummary,
   ExportTargetContext,
   ContextOptions,
   CommandDispatcher,
   CommandDispatchResult,
 } from './context.js';
 export { buildEditorContext } from './context.js';
 
 export type { QueryTool } from './queries.js';
 export {
@@ -205,24 +207,21 @@ export { BranchManager, createBranchManager } from './branch.js';
 export type { RevertResult } from './revert.js';
 export { revertAgentRun, findAgentTransactions, canRevertAgentRun } from './revert.js';
 
 export type { AuditEntry, AuditAction } from './audit.js';
 export { AuditTrail, createAuditTrail } from './audit.js';
 
 export type { AgentMemory, AgentPreference } from './memory.js';
 export { AgentMemoryManager, createAgentMemoryManager } from './memory.js';
 
 export type { KiloCodeHostOptions } from './kilocode-host.js';
-export {
-  KILOCODE_AGENT_HOST_ID,
-  createKiloCodeAgentHostManifest,
-} from './kilocode-host.js';
+export { KILOCODE_AGENT_HOST_ID, createKiloCodeAgentHostManifest } from './kilocode-host.js';
 
 export type {
   BenchmarkIntent,
   ValidationCheck,
   BenchmarkProject,
   BenchmarkMetrics,
   BenchmarkSuiteResult,
   PolicyLeakTestResult,
   PolicyViolation,
   EvaluationReport,
diff --git a/packages/provider-sdk/src/budget.test.ts b/packages/provider-sdk/src/budget.test.ts
new file mode 100644
index 0000000..f988bdd
--- /dev/null
+++ b/packages/provider-sdk/src/budget.test.ts
@@ -0,0 +1,146 @@
+import { describe, expect, it } from 'vitest';
+import {
+  createProviderBudgetLedger,
+  reconcileProviderBudget,
+  reserveProviderBudget,
+} from './budget.js';
+
+describe('provider budget ledger', () => {
+  it('caps reservations and rejects currency mismatches', () => {
+    const ledger = createProviderBudgetLedger();
+
+    const capped = reserveProviderBudget(ledger, {
+      reservationId: 'reservation-1',
+      idempotencyKey: 'reserve-1',
+      providerId: 'remote',
+      capability: 'speech.transcribe',
+      estimatedCost: { amount: '1.25', currency: 'USD' },
+      cap: { amount: '1.00', currency: 'USD' },
+    });
+
+    expect(capped.ok).toBe(false);
+    if (capped.ok) expect.unreachable('reservation should be capped');
+    expect(capped.reason).toBe('cap-exceeded');
+
+    const mismatch = reserveProviderBudget(ledger, {
+      reservationId: 'reservation-2',
+      idempotencyKey: 'reserve-2',
+      providerId: 'remote',
+      capability: 'speech.transcribe',
+      estimatedCost: { amount: '1.00', currency: 'EUR' },
+      cap: { amount: '1.00', currency: 'USD' },
+    });
+
+    expect(mismatch.ok).toBe(false);
+    if (mismatch.ok) expect.unreachable('reservation should reject currency mismatch');
+    expect(mismatch.reason).toBe('currency-mismatch');
+  });
+
+  it('records partial and final reconciliation without exceeding the reservation', () => {
+    const reserved = reserveProviderBudget(createProviderBudgetLedger(), {
+      reservationId: 'reservation-1',
+      idempotencyKey: 'reserve-1',
+      providerId: 'remote',
+      capability: 'speech.transcribe',
+      estimatedCost: { amount: '1.00', currency: 'USD' },
+      cap: { amount: '2.00', currency: 'USD' },
+    });
+    expect(reserved.ok).toBe(true);
+    if (!reserved.ok) expect.unreachable('reservation should succeed');
+
+    const partial = reconcileProviderBudget(reserved.ledger, {
+      reservationId: 'reservation-1',
+      idempotencyKey: 'usage-1',
+      kind: 'partial',
+      actualCost: { amount: '0.25', currency: 'USD' },
+      providerUsageId: 'usage-partial',
+    });
+    expect(partial.ok).toBe(true);
+    if (!partial.ok) expect.unreachable('partial reconciliation should succeed');
+    expect(partial.reservation.status).toBe('reserved');
+    expect(partial.reservation.spent.amount).toBe('0.25');
+
+    const final = reconcileProviderBudget(partial.ledger, {
+      reservationId: 'reservation-1',
+      idempotencyKey: 'usage-2',
+      kind: 'final',
+      actualCost: { amount: '0.50', currency: 'USD' },
+      providerUsageId: 'usage-final',
+    });
+    expect(final.ok).toBe(true);
+    if (!final.ok) expect.unreachable('final reconciliation should succeed');
+    expect(final.reservation.status).toBe('settled');
+    expect(final.reservation.spent.amount).toBe('0.75');
+    expect(final.reservation.released.amount).toBe('0.25');
+
+    const mismatch = reconcileProviderBudget(partial.ledger, {
+      reservationId: 'reservation-1',
+      idempotencyKey: 'usage-eur',
+      kind: 'partial',
+      actualCost: { amount: '0.10', currency: 'EUR' },
+      providerUsageId: 'usage-eur',
+    });
+    expect(mismatch.ok).toBe(false);
+    if (mismatch.ok) expect.unreachable('reconciliation should reject currency mismatch');
+    expect(mismatch.reason).toBe('currency-mismatch');
+
+    const overrun = reconcileProviderBudget(final.ledger, {
+      reservationId: 'reservation-1',
+      idempotencyKey: 'usage-3',
+      kind: 'final',
+      actualCost: { amount: '0.50', currency: 'USD' },
+      providerUsageId: 'usage-overrun',
+    });
+    expect(overrun.ok).toBe(false);
+    if (overrun.ok) expect.unreachable('settled reservation should reject replay with new key');
+    expect(overrun.reason).toBe('already-settled');
+  });
+
+  it('is idempotent for reservation and reconciliation replay', () => {
+    const first = reserveProviderBudget(createProviderBudgetLedger(), {
+      reservationId: 'reservation-1',
+      idempotencyKey: 'reserve-1',
+      providerId: 'remote',
+      capability: 'speech.transcribe',
+      estimatedCost: { amount: '1.00', currency: 'USD' },
+      cap: { amount: '2.00', currency: 'USD' },
+    });
+    expect(first.ok).toBe(true);
+    if (!first.ok) expect.unreachable('reservation should succeed');
+
+    const reservationReplay = reserveProviderBudget(first.ledger, {
+      reservationId: 'reservation-1',
+      idempotencyKey: 'reserve-1',
+      providerId: 'remote',
+      capability: 'speech.transcribe',
+      estimatedCost: { amount: '1.00', currency: 'USD' },
+      cap: { amount: '2.00', currency: 'USD' },
+    });
+    expect(reservationReplay.ok).toBe(true);
+    if (!reservationReplay.ok) expect.unreachable('reservation replay should succeed');
+    expect(reservationReplay.replay).toBe(true);
+    expect(reservationReplay.ledger).toBe(first.ledger);
+
+    const usage = reconcileProviderBudget(first.ledger, {
+      reservationId: 'reservation-1',
+      idempotencyKey: 'usage-1',
+      kind: 'partial',
+      actualCost: { amount: '0.20', currency: 'USD' },
+      providerUsageId: 'usage-1',
+    });
+    expect(usage.ok).toBe(true);
+    if (!usage.ok) expect.unreachable('usage reconciliation should succeed');
+
+    const usageReplay = reconcileProviderBudget(usage.ledger, {
+      reservationId: 'reservation-1',
+      idempotencyKey: 'usage-1',
+      kind: 'partial',
+      actualCost: { amount: '0.20', currency: 'USD' },
+      providerUsageId: 'usage-1',
+    });
+    expect(usageReplay.ok).toBe(true);
+    if (!usageReplay.ok) expect.unreachable('usage replay should succeed');
+    expect(usageReplay.replay).toBe(true);
+    expect(usageReplay.ledger).toBe(usage.ledger);
+  });
+});
diff --git a/packages/provider-sdk/src/budget.ts b/packages/provider-sdk/src/budget.ts
new file mode 100644
index 0000000..75315ff
--- /dev/null
+++ b/packages/provider-sdk/src/budget.ts
@@ -0,0 +1,237 @@
+import type { CapabilityId, Money } from './types.js';
+import { addMoney, compareMoney } from './utils.js';
+
+export interface ProviderBudgetLedgerV1 {
+  readonly ledgerVersion: 1;
+  readonly reservations: readonly ProviderBudgetReservationV1[];
+  readonly reconciliations: readonly ProviderBudgetReconciliationV1[];
+}
+
+export interface ProviderBudgetReservationV1 {
+  readonly reservationVersion: 1;
+  readonly reservationId: string;
+  readonly idempotencyKey: string;
+  readonly providerId: string;
+  readonly capability: CapabilityId;
+  readonly reserved: Money;
+  readonly cap: Money;
+  readonly spent: Money;
+  readonly released: Money;
+  readonly status: 'reserved' | 'settled';
+  readonly providerDecisionId?: string;
+  readonly productionRunId?: string;
+}
+
+export interface ProviderBudgetReconciliationV1 {
+  readonly reconciliationVersion: 1;
+  readonly reservationId: string;
+  readonly idempotencyKey: string;
+  readonly kind: 'partial' | 'final';
+  readonly actualCost: Money;
+  readonly providerUsageId?: string;
+}
+
+export interface ReserveProviderBudgetInput {
+  readonly reservationId: string;
+  readonly idempotencyKey: string;
+  readonly providerId: string;
+  readonly capability: CapabilityId;
+  readonly estimatedCost: Money;
+  readonly cap: Money;
+  readonly providerDecisionId?: string;
+  readonly productionRunId?: string;
+}
+
+export interface ReconcileProviderBudgetInput {
+  readonly reservationId: string;
+  readonly idempotencyKey: string;
+  readonly kind: 'partial' | 'final';
+  readonly actualCost: Money;
+  readonly providerUsageId?: string;
+}
+
+export type ReserveProviderBudgetResult =
+  | {
+      readonly ok: true;
+      readonly ledger: ProviderBudgetLedgerV1;
+      readonly reservation: ProviderBudgetReservationV1;
+      readonly replay: boolean;
+    }
+  | {
+      readonly ok: false;
+      readonly ledger: ProviderBudgetLedgerV1;
+      readonly reason: 'cap-exceeded' | 'currency-mismatch' | 'idempotency-conflict';
+    };
+
+export type ReconcileProviderBudgetResult =
+  | {
+      readonly ok: true;
+      readonly ledger: ProviderBudgetLedgerV1;
+      readonly reservation: ProviderBudgetReservationV1;
+      readonly reconciliation: ProviderBudgetReconciliationV1;
+      readonly replay: boolean;
+    }
+  | {
+      readonly ok: false;
+      readonly ledger: ProviderBudgetLedgerV1;
+      readonly reason:
+        | 'reservation-not-found'
+        | 'currency-mismatch'
+        | 'cap-exceeded'
+        | 'already-settled'
+        | 'idempotency-conflict';
+    };
+
+const ZERO_USD: Money = { amount: '0.00', currency: 'USD' };
+
+export function createProviderBudgetLedger(): ProviderBudgetLedgerV1 {
+  return {
+    ledgerVersion: 1,
+    reservations: [],
+    reconciliations: [],
+  };
+}
+
+export function reserveProviderBudget(
+  ledger: ProviderBudgetLedgerV1,
+  input: ReserveProviderBudgetInput,
+): ReserveProviderBudgetResult {
+  const replay = ledger.reservations.find(
+    (reservation) => reservation.idempotencyKey === input.idempotencyKey,
+  );
+  if (replay !== undefined) {
+    if (
+      replay.reservationId !== input.reservationId ||
+      replay.providerId !== input.providerId ||
+      replay.reserved.amount !== input.estimatedCost.amount ||
+      replay.reserved.currency !== input.estimatedCost.currency
+    ) {
+      return { ok: false, ledger, reason: 'idempotency-conflict' };
+    }
+    return { ok: true, ledger, reservation: replay, replay: true };
+  }
+
+  if (input.estimatedCost.currency !== input.cap.currency) {
+    return { ok: false, ledger, reason: 'currency-mismatch' };
+  }
+  if (compareMoney(input.estimatedCost, input.cap) > 0) {
+    return { ok: false, ledger, reason: 'cap-exceeded' };
+  }
+
+  const zero = zeroMoney(input.estimatedCost.currency);
+  const reservation: ProviderBudgetReservationV1 = {
+    reservationVersion: 1,
+    reservationId: input.reservationId,
+    idempotencyKey: input.idempotencyKey,
+    providerId: input.providerId,
+    capability: input.capability,
+    reserved: input.estimatedCost,
+    cap: input.cap,
+    spent: zero,
+    released: zero,
+    status: 'reserved',
+    ...(input.providerDecisionId === undefined
+      ? {}
+      : { providerDecisionId: input.providerDecisionId }),
+    ...(input.productionRunId === undefined ? {} : { productionRunId: input.productionRunId }),
+  };
+
+  return {
+    ok: true,
+    ledger: {
+      ...ledger,
+      reservations: [...ledger.reservations, reservation],
+    },
+    reservation,
+    replay: false,
+  };
+}
+
+export function reconcileProviderBudget(
+  ledger: ProviderBudgetLedgerV1,
+  input: ReconcileProviderBudgetInput,
+): ReconcileProviderBudgetResult {
+  const replay = ledger.reconciliations.find(
+    (reconciliation) => reconciliation.idempotencyKey === input.idempotencyKey,
+  );
+  if (replay !== undefined) {
+    const reservation = ledger.reservations.find(
+      (candidate) => candidate.reservationId === replay.reservationId,
+    );
+    if (
+      replay.reservationId !== input.reservationId ||
+      replay.kind !== input.kind ||
+      replay.actualCost.amount !== input.actualCost.amount ||
+      replay.actualCost.currency !== input.actualCost.currency ||
+      reservation === undefined
+    ) {
+      return { ok: false, ledger, reason: 'idempotency-conflict' };
+    }
+    return { ok: true, ledger, reservation, reconciliation: replay, replay: true };
+  }
+
+  const reservation = ledger.reservations.find(
+    (candidate) => candidate.reservationId === input.reservationId,
+  );
+  if (reservation === undefined) {
+    return { ok: false, ledger, reason: 'reservation-not-found' };
+  }
+  if (reservation.status === 'settled') {
+    return { ok: false, ledger, reason: 'already-settled' };
+  }
+  if (reservation.reserved.currency !== input.actualCost.currency) {
+    return { ok: false, ledger, reason: 'currency-mismatch' };
+  }
+
+  const nextSpent = addMoney(reservation.spent, input.actualCost);
+  if (compareMoney(nextSpent, reservation.reserved) > 0) {
+    return { ok: false, ledger, reason: 'cap-exceeded' };
+  }
+
+  const released =
+    input.kind === 'final' ? subtractMoney(reservation.reserved, nextSpent) : reservation.released;
+  const nextReservation: ProviderBudgetReservationV1 = {
+    ...reservation,
+    spent: nextSpent,
+    released,
+    status: input.kind === 'final' ? 'settled' : 'reserved',
+  };
+  const reconciliation: ProviderBudgetReconciliationV1 = {
+    reconciliationVersion: 1,
+    reservationId: input.reservationId,
+    idempotencyKey: input.idempotencyKey,
+    kind: input.kind,
+    actualCost: input.actualCost,
+    ...(input.providerUsageId === undefined ? {} : { providerUsageId: input.providerUsageId }),
+  };
+
+  return {
+    ok: true,
+    ledger: {
+      ...ledger,
+      reservations: ledger.reservations.map((candidate) =>
+        candidate.reservationId === input.reservationId ? nextReservation : candidate,
+      ),
+      reconciliations: [...ledger.reconciliations, reconciliation],
+    },
+    reservation: nextReservation,
+    reconciliation,
+    replay: false,
+  };
+}
+
+function zeroMoney(currency: string): Money {
+  return currency === 'USD' ? ZERO_USD : { amount: '0.00', currency };
+}
+
+function subtractMoney(left: Money, right: Money): Money {
+  if (left.currency !== right.currency) {
+    throw new Error(
+      `Cannot subtract money with different currencies: ${left.currency} vs ${right.currency}`,
+    );
+  }
+  return {
+    amount: (parseFloat(left.amount) - parseFloat(right.amount)).toFixed(2),
+    currency: left.currency,
+  };
+}
diff --git a/packages/provider-sdk/src/decision.test.ts b/packages/provider-sdk/src/decision.test.ts
new file mode 100644
index 0000000..01fff05
--- /dev/null
+++ b/packages/provider-sdk/src/decision.test.ts
@@ -0,0 +1,173 @@
+import { describe, expect, it } from 'vitest';
+import { decideProvider } from './decision.js';
+import { createMockProvider } from './testing.js';
+import type {
+  CapabilityDeclaration,
+  CapabilityRequest,
+  ProviderPolicy,
+  ProviderV2,
+} from './types.js';
+
+describe('decideProvider', () => {
+  const request = (overrides?: Partial<CapabilityRequest>): CapabilityRequest => ({
+    requestVersion: 1,
+    capability: 'speech.transcribe',
+    input: { assetId: 'asset-1' },
+    constraints: {},
+    idempotencyKey: 'idem-1',
+    ...overrides,
+  });
+
+  const policy = (overrides?: Partial<ProviderPolicy>): ProviderPolicy => ({
+    allowRemote: true,
+    blockedProviders: [],
+    blockedCapabilities: [],
+    requireLocalFor: [],
+    ...overrides,
+  });
+
+  const pricedProvider = (
+    id: string,
+    overrides?: Partial<CapabilityDeclaration> & {
+      readonly execution?: ProviderV2['manifest']['execution'];
+      readonly dataLeavesDevice?: boolean | 'depends';
+    },
+  ): ProviderV2 => {
+    const providerOptions = {
+      ...(overrides?.execution === undefined ? {} : { execution: overrides.execution }),
+      privacy: { dataLeavesDevice: overrides?.dataLeavesDevice ?? false },
+    };
+    const provider = createMockProvider(id, ['speech.transcribe'], providerOptions);
+    return {
+      ...provider,
+      manifest: {
+        ...provider.manifest,
+        capabilities: [
+          {
+            ...provider.manifest.capabilities[0]!,
+            ...overrides,
+            id: 'speech.transcribe',
+            inputSchema: {},
+            outputSchema: {},
+          },
+        ],
+      },
+    };
+  };
+
+  it('records a seven-dimension score breakdown after hard gates', () => {
+    const provider = pricedProvider('local-fast', {
+      pricing: { model: 'per-request', rate: '0.05', currency: 'USD' },
+      estimatedResources: { estimatedDurationMs: 500 },
+    });
+
+    const decision = decideProvider(request(), [provider], policy());
+
+    expect(decision.status).toBe('selected');
+    expect(decision.selectedProviderId).toBe('local-fast');
+    expect(decision.candidates).toHaveLength(1);
+    expect(decision.candidates[0]!.status).toBe('eligible');
+    expect(Object.keys(decision.candidates[0]!.scoreBreakdown!.dimensions)).toEqual([
+      'capability',
+      'privacy',
+      'locality',
+      'preference',
+      'cost',
+      'latency',
+      'availability',
+    ]);
+    expect(decision.candidates[0]!.scoreBreakdown!.total).toBeGreaterThan(0);
+  });
+
+  it('applies hard capability and privacy gates before scoring', () => {
+    const imageOnly = createMockProvider('image-only', ['image.generate']);
+    const remote = pricedProvider('remote', {
+      execution: 'remote-api',
+      dataLeavesDevice: true,
+    });
+
+    const decision = decideProvider(
+      request({ constraints: { requiredPrivacy: 'local-only' } }),
+      [imageOnly, remote],
+      policy(),
+    );
+
+    expect(decision.status).toBe('denied');
+    expect(decision.candidates).toEqual([
+      expect.objectContaining({
+        providerId: 'image-only',
+        status: 'rejected',
+        rejectedBy: 'capability',
+      }),
+      expect.objectContaining({
+        providerId: 'remote',
+        status: 'rejected',
+        rejectedBy: 'privacy',
+      }),
+    ]);
+    expect(decision.candidates.every((candidate) => candidate.scoreBreakdown === undefined)).toBe(
+      true,
+    );
+  });
+
+  it('chooses local over remote by default while keeping both eligible', () => {
+    const remote = pricedProvider('remote', { execution: 'remote-api', dataLeavesDevice: true });
+    const local = pricedProvider('local', { execution: 'worker-local', dataLeavesDevice: false });
+
+    const decision = decideProvider(request(), [remote, local], policy());
+
+    expect(decision.status).toBe('selected');
+    expect(decision.selectedProviderId).toBe('local');
+    expect(decision.candidates.map((candidate) => candidate.providerId)).toEqual([
+      'local',
+      'remote',
+    ]);
+  });
+
+  it('requires manual choice for an exact top-score tie when configured', () => {
+    const first = pricedProvider('first');
+    const second = pricedProvider('second');
+
+    const decision = decideProvider(request(), [first, second], policy(), {
+      requireManualChoiceOnTie: true,
+    });
+
+    expect(decision.status).toBe('manual-choice-required');
+    expect(decision.selectedProviderId).toBeUndefined();
+    expect(decision.reason).toContain('tie');
+  });
+
+  it('reports unavailable and denied outcomes', () => {
+    const provider = pricedProvider('remote', { execution: 'remote-api', dataLeavesDevice: true });
+
+    expect(
+      decideProvider(request(), [provider], policy(), {
+        unavailableProviderIds: ['remote'],
+      }).status,
+    ).toBe('unavailable');
+    expect(
+      decideProvider(request(), [provider], policy(), {
+        deniedProviderIds: ['remote'],
+      }).status,
+    ).toBe('denied');
+  });
+
+  it('links the decision to a production run and provider usage', () => {
+    const provider = pricedProvider('remote', { execution: 'remote-api', dataLeavesDevice: true });
+
+    const decision = decideProvider(request(), [provider], policy(), {
+      productionRunId: 'run-1',
+      providerUsage: {
+        providerId: 'remote',
+        capability: 'speech.transcribe',
+        modelId: 'speech-large',
+        timestamp: '2026-08-22T00:00:00.000Z',
+        durationMs: 12,
+      },
+    });
+
+    expect(decision.productionRunId).toBe('run-1');
+    expect(decision.providerUsage?.providerDecisionId).toBe(decision.decisionId);
+    expect(decision.providerUsage?.productionRunId).toBe('run-1');
+  });
+});
diff --git a/packages/provider-sdk/src/decision.ts b/packages/provider-sdk/src/decision.ts
new file mode 100644
index 0000000..2d43af5
--- /dev/null
+++ b/packages/provider-sdk/src/decision.ts
@@ -0,0 +1,364 @@
+import type {
+  AnyProvider,
+  CapabilityRequest,
+  Money,
+  ProviderCandidateDecisionV1,
+  ProviderCandidateGateResultV1,
+  ProviderCandidateGateV1,
+  ProviderDecisionV1,
+  ProviderPolicy,
+  ProviderScoreBreakdownV1,
+  ProviderUsage,
+} from './types.js';
+import {
+  compareMoney,
+  getCapabilityDeclaration,
+  getDataLeavesDevice,
+  getExecution,
+  getProviderId,
+  isLocalExecution,
+  supportsCapability,
+} from './utils.js';
+
+export interface ProviderDecisionOptions {
+  readonly createdAt?: string;
+  readonly productionRunId?: string;
+  readonly providerUsage?: ProviderUsage;
+  readonly unavailableProviderIds?: readonly string[];
+  readonly deniedProviderIds?: readonly string[];
+  readonly requireManualChoiceOnTie?: boolean;
+}
+
+export function decideProvider(
+  request: CapabilityRequest,
+  available: readonly AnyProvider[],
+  policy: ProviderPolicy,
+  options: ProviderDecisionOptions = {},
+): ProviderDecisionV1 {
+  const candidates = available.map((provider) =>
+    decideCandidate(provider, request, policy, options),
+  );
+  const eligible = candidates
+    .filter((candidate) => candidate.status === 'eligible')
+    .sort((left, right) => {
+      const scoreDelta = (right.scoreBreakdown?.total ?? 0) - (left.scoreBreakdown?.total ?? 0);
+      if (scoreDelta !== 0) return scoreDelta;
+      return left.providerId.localeCompare(right.providerId);
+    });
+
+  const decisionId = createDecisionId(request);
+  const base = {
+    decisionVersion: 1 as const,
+    decisionId,
+    idempotencyKey: request.idempotencyKey,
+    capability: request.capability,
+    candidates,
+    createdAt: options.createdAt ?? new Date().toISOString(),
+    ...(options.productionRunId === undefined ? {} : { productionRunId: options.productionRunId }),
+    ...(options.providerUsage === undefined
+      ? {}
+      : {
+          providerUsage: linkProviderUsage(
+            options.providerUsage,
+            decisionId,
+            options.productionRunId,
+          ),
+        }),
+  };
+
+  if (eligible.length === 0) {
+    const hasAnyCapable = candidates.some(
+      (candidate) => candidate.rejectedBy !== 'capability' && candidate.rejectedBy !== undefined,
+    );
+    const rejectedByAvailability = candidates.some(
+      (candidate) => candidate.rejectedBy === 'availability',
+    );
+    const status = !hasAnyCapable || rejectedByAvailability ? 'unavailable' : 'denied';
+    return {
+      ...base,
+      status,
+      reason:
+        status === 'unavailable'
+          ? `No available providers can satisfy '${request.capability}'`
+          : `Provider policy denied '${request.capability}'`,
+    };
+  }
+
+  const top = eligible[0]!;
+  const tied = eligible.filter(
+    (candidate) => candidate.scoreBreakdown?.total === top.scoreBreakdown?.total,
+  );
+
+  if (options.requireManualChoiceOnTie === true && tied.length > 1) {
+    return {
+      ...base,
+      candidates: eligible,
+      status: 'manual-choice-required',
+      reason: `Top provider tie requires manual choice: ${tied
+        .map((candidate) => candidate.providerId)
+        .join(', ')}`,
+    };
+  }
+
+  return {
+    ...base,
+    candidates: eligible,
+    status: 'selected',
+    selectedProviderId: top.providerId,
+    reason: `Selected '${top.providerId}' for '${request.capability}'`,
+  };
+}
+
+function decideCandidate(
+  provider: AnyProvider,
+  request: CapabilityRequest,
+  policy: ProviderPolicy,
+  options: ProviderDecisionOptions,
+): ProviderCandidateDecisionV1 {
+  const providerId = getProviderId(provider);
+  const execution = getExecution(provider);
+  const gates: ProviderCandidateGateResultV1[] = [];
+
+  pushGate(gates, 'capability-policy', !policy.blockedCapabilities.includes(request.capability), {
+    pass: `Capability '${request.capability}' is allowed by policy`,
+    fail: `Capability '${request.capability}' is blocked by policy`,
+  });
+  pushGate(gates, 'capability', supportsCapability(provider, request.capability), {
+    pass: `Provider supports '${request.capability}'`,
+    fail: `Provider does not support '${request.capability}'`,
+  });
+  pushGate(gates, 'provider-policy', !policy.blockedProviders.includes(providerId), {
+    pass: 'Provider is not blocked by policy',
+    fail: 'Provider is blocked by policy',
+  });
+  pushGate(gates, 'authorization', !options.deniedProviderIds?.includes(providerId), {
+    pass: 'Provider authorization is available',
+    fail: 'Provider authorization was denied',
+  });
+  pushGate(gates, 'availability', !options.unavailableProviderIds?.includes(providerId), {
+    pass: 'Provider is available',
+    fail: 'Provider is unavailable',
+  });
+  pushGate(gates, 'remote-policy', remoteAllowed(provider, request, policy), {
+    pass: 'Execution locality is allowed by policy',
+    fail: 'Remote execution is blocked by policy',
+  });
+  pushGate(gates, 'execution-preference', matchesExecutionPreference(provider, request), {
+    pass: 'Provider matches execution preference',
+    fail: 'Provider does not match execution preference',
+  });
+  pushGate(gates, 'privacy', matchesPrivacy(provider, request), {
+    pass: 'Provider satisfies privacy requirements',
+    fail: 'Provider violates local-only privacy requirements',
+  });
+  pushGate(gates, 'model', matchesModelAllowlist(provider, request), {
+    pass: 'Provider satisfies model constraints',
+    fail: 'Provider models are outside the allowlist',
+  });
+  pushGate(gates, 'cost', matchesCost(provider, request, policy), {
+    pass: 'Provider satisfies cost constraints',
+    fail: 'Provider price exceeds the configured cap or currency',
+  });
+
+  const failed = gates.find((gate) => gate.status === 'failed');
+  const declaration = getCapabilityDeclaration(provider, request.capability);
+  const estimatedCost =
+    declaration?.pricing === undefined
+      ? undefined
+      : { amount: declaration.pricing.rate, currency: declaration.pricing.currency };
+  const modelId = declaration?.models?.[0]?.id;
+
+  const candidate = {
+    candidateVersion: 1 as const,
+    providerId,
+    displayName: getDisplayName(provider),
+    capability: request.capability,
+    execution,
+    gates,
+    ...(estimatedCost === undefined ? {} : { estimatedCost }),
+    ...(modelId === undefined ? {} : { modelId }),
+  };
+
+  if (failed !== undefined) {
+    return {
+      ...candidate,
+      status: 'rejected',
+      rejectedBy: failed.gate,
+    };
+  }
+
+  return {
+    ...candidate,
+    status: 'eligible',
+    scoreBreakdown: scoreProvider(provider, request, policy),
+  };
+}
+
+function scoreProvider(
+  provider: AnyProvider,
+  request: CapabilityRequest,
+  policy: ProviderPolicy,
+): ProviderScoreBreakdownV1 {
+  const execution = getExecution(provider);
+  const local = isLocalExecution(execution);
+  const declaration = getCapabilityDeclaration(provider, request.capability);
+  const price = declaration?.pricing;
+  const maxCost = resolveMaxCost(request.constraints.maxCost, policy.maxCostPerRequest);
+  const rate = price === undefined ? undefined : parseFloat(price.rate);
+  const maxRate = maxCost === undefined ? undefined : parseFloat(maxCost.amount);
+  const duration = declaration?.estimatedResources?.estimatedDurationMs;
+  const maxDuration = request.constraints.maxDurationMs ?? 120_000;
+
+  const dimensions: ProviderScoreBreakdownV1['dimensions'] = {
+    capability: {
+      score: 1,
+      explanation: `Supports '${request.capability}'`,
+    },
+    privacy: {
+      score: getDataLeavesDevice(provider) === false ? 1 : 0.65,
+      explanation:
+        getDataLeavesDevice(provider) === false
+          ? 'Data stays on device'
+          : 'Data may leave device under approved policy',
+    },
+    locality: {
+      score: local ? 1 : 0.35,
+      explanation: local ? 'Local execution preferred by default' : 'Remote execution is available',
+    },
+    preference: {
+      score: preferenceScore(provider, request),
+      explanation: 'Execution preference alignment',
+    },
+    cost: {
+      score:
+        rate === undefined
+          ? 0.75
+          : maxRate === undefined || maxRate <= 0
+            ? clamp01(1 - rate)
+            : clamp01(1 - rate / maxRate),
+      explanation:
+        price === undefined ? 'No provider price declared' : `${price.rate} ${price.currency}`,
+    },
+    latency: {
+      score: duration === undefined ? 0.75 : clamp01(1 - duration / maxDuration),
+      explanation: duration === undefined ? 'No duration estimate declared' : `${duration}ms`,
+    },
+    availability: {
+      score: 1,
+      explanation: 'Provider is currently available',
+    },
+  };
+
+  const total =
+    Object.values(dimensions).reduce((sum, dimension) => sum + dimension.score, 0) /
+    Object.keys(dimensions).length;
+
+  return {
+    scoreVersion: 1,
+    dimensions,
+    total: roundScore(total),
+  };
+}
+
+function pushGate(
+  gates: ProviderCandidateGateResultV1[],
+  gate: ProviderCandidateGateV1,
+  passed: boolean,
+  reasons: { readonly pass: string; readonly fail: string },
+): void {
+  gates.push({
+    gate,
+    status: passed ? 'passed' : 'failed',
+    reason: passed ? reasons.pass : reasons.fail,
+  });
+}
+
+function remoteAllowed(
+  provider: AnyProvider,
+  request: CapabilityRequest,
+  policy: ProviderPolicy,
+): boolean {
+  const local = isLocalExecution(getExecution(provider));
+  if (!policy.allowRemote && !local) return false;
+  if (policy.requireLocalFor.includes(request.capability) && !local) return false;
+  return true;
+}
+
+function matchesExecutionPreference(provider: AnyProvider, request: CapabilityRequest): boolean {
+  const preference = request.constraints.executionPreference;
+  if (preference === undefined || preference.length === 0) return true;
+  const local = isLocalExecution(getExecution(provider));
+  return (preference.includes('local') && local) || (preference.includes('remote') && !local);
+}
+
+function matchesPrivacy(provider: AnyProvider, request: CapabilityRequest): boolean {
+  if (request.constraints.requiredPrivacy !== 'local-only') return true;
+  return getDataLeavesDevice(provider) === false;
+}
+
+function matchesModelAllowlist(provider: AnyProvider, request: CapabilityRequest): boolean {
+  const allowlist = request.constraints.modelAllowlist;
+  if (allowlist === undefined || allowlist.length === 0) return true;
+  const models = getCapabilityDeclaration(provider, request.capability)?.models;
+  if (models === undefined || models.length === 0) return true;
+  return models.some((model) => allowlist.includes(model.id));
+}
+
+function matchesCost(
+  provider: AnyProvider,
+  request: CapabilityRequest,
+  policy: ProviderPolicy,
+): boolean {
+  const maxCost = resolveMaxCost(request.constraints.maxCost, policy.maxCostPerRequest);
+  if (maxCost === undefined) return true;
+  const pricing = getCapabilityDeclaration(provider, request.capability)?.pricing;
+  if (pricing === undefined) return true;
+  if (pricing.currency !== maxCost.currency) return false;
+  return compareMoney({ amount: pricing.rate, currency: pricing.currency }, maxCost) <= 0;
+}
+
+function resolveMaxCost(
+  requestCost: Money | undefined,
+  policyCost: Money | undefined,
+): Money | undefined {
+  if (requestCost !== undefined && policyCost !== undefined) {
+    if (requestCost.currency !== policyCost.currency) return requestCost;
+    return compareMoney(requestCost, policyCost) < 0 ? requestCost : policyCost;
+  }
+  return requestCost ?? policyCost;
+}
+
+function preferenceScore(provider: AnyProvider, request: CapabilityRequest): number {
+  const preference = request.constraints.executionPreference;
+  if (preference === undefined || preference.length === 0) return 0.75;
+  return matchesExecutionPreference(provider, request) ? 1 : 0;
+}
+
+function getDisplayName(provider: AnyProvider): string {
+  return 'displayName' in provider.manifest ? provider.manifest.displayName : provider.manifest.id;
+}
+
+function linkProviderUsage(
+  usage: ProviderUsage,
+  providerDecisionId: string,
+  productionRunId: string | undefined,
+): ProviderUsage {
+  return {
+    ...usage,
+    providerDecisionId,
+    ...(productionRunId === undefined ? {} : { productionRunId }),
+  };
+}
+
+function createDecisionId(request: CapabilityRequest): string {
+  return `provider-decision-${request.idempotencyKey.replace(/[^A-Za-z0-9._:-]/g, '-')}`;
+}
+
+function clamp01(value: number): number {
+  if (!Number.isFinite(value)) return 0;
+  return Math.min(1, Math.max(0, value));
+}
+
+function roundScore(value: number): number {
+  return Math.round(value * 1_000_000) / 1_000_000;
+}
diff --git a/packages/provider-sdk/src/index.ts b/packages/provider-sdk/src/index.ts
index 4d0ae72..77d7df5 100644
--- a/packages/provider-sdk/src/index.ts
+++ b/packages/provider-sdk/src/index.ts
@@ -18,20 +18,27 @@ export type {
   ProviderHealthSpec,
   Money,
   CapabilityDeclaration,
   ProviderManifestV2,
   ProviderV2,
   AnyProvider,
   // Request types
   CapabilityRequest,
   ProviderPolicy,
   ProviderResolution,
+  ProviderScoreDimensionNameV1,
+  ProviderScoreDimensionV1,
+  ProviderScoreBreakdownV1,
+  ProviderCandidateGateV1,
+  ProviderCandidateGateResultV1,
+  ProviderCandidateDecisionV1,
+  ProviderDecisionV1,
   // Lifecycle types
   ProviderLifecycleState,
   ProviderStatus,
   // Privacy types
   PrivacyPreflight,
   // Secret types
   SecretHandle,
   SecretStore,
   ServerSecretReference,
   ReasoningModelReference,
@@ -46,27 +53,43 @@ export type {
   // Result types
   CapabilityResult,
   GeneratedOutput,
   Diagnostic,
 } from './types.js';
 
 // Re-export error
 export { ProviderUnavailableError } from './errors.js';
 
 // Re-export implementations
-export { resolveProvider } from './resolution.js';
+export { resolveProvider, resolveProviderDecision } from './resolution.js';
+export type { ProviderDecisionOptions } from './decision.js';
+export { decideProvider } from './decision.js';
+export type {
+  ProviderBudgetLedgerV1,
+  ProviderBudgetReservationV1,
+  ProviderBudgetReconciliationV1,
+  ReserveProviderBudgetInput,
+  ReconcileProviderBudgetInput,
+  ReserveProviderBudgetResult,
+  ReconcileProviderBudgetResult,
+} from './budget.js';
+export {
+  createProviderBudgetLedger,
+  reserveProviderBudget,
+  reconcileProviderBudget,
+} from './budget.js';
 export { ProviderLifecycle } from './lifecycle.js';
 export { computePrivacyPreflight } from './privacy.js';
 export { createMemorySecretStore } from './secrets.js';
 export type { AgentHostManifestValidation } from './agent-host.js';
 export { validateAgentHostManifest } from './agent-host.js';
-export { aggregateUsage } from './provenance.js';
+export { aggregateUsage, linkUsageToProviderDecision } from './provenance.js';
 export {
   createMockProvider,
   validateManifest,
   createTestRequest,
   assertResultSucceeded,
   simulateProviderFailure,
 } from './testing.js';
 
 // Re-export utilities
 export {
diff --git a/packages/provider-sdk/src/provenance.ts b/packages/provider-sdk/src/provenance.ts
index 513760c..b4f34d2 100644
--- a/packages/provider-sdk/src/provenance.ts
+++ b/packages/provider-sdk/src/provenance.ts
@@ -1,11 +1,11 @@
-import type { Money, ProviderUsage, UsageRecord } from './types.js';
+import type { Money, ProviderDecisionV1, ProviderUsage, UsageRecord } from './types.js';
 import { addMoney } from './utils.js';
 
 const ZERO_USD: Money = { amount: '0.00', currency: 'USD' };
 
 export function aggregateUsage(usages: readonly ProviderUsage[]): UsageRecord {
   if (usages.length === 0) {
     const now = new Date().toISOString();
     return {
       usages: [],
       totalCost: { ...ZERO_USD },
@@ -28,10 +28,25 @@ export function aggregateUsage(usages: readonly ProviderUsage[]): UsageRecord {
     }
   }
 
   return {
     usages,
     totalCost,
     periodStart: timestamps[0]!,
     periodEnd: timestamps[timestamps.length - 1]!,
   };
 }
+
+export function linkUsageToProviderDecision(
+  usage: ProviderUsage,
+  decision: Pick<ProviderDecisionV1, 'decisionId' | 'productionRunId'>,
+  budgetReservationId?: string,
+): ProviderUsage {
+  return {
+    ...usage,
+    providerDecisionId: decision.decisionId,
+    ...(decision.productionRunId === undefined
+      ? {}
+      : { productionRunId: decision.productionRunId }),
+    ...(budgetReservationId === undefined ? {} : { budgetReservationId }),
+  };
+}
diff --git a/packages/provider-sdk/src/resolution.ts b/packages/provider-sdk/src/resolution.ts
index e44e16a..fcff9a3 100644
--- a/packages/provider-sdk/src/resolution.ts
+++ b/packages/provider-sdk/src/resolution.ts
@@ -1,17 +1,20 @@
 import type {
   AnyProvider,
   CapabilityRequest,
+  ProviderDecisionV1,
   ProviderPolicy,
   ProviderResolution,
   Money,
 } from './types.js';
+import type { ProviderDecisionOptions } from './decision.js';
+import { decideProvider } from './decision.js';
 import {
   getProviderId,
   supportsCapability,
   getExecution,
   getDataLeavesDevice,
   getCapabilityDeclaration,
   isLocalExecution,
   compareMoney,
 } from './utils.js';
 
@@ -108,20 +111,29 @@ export function resolveProvider(
     };
   }
 
   return {
     status: 'resolved',
     provider: ranked[0]!,
     candidates: ranked,
   };
 }
 
+export function resolveProviderDecision(
+  request: CapabilityRequest,
+  available: readonly AnyProvider[],
+  policy: ProviderPolicy,
+  options?: ProviderDecisionOptions,
+): ProviderDecisionV1 {
+  return decideProvider(request, available, policy, options);
+}
+
 function resolveMaxCost(
   requestCost: Money | undefined,
   policyCost: Money | undefined,
 ): Money | undefined {
   if (requestCost && policyCost) {
     return compareMoney(requestCost, policyCost) < 0 ? requestCost : policyCost;
   }
   return requestCost ?? policyCost;
 }
 
diff --git a/packages/provider-sdk/src/types.ts b/packages/provider-sdk/src/types.ts
index 4d08b37..312e19a 100644
--- a/packages/provider-sdk/src/types.ts
+++ b/packages/provider-sdk/src/types.ts
@@ -153,20 +153,83 @@ export interface ProviderPolicy {
   readonly requireLocalFor: readonly CapabilityId[];
 }
 
 export interface ProviderResolution {
   readonly status: 'resolved' | 'ambiguous' | 'no-eligible' | 'blocked-by-policy';
   readonly provider?: AnyProvider;
   readonly candidates?: readonly AnyProvider[];
   readonly reason?: string;
 }
 
+// ===== Decision Ledger Types =====
+
+export type ProviderScoreDimensionNameV1 =
+  'capability' | 'privacy' | 'locality' | 'preference' | 'cost' | 'latency' | 'availability';
+
+export interface ProviderScoreDimensionV1 {
+  /** Normalized score in the inclusive range 0..1. */
+  readonly score: number;
+  readonly explanation: string;
+}
+
+export interface ProviderScoreBreakdownV1 {
+  readonly scoreVersion: 1;
+  readonly dimensions: Readonly<Record<ProviderScoreDimensionNameV1, ProviderScoreDimensionV1>>;
+  readonly total: number;
+}
+
+export type ProviderCandidateGateV1 =
+  | 'capability'
+  | 'provider-policy'
+  | 'capability-policy'
+  | 'remote-policy'
+  | 'execution-preference'
+  | 'privacy'
+  | 'model'
+  | 'cost'
+  | 'availability'
+  | 'authorization';
+
+export interface ProviderCandidateGateResultV1 {
+  readonly gate: ProviderCandidateGateV1;
+  readonly status: 'passed' | 'failed';
+  readonly reason: string;
+}
+
+export interface ProviderCandidateDecisionV1 {
+  readonly candidateVersion: 1;
+  readonly providerId: string;
+  readonly displayName: string;
+  readonly capability: CapabilityId;
+  readonly execution: 'worker-local' | 'remote-api' | 'server' | 'browser';
+  readonly status: 'eligible' | 'rejected';
+  readonly gates: readonly ProviderCandidateGateResultV1[];
+  readonly rejectedBy?: ProviderCandidateGateV1;
+  readonly scoreBreakdown?: ProviderScoreBreakdownV1;
+  readonly estimatedCost?: Money;
+  readonly modelId?: string;
+}
+
+export interface ProviderDecisionV1 {
+  readonly decisionVersion: 1;
+  readonly decisionId: string;
+  readonly idempotencyKey: string;
+  readonly capability: CapabilityId;
+  readonly status: 'selected' | 'manual-choice-required' | 'unavailable' | 'denied';
+  readonly selectedProviderId?: string;
+  readonly candidates: readonly ProviderCandidateDecisionV1[];
+  readonly reason: string;
+  readonly createdAt: string;
+  readonly productionRunId?: string;
+  readonly providerUsage?: ProviderUsage;
+}
+
 // ===== Lifecycle Types =====
 
 export type ProviderLifecycleState =
   'unconfigured' | 'configured' | 'healthy' | 'degraded' | 'offline' | 'unauthorized';
 
 export interface ProviderStatus {
   readonly providerId: string;
   readonly state: ProviderLifecycleState;
   readonly lastHealthCheck?: string;
   readonly adapterVersion: string;
@@ -280,32 +343,38 @@ export interface AgentHostManifest {
 
 export interface GenerationProvenance {
   readonly providerId: string;
   readonly modelId: string;
   readonly adapterVersion: string;
   readonly createdAt: string;
   readonly requestHash: string;
   readonly idempotencyKey: string;
   readonly processingTimeMs: number;
   readonly execution: 'worker-local' | 'remote-api' | 'server' | 'browser';
+  readonly providerDecisionId?: string;
+  readonly productionRunId?: string;
+  readonly budgetReservationId?: string;
 }
 
 export interface ProviderUsage {
   readonly providerId: string;
   readonly capability: CapabilityId;
   readonly modelId: string;
   readonly timestamp: string;
   readonly durationMs: number;
   readonly cost?: Money;
   readonly inputTokens?: number;
   readonly outputTokens?: number;
   readonly creditsUsed?: number;
+  readonly providerDecisionId?: string;
+  readonly productionRunId?: string;
+  readonly budgetReservationId?: string;
 }
 
 export interface UsageRecord {
   readonly usages: readonly ProviderUsage[];
   readonly totalCost: Money;
   readonly periodStart: string;
   readonly periodEnd: string;
 }
 
 // ===== Result Types =====
