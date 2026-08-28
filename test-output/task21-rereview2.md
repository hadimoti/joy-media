# Review package: 6dd55a7..0bf6f06

## Commits
0bf6f06 fix(editor): surface provider approval details

## Files changed
 apps/editor-web/src/AgentPanel.test.tsx | 88 +++++++++++++++++++++++++++++++++
 apps/editor-web/src/AgentPanel.tsx      | 53 ++++++++++++++++++--
 packages/agent-tools/src/approval.ts    |  5 ++
 packages/agent-tools/src/index.ts       |  1 +
 packages/agent-tools/src/plan.ts        |  7 +++
 packages/provider-sdk/src/privacy.ts    | 83 ++++++++++++++++++++++++++++++-
 6 files changed, 231 insertions(+), 6 deletions(-)

## Diff
diff --git a/apps/editor-web/src/AgentPanel.test.tsx b/apps/editor-web/src/AgentPanel.test.tsx
new file mode 100644
index 0000000..7015fdf
--- /dev/null
+++ b/apps/editor-web/src/AgentPanel.test.tsx
@@ -0,0 +1,88 @@
+import { renderToStaticMarkup } from 'react-dom/server';
+import { describe, expect, it } from 'vitest';
+import type { ApprovalDecision } from '@joy-media/agent-tools';
+import { ProviderApprovalDetails, selectJoyCodePendingApproval } from './AgentPanel.js';
+
+describe('AgentPanel approval selection', () => {
+  it('prefers provider preflight approval over generic manual provider decisions', () => {
+    const generic = decision({
+      id: 'approval-generic',
+      reason: 'Manual approval required for provider.generate',
+    });
+    const provider = decision({
+      id: 'approval-provider-sha256:abc123',
+      reason: 'Provider approval required for edge-tts speech.synthesize',
+      providerApproval: {
+        providerId: 'edge-tts',
+        capability: 'speech.synthesize',
+        requestDigest: 'sha256:abc123',
+      },
+    });
+
+    expect(selectJoyCodePendingApproval([generic, provider])).toBe(provider);
+  });
+
+  it('keeps blocked and generic approvals intact when no provider preflight is present', () => {
+    const generic = decision({ id: 'approval-generic', reason: 'Generic manual approval' });
+    const blocked = decision({
+      id: 'approval-blocked',
+      reason: 'Blocked by policy',
+      decision: 'blocked',
+    });
+
+    expect(selectJoyCodePendingApproval([generic])).toBe(generic);
+    expect(selectJoyCodePendingApproval([generic, blocked])).toBe(blocked);
+  });
+
+  it('renders provider approval details for Joy Code review', () => {
+    const provider = decision({
+      id: 'approval-provider-sha256:abc123',
+      reason: 'Provider approval required for edge-tts speech.synthesize',
+      providerApproval: {
+        providerId: 'edge-tts',
+        capability: 'speech.synthesize',
+        requestDigest: 'sha256:abc123',
+      },
+    });
+
+    const html = renderToStaticMarkup(<ProviderApprovalDetails approval={provider} />);
+
+    expect(html).toContain('Provider');
+    expect(html).toContain('edge-tts');
+    expect(html).toContain('Capability');
+    expect(html).toContain('speech.synthesize');
+    expect(html).toContain('Cost cap');
+    expect(html).toContain('0.00 USD');
+    expect(html).toContain('sha256:abc123');
+  });
+});
+
+function decision(overrides: {
+  readonly id: string;
+  readonly reason: string;
+  readonly decision?: ApprovalDecision['decision'];
+  readonly providerApproval?: ApprovalDecision['request']['providerApproval'];
+}): ApprovalDecision {
+  return {
+    decision: overrides.decision ?? 'requires-manual',
+    reason: overrides.reason,
+    request: {
+      id: overrides.id,
+      stepId: 'tts-step',
+      reason: 'paid-generation',
+      description: overrides.reason,
+      estimatedCost: { amount: '0.00', currency: 'USD' },
+      privacyImpact: {
+        dataLeavesDevice: true,
+        providerId: 'edge-tts',
+        dataTypes: ['text data'],
+        retentionDisclosure: 'Text is sent to Microsoft Edge online TTS for synthesis',
+      },
+      isReversible: true,
+      status: 'pending',
+      ...(overrides.providerApproval === undefined
+        ? {}
+        : { providerApproval: overrides.providerApproval }),
+    },
+  };
+}
diff --git a/apps/editor-web/src/AgentPanel.tsx b/apps/editor-web/src/AgentPanel.tsx
index 96720de..5e59eed 100644
--- a/apps/editor-web/src/AgentPanel.tsx
+++ b/apps/editor-web/src/AgentPanel.tsx
@@ -142,20 +142,67 @@ function initialJoyCodeState(projectId: string): JoyCodeState {
     threads = loadJoyCodeThreads(window.localStorage, projectId);
   } catch {
     // Storage can be disabled by browser policy. The composer still works in memory.
   }
   const existing = threads[0];
   if (existing !== undefined) return { threads, activeThreadId: existing.id };
   const thread = createJoyCodeThread(makeJoyCodeId('task'), new Date().toISOString());
   return { threads: [thread], activeThreadId: thread.id };
 }
 
+export function selectJoyCodePendingApproval(
+  decisions: readonly ApprovalDecision[],
+): ApprovalDecision | undefined {
+  return (
+    decisions.find((decision) => decision.decision === 'blocked') ??
+    decisions.find(
+      (decision) =>
+        decision.decision === 'requires-manual' && decision.request.providerApproval !== undefined,
+    ) ??
+    decisions.find((decision) => decision.decision === 'requires-manual') ??
+    decisions[0]
+  );
+}
+
+function approvalCostLabel(approval: ApprovalDecision): string | undefined {
+  const cost = approval.request.estimatedCost;
+  return cost === undefined ? undefined : `${cost.amount} ${cost.currency}`;
+}
+
+export function ProviderApprovalDetails({ approval }: { readonly approval: ApprovalDecision }) {
+  const provider = approval.request.providerApproval;
+  if (provider === undefined) return null;
+  const cost = approvalCostLabel(approval);
+  return (
+    <dl className="joy-code-provider-approval" aria-label="Provider approval details">
+      <div>
+        <dt>Provider</dt>
+        <dd>{provider.providerId}</dd>
+      </div>
+      <div>
+        <dt>Capability</dt>
+        <dd>{provider.capability}</dd>
+      </div>
+      {cost !== undefined && (
+        <div>
+          <dt>Cost cap</dt>
+          <dd>{cost}</dd>
+        </div>
+      )}
+      <div>
+        <dt>Approval</dt>
+        <dd>{provider.requestDigest}</dd>
+      </div>
+    </dl>
+  );
+}
+
 function threadTimestamp(value: string): string {
   const date = new Date(value);
   if (Number.isNaN(date.getTime())) return '';
   return new Intl.DateTimeFormat(undefined, {
     month: 'short',
     day: 'numeric',
     hour: '2-digit',
     minute: '2-digit',
   }).format(date);
 }
@@ -321,24 +368,21 @@ export function AgentPanel({
       appendMessage(threadId, 'assistant', built.reason);
       return;
     }
     const agentPlan = createPlan(built.goal, [...built.steps]);
     const dryRun = dryRunPlan(agentPlan, registry, buildEditorContext(baseProject));
     const decisions = approvalEngine.evaluatePlan(
       agentPlan,
       agentContext,
       (toolName) => registry.tools.get(toolName)?.scope,
     );
-    const approval =
-      decisions.find((decision) => decision.decision === 'blocked') ??
-      decisions.find((decision) => decision.decision === 'requires-manual') ??
-      decisions[0];
+    const approval = selectJoyCodePendingApproval(decisions);
     if (approval === undefined) {
       appendMessage(threadId, 'assistant', 'برای این برنامه هیچ تصمیم تأییدی ایجاد نشد.');
       return;
     }
     auditRef.current.record({
       planId: agentPlan.planId,
       action: 'plan-created',
       ...(built.steps[0]?.tool !== undefined ? { tool: built.steps[0].tool } : {}),
       ...(built.steps[0]?.arguments !== undefined ? { arguments: built.steps[0].arguments } : {}),
       userId: 'local-owner',
@@ -729,20 +773,21 @@ export function AgentPanel({
                     pendingChanges={pendingChanges}
                     width={400}
                     height={120}
                   />
                   {pending.dryRun.errors.length > 0 && (
                     <p className="agent-error">
                       Dry-run errors: {pending.dryRun.errors.join(', ')}
                     </p>
                   )}
                   <span className="joy-code-plan-reason">{pending.approval.reason}</span>
+                  <ProviderApprovalDetails approval={pending.approval} />
                   <div className="joy-code-plan-actions">
                     {pending.approval.decision === 'blocked' && (
                       <button type="button" onClick={reject}>
                         Dismiss
                       </button>
                     )}
                     {pending.approval.decision === 'requires-manual' && (
                       <>
                         <button
                           type="button"
diff --git a/packages/agent-tools/src/approval.ts b/packages/agent-tools/src/approval.ts
index 6342c99..56f5d9e 100644
--- a/packages/agent-tools/src/approval.ts
+++ b/packages/agent-tools/src/approval.ts
@@ -348,20 +348,25 @@ export function approvalRequestFromProviderPreflight(
       `Approval required for ${preflight.providerId} ${preflight.capability}`,
     ...(preflight.estimatedCost === undefined ? {} : { estimatedCost: preflight.estimatedCost }),
     privacyImpact: {
       dataLeavesDevice: preflight.dataLeavesDevice,
       providerId: preflight.providerId,
       dataTypes: preflight.dataBeingSent,
       ...(preflight.retentionDisclosure === undefined
         ? {}
         : { retentionDisclosure: preflight.retentionDisclosure }),
     },
+    providerApproval: {
+      providerId: preflight.providerId,
+      capability: preflight.capability,
+      requestDigest: preflight.requestDigest,
+    },
     isReversible: true,
     status: 'pending',
   };
 }
 
 export function createSuggestOnlyApprovalPolicy(): ApprovalPolicy {
   return {
     ...basePolicy(),
     executionMode: 'suggest-only',
     blockRemoteUploads: true,
diff --git a/packages/agent-tools/src/index.ts b/packages/agent-tools/src/index.ts
index b3f2fae..1a3b62c 100644
--- a/packages/agent-tools/src/index.ts
+++ b/packages/agent-tools/src/index.ts
@@ -67,20 +67,21 @@ export type {
   AgentEditPlan,
   AgentPlanStep,
   PlanEstimate,
   MoneyRange,
   DurationRange,
   Money,
   PlanStatus,
   ApprovalRequest,
   ApprovalReason,
   PrivacyImpact,
+  ProviderApprovalSummary,
   PlanOptions,
 } from './plan.js';
 export { createPlan, validatePlan, addStepToPlan, updatePlanStatus } from './plan.js';
 
 export type { AgentExecutionMode, ApprovalPolicy, ApprovalDecision } from './approval.js';
 export {
   ALL_TOOL_CAPABILITIES,
   ApprovalEngine,
   createSuggestOnlyApprovalPolicy,
   createPreviewAndApprovePolicy,
diff --git a/packages/agent-tools/src/plan.ts b/packages/agent-tools/src/plan.ts
index d36cb60..c93b3d5 100644
--- a/packages/agent-tools/src/plan.ts
+++ b/packages/agent-tools/src/plan.ts
@@ -54,20 +54,27 @@ export type PlanStatus =
 
 export interface ApprovalRequest {
   readonly id: string;
   readonly stepId: string;
   readonly reason: ApprovalReason;
   readonly description: string;
   readonly estimatedCost?: Money;
   readonly privacyImpact: PrivacyImpact;
   readonly isReversible: boolean;
   readonly status: 'pending' | 'approved' | 'rejected';
+  readonly providerApproval?: ProviderApprovalSummary;
+}
+
+export interface ProviderApprovalSummary {
+  readonly providerId: string;
+  readonly capability: string;
+  readonly requestDigest: string;
 }
 
 export type ApprovalReason =
   | 'project-edit'
   | 'paid-generation'
   | 'remote-upload'
   | 'voice-cloning'
   | 'destructive-edit'
   | 'publish-export'
   | 'plugin-install'
diff --git a/packages/provider-sdk/src/privacy.ts b/packages/provider-sdk/src/privacy.ts
index 9fda38c..372d420 100644
--- a/packages/provider-sdk/src/privacy.ts
+++ b/packages/provider-sdk/src/privacy.ts
@@ -1,11 +1,10 @@
-import { createHash } from 'node:crypto';
 import type {
   AnyProvider,
   CapabilityId,
   CapabilityRequest,
   Money,
   PrivacyPreflight,
 } from './types.js';
 import {
   getProviderId,
   getDataLeavesDevice,
@@ -73,20 +72,31 @@ const DEFAULT_SIZE_ESTIMATES: Record<CapabilityId, number> = {
   'image.upscale': 2_000_000,
   'video.generate': 1_000,
   'video.animate': 5_000_000,
   'video.interpolate': 50_000_000,
   'video.removeBackground': 50_000_000,
   'llm.complete': 5_000,
   'embedding.create': 5_000,
   'vision.analyze': 2_000_000,
 };
 
+const SHA256_K: readonly number[] = [
+  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
+  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
+  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
+  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
+  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
+  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
+  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
+  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
+];
+
 export interface ProviderApprovalBinding {
   readonly actorId: string;
   readonly providerId: string;
   readonly capability: CapabilityId;
   readonly requestDigest: string;
   readonly expiresAt: string;
   readonly costCap?: Money;
 }
 
 export interface ProviderApprovalGrant extends ProviderApprovalBinding {
@@ -153,21 +163,21 @@ export function computePrivacyPreflight(
     (result as { estimatedCost?: Money }).estimatedCost = estimatedCost;
   }
   if (retentionDisclosure !== undefined) {
     (result as { retentionDisclosure?: string }).retentionDisclosure = retentionDisclosure;
   }
 
   return result;
 }
 
 export function computeProviderRequestDigest(request: CapabilityRequest): string {
-  return `sha256:${createHash('sha256').update(stableJson(request)).digest('hex')}`;
+  return `sha256:${sha256Hex(stableJson(request))}`;
 }
 
 export function computeProviderApprovalPreflight(
   actorId: string,
   request: CapabilityRequest,
   provider: AnyProvider,
 ): ProviderApprovalPreflight {
   const preflight = computePrivacyPreflight(request, provider);
   return {
     ...preflight,
@@ -196,10 +206,79 @@ function requestForApprovalDigest(
 function stableJson(value: unknown): string {
   if (value === null || typeof value !== 'object') return JSON.stringify(value);
   if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
   const record = value as Record<string, unknown>;
   return `{${Object.keys(record)
     .sort()
     .filter((key) => record[key] !== undefined)
     .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
     .join(',')}}`;
 }
+
+function sha256Hex(text: string): string {
+  const data = new TextEncoder().encode(text);
+  const bitLength = data.length * 8;
+  const paddedLength = (((data.length + 8) >> 6) + 1) << 6;
+  const bytes = new Uint8Array(paddedLength);
+  bytes.set(data);
+  bytes[data.length] = 0x80;
+  const view = new DataView(bytes.buffer);
+  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
+  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
+
+  const h = [
+    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
+  ];
+  const w = new Array<number>(64).fill(0);
+
+  for (let offset = 0; offset < paddedLength; offset += 64) {
+    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
+    for (let i = 16; i < 64; i++) {
+      const w15 = w[i - 15]!;
+      const w2 = w[i - 2]!;
+      const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
+      const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
+      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
+    }
+
+    let a = h[0]!;
+    let b = h[1]!;
+    let c = h[2]!;
+    let d = h[3]!;
+    let e = h[4]!;
+    let f = h[5]!;
+    let g = h[6]!;
+    let hh = h[7]!;
+
+    for (let i = 0; i < 64; i++) {
+      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
+      const ch = (e & f) ^ (~e & g);
+      const t1 = (hh + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
+      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
+      const maj = (a & b) ^ (a & c) ^ (b & c);
+      const t2 = (s0 + maj) >>> 0;
+      hh = g;
+      g = f;
+      f = e;
+      e = (d + t1) >>> 0;
+      d = c;
+      c = b;
+      b = a;
+      a = (t1 + t2) >>> 0;
+    }
+
+    h[0] = (h[0]! + a) >>> 0;
+    h[1] = (h[1]! + b) >>> 0;
+    h[2] = (h[2]! + c) >>> 0;
+    h[3] = (h[3]! + d) >>> 0;
+    h[4] = (h[4]! + e) >>> 0;
+    h[5] = (h[5]! + f) >>> 0;
+    h[6] = (h[6]! + g) >>> 0;
+    h[7] = (h[7]! + hh) >>> 0;
+  }
+
+  return h.map((word) => word.toString(16).padStart(8, '0')).join('');
+}
+
+function rotateRight(value: number, bits: number): number {
+  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
+}
