/**
 * S1: Semantic Snapshot Tests
 *
 * Tests for semantic-snapshot.ts types and validation
 */

import { describe, expect, it } from 'vitest';

import {
  createSemanticSnapshotV1,
  EVIDENCE_KINDS_V1,
  getEvidence,
  getEvidenceByKind,
  hasEvidence,
  isSemanticSnapshotV1,
  isSnapshotEvidenceV1,
  type AudioRegionEvidenceV1,
  type SemanticSnapshotV1,
  type SnapshotEvidenceV1,
  type SnapshotSectionV1,
  validateSemanticSnapshotV1,
  validateSnapshotEvidence,
} from './semantic-snapshot.js';
import { createSemanticSnapshotV1 as createSemanticSnapshotPublic } from './index.js';

// ============================================================================
// Fixtures
// ============================================================================

const validClipEvidence: SnapshotEvidenceV1 = {
  id: 'clip-001',
  kind: 'clip',
  label: 'Intro Clip',
  summary: 'The opening scene of the video',
  startUs: 0,
  durationUs: 5000000,
  sourceEntityId: 'clip_entity_1',
  sourceEntityRevision: 1,
};

const validAssetEvidence: SnapshotEvidenceV1 = {
  id: 'asset-001',
  kind: 'asset',
  label: 'Background Music',
  sourceEntityId: 'asset_entity_1',
  sourceEntityRevision: 1,
};

const validCaptionEvidence: SnapshotEvidenceV1 = {
  id: 'caption-001',
  kind: 'caption-document',
  label: 'Persian Captions',
  sourceEntityId: 'caption_entity_1',
  sourceEntityRevision: 1,
};

const timelineSection: SnapshotSectionV1 = {
  id: 'section-timeline',
  label: 'Timeline',
  domain: 'timeline',
  evidence: [validClipEvidence],
};

const assetsSection: SnapshotSectionV1 = {
  id: 'section-assets',
  label: 'Assets',
  domain: 'assets',
  evidence: [validAssetEvidence],
};

const captionsSection: SnapshotSectionV1 = {
  id: 'section-captions',
  label: 'Captions',
  domain: 'captions',
  evidence: [validCaptionEvidence],
};

const projectDerivedAudioEvidence: AudioRegionEvidenceV1 = {
  id: 'audio-region-001',
  kind: 'audio-region',
  label: 'Interview dialog region',
  summary: 'Detected quiet dialog with clipped peak',
  startUs: 1000000,
  durationUs: 4000000,
  sourceEntityId: 'audio-source-001',
  sourceEntityRevision: 5,
  peakDb: -0.2,
  loudnessLufs: -25.1,
};

const projectDerivedSections: readonly SnapshotSectionV1[] = [
  {
    id: 'section-assets-project-derived',
    label: 'Project Assets',
    domain: 'assets',
    evidence: [
      {
        id: 'asset-video-001',
        kind: 'asset',
        label: 'Interview Master',
        summary: 'Primary interview recording used by the edit',
        sourceEntityId: 'asset-source-video-001',
        sourceEntityRevision: 4,
      },
    ],
  },
  {
    id: 'section-timeline-project-derived',
    label: 'Timeline',
    domain: 'timeline',
    evidence: [
      {
        id: 'clip-interview-001',
        kind: 'clip',
        label: 'Interview pull quote',
        summary: 'Cut down clip used in the opener',
        startUs: 1000000,
        durationUs: 4000000,
        sourceEntityId: 'clip-source-001',
        sourceEntityRevision: 7,
      },
    ],
  },
  {
    id: 'section-captions-project-derived',
    label: 'Captions',
    domain: 'captions',
    evidence: [
      {
        id: 'caption-range-001',
        kind: 'caption-document',
        label: 'Opening captions',
        summary: '0:01-0:05 pull-quote captions',
        startUs: 1000000,
        durationUs: 4000000,
        sourceEntityId: 'caption-source-001',
        sourceEntityRevision: 3,
      },
    ],
  },
  {
    id: 'section-audio-project-derived',
    label: 'Audio',
    domain: 'audio',
    evidence: [projectDerivedAudioEvidence],
  },
];

function createProjectDerivedSnapshot(): SemanticSnapshotV1 {
  return createSemanticSnapshotV1(projectDerivedSections, {
    projectId: 'project-derived-001',
    revision: 12,
    createdBy: 'semantic-test',
    schemaVersion: 2,
    contentHash: 'hash-project-derived-001',
  });
}

// ============================================================================
// Evidence Validation Tests
// ============================================================================

describe('validateSnapshotEvidence', () => {
  it('should accept valid clip evidence', () => {
    const errors = validateSnapshotEvidence(validClipEvidence);
    expect(errors).toEqual([]);
  });

  it('should accept valid asset evidence', () => {
    const errors = validateSnapshotEvidence(validAssetEvidence);
    expect(errors).toEqual([]);
  });

  it('should reject null evidence', () => {
    const errors = validateSnapshotEvidence(null);
    expect(errors).toContain('Evidence must be an object');
  });

  it('should reject non-object evidence', () => {
    const errors = validateSnapshotEvidence('not an object');
    expect(errors).toContain('Evidence must be an object');
  });

  it('should reject evidence with empty id', () => {
    const evidence: SnapshotEvidenceV1 = {
      ...validClipEvidence,
      id: '',
    };
    const errors = validateSnapshotEvidence(evidence);
    expect(errors.some((e) => e.includes('id'))).toBe(true);
  });

  it('should reject evidence with invalid kind', () => {
    const evidence: SnapshotEvidenceV1 = {
      ...validClipEvidence,
      kind: 'invalid-kind' as any,
    };
    const errors = validateSnapshotEvidence(evidence);
    expect(errors.some((e) => e.includes('kind'))).toBe(true);
  });

  it('should reject evidence with empty label', () => {
    const evidence: SnapshotEvidenceV1 = {
      ...validClipEvidence,
      label: '',
    };
    const errors = validateSnapshotEvidence(evidence);
    expect(errors.some((e) => e.includes('label'))).toBe(true);
  });

  it('should reject evidence with empty sourceEntityId', () => {
    const evidence: SnapshotEvidenceV1 = {
      ...validClipEvidence,
      sourceEntityId: '',
    };
    const errors = validateSnapshotEvidence(evidence);
    expect(errors.some((e) => e.includes('sourceEntityId'))).toBe(true);
  });

  it('should reject evidence with negative sourceEntityRevision', () => {
    const evidence: SnapshotEvidenceV1 = {
      ...validClipEvidence,
      sourceEntityRevision: -1,
    };
    const errors = validateSnapshotEvidence(evidence);
    expect(errors.some((e) => e.includes('sourceEntityRevision'))).toBe(true);
  });

  it('should accept all valid evidence kinds', () => {
    for (const kind of EVIDENCE_KINDS_V1) {
      const evidence = validEvidenceForKind(kind);
      const errors = validateSnapshotEvidence(evidence);
      expect(errors).toEqual([]);
    }
  });

  it('should reject incomplete semantic asset shot evidence', () => {
    const evidence: SnapshotEvidenceV1 = {
      id: 'asset-shot-incomplete',
      kind: 'asset-shot',
      label: 'Incomplete shot',
      sourceEntityId: 'asset-1',
      sourceEntityRevision: 1,
    };

    const errors = validateSnapshotEvidence(evidence);

    expect(errors).toContain('Asset shot evidence assetId must be a non-empty string');
    expect(errors).toContain('Asset shot evidence startUs must be a non-negative integer');
    expect(errors).toContain('Asset shot evidence durationUs must be a positive integer');
  });

  it('should reject incomplete semantic asset caption evidence', () => {
    const evidence: SnapshotEvidenceV1 = {
      id: 'asset-caption-incomplete',
      kind: 'asset-caption',
      label: 'Incomplete caption',
      sourceEntityId: 'asset-1',
      sourceEntityRevision: 1,
    };

    const errors = validateSnapshotEvidence(evidence);

    expect(errors).toContain('Asset caption evidence assetId must be a non-empty string');
    expect(errors).toContain('Asset caption evidence text must be a non-empty string');
    expect(errors).toContain('Asset caption evidence startUs must be a non-negative integer');
    expect(errors).toContain('Asset caption evidence durationUs must be a positive integer');
  });

  it('should reject incomplete semantic asset audio evidence', () => {
    const evidence: SnapshotEvidenceV1 = {
      id: 'asset-audio-incomplete',
      kind: 'asset-audio',
      label: 'Incomplete audio',
      sourceEntityId: 'asset-1',
      sourceEntityRevision: 1,
    };

    const errors = validateSnapshotEvidence(evidence);

    expect(errors).toContain('Asset audio evidence assetId must be a non-empty string');
    expect(errors).toContain(
      'Asset audio evidence audioKind must be one of: dialogue, music, sfx, ambient, unknown',
    );
    expect(errors).toContain('Asset audio evidence startUs must be a non-negative integer');
    expect(errors).toContain('Asset audio evidence durationUs must be a positive integer');
  });
});

function validEvidenceForKind(kind: (typeof EVIDENCE_KINDS_V1)[number]): SnapshotEvidenceV1 {
  const base: SnapshotEvidenceV1 = {
    id: `test-${kind}`,
    kind,
    label: `Test ${kind}`,
    sourceEntityId: 'entity-1',
    sourceEntityRevision: 1,
  };

  switch (kind) {
    case 'asset-shot':
      return {
        ...base,
        assetId: 'asset-1',
        startUs: 0,
        durationUs: 1_000_000,
      } as SnapshotEvidenceV1;
    case 'asset-caption':
      return {
        ...base,
        assetId: 'asset-1',
        startUs: 0,
        durationUs: 1_000_000,
        text: 'Product detail caption',
      } as SnapshotEvidenceV1;
    case 'asset-audio':
      return {
        ...base,
        assetId: 'asset-1',
        startUs: 0,
        durationUs: 1_000_000,
        audioKind: 'music',
      } as SnapshotEvidenceV1;
    default:
      return base;
  }
}

// ============================================================================
// Snapshot Creation Tests
// ============================================================================

describe('createSemanticSnapshotV1', () => {
  it('should create a valid snapshot with sections', () => {
    const snapshot = createSemanticSnapshotV1([timelineSection, assetsSection, captionsSection], {
      projectId: 'project-001',
      revision: 1,
      createdBy: 'test-user',
      schemaVersion: 1,
      contentHash: 'abc123',
    });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.metadata.projectId).toBe('project-001');
    expect(snapshot.metadata.revision).toBe(1);
    expect(snapshot.metadata.createdBy).toBe('test-user');
    expect(snapshot.sections).toHaveLength(3);
    expect(snapshot.evidenceIndex.size).toBe(3);
    expect(snapshot.evidenceIds).toHaveLength(3);
  });

  it('should build correct evidence index', () => {
    const snapshot = createSemanticSnapshotV1([timelineSection], {
      projectId: 'project-001',
      revision: 1,
      createdBy: 'test-user',
      schemaVersion: 1,
      contentHash: 'abc123',
    });

    expect(hasEvidence(snapshot, 'clip-001')).toBe(true);
    expect(hasEvidence(snapshot, 'asset-001')).toBe(false);
    expect(getEvidence(snapshot, 'clip-001')).toEqual(validClipEvidence);
    expect(getEvidence(snapshot, 'nonexistent')).toBeUndefined();
  });

  it('should build correct statistics', () => {
    const snapshot = createSemanticSnapshotV1([timelineSection, assetsSection, captionsSection], {
      projectId: 'project-001',
      revision: 1,
      createdBy: 'test-user',
      schemaVersion: 1,
      contentHash: 'abc123',
    });

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

    const snapshot = createSemanticSnapshotV1([emptySection], {
      projectId: 'project-001',
      revision: 1,
      createdBy: 'test-user',
      schemaVersion: 1,
      contentHash: 'abc123',
    });

    expect(snapshot.sections).toHaveLength(1);
    expect(snapshot.evidenceIndex.size).toBe(0);
    expect(snapshot.evidenceIds).toHaveLength(0);
  });

  it('should create a project-derived snapshot with asset, clip, caption range, and audio facts', () => {
    const snapshot = createProjectDerivedSnapshot();

    expect(snapshot.sections).toHaveLength(4);
    expect(snapshot.evidenceIds).toEqual([
      'asset-video-001',
      'clip-interview-001',
      'caption-range-001',
      'audio-region-001',
    ]);
    expect(snapshot.statistics.totalAssets).toBe(1);
    expect(snapshot.statistics.totalClips).toBe(1);
    expect(snapshot.statistics.totalCaptionDocuments).toBe(1);
    expect(snapshot.statistics.totalDurationUs).toBe(4000000);
    expect(getEvidence(snapshot, 'audio-region-001')).toMatchObject({
      kind: 'audio-region',
      peakDb: -0.2,
      loudnessLufs: -25.1,
    });
  });

  it('should round-trip through JSON and remain valid after rebuilding derived indexes', () => {
    const snapshot = createProjectDerivedSnapshot();
    const parsed = JSON.parse(JSON.stringify(snapshot)) as Omit<
      SemanticSnapshotV1,
      'evidenceIndex'
    > & {
      evidenceIndex?: unknown;
    };

    const rebuilt = createSemanticSnapshotPublic(parsed.sections, {
      projectId: parsed.metadata.projectId,
      revision: parsed.metadata.revision,
      createdBy: parsed.metadata.createdBy,
      schemaVersion: parsed.metadata.schemaVersion,
      contentHash: parsed.metadata.contentHash,
    });

    expect(validateSemanticSnapshotV1(rebuilt).valid).toBe(true);
    expect(rebuilt.evidenceIds).toEqual(snapshot.evidenceIds);
  });
});

// ============================================================================
// Snapshot Validation Tests
// ============================================================================

describe('validateSemanticSnapshotV1', () => {
  it('should validate a valid snapshot', () => {
    const snapshot = createSemanticSnapshotV1([timelineSection], {
      projectId: 'project-001',
      revision: 1,
      createdBy: 'test-user',
      schemaVersion: 1,
      contentHash: 'abc123',
    });

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
    const snapshot = createSemanticSnapshotV1([timelineSection], {
      projectId: 'project-001',
      revision: 1,
      createdBy: 'test-user',
      schemaVersion: 1,
      contentHash: 'abc123',
    });
    (snapshot as any).schemaVersion = 2;

    const result = validateSemanticSnapshotV1(snapshot);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('schema version'))).toBe(true);
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
    expect(result.errors.some((e) => e.includes('metadata'))).toBe(true);
  });

  it('should reject invalid sections', () => {
    const snapshot = {
      schemaVersion: 1,
      metadata: {
        id: 'snapshot-1',
        revision: 1,
        projectId: 'project-001',
        createdAt: '2024-01-01T00:00:00.000Z',
        schemaVersion: 1,
        contentHash: 'abc123',
        createdBy: 'test-user',
      },
      sections: 'not an array',
      evidenceIndex: new Map(),
      evidenceIds: [],
    };

    const result = validateSemanticSnapshotV1(snapshot);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Sections'))).toBe(true);
  });

  it('should reject evidence with out-of-bounds temporal ranges', () => {
    const snapshot = createSemanticSnapshotV1(
      [
        {
          id: 'section-invalid-range',
          label: 'Invalid Range',
          domain: 'timeline',
          evidence: [
            {
              ...validClipEvidence,
              id: 'clip-invalid-range',
              durationUs: Number.MAX_SAFE_INTEGER,
            },
          ],
        },
      ],
      {
        projectId: 'project-001',
        revision: 1,
        createdBy: 'test-user',
        schemaVersion: 1,
        contentHash: 'abc123',
      },
    );

    const result = validateSemanticSnapshotV1(snapshot);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('durationUs'))).toBe(true);
  });

  it('should reject corrupted derived evidence state that does not match sections', () => {
    const snapshot = createSemanticSnapshotV1([timelineSection, assetsSection], {
      projectId: 'project-001',
      revision: 1,
      createdBy: 'test-user',
      schemaVersion: 1,
      contentHash: 'abc123',
    });

    const corruptedSnapshot = {
      ...snapshot,
      evidenceIndex: new Map([[validClipEvidence.id, validClipEvidence]]),
      evidenceIds: [validClipEvidence.id, 'asset-missing-from-index'],
    };

    const result = validateSemanticSnapshotV1(corruptedSnapshot);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('evidenceIndex'))).toBe(true);
    expect(result.errors.some((error) => error.includes('evidenceIds'))).toBe(true);
  });

  it('should reject corrupted subtype-specific evidence data in the derived index', () => {
    const snapshot = createProjectDerivedSnapshot();
    const tamperedAudioEvidence: AudioRegionEvidenceV1 = {
      ...projectDerivedAudioEvidence,
      peakDb: -12.5,
      loudnessLufs: -8.3,
    };
    const tamperedEvidenceIndex = new Map(snapshot.evidenceIndex);
    tamperedEvidenceIndex.set(tamperedAudioEvidence.id, tamperedAudioEvidence);

    const result = validateSemanticSnapshotV1({
      ...snapshot,
      evidenceIndex: tamperedEvidenceIndex,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('audio-region-001'))).toBe(true);
  });
});

// ============================================================================
// Type Guard Tests
// ============================================================================

describe('type guards', () => {
  it('isSnapshotEvidenceV1 should identify valid evidence', () => {
    expect(isSnapshotEvidenceV1(validClipEvidence)).toBe(true);
    expect(isSnapshotEvidenceV1(null)).toBe(false);
    expect(isSnapshotEvidenceV1({})).toBe(false);
    expect(
      isSnapshotEvidenceV1({
        id: '',
        kind: 'clip',
        label: '',
        sourceEntityId: '',
        sourceEntityRevision: 0,
      }),
    ).toBe(false);
    expect(
      isSnapshotEvidenceV1({
        id: 'asset-caption-incomplete',
        kind: 'asset-caption',
        label: 'Incomplete caption',
        sourceEntityId: 'asset-1',
        sourceEntityRevision: 1,
      }),
    ).toBe(false);
  });

  it('isSemanticSnapshotV1 should identify valid snapshots', () => {
    const snapshot = createSemanticSnapshotV1([timelineSection], {
      projectId: 'project-001',
      revision: 1,
      createdBy: 'test-user',
      schemaVersion: 1,
      contentHash: 'abc123',
    });

    expect(isSemanticSnapshotV1(snapshot)).toBe(true);
    expect(isSemanticSnapshotV1(null)).toBe(false);
    expect(isSemanticSnapshotV1({})).toBe(false);
  });
});

// ============================================================================
// Evidence Query Tests
// ============================================================================

describe('evidence queries', () => {
  const snapshot = createSemanticSnapshotV1([timelineSection, assetsSection, captionsSection], {
    projectId: 'project-001',
    revision: 1,
    createdBy: 'test-user',
    schemaVersion: 1,
    contentHash: 'abc123',
  });

  it('getEvidenceByKind should return evidence of specific kind', () => {
    const clips = getEvidenceByKind(snapshot, 'clip');
    expect(clips).toHaveLength(1);
    expect(clips[0]).toBeDefined();
    expect(clips[0]?.id).toBe('clip-001');

    const assets = getEvidenceByKind(snapshot, 'asset');
    expect(assets).toHaveLength(1);
    expect(assets[0]).toBeDefined();
    expect(assets[0]?.id).toBe('asset-001');

    const captions = getEvidenceByKind(snapshot, 'caption-document');
    expect(captions).toHaveLength(1);
    expect(captions[0]).toBeDefined();
    expect(captions[0]?.id).toBe('caption-001');
  });

  it('getEvidenceByKind should return empty array for non-existent kind', () => {
    const markers = getEvidenceByKind(snapshot, 'marker');
    expect(markers).toHaveLength(0);
  });
});

// ============================================================================
// Persian/RTL Preservation Tests
// ============================================================================

describe('Persian/RTL preservation', () => {
  const persianText = 'متن فارسی برای تست';
  const rtlText = 'نص عربي';

  it('should preserve Persian text in evidence label', () => {
    const evidence: SnapshotEvidenceV1 = {
      id: 'persian-001',
      kind: 'clip',
      label: persianText,
      sourceEntityId: 'entity-1',
      sourceEntityRevision: 1,
    };

    const errors = validateSnapshotEvidence(evidence);
    expect(errors).toEqual([]);
    expect(evidence.label).toBe(persianText);
  });

  it('should preserve RTL text in evidence summary', () => {
    const evidence: SnapshotEvidenceV1 = {
      id: 'rtl-001',
      kind: 'clip',
      label: 'Test',
      summary: rtlText,
      sourceEntityId: 'entity-1',
      sourceEntityRevision: 1,
    };

    const errors = validateSnapshotEvidence(evidence);
    expect(errors).toEqual([]);
    expect(evidence.summary).toBe(rtlText);
  });

  it('should preserve Persian text through snapshot creation', () => {
    const persianSection: SnapshotSectionV1 = {
      id: 'persian-section',
      label: persianText,
      domain: 'timeline',
      evidence: [
        {
          id: 'persian-clip',
          kind: 'clip',
          label: persianText,
          summary: rtlText,
          startUs: 0,
          durationUs: 1000000,
          sourceEntityId: 'entity-1',
          sourceEntityRevision: 1,
        },
      ],
    };

    const snapshot = createSemanticSnapshotV1([persianSection], {
      projectId: 'project-001',
      revision: 1,
      createdBy: 'test-user',
      schemaVersion: 1,
      contentHash: 'abc123',
    });

    const evidence = getEvidence(snapshot, 'persian-clip');
    expect(evidence?.label).toBe(persianText);
    expect(evidence?.summary).toBe(rtlText);
  });
});

describe('public exports', () => {
  it('re-exports the semantic snapshot builder from the package entrypoint', () => {
    expect(createSemanticSnapshotPublic).toBe(createSemanticSnapshotV1);
  });
});
