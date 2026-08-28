# Review package: cfd0df8..4e62dfd

## Commits
4e62dfd fix(agent): tighten creative brief validation

## Files changed
 packages/agent-tools/src/creative-brief.test.ts | 151 ++++++++++++++++++++++++
 packages/agent-tools/src/creative-brief.ts      |  95 ++++++++++++++-
 packages/agent-tools/src/model-adapter.ts       |  24 +++-
 3 files changed, 264 insertions(+), 6 deletions(-)

## Diff
diff --git a/packages/agent-tools/src/creative-brief.test.ts b/packages/agent-tools/src/creative-brief.test.ts
index 764aec6..3c3e559 100644
--- a/packages/agent-tools/src/creative-brief.test.ts
+++ b/packages/agent-tools/src/creative-brief.test.ts
@@ -323,11 +323,162 @@ describe('createCreativeBrief', () => {
       humanDecisions: [],
       confidenceSummary: {
         overall: 'medium',
         rationale: 'Enough S1 evidence for a directional brief.',
       },
       generatedAt: '2026-08-21T00:00:00.000Z',
     };
 
     expect(validateCreativeBriefV1(invalidBrief, { snapshot, intelligence }).valid).toBe(false);
   });
+
+  it('rejects stale model output request identity and interpreted goal mismatches', async () => {
+    const snapshot = snapshotFixture();
+    const intelligence = intelligenceFixture(snapshot);
+    const request = requestFixture();
+    const valid = await createFakeModelAdapter({ mode: 'valid' }).createBrief({
+      snapshot,
+      intelligence,
+      request,
+    });
+
+    await expect(
+      createCreativeBrief({
+        snapshot,
+        intelligence,
+        request,
+        modelAdapter: {
+          async createBrief() {
+            return {
+              brief: {
+                ...valid.brief,
+                requestId: 'stale-request-id',
+              },
+            };
+          },
+        },
+      }),
+    ).rejects.toThrow(/requestId/i);
+
+    await expect(
+      createCreativeBrief({
+        snapshot,
+        intelligence,
+        request,
+        modelAdapter: {
+          async createBrief() {
+            return {
+              brief: {
+                ...valid.brief,
+                interpretedGoal: 'A different goal from a previous request.',
+              },
+            };
+          },
+        },
+      }),
+    ).rejects.toThrow(/interpretedGoal|goal/i);
+  });
+
+  it('rejects recommendation ranges outside cited evidence and request bounds', async () => {
+    const snapshot = snapshotFixture();
+    const intelligence = intelligenceFixture(snapshot);
+    const request = requestFixture({
+      scope: {
+        domains: ['timeline'],
+        boundedRangeUs: { startUs: 1_000_000, durationUs: 3_000_000 },
+      },
+    });
+    const valid = await createFakeModelAdapter({ mode: 'valid' }).createBrief({
+      snapshot,
+      intelligence,
+      request,
+    });
+    const recommendation = valid.brief.recommendations[0];
+    if (recommendation === undefined) {
+      throw new Error('valid fake adapter must create a recommendation');
+    }
+
+    await expect(
+      createCreativeBrief({
+        snapshot,
+        intelligence,
+        request,
+        modelAdapter: {
+          async createBrief() {
+            return {
+              brief: {
+                ...valid.brief,
+                recommendations: [
+                  {
+                    ...recommendation,
+                    boundedRangeUs: { startUs: 0, durationUs: 48 * 60 * 60 * 1_000_000 },
+                  },
+                ],
+              },
+            };
+          },
+        },
+      }),
+    ).rejects.toThrow(/range|duration|bounds/i);
+
+    await expect(
+      createCreativeBrief({
+        snapshot,
+        intelligence,
+        request,
+        modelAdapter: {
+          async createBrief() {
+            return {
+              brief: {
+                ...valid.brief,
+                recommendations: [
+                  {
+                    ...recommendation,
+                    boundedRangeUs: { startUs: 5_000_000, durationUs: 1_000_000 },
+                  },
+                ],
+              },
+            };
+          },
+        },
+      }),
+    ).rejects.toThrow(/request|bounds|range/i);
+  });
+
+  it('allows project-wide S2 factual findings with empty evidence references', async () => {
+    const snapshot = snapshotFixture();
+    const projectWideFinding: IntelligenceFindingV1 = {
+      id: 'finding-project-wide-001',
+      category: 'metadata',
+      severity: 'info',
+      title: 'Project-wide metadata is available',
+      description: 'This fact is derived from project-level metadata and has no S1 evidence id.',
+      evidenceIds: [],
+    };
+    const intelligence = createSemanticIntelligenceV1([projectWideFinding], [], {
+      projectId: PROJECT_ID,
+      snapshotRevision: snapshot.metadata.revision,
+      createdBy: 'test',
+      contentHash: 'project-wide-hash',
+    });
+
+    const brief = await createCreativeBrief({
+      snapshot,
+      intelligence,
+      request: requestFixture(),
+      modelAdapter: createFakeModelAdapter({ mode: 'valid' }),
+    });
+
+    expect(brief.factualFindings).toEqual([
+      {
+        source: 's2',
+        findingId: projectWideFinding.id,
+        title: projectWideFinding.title,
+        description: projectWideFinding.description,
+        evidenceReferences: [],
+        category: projectWideFinding.category,
+        severity: projectWideFinding.severity,
+      },
+    ]);
+    expect(brief.recommendations[0]?.evidenceReferences).toEqual(['clip-001']);
+  });
 });
diff --git a/packages/agent-tools/src/creative-brief.ts b/packages/agent-tools/src/creative-brief.ts
index 84b9581..4eeefb1 100644
--- a/packages/agent-tools/src/creative-brief.ts
+++ b/packages/agent-tools/src/creative-brief.ts
@@ -165,20 +165,21 @@ export interface CreativeBriefV1 {
 
 export interface CreativeBriefValidationResultV1 {
   readonly valid: boolean;
   readonly errors: readonly string[];
   readonly warnings: readonly string[];
 }
 
 export interface CreativeBriefValidationContextV1 {
   readonly snapshot: SemanticSnapshotV1;
   readonly intelligence: SemanticIntelligenceV1;
+  readonly request?: CreativeBriefRequestV1;
 }
 
 export interface CreateCreativeBriefOptionsV1 {
   readonly snapshot: unknown;
   readonly intelligence: unknown;
   readonly request: unknown;
   readonly modelAdapter: CreativeModelAdapter;
 }
 
 export class CreativeBriefValidationError extends Error {
@@ -374,20 +375,28 @@ function addTimeRangeErrors(
     errors.push(`${path}.startUs must be a non-negative integer within 24 hours`);
   }
 
   const durationValid =
     isNonNegativeInteger(value.durationUs) &&
     value.durationUs <= MAX_TIME_US &&
     (!requirePositiveDuration || value.durationUs > 0);
   if (!durationValid) {
     errors.push(`${path}.durationUs must be a bounded positive duration`);
   }
+
+  if (
+    isNonNegativeInteger(value.startUs) &&
+    isNonNegativeInteger(value.durationUs) &&
+    value.startUs + value.durationUs > MAX_TIME_US
+  ) {
+    errors.push(`${path} end must be within 24 hours`);
+  }
 }
 
 function addSecurityErrors(errors: string[], value: unknown, path: string): void {
   if (typeof value === 'string') {
     const checks: readonly [RegExp, string][] = [
       [/\bhttps?:\/\//i, 'URL'],
       [/\bfile:\/\//i, 'file URL'],
       [/\bs3:\/\//i, 'object-store URL'],
       [/\b[A-Za-z]:\\/i, 'private path'],
       [/^\/(?:tmp|Users|home|var|etc)\b/i, 'private path'],
@@ -449,20 +458,96 @@ function addEvidenceReferenceErrors(
     if (!isNonEmptyString(evidenceId, MAX_ID_LENGTH)) {
       errors.push(`${path} entries must be non-empty evidence ids`);
       continue;
     }
     if (!hasEvidence(snapshot, evidenceId)) {
       errors.push(`${path} references unknown evidence id ${evidenceId}`);
     }
   }
 }
 
+function isValidTimeRange(value: unknown): value is CreativeTimeRangeV1 {
+  return (
+    isRecord(value) &&
+    isNonNegativeInteger(value.startUs) &&
+    isNonNegativeInteger(value.durationUs) &&
+    value.durationUs > 0 &&
+    value.startUs + value.durationUs <= MAX_TIME_US
+  );
+}
+
+function rangeEnd(range: CreativeTimeRangeV1): number {
+  return range.startUs + range.durationUs;
+}
+
+function rangeContains(container: CreativeTimeRangeV1, child: CreativeTimeRangeV1): boolean {
+  return child.startUs >= container.startUs && rangeEnd(child) <= rangeEnd(container);
+}
+
+function addRecommendationRangeBoundErrors(
+  errors: string[],
+  recommendation: Record<string, unknown>,
+  path: string,
+  context: CreativeBriefValidationContextV1,
+): void {
+  if (!isValidTimeRange(recommendation.boundedRangeUs)) {
+    return;
+  }
+
+  const recommendationRange = recommendation.boundedRangeUs;
+
+  if (
+    context.request?.scope.boundedRangeUs !== undefined &&
+    isValidTimeRange(context.request.scope.boundedRangeUs) &&
+    !rangeContains(context.request.scope.boundedRangeUs, recommendationRange)
+  ) {
+    errors.push(`${path}.boundedRangeUs must stay within the request boundedRangeUs`);
+  }
+
+  if (!Array.isArray(recommendation.evidenceReferences)) {
+    return;
+  }
+
+  let temporalEvidenceCount = 0;
+  for (const evidenceId of recommendation.evidenceReferences) {
+    if (typeof evidenceId !== 'string') {
+      continue;
+    }
+
+    const evidence = context.snapshot.evidenceIndex.get(evidenceId);
+    if (
+      evidence === undefined ||
+      !isNonNegativeInteger(evidence.startUs) ||
+      !isNonNegativeInteger(evidence.durationUs) ||
+      evidence.durationUs <= 0
+    ) {
+      continue;
+    }
+
+    temporalEvidenceCount += 1;
+    if (
+      !rangeContains(
+        { startUs: evidence.startUs, durationUs: evidence.durationUs },
+        recommendationRange,
+      )
+    ) {
+      errors.push(`${path}.boundedRangeUs must stay within cited S1 evidence ${evidenceId}`);
+    }
+  }
+
+  if (temporalEvidenceCount === 0) {
+    errors.push(
+      `${path}.boundedRangeUs must cite at least one S1 evidence item with a bounded time range`,
+    );
+  }
+}
+
 function validateRequest(request: unknown): CreativeBriefValidationResultV1 {
   const errors: string[] = [];
 
   if (!isRecord(request)) {
     return { valid: false, errors: ['Request must be an object'], warnings: [] };
   }
 
   addUnknownKeyErrors(errors, request, REQUEST_KEYS, 'request');
   addStringError(errors, request.projectId, 'request.projectId', MAX_ID_LENGTH);
   if (!isNonNegativeInteger(request.snapshotRevision)) {
@@ -671,21 +756,21 @@ function addFactErrors(
     ) {
       errors.push(`${path}.evidenceReferences must match the deterministic S2 finding evidence`);
     }
   }
   addEvidenceReferenceErrors(
     errors,
     value.evidenceReferences,
     `${path}.evidenceReferences`,
     context.snapshot,
     {
-      requireNonEmpty: true,
+      requireNonEmpty: finding === undefined || finding.evidenceIds.length > 0,
     },
   );
 }
 
 function addInferenceErrors(
   errors: string[],
   value: unknown,
   path: string,
   context: CreativeBriefValidationContextV1,
 ): void {
@@ -789,20 +874,21 @@ function addRecommendationErrors(
   addEvidenceReferenceErrors(
     errors,
     value.evidenceReferences,
     `${path}.evidenceReferences`,
     context.snapshot,
     {
       requireNonEmpty: true,
     },
   );
   addTimeRangeErrors(errors, value.boundedRangeUs, `${path}.boundedRangeUs`, true);
+  addRecommendationRangeBoundErrors(errors, value, path, context);
 
   if (value.proposedIntent !== undefined) {
     if (!isRecord(value.proposedIntent)) {
       errors.push(`${path}.proposedIntent must be an object`);
     } else {
       addUnknownKeyErrors(
         errors,
         value.proposedIntent,
         ['label', 'summary', 'boundedRangeUs'],
         `${path}.proposedIntent`,
@@ -898,20 +984,26 @@ export function validateCreativeBriefV1(
     return { valid: false, errors: ['Model output brief must be an object'], warnings: [] };
   }
 
   addUnknownKeyErrors(errors, brief, BRIEF_KEYS, 'brief');
   if (brief.snapshotRevision !== context.snapshot.metadata.revision) {
     errors.push('brief snapshotRevision must match S1 snapshot revision');
   }
   if (brief.intelligenceRevision !== context.intelligence.metadata.revision) {
     errors.push('brief intelligenceRevision must match S2 intelligence revision');
   }
+  if (context.request !== undefined && brief.requestId !== context.request.requestId) {
+    errors.push('brief requestId must match the active creative brief request');
+  }
+  if (context.request !== undefined && brief.interpretedGoal !== context.request.goal) {
+    errors.push('brief interpretedGoal must match the active creative brief request goal');
+  }
   addStringError(errors, brief.requestId, 'brief.requestId', MAX_ID_LENGTH);
   addStringError(errors, brief.interpretedGoal, 'brief.interpretedGoal', MAX_GOAL_LENGTH);
   addStringError(errors, brief.generatedAt, 'brief.generatedAt', MAX_SHORT_TEXT_LENGTH);
 
   addArrayError(
     errors,
     brief.factualFindings,
     'brief.factualFindings',
     MAX_BRIEF_ITEMS,
     (fact, index) => addFactErrors(errors, fact, `brief.factualFindings[${index}]`, context),
@@ -1013,18 +1105,19 @@ export async function createCreativeBrief(
 
   if (!isRecord(output) || !('brief' in output)) {
     throw new CreativeBriefValidationError('Invalid model output', [
       'Model output must contain a brief object',
     ]);
   }
 
   const briefResult = validateCreativeBriefV1(output.brief, {
     snapshot: inputResult.snapshot,
     intelligence: inputResult.intelligence,
+    request,
   });
 
   if (!briefResult.valid) {
     throw new CreativeBriefValidationError('Invalid model output', briefResult.errors);
   }
 
   return output.brief as CreativeBriefV1;
 }
diff --git a/packages/agent-tools/src/model-adapter.ts b/packages/agent-tools/src/model-adapter.ts
index 6fd1f4d..d3bb4de 100644
--- a/packages/agent-tools/src/model-adapter.ts
+++ b/packages/agent-tools/src/model-adapter.ts
@@ -60,26 +60,40 @@ function deterministicUuid(seed: string): string {
 function firstEvidenceId(input: BoundedModelInputV1): string {
   const firstFindingEvidence = input.intelligence.findings[0]?.evidenceIds[0];
   return firstFindingEvidence ?? input.snapshot.evidenceIds[0] ?? 'missing-evidence';
 }
 
 function boundedRangeForEvidence(
   input: BoundedModelInputV1,
   evidenceId: string,
 ): CreativeTimeRangeV1 {
   const evidence = input.snapshot.evidenceIndex.get(evidenceId);
+  const evidenceStartUs = evidence?.startUs ?? 0;
+  const evidenceDurationUs = Math.max(1, evidence?.durationUs ?? 1_000_000);
+  const evidenceEndUs = evidenceStartUs + evidenceDurationUs;
+  const requestRange = input.request.scope.boundedRangeUs;
+
+  if (requestRange !== undefined) {
+    const requestEndUs = requestRange.startUs + requestRange.durationUs;
+    const startUs = Math.max(evidenceStartUs, requestRange.startUs);
+    const endUs = Math.min(evidenceEndUs, requestEndUs);
+    if (endUs > startUs) {
+      return {
+        startUs,
+        durationUs: endUs - startUs,
+      };
+    }
+  }
+
   return {
-    startUs: evidence?.startUs ?? input.request.scope.boundedRangeUs?.startUs ?? 0,
-    durationUs: Math.max(
-      1,
-      evidence?.durationUs ?? input.request.scope.boundedRangeUs?.durationUs ?? 1_000_000,
-    ),
+    startUs: evidenceStartUs,
+    durationUs: evidenceDurationUs,
   };
 }
 
 function factsFromIntelligence(intelligence: SemanticIntelligenceV1): readonly CreativeFactV1[] {
   return intelligence.findings.map((finding) => ({
     source: 's2',
     findingId: finding.id,
     title: finding.title,
     description: finding.description,
     evidenceReferences: finding.evidenceIds,
