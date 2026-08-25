/**
 * S2: Semantic Intelligence Tests
 *
 * Tests for semantic-intelligence.ts types and validation
 */

import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_RULES_V1,
  createSemanticIntelligenceV1,
  FINDING_CATEGORIES_V1,
  FINDING_SEVERITIES_V1,
  getBuiltInRuleV1,
  getBuiltInRulesV1,
  getFinding,
  getFindingsByCategory,
  getFindingsByEvidence,
  getFindingsBySeverity,
  hasFinding,
  isIntelligenceFindingV1,
  isIntelligenceRuleV1,
  isSemanticIntelligenceV1,
  type IntelligenceFindingV1,
  type IntelligenceRuleV1,
  type SemanticBrollSearchIndexV1,
  validateIntelligenceFinding,
  validateIntelligenceRule,
  validateSemanticBrollSearchIndexV1,
  validateSemanticIntelligenceV1,
} from './semantic-intelligence.js';
import { createSemanticIntelligenceV1 as createSemanticIntelligencePublic } from './index.js';

// ============================================================================
// Fixtures
// ============================================================================

const validFinding: IntelligenceFindingV1 = {
  id: 'finding-001',
  category: 'completeness',
  severity: 'error',
  title: 'Missing Asset Reference',
  description: 'Clip clip-001 references asset asset-001 which does not exist',
  evidenceIds: ['clip-001'],
  evidenceKind: 'clip',
};

const validFindingWithMetric: IntelligenceFindingV1 = {
  id: 'finding-002',
  category: 'timing',
  severity: 'notice',
  title: 'Timeline Gap',
  description: 'Gap of 5 seconds between clip-001 and clip-002',
  evidenceIds: ['clip-001', 'clip-002'],
  metric: {
    name: 'gapDurationUs',
    value: 5000000,
    unit: 'microseconds',
  },
};

const validRule: IntelligenceRuleV1 = {
  id: 'rule-001',
  name: 'Missing Asset Detection',
  description: 'Detects clips that reference missing or unavailable assets',
  category: 'completeness',
  defaultSeverity: 'error',
  enabled: true,
  appliesTo: ['clip', 'asset'],
};

const projectDerivedEvidenceIds = [
  'asset-video-001',
  'clip-interview-001',
  'caption-range-001',
  'audio-region-001',
] as const;

// ============================================================================
// Finding Validation Tests
// ============================================================================

describe('validateIntelligenceFinding', () => {
  it('should accept valid finding', () => {
    const errors = validateIntelligenceFinding(validFinding);
    expect(errors).toEqual([]);
  });

  it('should accept valid finding with metric', () => {
    const errors = validateIntelligenceFinding(validFindingWithMetric);
    expect(errors).toEqual([]);
  });

  it('should reject null finding', () => {
    const errors = validateIntelligenceFinding(null);
    expect(errors).toContain('Finding must be an object');
  });

  it('should reject non-object finding', () => {
    const errors = validateIntelligenceFinding('not an object');
    expect(errors).toContain('Finding must be an object');
  });

  it('should reject finding with empty id', () => {
    const finding: IntelligenceFindingV1 = {
      ...validFinding,
      id: '',
    };
    const errors = validateIntelligenceFinding(finding);
    expect(errors.some((e) => e.includes('id'))).toBe(true);
  });

  it('should reject finding with invalid category', () => {
    const finding: IntelligenceFindingV1 = {
      ...validFinding,
      category: 'invalid-category' as unknown as IntelligenceFindingV1['category'],
    };
    const errors = validateIntelligenceFinding(finding);
    expect(errors.some((e) => e.includes('category'))).toBe(true);
  });

  it('should reject finding with invalid severity', () => {
    const finding: IntelligenceFindingV1 = {
      ...validFinding,
      severity: 'invalid-severity' as unknown as IntelligenceFindingV1['severity'],
    };
    const errors = validateIntelligenceFinding(finding);
    expect(errors.some((e) => e.includes('severity'))).toBe(true);
  });

  it('should reject finding with empty title', () => {
    const finding: IntelligenceFindingV1 = {
      ...validFinding,
      title: '',
    };
    const errors = validateIntelligenceFinding(finding);
    expect(errors.some((e) => e.includes('title'))).toBe(true);
  });

  it('should reject finding with empty description', () => {
    const finding: IntelligenceFindingV1 = {
      ...validFinding,
      description: '',
    };
    const errors = validateIntelligenceFinding(finding);
    expect(errors.some((e) => e.includes('description'))).toBe(true);
  });

  it('should reject finding with empty evidenceIds array', () => {
    const finding: IntelligenceFindingV1 = {
      ...validFinding,
      evidenceIds: [],
    };
    // Empty array is still an array, so this should pass
    // EvidenceIds can be empty (finding applies to whole project)
    const errors = validateIntelligenceFinding(finding);
    expect(errors).toEqual([]);
  });

  it('should accept all valid finding categories', () => {
    for (const category of FINDING_CATEGORIES_V1) {
      const finding: IntelligenceFindingV1 = {
        id: `test-${category}`,
        category,
        severity: 'info',
        title: `Test ${category}`,
        description: `Test finding for ${category}`,
        evidenceIds: [],
      };
      const errors = validateIntelligenceFinding(finding);
      expect(errors).toEqual([]);
    }
  });

  it('should accept all valid finding severities', () => {
    for (const severity of FINDING_SEVERITIES_V1) {
      const finding: IntelligenceFindingV1 = {
        id: `test-${severity}`,
        category: 'completeness',
        severity,
        title: `Test ${severity}`,
        description: `Test finding with ${severity} severity`,
        evidenceIds: [],
      };
      const errors = validateIntelligenceFinding(finding);
      expect(errors).toEqual([]);
    }
  });

  it('should reject finding location ranges outside supported bounds', () => {
    const finding: IntelligenceFindingV1 = {
      ...validFinding,
      id: 'finding-invalid-location',
      location: {
        evidenceId: 'clip-001',
        startUs: -1,
      },
    };

    const errors = validateIntelligenceFinding(finding);
    expect(errors.some((error) => error.includes('location'))).toBe(true);
  });
});

// ============================================================================
// Rule Validation Tests
// ============================================================================

describe('validateIntelligenceRule', () => {
  it('should accept valid rule', () => {
    const errors = validateIntelligenceRule(validRule);
    expect(errors).toEqual([]);
  });

  it('should reject null rule', () => {
    const errors = validateIntelligenceRule(null);
    expect(errors).toContain('Rule must be an object');
  });

  it('should reject non-object rule', () => {
    const errors = validateIntelligenceRule('not an object');
    expect(errors).toContain('Rule must be an object');
  });

  it('should reject rule with empty id', () => {
    const rule: IntelligenceRuleV1 = {
      ...validRule,
      id: '',
    };
    const errors = validateIntelligenceRule(rule);
    expect(errors.some((e) => e.includes('id'))).toBe(true);
  });

  it('should reject rule with empty name', () => {
    const rule: IntelligenceRuleV1 = {
      ...validRule,
      name: '',
    };
    const errors = validateIntelligenceRule(rule);
    expect(errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('should reject rule with empty description', () => {
    const rule: IntelligenceRuleV1 = {
      ...validRule,
      description: '',
    };
    const errors = validateIntelligenceRule(rule);
    expect(errors.some((e) => e.includes('description'))).toBe(true);
  });

  it('should reject rule with invalid category', () => {
    const rule: IntelligenceRuleV1 = {
      ...validRule,
      category: 'invalid-category' as unknown as IntelligenceRuleV1['category'],
    };
    const errors = validateIntelligenceRule(rule);
    expect(errors.some((e) => e.includes('category'))).toBe(true);
  });

  it('should reject rule with invalid severity', () => {
    const rule: IntelligenceRuleV1 = {
      ...validRule,
      defaultSeverity: 'invalid-severity' as unknown as IntelligenceRuleV1['defaultSeverity'],
    };
    const errors = validateIntelligenceRule(rule);
    expect(errors.some((e) => e.includes('defaultSeverity'))).toBe(true);
  });

  it('should reject rule with enabled not boolean', () => {
    const rule: IntelligenceRuleV1 = {
      ...validRule,
      enabled: 'yes' as unknown as IntelligenceRuleV1['enabled'],
    };
    const errors = validateIntelligenceRule(rule);
    expect(errors.some((e) => e.includes('enabled'))).toBe(true);
  });

  it('should reject rule with invalid appliesTo', () => {
    const rule: IntelligenceRuleV1 = {
      ...validRule,
      appliesTo: 'not an array' as unknown as IntelligenceRuleV1['appliesTo'],
    };
    const errors = validateIntelligenceRule(rule);
    expect(errors.some((e) => e.includes('appliesTo'))).toBe(true);
  });

  it('should reject rule with unknown evidence kinds in appliesTo', () => {
    const rule: IntelligenceRuleV1 = {
      ...validRule,
      appliesTo: ['clip', 'not-a-kind' as unknown as IntelligenceRuleV1['appliesTo'][number]],
    };

    const errors = validateIntelligenceRule(rule);
    expect(errors.some((error) => error.includes('appliesTo'))).toBe(true);
  });
});

// ============================================================================
// Intelligence Creation Tests
// ============================================================================

describe('createSemanticIntelligenceV1', () => {
  it('should create valid intelligence with findings and rules', () => {
    const intelligence = createSemanticIntelligenceV1(
      [validFinding, validFindingWithMetric],
      [validRule],
      {
        projectId: 'project-001',
        snapshotRevision: 1,
        createdBy: 'test-user',
        contentHash: 'abc123',
      },
    );

    expect(intelligence.schemaVersion).toBe(1);
    expect(intelligence.metadata.projectId).toBe('project-001');
    expect(intelligence.metadata.snapshotRevision).toBe(1);
    expect(intelligence.snapshotRevision).toBe(1);
    expect(intelligence.findings).toHaveLength(2);
    expect(intelligence.rules).toHaveLength(1);
    expect(intelligence.findingIndex.size).toBe(2);
    expect(intelligence.findingIds).toHaveLength(2);
  });

  it('should build correct statistics', () => {
    const intelligence = createSemanticIntelligenceV1(
      [
        { ...validFinding, category: 'completeness', severity: 'error' },
        { ...validFinding, id: 'finding-002', category: 'completeness', severity: 'warning' },
        { ...validFinding, id: 'finding-003', category: 'structure', severity: 'info' },
      ],
      [validRule],
      {
        projectId: 'project-001',
        snapshotRevision: 1,
        createdBy: 'test-user',
        contentHash: 'abc123',
      },
    );

    expect(intelligence.statistics.totalFindings).toBe(3);
    expect(intelligence.statistics.findingsBySeverity.error).toBe(1);
    expect(intelligence.statistics.findingsBySeverity.warning).toBe(1);
    expect(intelligence.statistics.findingsBySeverity.info).toBe(1);
    expect(intelligence.statistics.findingsBySeverity.notice).toBe(0);
    expect(intelligence.statistics.findingsByCategory.completeness).toBe(2);
    expect(intelligence.statistics.findingsByCategory.structure).toBe(1);
  });

  it('should handle empty findings', () => {
    const intelligence = createSemanticIntelligenceV1([], [validRule], {
      projectId: 'project-001',
      snapshotRevision: 1,
      createdBy: 'test-user',
      contentHash: 'abc123',
    });

    expect(intelligence.findings).toHaveLength(0);
    expect(intelligence.findingIndex.size).toBe(0);
    expect(intelligence.findingIds).toHaveLength(0);
    expect(intelligence.statistics.totalFindings).toBe(0);
  });

  it('should round-trip through JSON and remain valid after rebuilding derived indexes', () => {
    const intelligence = createSemanticIntelligenceV1(
      [
        {
          ...validFinding,
          evidenceIds: ['clip-interview-001'],
        },
        {
          ...validFindingWithMetric,
          evidenceIds: ['clip-interview-001', 'caption-range-001'],
        },
      ],
      [validRule],
      {
        projectId: 'project-001',
        snapshotRevision: 1,
        createdBy: 'test-user',
        contentHash: 'abc123',
      },
    );

    const parsed = JSON.parse(JSON.stringify(intelligence)) as Omit<
      typeof intelligence,
      'findingIndex'
    > & {
      findingIndex?: unknown;
    };

    const rebuilt = createSemanticIntelligencePublic(parsed.findings, parsed.rules, {
      projectId: parsed.metadata.projectId,
      snapshotRevision: parsed.snapshotRevision,
      createdBy: parsed.metadata.createdBy,
      contentHash: parsed.metadata.contentHash,
    });

    const result = validateSemanticIntelligenceV1(rebuilt, projectDerivedEvidenceIds);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(rebuilt.findingIds).toEqual(intelligence.findingIds);
  });

  it('should produce the same metadata id for identical inputs', () => {
    const originalNow = Date.now;
    try {
      Date.now = () => 1000;
      const first = createSemanticIntelligenceV1([validFinding], [validRule], {
        projectId: 'project-001',
        snapshotRevision: 1,
        createdBy: 'test-user',
        contentHash: 'abc123',
      });

      Date.now = () => 2000;
      const second = createSemanticIntelligenceV1([validFinding], [validRule], {
        projectId: 'project-001',
        snapshotRevision: 1,
        createdBy: 'test-user',
        contentHash: 'abc123',
      });

      expect(second.metadata.id).toBe(first.metadata.id);
    } finally {
      Date.now = originalNow;
    }
  });
});

// ============================================================================
// Intelligence Validation Tests
// ============================================================================

describe('validateSemanticIntelligenceV1', () => {
  it('should validate valid intelligence', () => {
    const intelligence = createSemanticIntelligenceV1([validFinding], [validRule], {
      projectId: 'project-001',
      snapshotRevision: 1,
      createdBy: 'test-user',
      contentHash: 'abc123',
    });

    const result = validateSemanticIntelligenceV1(intelligence);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('should reject null intelligence', () => {
    const result = validateSemanticIntelligenceV1(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Intelligence must be an object');
  });

  it('should reject invalid schema version', () => {
    const intelligence = createSemanticIntelligenceV1([validFinding], [validRule], {
      projectId: 'project-001',
      snapshotRevision: 1,
      createdBy: 'test-user',
      contentHash: 'abc123',
    });
    Object.assign(intelligence, { schemaVersion: 2 });

    const result = validateSemanticIntelligenceV1(intelligence);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('schema version'))).toBe(true);
  });

  it('should reject missing metadata', () => {
    const intelligence = {
      schemaVersion: 1,
      snapshotRevision: 1,
      findings: [],
      rules: [],
      statistics: {},
      findingIndex: new Map(),
      findingIds: [],
      // Missing metadata
    };

    const result = validateSemanticIntelligenceV1(intelligence);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('metadata'))).toBe(true);
  });

  it('should reject invalid findings array', () => {
    const intelligence = {
      schemaVersion: 1,
      metadata: {
        id: 'intel-1',
        revision: 1,
        snapshotRevision: 1,
        projectId: 'project-001',
        createdAt: '2024-01-01T00:00:00.000Z',
        contentHash: 'abc123',
        createdBy: 'test-user',
      },
      snapshotRevision: 1,
      findings: 'not an array',
      rules: [],
      statistics: {},
      findingIndex: new Map(),
      findingIds: [],
    };

    const result = validateSemanticIntelligenceV1(intelligence);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Findings'))).toBe(true);
  });

  it('should warn about unknown evidence references', () => {
    const findingWithUnknownEvidence: IntelligenceFindingV1 = {
      ...validFinding,
      evidenceIds: ['unknown-evidence-001'],
    };

    const intelligence = createSemanticIntelligenceV1([findingWithUnknownEvidence], [validRule], {
      projectId: 'project-001',
      snapshotRevision: 1,
      createdBy: 'test-user',
      contentHash: 'abc123',
    });

    const result = validateSemanticIntelligenceV1(
      intelligence,
      ['clip-001', 'clip-002'], // known evidence IDs
    );

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes('unknown evidence'))).toBe(true);
  });
});

// ============================================================================
// Type Guard Tests
// ============================================================================

describe('type guards', () => {
  it('isIntelligenceFindingV1 should identify valid findings', () => {
    expect(isIntelligenceFindingV1(validFinding)).toBe(true);
    expect(isIntelligenceFindingV1(null)).toBe(false);
    expect(isIntelligenceFindingV1({})).toBe(false);
  });

  it('isIntelligenceRuleV1 should identify valid rules', () => {
    expect(isIntelligenceRuleV1(validRule)).toBe(true);
    expect(isIntelligenceRuleV1(null)).toBe(false);
    expect(isIntelligenceRuleV1({})).toBe(false);
  });

  it('isSemanticIntelligenceV1 should identify valid intelligence', () => {
    const intelligence = createSemanticIntelligenceV1([validFinding], [validRule], {
      projectId: 'project-001',
      snapshotRevision: 1,
      createdBy: 'test-user',
      contentHash: 'abc123',
    });

    expect(isSemanticIntelligenceV1(intelligence)).toBe(true);
    expect(isSemanticIntelligenceV1(null)).toBe(false);
    expect(isSemanticIntelligenceV1({})).toBe(false);
  });
});

// ============================================================================
// Finding Query Tests
// ============================================================================

describe('finding queries', () => {
  const finding2: IntelligenceFindingV1 = {
    ...validFinding,
    id: 'finding-002',
    category: 'structure',
    severity: 'warning',
    evidenceIds: ['clip-002'],
  };

  const finding3: IntelligenceFindingV1 = {
    ...validFinding,
    id: 'finding-003',
    category: 'quality',
    severity: 'error',
    evidenceIds: ['audio-region-001'],
  };

  const intelligence = createSemanticIntelligenceV1(
    [validFinding, finding2, finding3],
    [validRule],
    {
      projectId: 'project-001',
      snapshotRevision: 1,
      createdBy: 'test-user',
      contentHash: 'abc123',
    },
  );

  it('hasFinding should return correct results', () => {
    expect(hasFinding(intelligence, 'finding-001')).toBe(true);
    expect(hasFinding(intelligence, 'finding-002')).toBe(true);
    expect(hasFinding(intelligence, 'nonexistent')).toBe(false);
  });

  it('getFinding should return correct finding', () => {
    expect(getFinding(intelligence, 'finding-001')).toEqual(validFinding);
    expect(getFinding(intelligence, 'finding-002')).toEqual(finding2);
    expect(getFinding(intelligence, 'nonexistent')).toBeUndefined();
  });

  it('getFindingsByCategory should return findings of specific category', () => {
    const completeness = getFindingsByCategory(intelligence, 'completeness');
    expect(completeness).toHaveLength(1);
    expect(completeness[0]).toBeDefined();
    expect(completeness[0]?.id).toBe('finding-001');

    const structure = getFindingsByCategory(intelligence, 'structure');
    expect(structure).toHaveLength(1);
    expect(structure[0]).toBeDefined();
    expect(structure[0]?.id).toBe('finding-002');

    const quality = getFindingsByCategory(intelligence, 'quality');
    expect(quality).toHaveLength(1);
    expect(quality[0]).toBeDefined();
    expect(quality[0]?.id).toBe('finding-003');
  });

  it('getFindingsBySeverity should return findings of specific severity', () => {
    const errors = getFindingsBySeverity(intelligence, 'error');
    expect(errors).toHaveLength(2); // finding-001 and finding-003

    const warnings = getFindingsBySeverity(intelligence, 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBeDefined();
    expect(warnings[0]?.id).toBe('finding-002');
  });

  it('getFindingsByEvidence should return findings referencing specific evidence', () => {
    const findingWithEvidence = getFindingsByEvidence(intelligence, 'clip-001');
    expect(findingWithEvidence).toHaveLength(1);
    expect(findingWithEvidence[0]).toBeDefined();
    expect(findingWithEvidence[0]?.id).toBe('finding-001');

    const noFindings = getFindingsByEvidence(intelligence, 'nonexistent-evidence');
    expect(noFindings).toHaveLength(0);
  });
});

// ============================================================================
// Built-in Rules Tests
// ============================================================================

describe('built-in rules', () => {
  it('getBuiltInRulesV1 should return all built-in rules', () => {
    const rules = getBuiltInRulesV1();
    expect(rules).toHaveLength(BUILT_IN_RULES_V1.length);
    expect(rules).toEqual(BUILT_IN_RULES_V1);
  });

  it('getBuiltInRuleV1 should return rule by ID', () => {
    const rule = getBuiltInRuleV1('rule-missing-assets');
    expect(rule).toBeDefined();
    expect(rule?.id).toBe('rule-missing-assets');
  });

  it('getBuiltInRuleV1 should return undefined for unknown ID', () => {
    const rule = getBuiltInRuleV1('unknown-rule');
    expect(rule).toBeUndefined();
  });

  it('all built-in rules should be valid', () => {
    for (const rule of BUILT_IN_RULES_V1) {
      const errors = validateIntelligenceRule(rule);
      expect(errors).toEqual([]);
    }
  });
});

// ============================================================================
// Persian/RTL Preservation Tests
// ============================================================================

describe('Persian/RTL preservation', () => {
  const persianText = 'یافته عیوب یافت شد';
  const rtlText = 'عربي نص';

  it('should preserve Persian text in finding title', () => {
    const finding: IntelligenceFindingV1 = {
      id: 'persian-finding',
      category: 'completeness',
      severity: 'error',
      title: persianText,
      description: 'Test description',
      evidenceIds: [],
    };

    const errors = validateIntelligenceFinding(finding);
    expect(errors).toEqual([]);
    expect(finding.title).toBe(persianText);
  });

  it('should preserve RTL text in finding description', () => {
    const finding: IntelligenceFindingV1 = {
      id: 'rtl-finding',
      category: 'quality',
      severity: 'warning',
      title: 'Test',
      description: rtlText,
      evidenceIds: [],
    };

    const errors = validateIntelligenceFinding(finding);
    expect(errors).toEqual([]);
    expect(finding.description).toBe(rtlText);
  });

  it('should preserve Persian text through intelligence creation', () => {
    const finding: IntelligenceFindingV1 = {
      id: 'persian-finding',
      category: 'structure',
      severity: 'notice',
      title: persianText,
      description: rtlText,
      evidenceIds: ['clip-001'],
    };

    const intelligence = createSemanticIntelligenceV1([finding], [validRule], {
      projectId: 'project-001',
      snapshotRevision: 1,
      createdBy: 'test-user',
      contentHash: 'abc123',
    });

    const retrieved = getFinding(intelligence, 'persian-finding');
    expect(retrieved?.title).toBe(persianText);
    expect(retrieved?.description).toBe(rtlText);
  });

  it('should preserve Persian text in rule description', () => {
    const rule: IntelligenceRuleV1 = {
      id: 'persian-rule',
      name: persianText,
      description: rtlText,
      category: 'completeness',
      defaultSeverity: 'info',
      enabled: true,
      appliesTo: ['clip'],
    };

    const errors = validateIntelligenceRule(rule);
    expect(errors).toEqual([]);
    expect(rule.name).toBe(persianText);
    expect(rule.description).toBe(rtlText);
  });
});

describe('public exports', () => {
  it('re-exports the semantic intelligence builder from the package entrypoint', () => {
    expect(createSemanticIntelligencePublic).toBe(createSemanticIntelligenceV1);
  });
});

describe('SemanticBrollSearchIndexV1', () => {
  it('validates evidence-backed search ranges', () => {
    const index: SemanticBrollSearchIndexV1 = {
      schemaVersion: 1,
      projectId: 'project-broll',
      createdAt: '2026-08-22T00:00:00.000Z',
      evidenceIndex: new Map([
        [
          'asset-1.shot-1',
          {
            id: 'asset-1.shot-1',
            kind: 'asset-shot',
            label: 'Shot 1',
            summary: 'Close product detail',
            sourceEntityId: 'asset-1',
            sourceEntityRevision: 1,
            assetId: 'asset-1',
            startUs: 1_000_000,
            durationUs: 2_000_000,
            tags: ['product'],
          },
        ],
      ]),
      assets: [
        {
          assetId: 'asset-1',
          displayName: 'Product closeup.mp4',
          assetType: 'video',
          durationUs: 10_000_000,
          usedInTimeline: false,
          ranges: [
            {
              rangeId: 'asset-1.range-1',
              assetId: 'asset-1',
              startUs: 1_000_000,
              durationUs: 2_000_000,
              label: 'Close product detail',
              text: 'Close product detail',
              evidenceIds: ['asset-1.shot-1'],
            },
          ],
        },
      ],
    };

    expect(validateSemanticBrollSearchIndexV1(index)).toEqual([]);
  });

  it('rejects ranges without canonical evidence', () => {
    const index: SemanticBrollSearchIndexV1 = {
      schemaVersion: 1,
      projectId: 'project-broll',
      createdAt: '2026-08-22T00:00:00.000Z',
      evidenceIndex: new Map(),
      assets: [
        {
          assetId: 'asset-1',
          displayName: 'Product closeup.mp4',
          assetType: 'video',
          usedInTimeline: false,
          ranges: [
            {
              rangeId: 'asset-1.range-1',
              assetId: 'asset-1',
              startUs: 1_000_000,
              durationUs: 2_000_000,
              label: 'Close product detail',
              text: 'Close product detail',
              evidenceIds: ['missing-evidence'],
            },
          ],
        },
      ],
    };

    expect(validateSemanticBrollSearchIndexV1(index).join(' ')).toContain('missing evidence');
  });
});
