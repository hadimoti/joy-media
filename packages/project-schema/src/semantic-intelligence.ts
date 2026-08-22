/**
 * S2: Semantic Intelligence Types
 *
 * Deterministic project analysis derived from S1 semantic snapshots.
 * These types provide analytic findings about project state that are
 * verifiable and reproducible from the snapshot data.
 *
 * Dependency: S1 (semantic-snapshot.ts)
 */

import type {
  EvidenceId,
  EvidenceKindV1,
  SnapshotEvidenceV1,
  SnapshotRevision,
} from './semantic-snapshot.js';
import { EVIDENCE_KINDS_V1 } from './semantic-snapshot.js';

// ============================================================================
// Core Types
// ============================================================================

/** Unique identifier for a semantic intelligence report */
export type IntelligenceId = string;

/** Revision number for intelligence versioning */
export type IntelligenceRevision = number;

/** Timestamp in ISO 8601 format */
export type ISO8601 = string;

// ============================================================================
// Bounded String Types
// ============================================================================

/** Maximum length for intelligence identifiers */
const MAX_ID_LENGTH = 256;

/** Maximum length for labels and names */
const MAX_LABEL_LENGTH = 500;

/** Maximum length for descriptions */
const MAX_DESCRIPTION_LENGTH = 2000;

/** Maximum length for detailed findings */
const MAX_FINDING_LENGTH = 5000;

/** Maximum number of findings per intelligence report */
const MAX_FINDINGS_COUNT = 1000;

/** Maximum number of rules per intelligence report */
const MAX_RULES_COUNT = 500;

/** Maximum supported temporal range in microseconds (24 hours) */
const MAX_TIME_US = 24 * 60 * 60 * 1_000_000;

/** Maximum number of evidence kinds a rule can target */
const MAX_APPLIES_TO_COUNT = EVIDENCE_KINDS_V1.length;

// ============================================================================
// Validation Helpers
// ============================================================================

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringMaxLength(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoundedTimeUs(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= MAX_TIME_US;
}

// ============================================================================
// Intelligence Metadata
// ============================================================================

/** Metadata about the intelligence report */
export interface IntelligenceMetadataV1 {
  readonly id: IntelligenceId;
  readonly revision: IntelligenceRevision;
  /** The snapshot revision this intelligence was derived from */
  readonly snapshotRevision: SnapshotRevision;
  readonly projectId: string;
  readonly createdAt: ISO8601;
  /** Hash of the intelligence content for integrity verification */
  readonly contentHash: string;
  /** Entity that generated this intelligence (user, agent, system) */
  readonly createdBy: string;
}

// ============================================================================
// Finding Types
// ============================================================================

/**
 * Severity level for intelligence findings.
 * Findings are **deterministic facts** derived from the snapshot.
 */
export type FindingSeverityV1 = 'info' | 'notice' | 'warning' | 'error';

export const FINDING_SEVERITIES_V1: readonly FindingSeverityV1[] = [
  'info',
  'notice',
  'warning',
  'error',
];

/**
 * Category of intelligence finding.
 * These categorize the domain of analysis.
 */
export type FindingCategoryV1 =
  | 'structure'
  | 'content'
  | 'timing'
  | 'quality'
  | 'accessibility'
  | 'completeness'
  | 'consistency'
  | 'performance'
  | 'metadata';

export const FINDING_CATEGORIES_V1: readonly FindingCategoryV1[] = [
  'structure',
  'content',
  'timing',
  'quality',
  'accessibility',
  'completeness',
  'consistency',
  'performance',
  'metadata',
];

/**
 * A single deterministic finding from semantic analysis.
 *
 * Key invariant: Findings are **FACTS** derived from the snapshot.
 * They are NOT inferences, suggestions, or opinions.
 * S3 will distinguish these from model inferences.
 */
export interface IntelligenceFindingV1 {
  readonly id: string;
  readonly category: FindingCategoryV1;
  readonly severity: FindingSeverityV1;
  readonly title: string;
  readonly description: string;
  /**
   * Evidence IDs from S1 that support this finding.
   * Must reference valid canonical evidence.
   */
  readonly evidenceIds: readonly EvidenceId[];
  /**
   * The kind of evidence this finding relates to.
   * Optional but recommended for filtering.
   */
  readonly evidenceKind?: EvidenceKindV1;
  /**
   * Computed metric or count where applicable.
   * For example: gap duration, missing asset count, etc.
   */
  readonly metric?: {
    readonly name: string;
    readonly value: number;
    readonly unit?: string;
  };
  /**
   * Location information for findings that have a specific position.
   */
  readonly location?: {
    readonly evidenceId: EvidenceId;
    readonly startUs?: number;
    readonly durationUs?: number;
    readonly offset?: number;
  };
}

/** Validation for intelligence findings */
export function validateIntelligenceFinding(value: unknown): string[] {
  const errors: string[] = [];

  if (value === null || typeof value !== 'object') {
    return ['Finding must be an object'];
  }

  const finding = value as Record<string, unknown>;

  if (!isNonEmptyString(finding.id) || finding.id.length > MAX_ID_LENGTH) {
    errors.push(`Finding id must be a non-empty string <= ${MAX_ID_LENGTH} chars`);
  }

  if (
    !isNonEmptyString(finding.category) ||
    !FINDING_CATEGORIES_V1.includes(finding.category as FindingCategoryV1)
  ) {
    errors.push(`Finding category must be one of: ${FINDING_CATEGORIES_V1.join(', ')}`);
  }

  if (
    !isNonEmptyString(finding.severity) ||
    !FINDING_SEVERITIES_V1.includes(finding.severity as FindingSeverityV1)
  ) {
    errors.push(`Finding severity must be one of: ${FINDING_SEVERITIES_V1.join(', ')}`);
  }

  if (!isNonEmptyString(finding.title) || finding.title.length > MAX_LABEL_LENGTH) {
    errors.push(`Finding title must be a non-empty string <= ${MAX_LABEL_LENGTH} chars`);
  }

  if (!isNonEmptyString(finding.description) || finding.description.length > MAX_FINDING_LENGTH) {
    errors.push(`Finding description must be a non-empty string <= ${MAX_FINDING_LENGTH} chars`);
  }

  const evidenceIds = finding.evidenceIds as unknown[];
  if (!Array.isArray(evidenceIds)) {
    errors.push('Finding evidenceIds must be an array');
  } else {
    for (const id of evidenceIds) {
      if (!isNonEmptyString(id)) {
        errors.push('Each evidenceId must be a non-empty string');
        break;
      }
    }
  }

  if (
    finding.evidenceKind !== undefined &&
    (!isNonEmptyString(finding.evidenceKind) ||
      !EVIDENCE_KINDS_V1.includes(finding.evidenceKind as EvidenceKindV1))
  ) {
    errors.push(`Finding evidenceKind must be one of: ${EVIDENCE_KINDS_V1.join(', ')}`);
  }

  if (finding.metric !== undefined) {
    const metric = finding.metric as Record<string, unknown>;
    if (metric === null || typeof metric !== 'object') {
      errors.push('Finding metric must be an object if present');
    } else {
      if (!isNonEmptyString(metric.name) || metric.name.length > MAX_LABEL_LENGTH) {
        errors.push(`Finding metric name must be a non-empty string <= ${MAX_LABEL_LENGTH} chars`);
      }
      if (!isFiniteNumber(metric.value)) {
        errors.push('Finding metric value must be a finite number');
      }
      if (metric.unit !== undefined && !isStringMaxLength(metric.unit, MAX_LABEL_LENGTH)) {
        errors.push(`Finding metric unit must be <= ${MAX_LABEL_LENGTH} chars`);
      }
    }
  }

  if (finding.location !== undefined) {
    const location = finding.location as Record<string, unknown>;
    if (location === null || typeof location !== 'object') {
      errors.push('Finding location must be an object if present');
    } else {
      if (!isNonEmptyString(location.evidenceId) || location.evidenceId.length > MAX_ID_LENGTH) {
        errors.push(
          `Finding location evidenceId must be a non-empty string <= ${MAX_ID_LENGTH} chars`,
        );
      }
      if (location.startUs !== undefined && !isBoundedTimeUs(location.startUs)) {
        errors.push(`Finding location startUs must be a non-negative integer <= ${MAX_TIME_US}`);
      }
      if (location.durationUs !== undefined && !isBoundedTimeUs(location.durationUs)) {
        errors.push(`Finding location durationUs must be a non-negative integer <= ${MAX_TIME_US}`);
      }
      if (location.offset !== undefined && !isNonNegativeInteger(location.offset)) {
        errors.push('Finding location offset must be a non-negative integer');
      }
    }
  }

  return errors;
}

// ============================================================================
// Rule Types
// ============================================================================

/**
 * A semantic rule that produces findings.
 * Rules are deterministic transformations from snapshot state to findings.
 */
export interface IntelligenceRuleV1 {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: FindingCategoryV1;
  /** Default severity when this rule fires */
  readonly defaultSeverity: FindingSeverityV1;
  /**
   * Whether this rule is enabled by default.
   * Disabled rules can be explicitly enabled.
   */
  readonly enabled: boolean;
  /**
   * Evidence kinds this rule applies to.
   * Empty array means all kinds.
   */
  readonly appliesTo: readonly EvidenceKindV1[];
}

/** Validation for intelligence rules */
export function validateIntelligenceRule(value: unknown): string[] {
  const errors: string[] = [];

  if (value === null || typeof value !== 'object') {
    return ['Rule must be an object'];
  }

  const rule = value as Record<string, unknown>;

  if (!isNonEmptyString(rule.id) || rule.id.length > MAX_ID_LENGTH) {
    errors.push(`Rule id must be a non-empty string <= ${MAX_ID_LENGTH} chars`);
  }

  if (!isNonEmptyString(rule.name) || rule.name.length > MAX_LABEL_LENGTH) {
    errors.push(`Rule name must be a non-empty string <= ${MAX_LABEL_LENGTH} chars`);
  }

  if (!isNonEmptyString(rule.description) || rule.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`Rule description must be a non-empty string <= ${MAX_DESCRIPTION_LENGTH} chars`);
  }

  if (
    !isNonEmptyString(rule.category) ||
    !FINDING_CATEGORIES_V1.includes(rule.category as FindingCategoryV1)
  ) {
    errors.push(`Rule category must be one of: ${FINDING_CATEGORIES_V1.join(', ')}`);
  }

  if (
    !isNonEmptyString(rule.defaultSeverity) ||
    !FINDING_SEVERITIES_V1.includes(rule.defaultSeverity as FindingSeverityV1)
  ) {
    errors.push(`Rule defaultSeverity must be one of: ${FINDING_SEVERITIES_V1.join(', ')}`);
  }

  if (typeof rule.enabled !== 'boolean') {
    errors.push('Rule enabled must be a boolean');
  }

  const appliesTo = rule.appliesTo as unknown[];
  if (!Array.isArray(appliesTo)) {
    errors.push('Rule appliesTo must be an array');
  } else {
    if (appliesTo.length > MAX_APPLIES_TO_COUNT) {
      errors.push(`Rule appliesTo must contain at most ${MAX_APPLIES_TO_COUNT} evidence kinds`);
    }

    for (const evidenceKind of appliesTo) {
      if (
        !isNonEmptyString(evidenceKind) ||
        !EVIDENCE_KINDS_V1.includes(evidenceKind as EvidenceKindV1)
      ) {
        errors.push(`Rule appliesTo entries must be one of: ${EVIDENCE_KINDS_V1.join(', ')}`);
        break;
      }
    }
  }

  return errors;
}

// ============================================================================
// B-roll Semantic Search Index
// ============================================================================

export interface SemanticBrollTimeRangeV1 {
  readonly rangeId: string;
  readonly assetId: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly label: string;
  readonly text: string;
  readonly evidenceIds: readonly EvidenceId[];
}

export interface SemanticBrollAssetV1 {
  readonly assetId: string;
  readonly displayName: string;
  readonly assetType: 'video' | 'audio' | 'image' | 'other';
  readonly durationUs?: number;
  readonly usedInTimeline: boolean;
  readonly tags?: readonly string[];
  readonly ranges: readonly SemanticBrollTimeRangeV1[];
}

export interface SemanticBrollSearchIndexV1 {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly createdAt: ISO8601;
  readonly evidenceIndex: ReadonlyMap<EvidenceId, SnapshotEvidenceV1>;
  readonly assets: readonly SemanticBrollAssetV1[];
}

export function validateSemanticBrollSearchIndexV1(index: unknown): readonly string[] {
  const errors: string[] = [];

  if (index === null || typeof index !== 'object' || Array.isArray(index)) {
    return ['Semantic B-roll search index must be an object'];
  }

  const value = index as Record<string, unknown>;
  if (value.schemaVersion !== 1) {
    errors.push('Semantic B-roll search index schemaVersion must be 1');
  }
  if (!isNonEmptyString(value.projectId) || value.projectId.length > MAX_ID_LENGTH) {
    errors.push(
      `Semantic B-roll search index projectId must be a non-empty string <= ${MAX_ID_LENGTH} chars`,
    );
  }
  if (!isNonEmptyString(value.createdAt)) {
    errors.push('Semantic B-roll search index createdAt is required');
  }
  if (!(value.evidenceIndex instanceof Map)) {
    errors.push('Semantic B-roll search index evidenceIndex must be a Map');
  }

  const evidenceIndex =
    value.evidenceIndex instanceof Map
      ? (value.evidenceIndex as ReadonlyMap<EvidenceId, SnapshotEvidenceV1>)
      : new Map<EvidenceId, SnapshotEvidenceV1>();

  if (!Array.isArray(value.assets)) {
    errors.push('Semantic B-roll search index assets must be an array');
    return errors;
  }

  if (value.assets.length > MAX_FINDINGS_COUNT) {
    errors.push(
      `Semantic B-roll search index assets count exceeds maximum of ${MAX_FINDINGS_COUNT}`,
    );
  }

  for (const [assetIndex, asset] of value.assets.entries()) {
    if (asset === null || typeof asset !== 'object' || Array.isArray(asset)) {
      errors.push(`Semantic B-roll asset ${assetIndex} must be an object`);
      continue;
    }
    const assetValue = asset as Record<string, unknown>;
    if (!isNonEmptyString(assetValue.assetId) || assetValue.assetId.length > MAX_ID_LENGTH) {
      errors.push(`Semantic B-roll asset ${assetIndex} assetId is required`);
    }
    if (
      !isNonEmptyString(assetValue.displayName) ||
      assetValue.displayName.length > MAX_LABEL_LENGTH
    ) {
      errors.push(`Semantic B-roll asset ${assetIndex} displayName is required`);
    }
    if (
      assetValue.assetType !== 'video' &&
      assetValue.assetType !== 'audio' &&
      assetValue.assetType !== 'image' &&
      assetValue.assetType !== 'other'
    ) {
      errors.push(`Semantic B-roll asset ${assetIndex} assetType is invalid`);
    }
    if (typeof assetValue.usedInTimeline !== 'boolean') {
      errors.push(`Semantic B-roll asset ${assetIndex} usedInTimeline must be a boolean`);
    }
    if (assetValue.durationUs !== undefined && !isBoundedTimeUs(assetValue.durationUs)) {
      errors.push(`Semantic B-roll asset ${assetIndex} durationUs is invalid`);
    }
    if (!Array.isArray(assetValue.ranges)) {
      errors.push(`Semantic B-roll asset ${assetIndex} ranges must be an array`);
      continue;
    }
    for (const [rangeIndex, range] of assetValue.ranges.entries()) {
      if (range === null || typeof range !== 'object' || Array.isArray(range)) {
        errors.push(`Semantic B-roll range ${assetIndex}.${rangeIndex} must be an object`);
        continue;
      }
      const rangeValue = range as Record<string, unknown>;
      if (!isNonEmptyString(rangeValue.rangeId) || rangeValue.rangeId.length > MAX_ID_LENGTH) {
        errors.push(`Semantic B-roll range ${assetIndex}.${rangeIndex} rangeId is required`);
      }
      if (rangeValue.assetId !== assetValue.assetId) {
        errors.push(
          `Semantic B-roll range ${assetIndex}.${rangeIndex} assetId must match its asset`,
        );
      }
      if (!isBoundedTimeUs(rangeValue.startUs)) {
        errors.push(`Semantic B-roll range ${assetIndex}.${rangeIndex} startUs is invalid`);
      }
      if (!isBoundedTimeUs(rangeValue.durationUs)) {
        errors.push(`Semantic B-roll range ${assetIndex}.${rangeIndex} durationUs is invalid`);
      }
      if (!isNonEmptyString(rangeValue.label) || rangeValue.label.length > MAX_LABEL_LENGTH) {
        errors.push(`Semantic B-roll range ${assetIndex}.${rangeIndex} label is required`);
      }
      if (typeof rangeValue.text !== 'string' || rangeValue.text.length > MAX_FINDING_LENGTH) {
        errors.push(
          `Semantic B-roll range ${assetIndex}.${rangeIndex} text must be a bounded string`,
        );
      }
      if (!Array.isArray(rangeValue.evidenceIds) || rangeValue.evidenceIds.length === 0) {
        errors.push(`Semantic B-roll range ${assetIndex}.${rangeIndex} must cite evidence`);
        continue;
      }
      for (const evidenceId of rangeValue.evidenceIds) {
        if (!isNonEmptyString(evidenceId)) {
          errors.push(
            `Semantic B-roll range ${assetIndex}.${rangeIndex} evidenceIds must be non-empty strings`,
          );
          continue;
        }
        const evidence = evidenceIndex.get(evidenceId);
        if (evidence === undefined) {
          errors.push(
            `Semantic B-roll range ${assetIndex}.${rangeIndex} cites missing evidence ${evidenceId}`,
          );
        } else if (
          evidence.kind !== 'asset-shot' &&
          evidence.kind !== 'asset-caption' &&
          evidence.kind !== 'asset-audio'
        ) {
          errors.push(
            `Semantic B-roll range ${assetIndex}.${rangeIndex} cites non-B-roll evidence ${evidenceId}`,
          );
        }
      }
    }
  }

  return errors;
}

// ============================================================================
// Statistical Summary
// ============================================================================

/** Statistical summary of intelligence findings */
export interface IntelligenceStatisticsV1 {
  readonly totalFindings: number;
  readonly findingsBySeverity: {
    readonly info: number;
    readonly notice: number;
    readonly warning: number;
    readonly error: number;
  };
  readonly findingsByCategory: Record<FindingCategoryV1, number>;
  readonly totalRulesApplied: number;
  readonly totalRulesMatched: number;
}

// ============================================================================
// S2 Semantic Intelligence
// ============================================================================

/**
 * S2: Semantic Intelligence Version 1
 *
 * Deterministic analysis results derived from an S1 semantic snapshot.
 * All findings are **verifiable facts** about the project state.
 *
 * Key invariants:
 * - All arrays are readonly and bounded
 * - All strings are bounded
 * - All IDs are non-empty
 * - All evidence references must be valid S1 evidence IDs
 * - Findings are deterministic and reproducible
 * - No inferences, suggestions, or opinions
 */
export interface SemanticIntelligenceV1 {
  readonly schemaVersion: 1;
  readonly metadata: IntelligenceMetadataV1;

  /** The S1 snapshot revision this intelligence was derived from */
  readonly snapshotRevision: SnapshotRevision;

  /** Deterministic findings from analysis */
  readonly findings: readonly IntelligenceFindingV1[];

  /** The rules that were applied to produce these findings */
  readonly rules: readonly IntelligenceRuleV1[];

  /** Statistical summary of findings */
  readonly statistics: IntelligenceStatisticsV1;

  /**
   * Flat index of all findings by ID for O(1) lookup.
   * Derived from findings for convenience.
   */
  readonly findingIndex: ReadonlyMap<string, IntelligenceFindingV1>;

  /**
   * Flat list of all finding IDs for iteration.
   */
  readonly findingIds: readonly string[];
}

// ============================================================================
// Builder and Validation
// ============================================================================

/** Validation result for intelligence */
export interface IntelligenceValidationResultV1 {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Build options for creating semantic intelligence
 */
export interface BuildIntelligenceOptionsV1 {
  projectId: string;
  snapshotRevision: SnapshotRevision;
  createdBy: string;
  contentHash: string;
}

/**
 * Create semantic intelligence from findings and rules
 */
export function createSemanticIntelligenceV1(
  findings: readonly IntelligenceFindingV1[],
  rules: readonly IntelligenceRuleV1[],
  options: BuildIntelligenceOptionsV1,
): SemanticIntelligenceV1 {
  const now = new Date().toISOString();
  const metadata: IntelligenceMetadataV1 = {
    id: `intelligence-${options.projectId}-${options.snapshotRevision}-${options.contentHash}`,
    revision: 1,
    snapshotRevision: options.snapshotRevision,
    projectId: options.projectId,
    createdAt: now,
    contentHash: options.contentHash,
    createdBy: options.createdBy,
  };

  // Build statistics
  const statistics = {
    totalFindings: findings.length,
    findingsBySeverity: {
      info: 0,
      notice: 0,
      warning: 0,
      error: 0,
    },
    findingsByCategory: {
      structure: 0,
      content: 0,
      timing: 0,
      quality: 0,
      accessibility: 0,
      completeness: 0,
      consistency: 0,
      performance: 0,
      metadata: 0,
    },
    totalRulesApplied: rules.filter((r) => r.enabled).length,
    totalRulesMatched: 0, // Would be computed by rule matching, not set here
  };

  for (const finding of findings) {
    statistics.findingsBySeverity[finding.severity]++;
    statistics.findingsByCategory[finding.category]++;
  }

  // Build index
  const findingIndex = new Map<string, IntelligenceFindingV1>();
  const findingIds: string[] = [];

  for (const finding of findings) {
    findingIndex.set(finding.id, finding);
    findingIds.push(finding.id);
  }

  return {
    schemaVersion: 1,
    metadata,
    snapshotRevision: options.snapshotRevision,
    findings,
    rules,
    statistics,
    findingIndex,
    findingIds,
  };
}

/**
 * Validate semantic intelligence
 */
export function validateSemanticIntelligenceV1(
  intelligence: unknown,
  snapshotEvidenceIds?: readonly string[],
): IntelligenceValidationResultV1 {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (intelligence === null || typeof intelligence !== 'object') {
    return { valid: false, errors: ['Intelligence must be an object'], warnings: [] };
  }

  const i = intelligence as Record<string, unknown>;

  // Check schema version
  if (i.schemaVersion !== 1) {
    errors.push(`Unsupported schema version: ${i.schemaVersion}`);
  }

  // Validate metadata
  const metadata = i.metadata as Record<string, unknown>;
  if (!metadata || typeof metadata !== 'object') {
    errors.push('Intelligence metadata is required');
  } else {
    if (!isNonEmptyString(metadata.id)) {
      errors.push('Metadata id is required');
    }
    if (!isNonNegativeInteger(metadata.revision)) {
      errors.push('Metadata revision must be a non-negative integer');
    }
    if (!isNonNegativeInteger(metadata.snapshotRevision)) {
      errors.push('Metadata snapshotRevision must be a non-negative integer');
    }
    if (!isNonEmptyString(metadata.projectId)) {
      errors.push('Metadata projectId is required');
    }
    if (!isNonEmptyString(metadata.createdAt)) {
      errors.push('Metadata createdAt is required');
    }
  }

  // Validate findings
  const findings = i.findings as unknown[];
  if (!Array.isArray(findings)) {
    errors.push('Findings must be an array');
  } else {
    if (findings.length > MAX_FINDINGS_COUNT) {
      errors.push(`Findings count exceeds maximum of ${MAX_FINDINGS_COUNT}`);
    }

    for (const finding of findings) {
      const findingErrors = validateIntelligenceFinding(finding);
      errors.push(...findingErrors);

      // Validate evidence references if snapshot evidence IDs provided
      if (snapshotEvidenceIds && Array.isArray(snapshotEvidenceIds)) {
        const evidenceIds = (finding as IntelligenceFindingV1).evidenceIds;
        if (Array.isArray(evidenceIds)) {
          for (const evId of evidenceIds) {
            if (!snapshotEvidenceIds.includes(evId)) {
              warnings.push(
                `Finding ${(finding as IntelligenceFindingV1).id} references unknown evidence ID: ${evId}`,
              );
            }
          }
        }
      }
    }
  }

  // Validate rules
  const rules = i.rules as unknown[];
  if (!Array.isArray(rules)) {
    errors.push('Rules must be an array');
  } else {
    if (rules.length > MAX_RULES_COUNT) {
      errors.push(`Rules count exceeds maximum of ${MAX_RULES_COUNT}`);
    }

    for (const rule of rules) {
      const ruleErrors = validateIntelligenceRule(rule);
      errors.push(...ruleErrors);
    }
  }

  // Validate statistics
  const statistics = i.statistics as Record<string, unknown>;
  if (!statistics || typeof statistics !== 'object') {
    errors.push('Statistics is required');
  }

  // Validate finding index
  const findingIndex = i.findingIndex as Map<string, IntelligenceFindingV1>;
  if (!(findingIndex instanceof Map)) {
    errors.push('findingIndex must be a Map');
  }

  // Validate finding IDs
  const findingIds = i.findingIds as unknown[];
  if (!Array.isArray(findingIds)) {
    errors.push('findingIds must be an array');
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : [],
    warnings,
  };
}

/**
 * Check if a finding ID exists in intelligence
 */
export function hasFinding(intelligence: SemanticIntelligenceV1, findingId: string): boolean {
  return intelligence.findingIndex.has(findingId);
}

/**
 * Get finding by ID
 */
export function getFinding(
  intelligence: SemanticIntelligenceV1,
  findingId: string,
): IntelligenceFindingV1 | undefined {
  return intelligence.findingIndex.get(findingId);
}

/**
 * Get all findings of a specific category
 */
export function getFindingsByCategory(
  intelligence: SemanticIntelligenceV1,
  category: FindingCategoryV1,
): readonly IntelligenceFindingV1[] {
  return intelligence.findingIds
    .map((id) => intelligence.findingIndex.get(id))
    .filter((f): f is IntelligenceFindingV1 => f !== undefined && f.category === category);
}

/**
 * Get all findings of a specific severity
 */
export function getFindingsBySeverity(
  intelligence: SemanticIntelligenceV1,
  severity: FindingSeverityV1,
): readonly IntelligenceFindingV1[] {
  return intelligence.findingIds
    .map((id) => intelligence.findingIndex.get(id))
    .filter((f): f is IntelligenceFindingV1 => f !== undefined && f.severity === severity);
}

/**
 * Get findings that reference specific evidence
 */
export function getFindingsByEvidence(
  intelligence: SemanticIntelligenceV1,
  evidenceId: EvidenceId,
): readonly IntelligenceFindingV1[] {
  return intelligence.findingIds
    .map((id) => intelligence.findingIndex.get(id))
    .filter(
      (f): f is IntelligenceFindingV1 => f !== undefined && f.evidenceIds.includes(evidenceId),
    );
}

// ============================================================================
// Type Guards
// ============================================================================

export function isSemanticIntelligenceV1(value: unknown): value is SemanticIntelligenceV1 {
  if (value === null || typeof value !== 'object') return false;
  const i = value as SemanticIntelligenceV1;
  return (
    i.schemaVersion === 1 &&
    typeof i.metadata === 'object' &&
    i.metadata !== null &&
    isNonNegativeInteger(i.snapshotRevision) &&
    Array.isArray(i.findings) &&
    Array.isArray(i.rules) &&
    typeof i.statistics === 'object' &&
    i.statistics !== null &&
    i.findingIndex instanceof Map &&
    Array.isArray(i.findingIds)
  );
}

export function isIntelligenceFindingV1(value: unknown): value is IntelligenceFindingV1 {
  if (value === null || typeof value !== 'object') return false;
  const f = value as IntelligenceFindingV1;
  return (
    isNonEmptyString(f.id) &&
    isNonEmptyString(f.category) &&
    FINDING_CATEGORIES_V1.includes(f.category as FindingCategoryV1) &&
    isNonEmptyString(f.severity) &&
    FINDING_SEVERITIES_V1.includes(f.severity as FindingSeverityV1) &&
    isNonEmptyString(f.title) &&
    isNonEmptyString(f.description) &&
    Array.isArray(f.evidenceIds)
  );
}

export function isIntelligenceRuleV1(value: unknown): value is IntelligenceRuleV1 {
  if (value === null || typeof value !== 'object') return false;
  const r = value as IntelligenceRuleV1;
  return (
    isNonEmptyString(r.id) &&
    isNonEmptyString(r.name) &&
    isNonEmptyString(r.description) &&
    isNonEmptyString(r.category) &&
    FINDING_CATEGORIES_V1.includes(r.category as FindingCategoryV1) &&
    isNonEmptyString(r.defaultSeverity) &&
    FINDING_SEVERITIES_V1.includes(r.defaultSeverity as FindingSeverityV1) &&
    typeof r.enabled === 'boolean' &&
    Array.isArray(r.appliesTo)
  );
}

// ============================================================================
// Built-in Rules (S2 Deterministic Rules)
// ============================================================================

/**
 * Predefined rules for common semantic analysis.
 * These produce deterministic findings from S1 snapshots.
 */

const BUILT_IN_RULES_V1: readonly IntelligenceRuleV1[] = [
  {
    id: 'rule-missing-assets',
    name: 'Missing Asset Detection',
    description: 'Detects clips that reference missing or unavailable assets',
    category: 'completeness',
    defaultSeverity: 'error',
    enabled: true,
    appliesTo: ['clip', 'asset'],
  },
  {
    id: 'rule-empty-captions',
    name: 'Empty Caption Detection',
    description: 'Detects caption documents that have no text content',
    category: 'completeness',
    defaultSeverity: 'warning',
    enabled: true,
    appliesTo: ['caption-document'],
  },
  {
    id: 'rule-timeline-gaps',
    name: 'Timeline Gap Detection',
    description: 'Detects gaps between clips on the timeline',
    category: 'structure',
    defaultSeverity: 'notice',
    enabled: true,
    appliesTo: ['clip', 'track'],
  },
  {
    id: 'rule-overlapping-clips',
    name: 'Overlapping Clip Detection',
    description: 'Detects clips that overlap on the same track',
    category: 'structure',
    defaultSeverity: 'warning',
    enabled: true,
    appliesTo: ['clip'],
  },
  {
    id: 'rule-low-audio',
    name: 'Low Audio Detection',
    description: 'Detects audio regions with low volume that may be inaudible',
    category: 'quality',
    defaultSeverity: 'warning',
    enabled: true,
    appliesTo: ['audio-region'],
  },
  {
    id: 'rule-high-peak',
    name: 'Audio Clipping Detection',
    description: 'Detects audio regions that may be clipped/distorted',
    category: 'quality',
    defaultSeverity: 'error',
    enabled: true,
    appliesTo: ['audio-region'],
  },
  {
    id: 'rule-unused-assets',
    name: 'Unused Asset Detection',
    description: 'Detects assets that are not referenced by any clip',
    category: 'completeness',
    defaultSeverity: 'info',
    enabled: true,
    appliesTo: ['asset'],
  },
  {
    id: 'rule-long-clips',
    name: 'Long Clip Detection',
    description: 'Detects clips that exceed recommended duration thresholds',
    category: 'quality',
    defaultSeverity: 'notice',
    enabled: true,
    appliesTo: ['clip'],
  },
  {
    id: 'rule-missing-captions',
    name: 'Missing Caption Detection',
    description: 'Detects clips that do not have associated captions',
    category: 'accessibility',
    defaultSeverity: 'warning',
    enabled: true,
    appliesTo: ['clip', 'caption-document'],
  },
  {
    id: 'rule-color-space',
    name: 'Color Space Consistency',
    description: 'Detects inconsistent color spaces across assets',
    category: 'consistency',
    defaultSeverity: 'notice',
    enabled: true,
    appliesTo: ['asset', 'composition'],
  },
];

/** Get all built-in rules */
export function getBuiltInRulesV1(): readonly IntelligenceRuleV1[] {
  return BUILT_IN_RULES_V1;
}

/** Get a built-in rule by ID */
export function getBuiltInRuleV1(id: string): IntelligenceRuleV1 | undefined {
  return BUILT_IN_RULES_V1.find((r) => r.id === id);
}

export { BUILT_IN_RULES_V1 };
