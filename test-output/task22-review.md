# Review package: 0bf6f06..cfd0df8

## Commits
cfd0df8 feat(agent): create evidence-bounded read-only creative briefs

## Files changed
 packages/agent-tools/src/creative-brief.test.ts |  333 ++++++++
 packages/agent-tools/src/creative-brief.ts      | 1030 +++++++++++++++++++++++
 packages/agent-tools/src/index.ts               |   38 +
 packages/agent-tools/src/model-adapter.test.ts  |  131 +++
 packages/agent-tools/src/model-adapter.ts       |  247 ++++++
 5 files changed, 1779 insertions(+)

## Diff
diff --git a/packages/agent-tools/src/creative-brief.test.ts b/packages/agent-tools/src/creative-brief.test.ts
new file mode 100644
index 0000000..764aec6
--- /dev/null
+++ b/packages/agent-tools/src/creative-brief.test.ts
@@ -0,0 +1,333 @@
+import { describe, expect, it } from 'vitest';
+import {
+  createSemanticIntelligenceV1,
+  createSemanticSnapshotV1,
+  type IntelligenceFindingV1,
+  type SemanticIntelligenceV1,
+  type SemanticSnapshotV1,
+} from '@joy-media/project-schema';
+import {
+  createCreativeBrief,
+  validateCreativeBriefV1,
+  type CreativeBriefRequestV1,
+  type CreativeBriefV1,
+  type ProposedIntentV1,
+} from './creative-brief.js';
+import { createFakeModelAdapter } from './model-adapter.js';
+
+const PROJECT_ID = 'project-s3-brief';
+
+function snapshotFixture(): SemanticSnapshotV1 {
+  return createSemanticSnapshotV1(
+    [
+      {
+        id: 'timeline',
+        label: 'Timeline',
+        domain: 'timeline',
+        evidence: [
+          {
+            id: 'clip-001',
+            kind: 'clip',
+            label: 'Opening interview clip',
+            summary: 'Speaker intro starts after a long visual pause.',
+            sourceEntityId: 'clip-source-001',
+            sourceEntityRevision: 3,
+            startUs: 0,
+            durationUs: 8_000_000,
+          },
+        ],
+      },
+      {
+        id: 'captions',
+        label: 'Captions',
+        domain: 'captions',
+        evidence: [
+          {
+            id: 'caption-fa-001',
+            kind: 'caption-document',
+            label: 'زیرنویس فارسی',
+            summary: 'متن فارسی باید بدون تغییر باقی بماند',
+            sourceEntityId: 'caption-source-001',
+            sourceEntityRevision: 2,
+          },
+        ],
+      },
+    ],
+    {
+      projectId: PROJECT_ID,
+      revision: 7,
+      schemaVersion: 2,
+      contentHash: 'snapshot-hash',
+      createdBy: 'test',
+    },
+  );
+}
+
+function intelligenceFixture(snapshot: SemanticSnapshotV1): SemanticIntelligenceV1 {
+  const finding: IntelligenceFindingV1 = {
+    id: 'finding-pacing-001',
+    category: 'timing',
+    severity: 'notice',
+    title: 'Opening pause is measurable',
+    description: 'The first clip has an 8 second duration and can support a pacing recommendation.',
+    evidenceIds: ['clip-001'],
+    evidenceKind: 'clip',
+    location: {
+      evidenceId: 'clip-001',
+      startUs: 0,
+      durationUs: 8_000_000,
+    },
+  };
+
+  return createSemanticIntelligenceV1([finding], [], {
+    projectId: snapshot.metadata.projectId,
+    snapshotRevision: snapshot.metadata.revision,
+    createdBy: 'test',
+    contentHash: 'intelligence-hash',
+  });
+}
+
+function requestFixture(overrides: Partial<CreativeBriefRequestV1> = {}): CreativeBriefRequestV1 {
+  return {
+    projectId: PROJECT_ID,
+    snapshotRevision: 7,
+    intelligenceRevision: 1,
+    goal: 'Make the intro feel tighter while preserving the Persian caption tone.',
+    scope: {
+      domains: ['timeline', 'captions'],
+      boundedRangeUs: { startUs: 0, durationUs: 8_000_000 },
+    },
+    focusAreas: ['pacing', 'captions'],
+    constraints: [{ id: 'constraint-voice', text: 'Keep the speaker voice natural.' }],
+    referenceMaterials: [{ id: 'ref-tone', label: 'Tone note', excerpt: 'Warm, concise, direct.' }],
+    requestId: 'brief-request-001',
+    createdAt: '2026-08-21T00:00:00.000Z',
+    ...overrides,
+  };
+}
+
+describe('createCreativeBrief', () => {
+  it('creates a valid brief with S2 facts separated from model inferences', async () => {
+    const snapshot = snapshotFixture();
+    const intelligence = intelligenceFixture(snapshot);
+    const request = requestFixture();
+
+    const brief = await createCreativeBrief({
+      snapshot,
+      intelligence,
+      request,
+      modelAdapter: createFakeModelAdapter({ mode: 'valid' }),
+    });
+
+    expect(brief.requestId).toBe(request.requestId);
+    expect(brief.snapshotRevision).toBe(snapshot.metadata.revision);
+    expect(brief.intelligenceRevision).toBe(intelligence.metadata.revision);
+    expect(brief.factualFindings).toHaveLength(1);
+    expect(brief.factualFindings[0]).toMatchObject({
+      source: 's2',
+      findingId: 'finding-pacing-001',
+      title: 'Opening pause is measurable',
+    });
+    expect(brief.modelInferences[0]?.source).toBe('model');
+    expect(brief.modelInferences[0]?.evidenceReferences).toEqual(['clip-001']);
+
+    for (const recommendation of brief.recommendations) {
+      expect(recommendation.evidenceReferences.length).toBeGreaterThan(0);
+      expect(recommendation.evidenceReferences.every((id) => snapshot.evidenceIndex.has(id))).toBe(
+        true,
+      );
+      expect(recommendation.boundedRangeUs.startUs).toBeGreaterThanOrEqual(0);
+      expect(recommendation.boundedRangeUs.durationUs).toBeGreaterThan(0);
+    }
+  });
+
+  it('rejects a missing or mismatched snapshot revision before calling the model', async () => {
+    const snapshot = snapshotFixture();
+    const intelligence = intelligenceFixture(snapshot);
+    const calls: string[] = [];
+
+    await expect(
+      createCreativeBrief({
+        snapshot,
+        intelligence,
+        request: requestFixture({ snapshotRevision: 99 }),
+        modelAdapter: {
+          async createBrief() {
+            calls.push('called');
+            throw new Error('should not be called');
+          },
+        },
+      }),
+    ).rejects.toThrow(/snapshot revision/i);
+
+    expect(calls).toEqual([]);
+  });
+
+  it('rejects unresolved evidence in S2 input and model recommendations', async () => {
+    const snapshot = snapshotFixture();
+    const intelligenceWithUnknownEvidence = createSemanticIntelligenceV1(
+      [
+        {
+          id: 'finding-unknown-evidence',
+          category: 'quality',
+          severity: 'warning',
+          title: 'Unknown evidence',
+          description: 'This finding points outside the S1 snapshot.',
+          evidenceIds: ['missing-evidence'],
+        },
+      ],
+      [],
+      {
+        projectId: PROJECT_ID,
+        snapshotRevision: snapshot.metadata.revision,
+        createdBy: 'test',
+        contentHash: 'unknown-evidence-hash',
+      },
+    );
+
+    await expect(
+      createCreativeBrief({
+        snapshot,
+        intelligence: intelligenceWithUnknownEvidence,
+        request: requestFixture(),
+        modelAdapter: createFakeModelAdapter({ mode: 'valid' }),
+      }),
+    ).rejects.toThrow(/unknown evidence/i);
+
+    await expect(
+      createCreativeBrief({
+        snapshot,
+        intelligence: intelligenceFixture(snapshot),
+        request: requestFixture(),
+        modelAdapter: createFakeModelAdapter({ mode: 'unsafe' }),
+      }),
+    ).rejects.toThrow(/evidence|url|secret|path|command/i);
+  });
+
+  it('rejects malformed and oversized model output', async () => {
+    const snapshot = snapshotFixture();
+    const intelligence = intelligenceFixture(snapshot);
+    const request = requestFixture();
+
+    await expect(
+      createCreativeBrief({
+        snapshot,
+        intelligence,
+        request,
+        modelAdapter: createFakeModelAdapter({ mode: 'malformed' }),
+      }),
+    ).rejects.toThrow(/model output/i);
+
+    await expect(
+      createCreativeBrief({
+        snapshot,
+        intelligence,
+        request,
+        modelAdapter: createFakeModelAdapter({ mode: 'excessive' }),
+      }),
+    ).rejects.toThrow(/maximum|too large|too long/i);
+  });
+
+  it('rejects request command surfaces and preserves inputs without mutation', async () => {
+    const snapshot = snapshotFixture();
+    const intelligence = intelligenceFixture(snapshot);
+    const snapshotEvidenceBefore = [...snapshot.evidenceIds];
+    const findingIdsBefore = [...intelligence.findingIds];
+    const request = {
+      ...requestFixture(),
+      commands: [{ type: 'deleteClip', id: 'clip-001' }],
+    } as unknown;
+
+    await expect(
+      createCreativeBrief({
+        snapshot,
+        intelligence,
+        request,
+        modelAdapter: createFakeModelAdapter({ mode: 'valid' }),
+      }),
+    ).rejects.toThrow(/command|unknown field/i);
+
+    expect(snapshot.evidenceIds).toEqual(snapshotEvidenceBefore);
+    expect(intelligence.findingIds).toEqual(findingIdsBefore);
+    expect(snapshot.evidenceIndex.has('clip-001')).toBe(true);
+  });
+
+  it('preserves Persian and RTL text byte-for-byte through the valid fake adapter', async () => {
+    const snapshot = snapshotFixture();
+    const intelligence = intelligenceFixture(snapshot);
+    const persianGoal = 'ریتم شروع را بهتر کن، اما لحن فارسی را تغییر نده.';
+    const persianConstraint = 'هیچ ترجمه یا نرمال‌سازی روی متن فارسی انجام نشود.';
+
+    const brief = await createCreativeBrief({
+      snapshot,
+      intelligence,
+      request: requestFixture({
+        goal: persianGoal,
+        constraints: [{ id: 'constraint-fa', text: persianConstraint }],
+        referenceMaterials: [{ id: 'ref-fa', label: 'یادداشت لحن', excerpt: persianConstraint }],
+      }),
+      modelAdapter: createFakeModelAdapter({ mode: 'valid' }),
+    });
+
+    expect(brief.interpretedGoal).toBe(persianGoal);
+    expect(brief.assumptions.some((assumption) => assumption.text === persianConstraint)).toBe(
+      true,
+    );
+    expect(
+      brief.recommendations.some((recommendation) =>
+        recommendation.rationale.includes(persianGoal),
+      ),
+    ).toBe(true);
+  });
+
+  it('rejects model output that mislabels facts or leaks command/project mutation fields', async () => {
+    const snapshot = snapshotFixture();
+    const intelligence = intelligenceFixture(snapshot);
+
+    const invalidBrief: CreativeBriefV1 = {
+      snapshotRevision: snapshot.metadata.revision,
+      intelligenceRevision: intelligence.metadata.revision,
+      requestId: 'brief-request-001',
+      interpretedGoal: 'Goal',
+      factualFindings: [
+        {
+          source: 's2',
+          findingId: 'finding-pacing-001',
+          title: 'Model changed the deterministic title',
+          description: 'The description no longer matches S2.',
+          evidenceReferences: ['clip-001'],
+          category: 'timing',
+          severity: 'notice',
+        },
+      ],
+      modelInferences: [],
+      assumptions: [],
+      recommendations: [
+        {
+          id: '11111111-1111-4111-8111-111111111111',
+          kind: 'pacing-adjustment',
+          confidence: 'medium',
+          evidenceReferences: ['clip-001'],
+          boundedRangeUs: { startUs: 0, durationUs: 1_000_000 },
+          rationale: 'Tighten the intro.',
+          expectedBenefit: 'Cleaner opening.',
+          riskClassification: 'low',
+          proposedIntent: {
+            label: 'Read-only intent',
+            summary: 'This is not executable.',
+            commands: [{ type: 'trim' }],
+          } as unknown as ProposedIntentV1,
+        },
+      ],
+      blockers: [],
+      humanDecisions: [],
+      confidenceSummary: {
+        overall: 'medium',
+        rationale: 'Enough S1 evidence for a directional brief.',
+      },
+      generatedAt: '2026-08-21T00:00:00.000Z',
+    };
+
+    expect(validateCreativeBriefV1(invalidBrief, { snapshot, intelligence }).valid).toBe(false);
+  });
+});
diff --git a/packages/agent-tools/src/creative-brief.ts b/packages/agent-tools/src/creative-brief.ts
new file mode 100644
index 0000000..84b9581
--- /dev/null
+++ b/packages/agent-tools/src/creative-brief.ts
@@ -0,0 +1,1030 @@
+import {
+  hasEvidence,
+  isSemanticIntelligenceV1,
+  isSemanticSnapshotV1,
+  validateSemanticIntelligenceV1,
+  validateSemanticSnapshotV1,
+  type EvidenceId,
+  type FindingCategoryV1,
+  type FindingSeverityV1,
+  type SemanticIntelligenceV1,
+  type SemanticSnapshotV1,
+} from '@joy-media/project-schema';
+import type { CreativeModelAdapter } from './model-adapter.js';
+
+const MAX_ID_LENGTH = 256;
+const MAX_GOAL_LENGTH = 1000;
+const MAX_TEXT_LENGTH = 2000;
+const MAX_SHORT_TEXT_LENGTH = 500;
+const MAX_FOCUS_AREAS = 10;
+const MAX_CONSTRAINTS = 20;
+const MAX_REFERENCE_MATERIALS = 5;
+const MAX_BRIEF_ITEMS = 20;
+const MAX_EVIDENCE_REFERENCES = 10;
+const MAX_TIME_US = 24 * 60 * 60 * 1_000_000;
+
+export type CreativeBriefDomainV1 =
+  'timeline' | 'assets' | 'captions' | 'audio' | 'composition' | 'workflow' | 'export' | 'metadata';
+
+export type CreativeFocusAreaV1 =
+  | 'pacing'
+  | 'captions'
+  | 'audio'
+  | 'visuals'
+  | 'color'
+  | 'composition'
+  | 'accessibility'
+  | 'export'
+  | 'style'
+  | 'content';
+
+export type ConfidenceLevelV1 = 'low' | 'medium' | 'high';
+export type RiskClassificationV1 = 'none' | 'low' | 'medium' | 'high';
+
+export type CreativeRecommendationKindV1 =
+  | 'pacing-adjustment'
+  | 'caption-improvement'
+  | 'audio-enhancement'
+  | 'visual-refinement'
+  | 'color-correction'
+  | 'composition-improvement'
+  | 'content-addition'
+  | 'content-removal'
+  | 'style-suggestion'
+  | 'accessibility-improvement'
+  | 'export-optimization';
+
+export interface CreativeTimeRangeV1 {
+  readonly startUs: number;
+  readonly durationUs: number;
+}
+
+export interface CreativeBriefScopeV1 {
+  readonly domains: readonly CreativeBriefDomainV1[];
+  readonly boundedRangeUs?: CreativeTimeRangeV1;
+}
+
+export interface CreativeConstraintV1 {
+  readonly id: string;
+  readonly text: string;
+}
+
+export interface ReferenceMaterialV1 {
+  readonly id: string;
+  readonly label: string;
+  readonly excerpt: string;
+}
+
+export interface CreativeBriefRequestV1 {
+  readonly projectId: string;
+  readonly snapshotRevision: number;
+  readonly intelligenceRevision: number;
+  readonly goal: string;
+  readonly scope: CreativeBriefScopeV1;
+  readonly focusAreas: readonly CreativeFocusAreaV1[];
+  readonly constraints: readonly CreativeConstraintV1[];
+  readonly referenceMaterials: readonly ReferenceMaterialV1[];
+  readonly requestId: string;
+  readonly createdAt: string;
+}
+
+export interface CreativeFactV1 {
+  readonly source: 's2';
+  readonly findingId: string;
+  readonly title: string;
+  readonly description: string;
+  readonly evidenceReferences: readonly EvidenceId[];
+  readonly category: FindingCategoryV1;
+  readonly severity: FindingSeverityV1;
+}
+
+export interface CreativeInferenceV1 {
+  readonly id: string;
+  readonly source: 'model';
+  readonly inference: string;
+  readonly evidenceReferences: readonly EvidenceId[];
+  readonly confidence: ConfidenceLevelV1;
+}
+
+export interface CreativeAssumptionV1 {
+  readonly id: string;
+  readonly text: string;
+  readonly evidenceReferences: readonly EvidenceId[];
+}
+
+export interface ProposedIntentV1 {
+  readonly label: string;
+  readonly summary: string;
+  readonly boundedRangeUs?: CreativeTimeRangeV1;
+}
+
+export interface CreativeRecommendationV1 {
+  readonly id: string;
+  readonly kind: CreativeRecommendationKindV1;
+  readonly confidence: ConfidenceLevelV1;
+  readonly evidenceReferences: readonly EvidenceId[];
+  readonly boundedRangeUs: CreativeTimeRangeV1;
+  readonly rationale: string;
+  readonly expectedBenefit: string;
+  readonly riskClassification: RiskClassificationV1;
+  readonly proposedIntent?: ProposedIntentV1;
+}
+
+export interface CreativeBlockerV1 {
+  readonly id: string;
+  readonly reason: string;
+  readonly evidenceReferences: readonly EvidenceId[];
+}
+
+export interface HumanDecisionV1 {
+  readonly id: string;
+  readonly question: string;
+  readonly options: readonly string[];
+  readonly evidenceReferences: readonly EvidenceId[];
+}
+
+export interface ConfidenceSummaryV1 {
+  readonly overall: ConfidenceLevelV1;
+  readonly rationale: string;
+}
+
+export interface CreativeBriefV1 {
+  readonly snapshotRevision: number;
+  readonly intelligenceRevision: number;
+  readonly requestId: string;
+  readonly interpretedGoal: string;
+  readonly factualFindings: readonly CreativeFactV1[];
+  readonly modelInferences: readonly CreativeInferenceV1[];
+  readonly assumptions: readonly CreativeAssumptionV1[];
+  readonly recommendations: readonly CreativeRecommendationV1[];
+  readonly blockers: readonly CreativeBlockerV1[];
+  readonly humanDecisions: readonly HumanDecisionV1[];
+  readonly confidenceSummary: ConfidenceSummaryV1;
+  readonly generatedAt: string;
+}
+
+export interface CreativeBriefValidationResultV1 {
+  readonly valid: boolean;
+  readonly errors: readonly string[];
+  readonly warnings: readonly string[];
+}
+
+export interface CreativeBriefValidationContextV1 {
+  readonly snapshot: SemanticSnapshotV1;
+  readonly intelligence: SemanticIntelligenceV1;
+}
+
+export interface CreateCreativeBriefOptionsV1 {
+  readonly snapshot: unknown;
+  readonly intelligence: unknown;
+  readonly request: unknown;
+  readonly modelAdapter: CreativeModelAdapter;
+}
+
+export class CreativeBriefValidationError extends Error {
+  constructor(
+    message: string,
+    readonly errors: readonly string[],
+  ) {
+    super(`${message}: ${errors.join('; ')}`);
+    this.name = 'CreativeBriefValidationError';
+  }
+}
+
+const DOMAINS: readonly CreativeBriefDomainV1[] = [
+  'timeline',
+  'assets',
+  'captions',
+  'audio',
+  'composition',
+  'workflow',
+  'export',
+  'metadata',
+];
+
+const FOCUS_AREAS: readonly CreativeFocusAreaV1[] = [
+  'pacing',
+  'captions',
+  'audio',
+  'visuals',
+  'color',
+  'composition',
+  'accessibility',
+  'export',
+  'style',
+  'content',
+];
+
+const CONFIDENCE_LEVELS: readonly ConfidenceLevelV1[] = ['low', 'medium', 'high'];
+const RISK_CLASSIFICATIONS: readonly RiskClassificationV1[] = ['none', 'low', 'medium', 'high'];
+
+const RECOMMENDATION_KINDS: readonly CreativeRecommendationKindV1[] = [
+  'pacing-adjustment',
+  'caption-improvement',
+  'audio-enhancement',
+  'visual-refinement',
+  'color-correction',
+  'composition-improvement',
+  'content-addition',
+  'content-removal',
+  'style-suggestion',
+  'accessibility-improvement',
+  'export-optimization',
+];
+
+const REQUEST_KEYS = [
+  'projectId',
+  'snapshotRevision',
+  'intelligenceRevision',
+  'goal',
+  'scope',
+  'focusAreas',
+  'constraints',
+  'referenceMaterials',
+  'requestId',
+  'createdAt',
+] as const;
+
+const BRIEF_KEYS = [
+  'snapshotRevision',
+  'intelligenceRevision',
+  'requestId',
+  'interpretedGoal',
+  'factualFindings',
+  'modelInferences',
+  'assumptions',
+  'recommendations',
+  'blockers',
+  'humanDecisions',
+  'confidenceSummary',
+  'generatedAt',
+] as const;
+
+const DANGEROUS_KEYS = new Set([
+  'command',
+  'commands',
+  'tool',
+  'tools',
+  'agent',
+  'agents',
+  'project',
+  'projectmutation',
+  'projectpatch',
+  'patch',
+  'operation',
+  'operations',
+  'editplan',
+  'dryrun',
+  'approval',
+  'job',
+  'jobs',
+  'execute',
+  'executor',
+  'mutation',
+  'save',
+  'write',
+]);
+
+function isRecord(value: unknown): value is Record<string, unknown> {
+  return typeof value === 'object' && value !== null && !Array.isArray(value);
+}
+
+function isNonEmptyString(value: unknown, max = MAX_TEXT_LENGTH): value is string {
+  return typeof value === 'string' && value.length > 0 && value.length <= max;
+}
+
+function isNonNegativeInteger(value: unknown): value is number {
+  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
+}
+
+function isUuidV4(value: unknown): value is string {
+  return (
+    typeof value === 'string' &&
+    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
+  );
+}
+
+function addUnknownKeyErrors(
+  errors: string[],
+  value: Record<string, unknown>,
+  allowedKeys: readonly string[],
+  path: string,
+): void {
+  for (const key of Object.keys(value)) {
+    if (!allowedKeys.includes(key)) {
+      errors.push(`${path} contains unknown field ${key}`);
+    }
+  }
+}
+
+function addEnumError<T extends string>(
+  errors: string[],
+  value: unknown,
+  allowed: readonly T[],
+  path: string,
+): void {
+  if (typeof value !== 'string' || !allowed.includes(value as T)) {
+    errors.push(`${path} must be one of: ${allowed.join(', ')}`);
+  }
+}
+
+function addStringError(
+  errors: string[],
+  value: unknown,
+  path: string,
+  max = MAX_TEXT_LENGTH,
+): void {
+  if (!isNonEmptyString(value, max)) {
+    errors.push(`${path} must be a non-empty string with maximum length ${max}`);
+  }
+}
+
+function addArrayError<T>(
+  errors: string[],
+  value: unknown,
+  path: string,
+  max: number,
+  validateItem: (item: unknown, index: number) => void,
+): void {
+  if (!Array.isArray(value)) {
+    errors.push(`${path} must be an array`);
+    return;
+  }
+
+  if (value.length > max) {
+    errors.push(`${path} exceeds maximum length ${max}`);
+  }
+
+  value.forEach((item, index) => validateItem(item as T, index));
+}
+
+function addTimeRangeErrors(
+  errors: string[],
+  value: unknown,
+  path: string,
+  requirePositiveDuration: boolean,
+): void {
+  if (!isRecord(value)) {
+    errors.push(`${path} must be a bounded range object`);
+    return;
+  }
+
+  addUnknownKeyErrors(errors, value, ['startUs', 'durationUs'], path);
+  if (!isNonNegativeInteger(value.startUs) || value.startUs > MAX_TIME_US) {
+    errors.push(`${path}.startUs must be a non-negative integer within 24 hours`);
+  }
+
+  const durationValid =
+    isNonNegativeInteger(value.durationUs) &&
+    value.durationUs <= MAX_TIME_US &&
+    (!requirePositiveDuration || value.durationUs > 0);
+  if (!durationValid) {
+    errors.push(`${path}.durationUs must be a bounded positive duration`);
+  }
+}
+
+function addSecurityErrors(errors: string[], value: unknown, path: string): void {
+  if (typeof value === 'string') {
+    const checks: readonly [RegExp, string][] = [
+      [/\bhttps?:\/\//i, 'URL'],
+      [/\bfile:\/\//i, 'file URL'],
+      [/\bs3:\/\//i, 'object-store URL'],
+      [/\b[A-Za-z]:\\/i, 'private path'],
+      [/^\/(?:tmp|Users|home|var|etc)\b/i, 'private path'],
+      [/\b(?:api[_-]?key|secret|token|password)\s*[:=]/i, 'credential'],
+      [/\bsk-[A-Za-z0-9_-]{12,}\b/, 'credential'],
+      [
+        /\b(?:system prompt|developer message|prompt leakage|hidden instructions)\b/i,
+        'prompt leakage',
+      ],
+    ];
+
+    for (const [pattern, label] of checks) {
+      if (pattern.test(value)) {
+        errors.push(`${path} contains unsafe ${label}`);
+      }
+    }
+    return;
+  }
+
+  if (Array.isArray(value)) {
+    value.forEach((item, index) => addSecurityErrors(errors, item, `${path}[${index}]`));
+    return;
+  }
+
+  if (!isRecord(value)) {
+    return;
+  }
+
+  for (const [key, child] of Object.entries(value)) {
+    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
+    if (DANGEROUS_KEYS.has(normalized) || normalized.includes('command')) {
+      errors.push(`${path}.${key} exposes a command or mutation surface`);
+    }
+    addSecurityErrors(errors, child, `${path}.${key}`);
+  }
+}
+
+function addEvidenceReferenceErrors(
+  errors: string[],
+  value: unknown,
+  path: string,
+  snapshot: SemanticSnapshotV1,
+  options: { readonly requireNonEmpty: boolean },
+): void {
+  if (!Array.isArray(value)) {
+    errors.push(`${path} must be an array`);
+    return;
+  }
+
+  if (options.requireNonEmpty && value.length === 0) {
+    errors.push(`${path} must cite at least one S1 evidence id`);
+  }
+
+  if (value.length > MAX_EVIDENCE_REFERENCES) {
+    errors.push(`${path} exceeds maximum length ${MAX_EVIDENCE_REFERENCES}`);
+  }
+
+  for (const evidenceId of value) {
+    if (!isNonEmptyString(evidenceId, MAX_ID_LENGTH)) {
+      errors.push(`${path} entries must be non-empty evidence ids`);
+      continue;
+    }
+    if (!hasEvidence(snapshot, evidenceId)) {
+      errors.push(`${path} references unknown evidence id ${evidenceId}`);
+    }
+  }
+}
+
+function validateRequest(request: unknown): CreativeBriefValidationResultV1 {
+  const errors: string[] = [];
+
+  if (!isRecord(request)) {
+    return { valid: false, errors: ['Request must be an object'], warnings: [] };
+  }
+
+  addUnknownKeyErrors(errors, request, REQUEST_KEYS, 'request');
+  addStringError(errors, request.projectId, 'request.projectId', MAX_ID_LENGTH);
+  if (!isNonNegativeInteger(request.snapshotRevision)) {
+    errors.push('request.snapshotRevision must be a non-negative integer');
+  }
+  if (!isNonNegativeInteger(request.intelligenceRevision)) {
+    errors.push('request.intelligenceRevision must be a non-negative integer');
+  }
+  addStringError(errors, request.goal, 'request.goal', MAX_GOAL_LENGTH);
+  addStringError(errors, request.requestId, 'request.requestId', MAX_ID_LENGTH);
+  addStringError(errors, request.createdAt, 'request.createdAt', MAX_SHORT_TEXT_LENGTH);
+
+  if (!isRecord(request.scope)) {
+    errors.push('request.scope must be an object');
+  } else {
+    addUnknownKeyErrors(errors, request.scope, ['domains', 'boundedRangeUs'], 'request.scope');
+    addArrayError(
+      errors,
+      request.scope.domains,
+      'request.scope.domains',
+      DOMAINS.length,
+      (domain, index) => addEnumError(errors, domain, DOMAINS, `request.scope.domains[${index}]`),
+    );
+    if (request.scope.boundedRangeUs !== undefined) {
+      addTimeRangeErrors(
+        errors,
+        request.scope.boundedRangeUs,
+        'request.scope.boundedRangeUs',
+        false,
+      );
+    }
+  }
+
+  addArrayError(
+    errors,
+    request.focusAreas,
+    'request.focusAreas',
+    MAX_FOCUS_AREAS,
+    (focusArea, index) =>
+      addEnumError(errors, focusArea, FOCUS_AREAS, `request.focusAreas[${index}]`),
+  );
+
+  addArrayError(
+    errors,
+    request.constraints,
+    'request.constraints',
+    MAX_CONSTRAINTS,
+    (constraint, index) => {
+      const path = `request.constraints[${index}]`;
+      if (!isRecord(constraint)) {
+        errors.push(`${path} must be an object`);
+        return;
+      }
+      addUnknownKeyErrors(errors, constraint, ['id', 'text'], path);
+      addStringError(errors, constraint.id, `${path}.id`, MAX_ID_LENGTH);
+      addStringError(errors, constraint.text, `${path}.text`, MAX_TEXT_LENGTH);
+    },
+  );
+
+  addArrayError(
+    errors,
+    request.referenceMaterials,
+    'request.referenceMaterials',
+    MAX_REFERENCE_MATERIALS,
+    (material, index) => {
+      const path = `request.referenceMaterials[${index}]`;
+      if (!isRecord(material)) {
+        errors.push(`${path} must be an object`);
+        return;
+      }
+      addUnknownKeyErrors(errors, material, ['id', 'label', 'excerpt'], path);
+      addStringError(errors, material.id, `${path}.id`, MAX_ID_LENGTH);
+      addStringError(errors, material.label, `${path}.label`, MAX_SHORT_TEXT_LENGTH);
+      addStringError(errors, material.excerpt, `${path}.excerpt`, MAX_TEXT_LENGTH);
+    },
+  );
+
+  addSecurityErrors(errors, request, 'request');
+
+  return { valid: errors.length === 0, errors, warnings: [] };
+}
+
+function validateSnapshotAndIntelligence(
+  snapshot: unknown,
+  intelligence: unknown,
+  request: CreativeBriefRequestV1,
+): {
+  readonly snapshot: SemanticSnapshotV1 | undefined;
+  readonly intelligence: SemanticIntelligenceV1 | undefined;
+  readonly errors: readonly string[];
+} {
+  const errors: string[] = [];
+
+  const snapshotResult = validateSemanticSnapshotV1(snapshot);
+  if (!snapshotResult.valid || !isSemanticSnapshotV1(snapshot)) {
+    errors.push(
+      ...(snapshotResult.errors.length > 0
+        ? snapshotResult.errors
+        : ['Missing or invalid snapshot']),
+    );
+  }
+
+  if (isSemanticSnapshotV1(snapshot)) {
+    if (snapshot.metadata.projectId !== request.projectId) {
+      errors.push('snapshot projectId must match request projectId');
+    }
+    if (snapshot.metadata.revision !== request.snapshotRevision) {
+      errors.push('snapshot revision must match request snapshotRevision');
+    }
+  }
+
+  const evidenceIds = isSemanticSnapshotV1(snapshot) ? snapshot.evidenceIds : undefined;
+  const intelligenceResult = validateSemanticIntelligenceV1(intelligence, evidenceIds);
+  if (!intelligenceResult.valid || !isSemanticIntelligenceV1(intelligence)) {
+    errors.push(
+      ...(intelligenceResult.errors.length > 0
+        ? intelligenceResult.errors
+        : ['Missing or invalid intelligence']),
+    );
+  }
+
+  if (intelligenceResult.warnings.length > 0) {
+    errors.push(...intelligenceResult.warnings);
+  }
+
+  if (isSemanticIntelligenceV1(intelligence)) {
+    if (intelligence.metadata.projectId !== request.projectId) {
+      errors.push('intelligence projectId must match request projectId');
+    }
+    if (intelligence.metadata.revision !== request.intelligenceRevision) {
+      errors.push('intelligence revision must match request intelligenceRevision');
+    }
+    if (intelligence.snapshotRevision !== request.snapshotRevision) {
+      errors.push('intelligence snapshotRevision must match request snapshotRevision');
+    }
+  }
+
+  if (isSemanticSnapshotV1(snapshot) && isSemanticIntelligenceV1(intelligence)) {
+    for (const finding of intelligence.findings) {
+      for (const evidenceId of finding.evidenceIds) {
+        if (!hasEvidence(snapshot, evidenceId)) {
+          errors.push(`finding ${finding.id} references unknown evidence id ${evidenceId}`);
+        }
+      }
+      if (finding.location !== undefined && !hasEvidence(snapshot, finding.location.evidenceId)) {
+        errors.push(
+          `finding ${finding.id} location references unknown evidence id ${finding.location.evidenceId}`,
+        );
+      }
+    }
+  }
+
+  return {
+    snapshot: isSemanticSnapshotV1(snapshot) ? snapshot : undefined,
+    intelligence: isSemanticIntelligenceV1(intelligence) ? intelligence : undefined,
+    errors,
+  };
+}
+
+function addFactErrors(
+  errors: string[],
+  value: unknown,
+  path: string,
+  context: CreativeBriefValidationContextV1,
+): void {
+  if (!isRecord(value)) {
+    errors.push(`${path} must be an object`);
+    return;
+  }
+
+  addUnknownKeyErrors(
+    errors,
+    value,
+    ['source', 'findingId', 'title', 'description', 'evidenceReferences', 'category', 'severity'],
+    path,
+  );
+  if (value.source !== 's2') {
+    errors.push(`${path}.source must be s2`);
+  }
+  addStringError(errors, value.findingId, `${path}.findingId`, MAX_ID_LENGTH);
+  const finding =
+    typeof value.findingId === 'string'
+      ? context.intelligence.findingIndex.get(value.findingId)
+      : undefined;
+  if (finding === undefined) {
+    errors.push(`${path}.findingId must reference an S2 finding`);
+  } else {
+    if (value.title !== finding.title) {
+      errors.push(`${path}.title must match the deterministic S2 finding title`);
+    }
+    if (value.description !== finding.description) {
+      errors.push(`${path}.description must match the deterministic S2 finding description`);
+    }
+    if (value.category !== finding.category) {
+      errors.push(`${path}.category must match the deterministic S2 finding category`);
+    }
+    if (value.severity !== finding.severity) {
+      errors.push(`${path}.severity must match the deterministic S2 finding severity`);
+    }
+    if (
+      !Array.isArray(value.evidenceReferences) ||
+      value.evidenceReferences.length !== finding.evidenceIds.length ||
+      value.evidenceReferences.some(
+        (evidenceId, index) => evidenceId !== finding.evidenceIds[index],
+      )
+    ) {
+      errors.push(`${path}.evidenceReferences must match the deterministic S2 finding evidence`);
+    }
+  }
+  addEvidenceReferenceErrors(
+    errors,
+    value.evidenceReferences,
+    `${path}.evidenceReferences`,
+    context.snapshot,
+    {
+      requireNonEmpty: true,
+    },
+  );
+}
+
+function addInferenceErrors(
+  errors: string[],
+  value: unknown,
+  path: string,
+  context: CreativeBriefValidationContextV1,
+): void {
+  if (!isRecord(value)) {
+    errors.push(`${path} must be an object`);
+    return;
+  }
+
+  addUnknownKeyErrors(
+    errors,
+    value,
+    ['id', 'source', 'inference', 'evidenceReferences', 'confidence'],
+    path,
+  );
+  if (!isUuidV4(value.id)) {
+    errors.push(`${path}.id must be a UUID v4`);
+  }
+  if (value.source !== 'model') {
+    errors.push(`${path}.source must be model`);
+  }
+  addStringError(errors, value.inference, `${path}.inference`, MAX_TEXT_LENGTH);
+  addEnumError(errors, value.confidence, CONFIDENCE_LEVELS, `${path}.confidence`);
+  addEvidenceReferenceErrors(
+    errors,
+    value.evidenceReferences,
+    `${path}.evidenceReferences`,
+    context.snapshot,
+    {
+      requireNonEmpty: true,
+    },
+  );
+}
+
+function addAssumptionErrors(
+  errors: string[],
+  value: unknown,
+  path: string,
+  context: CreativeBriefValidationContextV1,
+): void {
+  if (!isRecord(value)) {
+    errors.push(`${path} must be an object`);
+    return;
+  }
+
+  addUnknownKeyErrors(errors, value, ['id', 'text', 'evidenceReferences'], path);
+  if (!isUuidV4(value.id)) {
+    errors.push(`${path}.id must be a UUID v4`);
+  }
+  addStringError(errors, value.text, `${path}.text`, MAX_TEXT_LENGTH);
+  addEvidenceReferenceErrors(
+    errors,
+    value.evidenceReferences,
+    `${path}.evidenceReferences`,
+    context.snapshot,
+    {
+      requireNonEmpty: false,
+    },
+  );
+}
+
+function addRecommendationErrors(
+  errors: string[],
+  value: unknown,
+  path: string,
+  context: CreativeBriefValidationContextV1,
+): void {
+  if (!isRecord(value)) {
+    errors.push(`${path} must be an object`);
+    return;
+  }
+
+  addUnknownKeyErrors(
+    errors,
+    value,
+    [
+      'id',
+      'kind',
+      'confidence',
+      'evidenceReferences',
+      'boundedRangeUs',
+      'rationale',
+      'expectedBenefit',
+      'riskClassification',
+      'proposedIntent',
+    ],
+    path,
+  );
+  if (!isUuidV4(value.id)) {
+    errors.push(`${path}.id must be a UUID v4`);
+  }
+  addEnumError(errors, value.kind, RECOMMENDATION_KINDS, `${path}.kind`);
+  addEnumError(errors, value.confidence, CONFIDENCE_LEVELS, `${path}.confidence`);
+  addEnumError(
+    errors,
+    value.riskClassification,
+    RISK_CLASSIFICATIONS,
+    `${path}.riskClassification`,
+  );
+  addStringError(errors, value.rationale, `${path}.rationale`, MAX_TEXT_LENGTH);
+  addStringError(errors, value.expectedBenefit, `${path}.expectedBenefit`, MAX_SHORT_TEXT_LENGTH);
+  addEvidenceReferenceErrors(
+    errors,
+    value.evidenceReferences,
+    `${path}.evidenceReferences`,
+    context.snapshot,
+    {
+      requireNonEmpty: true,
+    },
+  );
+  addTimeRangeErrors(errors, value.boundedRangeUs, `${path}.boundedRangeUs`, true);
+
+  if (value.proposedIntent !== undefined) {
+    if (!isRecord(value.proposedIntent)) {
+      errors.push(`${path}.proposedIntent must be an object`);
+    } else {
+      addUnknownKeyErrors(
+        errors,
+        value.proposedIntent,
+        ['label', 'summary', 'boundedRangeUs'],
+        `${path}.proposedIntent`,
+      );
+      addStringError(
+        errors,
+        value.proposedIntent.label,
+        `${path}.proposedIntent.label`,
+        MAX_SHORT_TEXT_LENGTH,
+      );
+      addStringError(
+        errors,
+        value.proposedIntent.summary,
+        `${path}.proposedIntent.summary`,
+        MAX_TEXT_LENGTH,
+      );
+      if (value.proposedIntent.boundedRangeUs !== undefined) {
+        addTimeRangeErrors(
+          errors,
+          value.proposedIntent.boundedRangeUs,
+          `${path}.proposedIntent.boundedRangeUs`,
+          true,
+        );
+      }
+    }
+  }
+}
+
+function addBlockerErrors(
+  errors: string[],
+  value: unknown,
+  path: string,
+  context: CreativeBriefValidationContextV1,
+): void {
+  if (!isRecord(value)) {
+    errors.push(`${path} must be an object`);
+    return;
+  }
+
+  addUnknownKeyErrors(errors, value, ['id', 'reason', 'evidenceReferences'], path);
+  if (!isUuidV4(value.id)) {
+    errors.push(`${path}.id must be a UUID v4`);
+  }
+  addStringError(errors, value.reason, `${path}.reason`, MAX_TEXT_LENGTH);
+  addEvidenceReferenceErrors(
+    errors,
+    value.evidenceReferences,
+    `${path}.evidenceReferences`,
+    context.snapshot,
+    {
+      requireNonEmpty: false,
+    },
+  );
+}
+
+function addHumanDecisionErrors(
+  errors: string[],
+  value: unknown,
+  path: string,
+  context: CreativeBriefValidationContextV1,
+): void {
+  if (!isRecord(value)) {
+    errors.push(`${path} must be an object`);
+    return;
+  }
+
+  addUnknownKeyErrors(errors, value, ['id', 'question', 'options', 'evidenceReferences'], path);
+  if (!isUuidV4(value.id)) {
+    errors.push(`${path}.id must be a UUID v4`);
+  }
+  addStringError(errors, value.question, `${path}.question`, MAX_TEXT_LENGTH);
+  addArrayError(errors, value.options, `${path}.options`, 6, (option, index) =>
+    addStringError(errors, option, `${path}.options[${index}]`, MAX_SHORT_TEXT_LENGTH),
+  );
+  addEvidenceReferenceErrors(
+    errors,
+    value.evidenceReferences,
+    `${path}.evidenceReferences`,
+    context.snapshot,
+    {
+      requireNonEmpty: false,
+    },
+  );
+}
+
+export function validateCreativeBriefV1(
+  brief: unknown,
+  context: CreativeBriefValidationContextV1,
+): CreativeBriefValidationResultV1 {
+  const errors: string[] = [];
+
+  if (!isRecord(brief)) {
+    return { valid: false, errors: ['Model output brief must be an object'], warnings: [] };
+  }
+
+  addUnknownKeyErrors(errors, brief, BRIEF_KEYS, 'brief');
+  if (brief.snapshotRevision !== context.snapshot.metadata.revision) {
+    errors.push('brief snapshotRevision must match S1 snapshot revision');
+  }
+  if (brief.intelligenceRevision !== context.intelligence.metadata.revision) {
+    errors.push('brief intelligenceRevision must match S2 intelligence revision');
+  }
+  addStringError(errors, brief.requestId, 'brief.requestId', MAX_ID_LENGTH);
+  addStringError(errors, brief.interpretedGoal, 'brief.interpretedGoal', MAX_GOAL_LENGTH);
+  addStringError(errors, brief.generatedAt, 'brief.generatedAt', MAX_SHORT_TEXT_LENGTH);
+
+  addArrayError(
+    errors,
+    brief.factualFindings,
+    'brief.factualFindings',
+    MAX_BRIEF_ITEMS,
+    (fact, index) => addFactErrors(errors, fact, `brief.factualFindings[${index}]`, context),
+  );
+  addArrayError(
+    errors,
+    brief.modelInferences,
+    'brief.modelInferences',
+    MAX_BRIEF_ITEMS,
+    (inference, index) =>
+      addInferenceErrors(errors, inference, `brief.modelInferences[${index}]`, context),
+  );
+  addArrayError(
+    errors,
+    brief.assumptions,
+    'brief.assumptions',
+    MAX_BRIEF_ITEMS,
+    (assumption, index) =>
+      addAssumptionErrors(errors, assumption, `brief.assumptions[${index}]`, context),
+  );
+  addArrayError(
+    errors,
+    brief.recommendations,
+    'brief.recommendations',
+    MAX_BRIEF_ITEMS,
+    (recommendation, index) =>
+      addRecommendationErrors(errors, recommendation, `brief.recommendations[${index}]`, context),
+  );
+  addArrayError(errors, brief.blockers, 'brief.blockers', MAX_BRIEF_ITEMS, (blocker, index) =>
+    addBlockerErrors(errors, blocker, `brief.blockers[${index}]`, context),
+  );
+  addArrayError(
+    errors,
+    brief.humanDecisions,
+    'brief.humanDecisions',
+    MAX_BRIEF_ITEMS,
+    (decision, index) =>
+      addHumanDecisionErrors(errors, decision, `brief.humanDecisions[${index}]`, context),
+  );
+
+  if (!isRecord(brief.confidenceSummary)) {
+    errors.push('brief.confidenceSummary must be an object');
+  } else {
+    addUnknownKeyErrors(
+      errors,
+      brief.confidenceSummary,
+      ['overall', 'rationale'],
+      'brief.confidenceSummary',
+    );
+    addEnumError(
+      errors,
+      brief.confidenceSummary.overall,
+      CONFIDENCE_LEVELS,
+      'brief.confidenceSummary.overall',
+    );
+    addStringError(
+      errors,
+      brief.confidenceSummary.rationale,
+      'brief.confidenceSummary.rationale',
+      MAX_TEXT_LENGTH,
+    );
+  }
+
+  addSecurityErrors(errors, brief, 'brief');
+
+  return { valid: errors.length === 0, errors, warnings: [] };
+}
+
+export async function createCreativeBrief(
+  options: CreateCreativeBriefOptionsV1,
+): Promise<CreativeBriefV1> {
+  const requestResult = validateRequest(options.request);
+  if (!requestResult.valid) {
+    throw new CreativeBriefValidationError('Invalid creative brief request', requestResult.errors);
+  }
+
+  const request = options.request as CreativeBriefRequestV1;
+  const inputResult = validateSnapshotAndIntelligence(
+    options.snapshot,
+    options.intelligence,
+    request,
+  );
+  if (
+    inputResult.errors.length > 0 ||
+    inputResult.snapshot === undefined ||
+    inputResult.intelligence === undefined
+  ) {
+    throw new CreativeBriefValidationError(
+      'Invalid S1/S2 input for creative brief',
+      inputResult.errors,
+    );
+  }
+
+  const output = await options.modelAdapter.createBrief({
+    snapshot: inputResult.snapshot,
+    intelligence: inputResult.intelligence,
+    request,
+  });
+
+  if (!isRecord(output) || !('brief' in output)) {
+    throw new CreativeBriefValidationError('Invalid model output', [
+      'Model output must contain a brief object',
+    ]);
+  }
+
+  const briefResult = validateCreativeBriefV1(output.brief, {
+    snapshot: inputResult.snapshot,
+    intelligence: inputResult.intelligence,
+  });
+
+  if (!briefResult.valid) {
+    throw new CreativeBriefValidationError('Invalid model output', briefResult.errors);
+  }
+
+  return output.brief as CreativeBriefV1;
+}
diff --git a/packages/agent-tools/src/index.ts b/packages/agent-tools/src/index.ts
index 1a3b62c..94e4e52 100644
--- a/packages/agent-tools/src/index.ts
+++ b/packages/agent-tools/src/index.ts
@@ -211,20 +211,58 @@ export { revertAgentRun, findAgentTransactions, canRevertAgentRun } from './reve
 
 export type { AuditEntry, AuditAction } from './audit.js';
 export { AuditTrail, createAuditTrail } from './audit.js';
 
 export type { AgentMemory, AgentPreference } from './memory.js';
 export { AgentMemoryManager, createAgentMemoryManager } from './memory.js';
 
 export type { KiloCodeHostOptions } from './kilocode-host.js';
 export { KILOCODE_AGENT_HOST_ID, createKiloCodeAgentHostManifest } from './kilocode-host.js';
 
+export type {
+  CreativeBriefDomainV1,
+  CreativeFocusAreaV1,
+  ConfidenceLevelV1,
+  RiskClassificationV1,
+  CreativeRecommendationKindV1,
+  CreativeTimeRangeV1,
+  CreativeBriefScopeV1,
+  CreativeConstraintV1,
+  ReferenceMaterialV1,
+  CreativeBriefRequestV1,
+  CreativeFactV1,
+  CreativeInferenceV1,
+  CreativeAssumptionV1,
+  ProposedIntentV1,
+  CreativeRecommendationV1,
+  CreativeBlockerV1,
+  HumanDecisionV1,
+  ConfidenceSummaryV1,
+  CreativeBriefV1,
+  CreativeBriefValidationResultV1,
+  CreativeBriefValidationContextV1,
+  CreateCreativeBriefOptionsV1,
+} from './creative-brief.js';
+export {
+  CreativeBriefValidationError,
+  createCreativeBrief,
+  validateCreativeBriefV1,
+} from './creative-brief.js';
+export type {
+  BoundedModelInputV1,
+  StructuredModelOutputV1,
+  CreativeModelAdapter,
+  FakeModelAdapterMode,
+  FakeModelAdapterOptions,
+} from './model-adapter.js';
+export { createFakeModelAdapter } from './model-adapter.js';
+
 export type {
   BenchmarkIntent,
   ValidationCheck,
   BenchmarkProject,
   BenchmarkMetrics,
   BenchmarkSuiteResult,
   PolicyLeakTestResult,
   PolicyViolation,
   EvaluationReport,
 } from './benchmarks/index.js';
diff --git a/packages/agent-tools/src/model-adapter.test.ts b/packages/agent-tools/src/model-adapter.test.ts
new file mode 100644
index 0000000..81523e8
--- /dev/null
+++ b/packages/agent-tools/src/model-adapter.test.ts
@@ -0,0 +1,131 @@
+import { describe, expect, it } from 'vitest';
+import {
+  createSemanticIntelligenceV1,
+  createSemanticSnapshotV1,
+  type SemanticIntelligenceV1,
+  type SemanticSnapshotV1,
+} from '@joy-media/project-schema';
+import { createCreativeBrief, type CreativeBriefRequestV1 } from './creative-brief.js';
+import { createFakeModelAdapter } from './model-adapter.js';
+
+function snapshotFixture(): SemanticSnapshotV1 {
+  return createSemanticSnapshotV1(
+    [
+      {
+        id: 'timeline',
+        label: 'Timeline',
+        domain: 'timeline',
+        evidence: [
+          {
+            id: 'clip-001',
+            kind: 'clip',
+            label: 'Intro clip',
+            summary: 'The intro has a bounded range.',
+            sourceEntityId: 'clip-source-001',
+            sourceEntityRevision: 1,
+            startUs: 0,
+            durationUs: 5_000_000,
+          },
+        ],
+      },
+    ],
+    {
+      projectId: 'project-fake-adapter',
+      revision: 2,
+      schemaVersion: 2,
+      contentHash: 'snapshot',
+      createdBy: 'test',
+    },
+  );
+}
+
+function intelligenceFixture(snapshot: SemanticSnapshotV1): SemanticIntelligenceV1 {
+  return createSemanticIntelligenceV1(
+    [
+      {
+        id: 'finding-001',
+        category: 'timing',
+        severity: 'info',
+        title: 'Intro range exists',
+        description: 'The intro clip has a bounded five second duration.',
+        evidenceIds: ['clip-001'],
+        location: { evidenceId: 'clip-001', startUs: 0, durationUs: 5_000_000 },
+      },
+    ],
+    [],
+    {
+      projectId: snapshot.metadata.projectId,
+      snapshotRevision: snapshot.metadata.revision,
+      createdBy: 'test',
+      contentHash: 'intel',
+    },
+  );
+}
+
+function requestFixture(snapshot: SemanticSnapshotV1): CreativeBriefRequestV1 {
+  return {
+    projectId: snapshot.metadata.projectId,
+    snapshotRevision: snapshot.metadata.revision,
+    intelligenceRevision: 1,
+    goal: 'Suggest a tighter opening.',
+    scope: { domains: ['timeline'], boundedRangeUs: { startUs: 0, durationUs: 5_000_000 } },
+    focusAreas: ['pacing'],
+    constraints: [],
+    referenceMaterials: [],
+    requestId: 'request-fake-adapter',
+    createdAt: '2026-08-21T12:00:00.000Z',
+  };
+}
+
+describe('createFakeModelAdapter', () => {
+  it('valid mode is deterministic for identical bounded inputs', async () => {
+    const snapshot = snapshotFixture();
+    const intelligence = intelligenceFixture(snapshot);
+    const request = requestFixture(snapshot);
+    const adapter = createFakeModelAdapter({ mode: 'valid' });
+
+    const first = await adapter.createBrief({ snapshot, intelligence, request });
+    const second = await adapter.createBrief({ snapshot, intelligence, request });
+
+    expect(first).toEqual(second);
+    expect(first.brief.recommendations[0]?.id).toMatch(
+      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
+    );
+    expect(first.brief.recommendations[0]?.evidenceReferences).toEqual(['clip-001']);
+  });
+
+  it.each([
+    ['malformed', /model output/i],
+    ['unsafe', /evidence|url|secret|path|command/i],
+    ['excessive', /maximum|too large|too long/i],
+    ['timeout', /timeout|unavailable/i],
+  ] as const)('mode %s produces a catchable orchestration failure', async (mode, message) => {
+    const snapshot = snapshotFixture();
+    const intelligence = intelligenceFixture(snapshot);
+
+    await expect(
+      createCreativeBrief({
+        snapshot,
+        intelligence,
+        request: requestFixture(snapshot),
+        modelAdapter: createFakeModelAdapter({ mode }),
+      }),
+    ).rejects.toThrow(message);
+  });
+
+  it('empty mode returns a valid read-only brief with blockers instead of fake success', async () => {
+    const snapshot = snapshotFixture();
+    const intelligence = intelligenceFixture(snapshot);
+
+    const brief = await createCreativeBrief({
+      snapshot,
+      intelligence,
+      request: requestFixture(snapshot),
+      modelAdapter: createFakeModelAdapter({ mode: 'empty' }),
+    });
+
+    expect(brief.recommendations).toEqual([]);
+    expect(brief.blockers[0]?.reason).toMatch(/unavailable|no recommendation/i);
+    expect(brief.humanDecisions.length).toBeGreaterThan(0);
+  });
+});
diff --git a/packages/agent-tools/src/model-adapter.ts b/packages/agent-tools/src/model-adapter.ts
new file mode 100644
index 0000000..6fd1f4d
--- /dev/null
+++ b/packages/agent-tools/src/model-adapter.ts
@@ -0,0 +1,247 @@
+import type { SemanticIntelligenceV1, SemanticSnapshotV1 } from '@joy-media/project-schema';
+import type {
+  CreativeAssumptionV1,
+  CreativeBlockerV1,
+  CreativeBriefRequestV1,
+  CreativeBriefV1,
+  CreativeFactV1,
+  CreativeInferenceV1,
+  CreativeRecommendationV1,
+  CreativeTimeRangeV1,
+  HumanDecisionV1,
+} from './creative-brief.js';
+
+export interface BoundedModelInputV1 {
+  readonly snapshot: SemanticSnapshotV1;
+  readonly intelligence: SemanticIntelligenceV1;
+  readonly request: CreativeBriefRequestV1;
+}
+
+export interface StructuredModelOutputV1 {
+  readonly brief: CreativeBriefV1;
+}
+
+export interface CreativeModelAdapter {
+  createBrief(input: BoundedModelInputV1): Promise<StructuredModelOutputV1>;
+}
+
+export type FakeModelAdapterMode =
+  'valid' | 'malformed' | 'unsafe' | 'excessive' | 'empty' | 'timeout';
+
+export interface FakeModelAdapterOptions {
+  readonly mode?: FakeModelAdapterMode;
+}
+
+function hashString(input: string): string {
+  let hash = 0x811c9dc5;
+  for (let index = 0; index < input.length; index++) {
+    hash ^= input.charCodeAt(index);
+    hash = Math.imul(hash, 0x01000193);
+  }
+  return (hash >>> 0).toString(16).padStart(8, '0');
+}
+
+function deterministicUuid(seed: string): string {
+  const material = [
+    hashString(`${seed}:0`),
+    hashString(`${seed}:1`),
+    hashString(`${seed}:2`),
+    hashString(`${seed}:3`),
+  ].join('');
+  return [
+    material.slice(0, 8),
+    material.slice(8, 12),
+    `4${material.slice(13, 16)}`,
+    `8${material.slice(17, 20)}`,
+    material.slice(20, 32),
+  ].join('-');
+}
+
+function firstEvidenceId(input: BoundedModelInputV1): string {
+  const firstFindingEvidence = input.intelligence.findings[0]?.evidenceIds[0];
+  return firstFindingEvidence ?? input.snapshot.evidenceIds[0] ?? 'missing-evidence';
+}
+
+function boundedRangeForEvidence(
+  input: BoundedModelInputV1,
+  evidenceId: string,
+): CreativeTimeRangeV1 {
+  const evidence = input.snapshot.evidenceIndex.get(evidenceId);
+  return {
+    startUs: evidence?.startUs ?? input.request.scope.boundedRangeUs?.startUs ?? 0,
+    durationUs: Math.max(
+      1,
+      evidence?.durationUs ?? input.request.scope.boundedRangeUs?.durationUs ?? 1_000_000,
+    ),
+  };
+}
+
+function factsFromIntelligence(intelligence: SemanticIntelligenceV1): readonly CreativeFactV1[] {
+  return intelligence.findings.map((finding) => ({
+    source: 's2',
+    findingId: finding.id,
+    title: finding.title,
+    description: finding.description,
+    evidenceReferences: finding.evidenceIds,
+    category: finding.category,
+    severity: finding.severity,
+  }));
+}
+
+function validBrief(input: BoundedModelInputV1): CreativeBriefV1 {
+  const evidenceId = firstEvidenceId(input);
+  const range = boundedRangeForEvidence(input, evidenceId);
+  const seed = `${input.request.requestId}:${input.snapshot.metadata.revision}:${input.intelligence.metadata.revision}`;
+  const firstConstraint = input.request.constraints[0]?.text;
+
+  const inferences: readonly CreativeInferenceV1[] = [
+    {
+      id: deterministicUuid(`${seed}:inference`),
+      source: 'model',
+      inference: `The opening can likely feel tighter while preserving the requested goal: ${input.request.goal}`,
+      evidenceReferences: [evidenceId],
+      confidence: 'medium',
+    },
+  ];
+
+  const assumptions: readonly CreativeAssumptionV1[] =
+    firstConstraint === undefined
+      ? []
+      : [
+          {
+            id: deterministicUuid(`${seed}:assumption`),
+            text: firstConstraint,
+            evidenceReferences: [],
+          },
+        ];
+
+  const recommendations: readonly CreativeRecommendationV1[] = [
+    {
+      id: deterministicUuid(`${seed}:recommendation`),
+      kind: 'pacing-adjustment',
+      confidence: 'medium',
+      evidenceReferences: [evidenceId],
+      boundedRangeUs: range,
+      rationale: `Use S1 evidence ${evidenceId} to evaluate a bounded pacing adjustment for: ${input.request.goal}`,
+      expectedBenefit: 'A clearer, tighter opening without applying any edit.',
+      riskClassification: 'low',
+      proposedIntent: {
+        label: 'Review pacing only',
+        summary: 'Read-only recommendation; conversion to an edit plan is out of scope.',
+        boundedRangeUs: range,
+      },
+    },
+  ];
+
+  return {
+    snapshotRevision: input.snapshot.metadata.revision,
+    intelligenceRevision: input.intelligence.metadata.revision,
+    requestId: input.request.requestId,
+    interpretedGoal: input.request.goal,
+    factualFindings: factsFromIntelligence(input.intelligence),
+    modelInferences: inferences,
+    assumptions,
+    recommendations,
+    blockers: [],
+    humanDecisions: [],
+    confidenceSummary: {
+      overall: 'medium',
+      rationale: 'Recommendation is bounded by S1 evidence and separated from S2 facts.',
+    },
+    generatedAt: input.request.createdAt,
+  };
+}
+
+function emptyBrief(input: BoundedModelInputV1): CreativeBriefV1 {
+  const seed = `${input.request.requestId}:empty`;
+  const blockers: readonly CreativeBlockerV1[] = [
+    {
+      id: deterministicUuid(`${seed}:blocker`),
+      reason: 'Model capability unavailable; no recommendation was fabricated.',
+      evidenceReferences: [],
+    },
+  ];
+  const humanDecisions: readonly HumanDecisionV1[] = [
+    {
+      id: deterministicUuid(`${seed}:decision`),
+      question: 'Should a human creative reviewer provide direction for this goal?',
+      options: ['Request human review', 'Revise the brief goal'],
+      evidenceReferences: [],
+    },
+  ];
+
+  return {
+    snapshotRevision: input.snapshot.metadata.revision,
+    intelligenceRevision: input.intelligence.metadata.revision,
+    requestId: input.request.requestId,
+    interpretedGoal: input.request.goal,
+    factualFindings: factsFromIntelligence(input.intelligence),
+    modelInferences: [],
+    assumptions: [],
+    recommendations: [],
+    blockers,
+    humanDecisions,
+    confidenceSummary: {
+      overall: 'low',
+      rationale: 'No model recommendation was produced.',
+    },
+    generatedAt: input.request.createdAt,
+  };
+}
+
+export function createFakeModelAdapter(
+  options: FakeModelAdapterOptions = {},
+): CreativeModelAdapter {
+  const mode = options.mode ?? 'valid';
+
+  return {
+    async createBrief(input) {
+      if (mode === 'timeout') {
+        throw new Error('Fake model unavailable: timeout');
+      }
+
+      if (mode === 'malformed') {
+        return {
+          brief: { requestId: input.request.requestId },
+        } as unknown as StructuredModelOutputV1;
+      }
+
+      if (mode === 'empty') {
+        return { brief: emptyBrief(input) };
+      }
+
+      const brief = validBrief(input);
+
+      if (mode === 'unsafe') {
+        return {
+          brief: {
+            ...brief,
+            recommendations: [
+              {
+                ...brief.recommendations[0],
+                evidenceReferences: ['missing-evidence'],
+                rationale: 'Unsafe output includes file://private/path and api_key=secret.',
+              },
+            ],
+          } as CreativeBriefV1,
+        };
+      }
+
+      if (mode === 'excessive') {
+        return {
+          brief: {
+            ...brief,
+            recommendations: [
+              {
+                ...brief.recommendations[0],
+                rationale: 'x'.repeat(2_001),
+              },
+            ],
+          } as CreativeBriefV1,
+        };
+      }
+
+      return { brief };
+    },
+  };
+}
