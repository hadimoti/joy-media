# Review package: 56a6577..ed0b6be

## Commits
ed0b6be fix(schema): validate semantic asset evidence subtypes

## Files changed
 .../project-schema/src/semantic-snapshot.test.ts   | 316 +++++++++++++--------
 packages/project-schema/src/semantic-snapshot.ts   |  95 ++++++-
 2 files changed, 279 insertions(+), 132 deletions(-)

## Diff
diff --git a/packages/project-schema/src/semantic-snapshot.test.ts b/packages/project-schema/src/semantic-snapshot.test.ts
index c3f62a9..961c44b 100644
--- a/packages/project-schema/src/semantic-snapshot.test.ts
+++ b/packages/project-schema/src/semantic-snapshot.test.ts
@@ -1,21 +1,17 @@
 /**
  * S1: Semantic Snapshot Tests
- * 
+ *
  * Tests for semantic-snapshot.ts types and validation
  */
 
-import {
-  describe,
-  expect,
-  it,
-} from 'vitest';
+import { describe, expect, it } from 'vitest';
 
 import {
   createSemanticSnapshotV1,
   EVIDENCE_KINDS_V1,
   getEvidence,
   getEvidenceByKind,
   hasEvidence,
   isSemanticSnapshotV1,
   isSnapshotEvidenceV1,
   type AudioRegionEvidenceV1,
@@ -184,154 +180,226 @@ describe('validateSnapshotEvidence', () => {
     const errors = validateSnapshotEvidence('not an object');
     expect(errors).toContain('Evidence must be an object');
   });
 
   it('should reject evidence with empty id', () => {
     const evidence: SnapshotEvidenceV1 = {
       ...validClipEvidence,
       id: '',
     };
     const errors = validateSnapshotEvidence(evidence);
-    expect(errors.some(e => e.includes('id'))).toBe(true);
+    expect(errors.some((e) => e.includes('id'))).toBe(true);
   });
 
   it('should reject evidence with invalid kind', () => {
     const evidence: SnapshotEvidenceV1 = {
       ...validClipEvidence,
       kind: 'invalid-kind' as any,
     };
     const errors = validateSnapshotEvidence(evidence);
-    expect(errors.some(e => e.includes('kind'))).toBe(true);
+    expect(errors.some((e) => e.includes('kind'))).toBe(true);
   });
 
   it('should reject evidence with empty label', () => {
     const evidence: SnapshotEvidenceV1 = {
       ...validClipEvidence,
       label: '',
     };
     const errors = validateSnapshotEvidence(evidence);
-    expect(errors.some(e => e.includes('label'))).toBe(true);
+    expect(errors.some((e) => e.includes('label'))).toBe(true);
   });
 
   it('should reject evidence with empty sourceEntityId', () => {
     const evidence: SnapshotEvidenceV1 = {
       ...validClipEvidence,
       sourceEntityId: '',
     };
     const errors = validateSnapshotEvidence(evidence);
-    expect(errors.some(e => e.includes('sourceEntityId'))).toBe(true);
+    expect(errors.some((e) => e.includes('sourceEntityId'))).toBe(true);
   });
 
   it('should reject evidence with negative sourceEntityRevision', () => {
     const evidence: SnapshotEvidenceV1 = {
       ...validClipEvidence,
       sourceEntityRevision: -1,
     };
     const errors = validateSnapshotEvidence(evidence);
-    expect(errors.some(e => e.includes('sourceEntityRevision'))).toBe(true);
+    expect(errors.some((e) => e.includes('sourceEntityRevision'))).toBe(true);
   });
 
   it('should accept all valid evidence kinds', () => {
     for (const kind of EVIDENCE_KINDS_V1) {
-      const evidence: SnapshotEvidenceV1 = {
-        id: `test-${kind}`,
-        kind,
-        label: `Test ${kind}`,
-        sourceEntityId: 'entity-1',
-        sourceEntityRevision: 1,
-      };
+      const evidence = validEvidenceForKind(kind);
       const errors = validateSnapshotEvidence(evidence);
       expect(errors).toEqual([]);
     }
   });
+
+  it('should reject incomplete semantic asset shot evidence', () => {
+    const evidence: SnapshotEvidenceV1 = {
+      id: 'asset-shot-incomplete',
+      kind: 'asset-shot',
+      label: 'Incomplete shot',
+      sourceEntityId: 'asset-1',
+      sourceEntityRevision: 1,
+    };
+
+    const errors = validateSnapshotEvidence(evidence);
+
+    expect(errors).toContain('Asset shot evidence assetId must be a non-empty string');
+    expect(errors).toContain('Asset shot evidence startUs must be a non-negative integer');
+    expect(errors).toContain('Asset shot evidence durationUs must be a positive integer');
+  });
+
+  it('should reject incomplete semantic asset caption evidence', () => {
+    const evidence: SnapshotEvidenceV1 = {
+      id: 'asset-caption-incomplete',
+      kind: 'asset-caption',
+      label: 'Incomplete caption',
+      sourceEntityId: 'asset-1',
+      sourceEntityRevision: 1,
+    };
+
+    const errors = validateSnapshotEvidence(evidence);
+
+    expect(errors).toContain('Asset caption evidence assetId must be a non-empty string');
+    expect(errors).toContain('Asset caption evidence text must be a non-empty string');
+    expect(errors).toContain('Asset caption evidence startUs must be a non-negative integer');
+    expect(errors).toContain('Asset caption evidence durationUs must be a positive integer');
+  });
+
+  it('should reject incomplete semantic asset audio evidence', () => {
+    const evidence: SnapshotEvidenceV1 = {
+      id: 'asset-audio-incomplete',
+      kind: 'asset-audio',
+      label: 'Incomplete audio',
+      sourceEntityId: 'asset-1',
+      sourceEntityRevision: 1,
+    };
+
+    const errors = validateSnapshotEvidence(evidence);
+
+    expect(errors).toContain('Asset audio evidence assetId must be a non-empty string');
+    expect(errors).toContain(
+      'Asset audio evidence audioKind must be one of: dialogue, music, sfx, ambient, unknown',
+    );
+    expect(errors).toContain('Asset audio evidence startUs must be a non-negative integer');
+    expect(errors).toContain('Asset audio evidence durationUs must be a positive integer');
+  });
 });
 
+function validEvidenceForKind(kind: (typeof EVIDENCE_KINDS_V1)[number]): SnapshotEvidenceV1 {
+  const base: SnapshotEvidenceV1 = {
+    id: `test-${kind}`,
+    kind,
+    label: `Test ${kind}`,
+    sourceEntityId: 'entity-1',
+    sourceEntityRevision: 1,
+  };
+
+  switch (kind) {
+    case 'asset-shot':
+      return {
+        ...base,
+        assetId: 'asset-1',
+        startUs: 0,
+        durationUs: 1_000_000,
+      } as SnapshotEvidenceV1;
+    case 'asset-caption':
+      return {
+        ...base,
+        assetId: 'asset-1',
+        startUs: 0,
+        durationUs: 1_000_000,
+        text: 'Product detail caption',
+      } as SnapshotEvidenceV1;
+    case 'asset-audio':
+      return {
+        ...base,
+        assetId: 'asset-1',
+        startUs: 0,
+        durationUs: 1_000_000,
+        audioKind: 'music',
+      } as SnapshotEvidenceV1;
+    default:
+      return base;
+  }
+}
+
 // ============================================================================
 // Snapshot Creation Tests
 // ============================================================================
 
 describe('createSemanticSnapshotV1', () => {
   it('should create a valid snapshot with sections', () => {
-    const snapshot = createSemanticSnapshotV1(
-      [timelineSection, assetsSection, captionsSection],
-      {
-        projectId: 'project-001',
-        revision: 1,
-        createdBy: 'test-user',
-        schemaVersion: 1,
-        contentHash: 'abc123',
-      },
-    );
+    const snapshot = createSemanticSnapshotV1([timelineSection, assetsSection, captionsSection], {
+      projectId: 'project-001',
+      revision: 1,
+      createdBy: 'test-user',
+      schemaVersion: 1,
+      contentHash: 'abc123',
+    });
 
     expect(snapshot.schemaVersion).toBe(1);
     expect(snapshot.metadata.projectId).toBe('project-001');
     expect(snapshot.metadata.revision).toBe(1);
     expect(snapshot.metadata.createdBy).toBe('test-user');
     expect(snapshot.sections).toHaveLength(3);
     expect(snapshot.evidenceIndex.size).toBe(3);
     expect(snapshot.evidenceIds).toHaveLength(3);
   });
 
   it('should build correct evidence index', () => {
-    const snapshot = createSemanticSnapshotV1(
-      [timelineSection],
-      {
-        projectId: 'project-001',
-        revision: 1,
-        createdBy: 'test-user',
-        schemaVersion: 1,
-        contentHash: 'abc123',
-      },
-    );
+    const snapshot = createSemanticSnapshotV1([timelineSection], {
+      projectId: 'project-001',
+      revision: 1,
+      createdBy: 'test-user',
+      schemaVersion: 1,
+      contentHash: 'abc123',
+    });
 
     expect(hasEvidence(snapshot, 'clip-001')).toBe(true);
     expect(hasEvidence(snapshot, 'asset-001')).toBe(false);
     expect(getEvidence(snapshot, 'clip-001')).toEqual(validClipEvidence);
     expect(getEvidence(snapshot, 'nonexistent')).toBeUndefined();
   });
 
   it('should build correct statistics', () => {
-    const snapshot = createSemanticSnapshotV1(
-      [timelineSection, assetsSection, captionsSection],
-      {
-        projectId: 'project-001',
-        revision: 1,
-        createdBy: 'test-user',
-        schemaVersion: 1,
-        contentHash: 'abc123',
-      },
-    );
+    const snapshot = createSemanticSnapshotV1([timelineSection, assetsSection, captionsSection], {
+      projectId: 'project-001',
+      revision: 1,
+      createdBy: 'test-user',
+      schemaVersion: 1,
+      contentHash: 'abc123',
+    });
 
     expect(snapshot.statistics.totalClips).toBe(1);
     expect(snapshot.statistics.totalAssets).toBe(1);
     expect(snapshot.statistics.totalCaptionDocuments).toBe(1);
     expect(snapshot.statistics.totalDurationUs).toBe(5000000);
   });
 
   it('should handle empty sections', () => {
     const emptySection: SnapshotSectionV1 = {
       id: 'empty-section',
       label: 'Empty',
       domain: 'metadata',
       evidence: [],
     };
 
-    const snapshot = createSemanticSnapshotV1(
-      [emptySection],
-      {
-        projectId: 'project-001',
-        revision: 1,
-        createdBy: 'test-user',
-        schemaVersion: 1,
-        contentHash: 'abc123',
-      },
-    );
+    const snapshot = createSemanticSnapshotV1([emptySection], {
+      projectId: 'project-001',
+      revision: 1,
+      createdBy: 'test-user',
+      schemaVersion: 1,
+      contentHash: 'abc123',
+    });
 
     expect(snapshot.sections).toHaveLength(1);
     expect(snapshot.evidenceIndex.size).toBe(0);
     expect(snapshot.evidenceIds).toHaveLength(0);
   });
 
   it('should create a project-derived snapshot with asset, clip, caption range, and audio facts', () => {
     const snapshot = createProjectDerivedSnapshot();
 
     expect(snapshot.sections).toHaveLength(4);
@@ -347,21 +415,24 @@ describe('createSemanticSnapshotV1', () => {
     expect(snapshot.statistics.totalDurationUs).toBe(4000000);
     expect(getEvidence(snapshot, 'audio-region-001')).toMatchObject({
       kind: 'audio-region',
       peakDb: -0.2,
       loudnessLufs: -25.1,
     });
   });
 
   it('should round-trip through JSON and remain valid after rebuilding derived indexes', () => {
     const snapshot = createProjectDerivedSnapshot();
-    const parsed = JSON.parse(JSON.stringify(snapshot)) as Omit<SemanticSnapshotV1, 'evidenceIndex'> & {
+    const parsed = JSON.parse(JSON.stringify(snapshot)) as Omit<
+      SemanticSnapshotV1,
+      'evidenceIndex'
+    > & {
       evidenceIndex?: unknown;
     };
 
     const rebuilt = createSemanticSnapshotPublic(parsed.sections, {
       projectId: parsed.metadata.projectId,
       revision: parsed.metadata.revision,
       createdBy: parsed.metadata.createdBy,
       schemaVersion: parsed.metadata.schemaVersion,
       contentHash: parsed.metadata.contentHash,
     });
@@ -370,72 +441,66 @@ describe('createSemanticSnapshotV1', () => {
     expect(rebuilt.evidenceIds).toEqual(snapshot.evidenceIds);
   });
 });
 
 // ============================================================================
 // Snapshot Validation Tests
 // ============================================================================
 
 describe('validateSemanticSnapshotV1', () => {
   it('should validate a valid snapshot', () => {
-    const snapshot = createSemanticSnapshotV1(
-      [timelineSection],
-      {
-        projectId: 'project-001',
-        revision: 1,
-        createdBy: 'test-user',
-        schemaVersion: 1,
-        contentHash: 'abc123',
-      },
-    );
+    const snapshot = createSemanticSnapshotV1([timelineSection], {
+      projectId: 'project-001',
+      revision: 1,
+      createdBy: 'test-user',
+      schemaVersion: 1,
+      contentHash: 'abc123',
+    });
 
     const result = validateSemanticSnapshotV1(snapshot);
     expect(result.valid).toBe(true);
     expect(result.errors).toEqual([]);
   });
 
   it('should reject null snapshot', () => {
     const result = validateSemanticSnapshotV1(null);
     expect(result.valid).toBe(false);
     expect(result.errors).toContain('Snapshot must be an object');
   });
 
   it('should reject invalid schema version', () => {
-    const snapshot = createSemanticSnapshotV1(
-      [timelineSection],
-      {
-        projectId: 'project-001',
-        revision: 1,
-        createdBy: 'test-user',
-        schemaVersion: 1,
-        contentHash: 'abc123',
-      },
-    );
+    const snapshot = createSemanticSnapshotV1([timelineSection], {
+      projectId: 'project-001',
+      revision: 1,
+      createdBy: 'test-user',
+      schemaVersion: 1,
+      contentHash: 'abc123',
+    });
     (snapshot as any).schemaVersion = 2;
 
     const result = validateSemanticSnapshotV1(snapshot);
     expect(result.valid).toBe(false);
-    expect(result.errors.some(e => e.includes('schema version'))).toBe(true);
+    expect(result.errors.some((e) => e.includes('schema version'))).toBe(true);
   });
 
   it('should reject missing metadata', () => {
     const snapshot = {
       schemaVersion: 1,
       sections: [],
       evidenceIndex: new Map(),
       evidenceIds: [],
       // Missing metadata
     };
 
     const result = validateSemanticSnapshotV1(snapshot);
     expect(result.valid).toBe(false);
-    expect(result.errors.some(e => e.includes('metadata'))).toBe(true);
+    expect(result.errors.some((e) => e.includes('metadata'))).toBe(true);
   });
 
   it('should reject invalid sections', () => {
     const snapshot = {
       schemaVersion: 1,
       metadata: {
         id: 'snapshot-1',
         revision: 1,
         projectId: 'project-001',
         createdAt: '2024-01-01T00:00:00.000Z',
@@ -443,21 +508,21 @@ describe('validateSemanticSnapshotV1', () => {
         contentHash: 'abc123',
         createdBy: 'test-user',
       },
       sections: 'not an array',
       evidenceIndex: new Map(),
       evidenceIds: [],
     };
 
     const result = validateSemanticSnapshotV1(snapshot);
     expect(result.valid).toBe(false);
-    expect(result.errors.some(e => e.includes('Sections'))).toBe(true);
+    expect(result.errors.some((e) => e.includes('Sections'))).toBe(true);
   });
 
   it('should reject evidence with out-of-bounds temporal ranges', () => {
     const snapshot = createSemanticSnapshotV1(
       [
         {
           id: 'section-invalid-range',
           label: 'Invalid Range',
           domain: 'timeline',
           evidence: [
@@ -477,30 +542,27 @@ describe('validateSemanticSnapshotV1', () => {
         contentHash: 'abc123',
       },
     );
 
     const result = validateSemanticSnapshotV1(snapshot);
     expect(result.valid).toBe(false);
     expect(result.errors.some((error) => error.includes('durationUs'))).toBe(true);
   });
 
   it('should reject corrupted derived evidence state that does not match sections', () => {
-    const snapshot = createSemanticSnapshotV1(
-      [timelineSection, assetsSection],
-      {
-        projectId: 'project-001',
-        revision: 1,
-        createdBy: 'test-user',
-        schemaVersion: 1,
-        contentHash: 'abc123',
-      },
-    );
+    const snapshot = createSemanticSnapshotV1([timelineSection, assetsSection], {
+      projectId: 'project-001',
+      revision: 1,
+      createdBy: 'test-user',
+      schemaVersion: 1,
+      contentHash: 'abc123',
+    });
 
     const corruptedSnapshot = {
       ...snapshot,
       evidenceIndex: new Map([[validClipEvidence.id, validClipEvidence]]),
       evidenceIds: [validClipEvidence.id, 'asset-missing-from-index'],
     };
 
     const result = validateSemanticSnapshotV1(corruptedSnapshot);
     expect(result.valid).toBe(false);
     expect(result.errors.some((error) => error.includes('evidenceIndex'))).toBe(true);
@@ -529,56 +591,67 @@ describe('validateSemanticSnapshotV1', () => {
 
 // ============================================================================
 // Type Guard Tests
 // ============================================================================
 
 describe('type guards', () => {
   it('isSnapshotEvidenceV1 should identify valid evidence', () => {
     expect(isSnapshotEvidenceV1(validClipEvidence)).toBe(true);
     expect(isSnapshotEvidenceV1(null)).toBe(false);
     expect(isSnapshotEvidenceV1({})).toBe(false);
-    expect(isSnapshotEvidenceV1({ id: '', kind: 'clip', label: '', sourceEntityId: '', sourceEntityRevision: 0 })).toBe(false);
+    expect(
+      isSnapshotEvidenceV1({
+        id: '',
+        kind: 'clip',
+        label: '',
+        sourceEntityId: '',
+        sourceEntityRevision: 0,
+      }),
+    ).toBe(false);
+    expect(
+      isSnapshotEvidenceV1({
+        id: 'asset-caption-incomplete',
+        kind: 'asset-caption',
+        label: 'Incomplete caption',
+        sourceEntityId: 'asset-1',
+        sourceEntityRevision: 1,
+      }),
+    ).toBe(false);
   });
 
   it('isSemanticSnapshotV1 should identify valid snapshots', () => {
-    const snapshot = createSemanticSnapshotV1(
-      [timelineSection],
-      {
-        projectId: 'project-001',
-        revision: 1,
-        createdBy: 'test-user',
-        schemaVersion: 1,
-        contentHash: 'abc123',
-      },
-    );
+    const snapshot = createSemanticSnapshotV1([timelineSection], {
+      projectId: 'project-001',
+      revision: 1,
+      createdBy: 'test-user',
+      schemaVersion: 1,
+      contentHash: 'abc123',
+    });
 
     expect(isSemanticSnapshotV1(snapshot)).toBe(true);
     expect(isSemanticSnapshotV1(null)).toBe(false);
     expect(isSemanticSnapshotV1({})).toBe(false);
   });
 });
 
 // ============================================================================
 // Evidence Query Tests
 // ============================================================================
 
 describe('evidence queries', () => {
-  const snapshot = createSemanticSnapshotV1(
-    [timelineSection, assetsSection, captionsSection],
-    {
-      projectId: 'project-001',
-      revision: 1,
-      createdBy: 'test-user',
-      schemaVersion: 1,
-      contentHash: 'abc123',
-    },
-  );
+  const snapshot = createSemanticSnapshotV1([timelineSection, assetsSection, captionsSection], {
+    projectId: 'project-001',
+    revision: 1,
+    createdBy: 'test-user',
+    schemaVersion: 1,
+    contentHash: 'abc123',
+  });
 
   it('getEvidenceByKind should return evidence of specific kind', () => {
     const clips = getEvidenceByKind(snapshot, 'clip');
     expect(clips).toHaveLength(1);
     expect(clips[0]).toBeDefined();
     expect(clips[0]?.id).toBe('clip-001');
 
     const assets = getEvidenceByKind(snapshot, 'asset');
     expect(assets).toHaveLength(1);
     expect(assets[0]).toBeDefined();
@@ -645,30 +718,27 @@ describe('Persian/RTL preservation', () => {
           label: persianText,
           summary: rtlText,
           startUs: 0,
           durationUs: 1000000,
           sourceEntityId: 'entity-1',
           sourceEntityRevision: 1,
         },
       ],
     };
 
-    const snapshot = createSemanticSnapshotV1(
-      [persianSection],
-      {
-        projectId: 'project-001',
-        revision: 1,
-        createdBy: 'test-user',
-        schemaVersion: 1,
-        contentHash: 'abc123',
-      },
-    );
+    const snapshot = createSemanticSnapshotV1([persianSection], {
+      projectId: 'project-001',
+      revision: 1,
+      createdBy: 'test-user',
+      schemaVersion: 1,
+      contentHash: 'abc123',
+    });
 
     const evidence = getEvidence(snapshot, 'persian-clip');
     expect(evidence?.label).toBe(persianText);
     expect(evidence?.summary).toBe(rtlText);
   });
 });
 
 describe('public exports', () => {
   it('re-exports the semantic snapshot builder from the package entrypoint', () => {
     expect(createSemanticSnapshotPublic).toBe(createSemanticSnapshotV1);
diff --git a/packages/project-schema/src/semantic-snapshot.ts b/packages/project-schema/src/semantic-snapshot.ts
index 8896f4d..7a7919f 100644
--- a/packages/project-schema/src/semantic-snapshot.ts
+++ b/packages/project-schema/src/semantic-snapshot.ts
@@ -63,20 +63,28 @@ function isReadonlyArray<T>(value: unknown, guard: (v: unknown) => v is T): valu
 }
 
 function isNonNegativeInteger(value: unknown): value is number {
   return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
 }
 
 function isBoundedTimeUs(value: unknown): value is number {
   return isNonNegativeInteger(value) && value <= MAX_TIME_US;
 }
 
+function isPositiveBoundedTimeUs(value: unknown): value is number {
+  return isNonNegativeInteger(value) && value > 0 && value <= MAX_TIME_US;
+}
+
+function isFiniteNumber(value: unknown): value is number {
+  return typeof value === 'number' && Number.isFinite(value);
+}
+
 function hasSameDerivedEvidence(
   expected: SnapshotEvidenceV1,
   actual: unknown,
 ): actual is SnapshotEvidenceV1 {
   if (!isSnapshotEvidenceV1(actual)) {
     return false;
   }
 
   const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
     left.localeCompare(right),
@@ -207,23 +215,100 @@ export function validateSnapshotEvidence(value: unknown): string[] {
     !isNonEmptyString(evidence.sourceEntityId) ||
     evidence.sourceEntityId.length > MAX_ID_LENGTH
   ) {
     errors.push(`Evidence sourceEntityId must be a non-empty string <= ${MAX_ID_LENGTH} chars`);
   }
 
   if (!isNonNegativeInteger(evidence.sourceEntityRevision)) {
     errors.push('Evidence sourceEntityRevision must be a non-negative integer');
   }
 
+  errors.push(...validateSemanticAssetEvidenceSubtype(evidence));
+
   return errors;
 }
 
+function validateSemanticAssetEvidenceSubtype(evidence: Record<string, unknown>): string[] {
+  switch (evidence.kind) {
+    case 'asset-shot':
+      return validateAssetShotEvidence(evidence);
+    case 'asset-caption':
+      return validateAssetCaptionEvidence(evidence);
+    case 'asset-audio':
+      return validateAssetAudioEvidence(evidence);
+    default:
+      return [];
+  }
+}
+
+function validateAssetShotEvidence(evidence: Record<string, unknown>): string[] {
+  const errors: string[] = [];
+  validateSemanticAssetRangeFields(evidence, 'Asset shot evidence', errors);
+  if (
+    evidence.tags !== undefined &&
+    (!Array.isArray(evidence.tags) ||
+      !evidence.tags.every((tag) => isStringMaxLength(tag, MAX_LABEL_LENGTH)))
+  ) {
+    errors.push('Asset shot evidence tags must be an array of bounded strings');
+  }
+  return errors;
+}
+
+function validateAssetCaptionEvidence(evidence: Record<string, unknown>): string[] {
+  const errors: string[] = [];
+  validateSemanticAssetRangeFields(evidence, 'Asset caption evidence', errors);
+  if (!isNonEmptyString(evidence.text) || evidence.text.length > MAX_SUMMARY_LENGTH) {
+    errors.push('Asset caption evidence text must be a non-empty string');
+  }
+  if (evidence.language !== undefined && !isStringMaxLength(evidence.language, MAX_LABEL_LENGTH)) {
+    errors.push('Asset caption evidence language must be a bounded string');
+  }
+  return errors;
+}
+
+function validateAssetAudioEvidence(evidence: Record<string, unknown>): string[] {
+  const errors: string[] = [];
+  const audioKinds = ['dialogue', 'music', 'sfx', 'ambient', 'unknown'] as const;
+  validateSemanticAssetRangeFields(evidence, 'Asset audio evidence', errors);
+  if (!audioKinds.includes(evidence.audioKind as (typeof audioKinds)[number])) {
+    errors.push(
+      'Asset audio evidence audioKind must be one of: dialogue, music, sfx, ambient, unknown',
+    );
+  }
+  if (
+    evidence.transcript !== undefined &&
+    !isStringMaxLength(evidence.transcript, MAX_SUMMARY_LENGTH)
+  ) {
+    errors.push('Asset audio evidence transcript must be a bounded string');
+  }
+  if (evidence.loudnessLufs !== undefined && !isFiniteNumber(evidence.loudnessLufs)) {
+    errors.push('Asset audio evidence loudnessLufs must be a finite number');
+  }
+  return errors;
+}
+
+function validateSemanticAssetRangeFields(
+  evidence: Record<string, unknown>,
+  label: string,
+  errors: string[],
+): void {
+  if (!isNonEmptyString(evidence.assetId) || evidence.assetId.length > MAX_ID_LENGTH) {
+    errors.push(`${label} assetId must be a non-empty string`);
+  }
+  if (!isBoundedTimeUs(evidence.startUs)) {
+    errors.push(`${label} startUs must be a non-negative integer`);
+  }
+  if (!isPositiveBoundedTimeUs(evidence.durationUs)) {
+    errors.push(`${label} durationUs must be a positive integer`);
+  }
+}
+
 // ============================================================================
 // Media Evidence Subtypes
 // ============================================================================
 
 /** Evidence for video/audio/image assets */
 export interface AssetEvidenceV1 extends SnapshotEvidenceV1 {
   readonly kind: 'asset';
   readonly assetType: 'video' | 'audio' | 'image' | 'other';
   readonly fileSizeBytes: number;
   readonly mimeType: string;
@@ -766,20 +851,12 @@ export function isSemanticSnapshotV1(value: unknown): value is SemanticSnapshotV
     typeof s.metadata === 'object' &&
     s.metadata !== null &&
     Array.isArray(s.sections) &&
     s.evidenceIndex instanceof Map &&
     Array.isArray(s.evidenceIds)
   );
 }
 
 export function isSnapshotEvidenceV1(value: unknown): value is SnapshotEvidenceV1 {
   if (value === null || typeof value !== 'object') return false;
-  const ev = value as SnapshotEvidenceV1;
-  return (
-    isNonEmptyString(ev.id) &&
-    isNonEmptyString(ev.kind) &&
-    EVIDENCE_KINDS_V1.includes(ev.kind as EvidenceKindV1) &&
-    isNonEmptyString(ev.label) &&
-    isNonEmptyString(ev.sourceEntityId) &&
-    isNonNegativeInteger(ev.sourceEntityRevision)
-  );
+  return validateSnapshotEvidence(value).length === 0;
 }
