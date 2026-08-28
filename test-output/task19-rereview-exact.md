# Review package: de3cb2f..03d94f5

## Commits
03d94f5 fix(providers): preserve decision audits and strict budget replay

## Files changed
 packages/provider-sdk/src/budget.test.ts   | 29 +++++++++++++++++++
 packages/provider-sdk/src/budget.ts        | 46 +++++++++++++++++++++---------
 packages/provider-sdk/src/decision.test.ts | 36 ++++++++++++++++++++++-
 packages/provider-sdk/src/decision.ts      |  8 ++++--
 4 files changed, 103 insertions(+), 16 deletions(-)

## Diff
diff --git a/packages/provider-sdk/src/budget.test.ts b/packages/provider-sdk/src/budget.test.ts
index f988bdd..3dfc5dd 100644
--- a/packages/provider-sdk/src/budget.test.ts
+++ b/packages/provider-sdk/src/budget.test.ts
@@ -97,37 +97,55 @@ describe('provider budget ledger', () => {
   });
 
   it('is idempotent for reservation and reconciliation replay', () => {
     const first = reserveProviderBudget(createProviderBudgetLedger(), {
       reservationId: 'reservation-1',
       idempotencyKey: 'reserve-1',
       providerId: 'remote',
       capability: 'speech.transcribe',
       estimatedCost: { amount: '1.00', currency: 'USD' },
       cap: { amount: '2.00', currency: 'USD' },
+      providerDecisionId: 'decision-1',
+      productionRunId: 'run-1',
     });
     expect(first.ok).toBe(true);
     if (!first.ok) expect.unreachable('reservation should succeed');
 
     const reservationReplay = reserveProviderBudget(first.ledger, {
       reservationId: 'reservation-1',
       idempotencyKey: 'reserve-1',
       providerId: 'remote',
       capability: 'speech.transcribe',
       estimatedCost: { amount: '1.00', currency: 'USD' },
       cap: { amount: '2.00', currency: 'USD' },
+      providerDecisionId: 'decision-1',
+      productionRunId: 'run-1',
     });
     expect(reservationReplay.ok).toBe(true);
     if (!reservationReplay.ok) expect.unreachable('reservation replay should succeed');
     expect(reservationReplay.replay).toBe(true);
     expect(reservationReplay.ledger).toBe(first.ledger);
 
+    const reservationConflict = reserveProviderBudget(first.ledger, {
+      reservationId: 'reservation-1',
+      idempotencyKey: 'reserve-1',
+      providerId: 'remote',
+      capability: 'image.generate',
+      estimatedCost: { amount: '1.00', currency: 'USD' },
+      cap: { amount: '1.50', currency: 'USD' },
+      providerDecisionId: 'decision-2',
+      productionRunId: 'run-2',
+    });
+    expect(reservationConflict.ok).toBe(false);
+    if (reservationConflict.ok) expect.unreachable('changed replay inputs should conflict');
+    expect(reservationConflict.reason).toBe('idempotency-conflict');
+
     const usage = reconcileProviderBudget(first.ledger, {
       reservationId: 'reservation-1',
       idempotencyKey: 'usage-1',
       kind: 'partial',
       actualCost: { amount: '0.20', currency: 'USD' },
       providerUsageId: 'usage-1',
     });
     expect(usage.ok).toBe(true);
     if (!usage.ok) expect.unreachable('usage reconciliation should succeed');
 
@@ -135,12 +153,23 @@ describe('provider budget ledger', () => {
       reservationId: 'reservation-1',
       idempotencyKey: 'usage-1',
       kind: 'partial',
       actualCost: { amount: '0.20', currency: 'USD' },
       providerUsageId: 'usage-1',
     });
     expect(usageReplay.ok).toBe(true);
     if (!usageReplay.ok) expect.unreachable('usage replay should succeed');
     expect(usageReplay.replay).toBe(true);
     expect(usageReplay.ledger).toBe(usage.ledger);
+
+    const usageConflict = reconcileProviderBudget(usage.ledger, {
+      reservationId: 'reservation-1',
+      idempotencyKey: 'usage-1',
+      kind: 'partial',
+      actualCost: { amount: '0.20', currency: 'USD' },
+      providerUsageId: 'usage-2',
+    });
+    expect(usageConflict.ok).toBe(false);
+    if (usageConflict.ok) expect.unreachable('changed usage replay inputs should conflict');
+    expect(usageConflict.reason).toBe('idempotency-conflict');
   });
 });
diff --git a/packages/provider-sdk/src/budget.ts b/packages/provider-sdk/src/budget.ts
index 75315ff..98ae6b8 100644
--- a/packages/provider-sdk/src/budget.ts
+++ b/packages/provider-sdk/src/budget.ts
@@ -93,26 +93,21 @@ export function createProviderBudgetLedger(): ProviderBudgetLedgerV1 {
 }
 
 export function reserveProviderBudget(
   ledger: ProviderBudgetLedgerV1,
   input: ReserveProviderBudgetInput,
 ): ReserveProviderBudgetResult {
   const replay = ledger.reservations.find(
     (reservation) => reservation.idempotencyKey === input.idempotencyKey,
   );
   if (replay !== undefined) {
-    if (
-      replay.reservationId !== input.reservationId ||
-      replay.providerId !== input.providerId ||
-      replay.reserved.amount !== input.estimatedCost.amount ||
-      replay.reserved.currency !== input.estimatedCost.currency
-    ) {
+    if (!sameReservationReplay(replay, input)) {
       return { ok: false, ledger, reason: 'idempotency-conflict' };
     }
     return { ok: true, ledger, reservation: replay, replay: true };
   }
 
   if (input.estimatedCost.currency !== input.cap.currency) {
     return { ok: false, ledger, reason: 'currency-mismatch' };
   }
   if (compareMoney(input.estimatedCost, input.cap) > 0) {
     return { ok: false, ledger, reason: 'cap-exceeded' };
@@ -151,27 +146,21 @@ export function reconcileProviderBudget(
   ledger: ProviderBudgetLedgerV1,
   input: ReconcileProviderBudgetInput,
 ): ReconcileProviderBudgetResult {
   const replay = ledger.reconciliations.find(
     (reconciliation) => reconciliation.idempotencyKey === input.idempotencyKey,
   );
   if (replay !== undefined) {
     const reservation = ledger.reservations.find(
       (candidate) => candidate.reservationId === replay.reservationId,
     );
-    if (
-      replay.reservationId !== input.reservationId ||
-      replay.kind !== input.kind ||
-      replay.actualCost.amount !== input.actualCost.amount ||
-      replay.actualCost.currency !== input.actualCost.currency ||
-      reservation === undefined
-    ) {
+    if (reservation === undefined || !sameReconciliationReplay(replay, input)) {
       return { ok: false, ledger, reason: 'idempotency-conflict' };
     }
     return { ok: true, ledger, reservation, reconciliation: replay, replay: true };
   }
 
   const reservation = ledger.reservations.find(
     (candidate) => candidate.reservationId === input.reservationId,
   );
   if (reservation === undefined) {
     return { ok: false, ledger, reason: 'reservation-not-found' };
@@ -217,20 +206,51 @@ export function reconcileProviderBudget(
     reservation: nextReservation,
     reconciliation,
     replay: false,
   };
 }
 
 function zeroMoney(currency: string): Money {
   return currency === 'USD' ? ZERO_USD : { amount: '0.00', currency };
 }
 
+function sameReservationReplay(
+  reservation: ProviderBudgetReservationV1,
+  input: ReserveProviderBudgetInput,
+): boolean {
+  return (
+    reservation.reservationId === input.reservationId &&
+    reservation.providerId === input.providerId &&
+    reservation.capability === input.capability &&
+    sameMoney(reservation.reserved, input.estimatedCost) &&
+    sameMoney(reservation.cap, input.cap) &&
+    reservation.providerDecisionId === input.providerDecisionId &&
+    reservation.productionRunId === input.productionRunId
+  );
+}
+
+function sameReconciliationReplay(
+  reconciliation: ProviderBudgetReconciliationV1,
+  input: ReconcileProviderBudgetInput,
+): boolean {
+  return (
+    reconciliation.reservationId === input.reservationId &&
+    reconciliation.kind === input.kind &&
+    sameMoney(reconciliation.actualCost, input.actualCost) &&
+    reconciliation.providerUsageId === input.providerUsageId
+  );
+}
+
+function sameMoney(left: Money, right: Money): boolean {
+  return left.amount === right.amount && left.currency === right.currency;
+}
+
 function subtractMoney(left: Money, right: Money): Money {
   if (left.currency !== right.currency) {
     throw new Error(
       `Cannot subtract money with different currencies: ${left.currency} vs ${right.currency}`,
     );
   }
   return {
     amount: (parseFloat(left.amount) - parseFloat(right.amount)).toFixed(2),
     currency: left.currency,
   };
diff --git a/packages/provider-sdk/src/decision.test.ts b/packages/provider-sdk/src/decision.test.ts
index 01fff05..84141bc 100644
--- a/packages/provider-sdk/src/decision.test.ts
+++ b/packages/provider-sdk/src/decision.test.ts
@@ -117,31 +117,65 @@ describe('decideProvider', () => {
     const decision = decideProvider(request(), [remote, local], policy());
 
     expect(decision.status).toBe('selected');
     expect(decision.selectedProviderId).toBe('local');
     expect(decision.candidates.map((candidate) => candidate.providerId)).toEqual([
       'local',
       'remote',
     ]);
   });
 
+  it('preserves rejected hard-gate audit entries on selected decisions', () => {
+    const local = pricedProvider('local', { execution: 'worker-local', dataLeavesDevice: false });
+    const imageOnly = createMockProvider('image-only', ['image.generate']);
+    const remote = pricedProvider('remote', { execution: 'remote-api', dataLeavesDevice: true });
+
+    const decision = decideProvider(
+      request({ constraints: { requiredPrivacy: 'local-only' } }),
+      [remote, imageOnly, local],
+      policy(),
+    );
+
+    expect(decision.status).toBe('selected');
+    expect(decision.selectedProviderId).toBe('local');
+    expect(decision.candidates.map((candidate) => candidate.providerId)).toEqual([
+      'local',
+      'remote',
+      'image-only',
+    ]);
+    expect(decision.candidates).toEqual(
+      expect.arrayContaining([
+        expect.objectContaining({ providerId: 'remote', rejectedBy: 'privacy' }),
+        expect.objectContaining({ providerId: 'image-only', rejectedBy: 'capability' }),
+      ]),
+    );
+  });
+
   it('requires manual choice for an exact top-score tie when configured', () => {
     const first = pricedProvider('first');
     const second = pricedProvider('second');
+    const imageOnly = createMockProvider('image-only', ['image.generate']);
 
-    const decision = decideProvider(request(), [first, second], policy(), {
+    const decision = decideProvider(request(), [first, imageOnly, second], policy(), {
       requireManualChoiceOnTie: true,
     });
 
     expect(decision.status).toBe('manual-choice-required');
     expect(decision.selectedProviderId).toBeUndefined();
     expect(decision.reason).toContain('tie');
+    expect(decision.candidates).toEqual(
+      expect.arrayContaining([
+        expect.objectContaining({ providerId: 'first', status: 'eligible' }),
+        expect.objectContaining({ providerId: 'second', status: 'eligible' }),
+        expect.objectContaining({ providerId: 'image-only', rejectedBy: 'capability' }),
+      ]),
+    );
   });
 
   it('reports unavailable and denied outcomes', () => {
     const provider = pricedProvider('remote', { execution: 'remote-api', dataLeavesDevice: true });
 
     expect(
       decideProvider(request(), [provider], policy(), {
         unavailableProviderIds: ['remote'],
       }).status,
     ).toBe('unavailable');
diff --git a/packages/provider-sdk/src/decision.ts b/packages/provider-sdk/src/decision.ts
index 2d43af5..28a951e 100644
--- a/packages/provider-sdk/src/decision.ts
+++ b/packages/provider-sdk/src/decision.ts
@@ -81,35 +81,39 @@ export function decideProvider(
         status === 'unavailable'
           ? `No available providers can satisfy '${request.capability}'`
           : `Provider policy denied '${request.capability}'`,
     };
   }
 
   const top = eligible[0]!;
   const tied = eligible.filter(
     (candidate) => candidate.scoreBreakdown?.total === top.scoreBreakdown?.total,
   );
+  const rankedCandidates = [
+    ...eligible,
+    ...candidates.filter((candidate) => candidate.status === 'rejected'),
+  ];
 
   if (options.requireManualChoiceOnTie === true && tied.length > 1) {
     return {
       ...base,
-      candidates: eligible,
+      candidates: rankedCandidates,
       status: 'manual-choice-required',
       reason: `Top provider tie requires manual choice: ${tied
         .map((candidate) => candidate.providerId)
         .join(', ')}`,
     };
   }
 
   return {
     ...base,
-    candidates: eligible,
+    candidates: rankedCandidates,
     status: 'selected',
     selectedProviderId: top.providerId,
     reason: `Selected '${top.providerId}' for '${request.capability}'`,
   };
 }
 
 function decideCandidate(
   provider: AnyProvider,
   request: CapabilityRequest,
   policy: ProviderPolicy,
