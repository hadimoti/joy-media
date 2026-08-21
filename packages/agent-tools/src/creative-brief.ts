import {
  hasEvidence,
  isSemanticIntelligenceV1,
  isSemanticSnapshotV1,
  validateSemanticIntelligenceV1,
  validateSemanticSnapshotV1,
  type EvidenceId,
  type FindingCategoryV1,
  type FindingSeverityV1,
  type SemanticIntelligenceV1,
  type SemanticSnapshotV1,
} from '@joy-media/project-schema';
import type { CreativeModelAdapter } from './model-adapter.js';

const MAX_ID_LENGTH = 256;
const MAX_GOAL_LENGTH = 1000;
const MAX_TEXT_LENGTH = 2000;
const MAX_SHORT_TEXT_LENGTH = 500;
const MAX_FOCUS_AREAS = 10;
const MAX_CONSTRAINTS = 20;
const MAX_REFERENCE_MATERIALS = 5;
const MAX_BRIEF_ITEMS = 20;
const MAX_EVIDENCE_REFERENCES = 10;
const MAX_TIME_US = 24 * 60 * 60 * 1_000_000;

export type CreativeBriefDomainV1 =
  'timeline' | 'assets' | 'captions' | 'audio' | 'composition' | 'workflow' | 'export' | 'metadata';

export type CreativeFocusAreaV1 =
  | 'pacing'
  | 'captions'
  | 'audio'
  | 'visuals'
  | 'color'
  | 'composition'
  | 'accessibility'
  | 'export'
  | 'style'
  | 'content';

export type ConfidenceLevelV1 = 'low' | 'medium' | 'high';
export type RiskClassificationV1 = 'none' | 'low' | 'medium' | 'high';

export type CreativeRecommendationKindV1 =
  | 'pacing-adjustment'
  | 'caption-improvement'
  | 'audio-enhancement'
  | 'visual-refinement'
  | 'color-correction'
  | 'composition-improvement'
  | 'content-addition'
  | 'content-removal'
  | 'style-suggestion'
  | 'accessibility-improvement'
  | 'export-optimization';

export interface CreativeTimeRangeV1 {
  readonly startUs: number;
  readonly durationUs: number;
}

export interface CreativeBriefScopeV1 {
  readonly domains: readonly CreativeBriefDomainV1[];
  readonly boundedRangeUs?: CreativeTimeRangeV1;
}

export interface CreativeConstraintV1 {
  readonly id: string;
  readonly text: string;
}

export interface ReferenceMaterialV1 {
  readonly id: string;
  readonly label: string;
  readonly excerpt: string;
}

export interface CreativeBriefRequestV1 {
  readonly projectId: string;
  readonly snapshotRevision: number;
  readonly intelligenceRevision: number;
  readonly goal: string;
  readonly scope: CreativeBriefScopeV1;
  readonly focusAreas: readonly CreativeFocusAreaV1[];
  readonly constraints: readonly CreativeConstraintV1[];
  readonly referenceMaterials: readonly ReferenceMaterialV1[];
  readonly requestId: string;
  readonly createdAt: string;
}

export interface CreativeFactV1 {
  readonly source: 's2';
  readonly findingId: string;
  readonly title: string;
  readonly description: string;
  readonly evidenceReferences: readonly EvidenceId[];
  readonly category: FindingCategoryV1;
  readonly severity: FindingSeverityV1;
}

export interface CreativeInferenceV1 {
  readonly id: string;
  readonly source: 'model';
  readonly inference: string;
  readonly evidenceReferences: readonly EvidenceId[];
  readonly confidence: ConfidenceLevelV1;
}

export interface CreativeAssumptionV1 {
  readonly id: string;
  readonly text: string;
  readonly evidenceReferences: readonly EvidenceId[];
}

export interface ProposedIntentV1 {
  readonly label: string;
  readonly summary: string;
  readonly boundedRangeUs?: CreativeTimeRangeV1;
}

export interface CreativeRecommendationV1 {
  readonly id: string;
  readonly kind: CreativeRecommendationKindV1;
  readonly confidence: ConfidenceLevelV1;
  readonly evidenceReferences: readonly EvidenceId[];
  readonly boundedRangeUs: CreativeTimeRangeV1;
  readonly rationale: string;
  readonly expectedBenefit: string;
  readonly riskClassification: RiskClassificationV1;
  readonly proposedIntent?: ProposedIntentV1;
}

export interface CreativeBlockerV1 {
  readonly id: string;
  readonly reason: string;
  readonly evidenceReferences: readonly EvidenceId[];
}

export interface HumanDecisionV1 {
  readonly id: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly evidenceReferences: readonly EvidenceId[];
}

export interface ConfidenceSummaryV1 {
  readonly overall: ConfidenceLevelV1;
  readonly rationale: string;
}

export interface CreativeBriefV1 {
  readonly snapshotRevision: number;
  readonly intelligenceRevision: number;
  readonly requestId: string;
  readonly interpretedGoal: string;
  readonly factualFindings: readonly CreativeFactV1[];
  readonly modelInferences: readonly CreativeInferenceV1[];
  readonly assumptions: readonly CreativeAssumptionV1[];
  readonly recommendations: readonly CreativeRecommendationV1[];
  readonly blockers: readonly CreativeBlockerV1[];
  readonly humanDecisions: readonly HumanDecisionV1[];
  readonly confidenceSummary: ConfidenceSummaryV1;
  readonly generatedAt: string;
}

export interface CreativeBriefValidationResultV1 {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface CreativeBriefValidationContextV1 {
  readonly snapshot: SemanticSnapshotV1;
  readonly intelligence: SemanticIntelligenceV1;
}

export interface CreateCreativeBriefOptionsV1 {
  readonly snapshot: unknown;
  readonly intelligence: unknown;
  readonly request: unknown;
  readonly modelAdapter: CreativeModelAdapter;
}

export class CreativeBriefValidationError extends Error {
  constructor(
    message: string,
    readonly errors: readonly string[],
  ) {
    super(`${message}: ${errors.join('; ')}`);
    this.name = 'CreativeBriefValidationError';
  }
}

const DOMAINS: readonly CreativeBriefDomainV1[] = [
  'timeline',
  'assets',
  'captions',
  'audio',
  'composition',
  'workflow',
  'export',
  'metadata',
];

const FOCUS_AREAS: readonly CreativeFocusAreaV1[] = [
  'pacing',
  'captions',
  'audio',
  'visuals',
  'color',
  'composition',
  'accessibility',
  'export',
  'style',
  'content',
];

const CONFIDENCE_LEVELS: readonly ConfidenceLevelV1[] = ['low', 'medium', 'high'];
const RISK_CLASSIFICATIONS: readonly RiskClassificationV1[] = ['none', 'low', 'medium', 'high'];

const RECOMMENDATION_KINDS: readonly CreativeRecommendationKindV1[] = [
  'pacing-adjustment',
  'caption-improvement',
  'audio-enhancement',
  'visual-refinement',
  'color-correction',
  'composition-improvement',
  'content-addition',
  'content-removal',
  'style-suggestion',
  'accessibility-improvement',
  'export-optimization',
];

const REQUEST_KEYS = [
  'projectId',
  'snapshotRevision',
  'intelligenceRevision',
  'goal',
  'scope',
  'focusAreas',
  'constraints',
  'referenceMaterials',
  'requestId',
  'createdAt',
] as const;

const BRIEF_KEYS = [
  'snapshotRevision',
  'intelligenceRevision',
  'requestId',
  'interpretedGoal',
  'factualFindings',
  'modelInferences',
  'assumptions',
  'recommendations',
  'blockers',
  'humanDecisions',
  'confidenceSummary',
  'generatedAt',
] as const;

const DANGEROUS_KEYS = new Set([
  'command',
  'commands',
  'tool',
  'tools',
  'agent',
  'agents',
  'project',
  'projectmutation',
  'projectpatch',
  'patch',
  'operation',
  'operations',
  'editplan',
  'dryrun',
  'approval',
  'job',
  'jobs',
  'execute',
  'executor',
  'mutation',
  'save',
  'write',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, max = MAX_TEXT_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isUuidV4(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function addUnknownKeyErrors(
  errors: string[],
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      errors.push(`${path} contains unknown field ${key}`);
    }
  }
}

function addEnumError<T extends string>(
  errors: string[],
  value: unknown,
  allowed: readonly T[],
  path: string,
): void {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    errors.push(`${path} must be one of: ${allowed.join(', ')}`);
  }
}

function addStringError(
  errors: string[],
  value: unknown,
  path: string,
  max = MAX_TEXT_LENGTH,
): void {
  if (!isNonEmptyString(value, max)) {
    errors.push(`${path} must be a non-empty string with maximum length ${max}`);
  }
}

function addArrayError<T>(
  errors: string[],
  value: unknown,
  path: string,
  max: number,
  validateItem: (item: unknown, index: number) => void,
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }

  if (value.length > max) {
    errors.push(`${path} exceeds maximum length ${max}`);
  }

  value.forEach((item, index) => validateItem(item as T, index));
}

function addTimeRangeErrors(
  errors: string[],
  value: unknown,
  path: string,
  requirePositiveDuration: boolean,
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be a bounded range object`);
    return;
  }

  addUnknownKeyErrors(errors, value, ['startUs', 'durationUs'], path);
  if (!isNonNegativeInteger(value.startUs) || value.startUs > MAX_TIME_US) {
    errors.push(`${path}.startUs must be a non-negative integer within 24 hours`);
  }

  const durationValid =
    isNonNegativeInteger(value.durationUs) &&
    value.durationUs <= MAX_TIME_US &&
    (!requirePositiveDuration || value.durationUs > 0);
  if (!durationValid) {
    errors.push(`${path}.durationUs must be a bounded positive duration`);
  }
}

function addSecurityErrors(errors: string[], value: unknown, path: string): void {
  if (typeof value === 'string') {
    const checks: readonly [RegExp, string][] = [
      [/\bhttps?:\/\//i, 'URL'],
      [/\bfile:\/\//i, 'file URL'],
      [/\bs3:\/\//i, 'object-store URL'],
      [/\b[A-Za-z]:\\/i, 'private path'],
      [/^\/(?:tmp|Users|home|var|etc)\b/i, 'private path'],
      [/\b(?:api[_-]?key|secret|token|password)\s*[:=]/i, 'credential'],
      [/\bsk-[A-Za-z0-9_-]{12,}\b/, 'credential'],
      [
        /\b(?:system prompt|developer message|prompt leakage|hidden instructions)\b/i,
        'prompt leakage',
      ],
    ];

    for (const [pattern, label] of checks) {
      if (pattern.test(value)) {
        errors.push(`${path} contains unsafe ${label}`);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => addSecurityErrors(errors, item, `${path}[${index}]`));
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    if (DANGEROUS_KEYS.has(normalized) || normalized.includes('command')) {
      errors.push(`${path}.${key} exposes a command or mutation surface`);
    }
    addSecurityErrors(errors, child, `${path}.${key}`);
  }
}

function addEvidenceReferenceErrors(
  errors: string[],
  value: unknown,
  path: string,
  snapshot: SemanticSnapshotV1,
  options: { readonly requireNonEmpty: boolean },
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }

  if (options.requireNonEmpty && value.length === 0) {
    errors.push(`${path} must cite at least one S1 evidence id`);
  }

  if (value.length > MAX_EVIDENCE_REFERENCES) {
    errors.push(`${path} exceeds maximum length ${MAX_EVIDENCE_REFERENCES}`);
  }

  for (const evidenceId of value) {
    if (!isNonEmptyString(evidenceId, MAX_ID_LENGTH)) {
      errors.push(`${path} entries must be non-empty evidence ids`);
      continue;
    }
    if (!hasEvidence(snapshot, evidenceId)) {
      errors.push(`${path} references unknown evidence id ${evidenceId}`);
    }
  }
}

function validateRequest(request: unknown): CreativeBriefValidationResultV1 {
  const errors: string[] = [];

  if (!isRecord(request)) {
    return { valid: false, errors: ['Request must be an object'], warnings: [] };
  }

  addUnknownKeyErrors(errors, request, REQUEST_KEYS, 'request');
  addStringError(errors, request.projectId, 'request.projectId', MAX_ID_LENGTH);
  if (!isNonNegativeInteger(request.snapshotRevision)) {
    errors.push('request.snapshotRevision must be a non-negative integer');
  }
  if (!isNonNegativeInteger(request.intelligenceRevision)) {
    errors.push('request.intelligenceRevision must be a non-negative integer');
  }
  addStringError(errors, request.goal, 'request.goal', MAX_GOAL_LENGTH);
  addStringError(errors, request.requestId, 'request.requestId', MAX_ID_LENGTH);
  addStringError(errors, request.createdAt, 'request.createdAt', MAX_SHORT_TEXT_LENGTH);

  if (!isRecord(request.scope)) {
    errors.push('request.scope must be an object');
  } else {
    addUnknownKeyErrors(errors, request.scope, ['domains', 'boundedRangeUs'], 'request.scope');
    addArrayError(
      errors,
      request.scope.domains,
      'request.scope.domains',
      DOMAINS.length,
      (domain, index) => addEnumError(errors, domain, DOMAINS, `request.scope.domains[${index}]`),
    );
    if (request.scope.boundedRangeUs !== undefined) {
      addTimeRangeErrors(
        errors,
        request.scope.boundedRangeUs,
        'request.scope.boundedRangeUs',
        false,
      );
    }
  }

  addArrayError(
    errors,
    request.focusAreas,
    'request.focusAreas',
    MAX_FOCUS_AREAS,
    (focusArea, index) =>
      addEnumError(errors, focusArea, FOCUS_AREAS, `request.focusAreas[${index}]`),
  );

  addArrayError(
    errors,
    request.constraints,
    'request.constraints',
    MAX_CONSTRAINTS,
    (constraint, index) => {
      const path = `request.constraints[${index}]`;
      if (!isRecord(constraint)) {
        errors.push(`${path} must be an object`);
        return;
      }
      addUnknownKeyErrors(errors, constraint, ['id', 'text'], path);
      addStringError(errors, constraint.id, `${path}.id`, MAX_ID_LENGTH);
      addStringError(errors, constraint.text, `${path}.text`, MAX_TEXT_LENGTH);
    },
  );

  addArrayError(
    errors,
    request.referenceMaterials,
    'request.referenceMaterials',
    MAX_REFERENCE_MATERIALS,
    (material, index) => {
      const path = `request.referenceMaterials[${index}]`;
      if (!isRecord(material)) {
        errors.push(`${path} must be an object`);
        return;
      }
      addUnknownKeyErrors(errors, material, ['id', 'label', 'excerpt'], path);
      addStringError(errors, material.id, `${path}.id`, MAX_ID_LENGTH);
      addStringError(errors, material.label, `${path}.label`, MAX_SHORT_TEXT_LENGTH);
      addStringError(errors, material.excerpt, `${path}.excerpt`, MAX_TEXT_LENGTH);
    },
  );

  addSecurityErrors(errors, request, 'request');

  return { valid: errors.length === 0, errors, warnings: [] };
}

function validateSnapshotAndIntelligence(
  snapshot: unknown,
  intelligence: unknown,
  request: CreativeBriefRequestV1,
): {
  readonly snapshot: SemanticSnapshotV1 | undefined;
  readonly intelligence: SemanticIntelligenceV1 | undefined;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];

  const snapshotResult = validateSemanticSnapshotV1(snapshot);
  if (!snapshotResult.valid || !isSemanticSnapshotV1(snapshot)) {
    errors.push(
      ...(snapshotResult.errors.length > 0
        ? snapshotResult.errors
        : ['Missing or invalid snapshot']),
    );
  }

  if (isSemanticSnapshotV1(snapshot)) {
    if (snapshot.metadata.projectId !== request.projectId) {
      errors.push('snapshot projectId must match request projectId');
    }
    if (snapshot.metadata.revision !== request.snapshotRevision) {
      errors.push('snapshot revision must match request snapshotRevision');
    }
  }

  const evidenceIds = isSemanticSnapshotV1(snapshot) ? snapshot.evidenceIds : undefined;
  const intelligenceResult = validateSemanticIntelligenceV1(intelligence, evidenceIds);
  if (!intelligenceResult.valid || !isSemanticIntelligenceV1(intelligence)) {
    errors.push(
      ...(intelligenceResult.errors.length > 0
        ? intelligenceResult.errors
        : ['Missing or invalid intelligence']),
    );
  }

  if (intelligenceResult.warnings.length > 0) {
    errors.push(...intelligenceResult.warnings);
  }

  if (isSemanticIntelligenceV1(intelligence)) {
    if (intelligence.metadata.projectId !== request.projectId) {
      errors.push('intelligence projectId must match request projectId');
    }
    if (intelligence.metadata.revision !== request.intelligenceRevision) {
      errors.push('intelligence revision must match request intelligenceRevision');
    }
    if (intelligence.snapshotRevision !== request.snapshotRevision) {
      errors.push('intelligence snapshotRevision must match request snapshotRevision');
    }
  }

  if (isSemanticSnapshotV1(snapshot) && isSemanticIntelligenceV1(intelligence)) {
    for (const finding of intelligence.findings) {
      for (const evidenceId of finding.evidenceIds) {
        if (!hasEvidence(snapshot, evidenceId)) {
          errors.push(`finding ${finding.id} references unknown evidence id ${evidenceId}`);
        }
      }
      if (finding.location !== undefined && !hasEvidence(snapshot, finding.location.evidenceId)) {
        errors.push(
          `finding ${finding.id} location references unknown evidence id ${finding.location.evidenceId}`,
        );
      }
    }
  }

  return {
    snapshot: isSemanticSnapshotV1(snapshot) ? snapshot : undefined,
    intelligence: isSemanticIntelligenceV1(intelligence) ? intelligence : undefined,
    errors,
  };
}

function addFactErrors(
  errors: string[],
  value: unknown,
  path: string,
  context: CreativeBriefValidationContextV1,
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }

  addUnknownKeyErrors(
    errors,
    value,
    ['source', 'findingId', 'title', 'description', 'evidenceReferences', 'category', 'severity'],
    path,
  );
  if (value.source !== 's2') {
    errors.push(`${path}.source must be s2`);
  }
  addStringError(errors, value.findingId, `${path}.findingId`, MAX_ID_LENGTH);
  const finding =
    typeof value.findingId === 'string'
      ? context.intelligence.findingIndex.get(value.findingId)
      : undefined;
  if (finding === undefined) {
    errors.push(`${path}.findingId must reference an S2 finding`);
  } else {
    if (value.title !== finding.title) {
      errors.push(`${path}.title must match the deterministic S2 finding title`);
    }
    if (value.description !== finding.description) {
      errors.push(`${path}.description must match the deterministic S2 finding description`);
    }
    if (value.category !== finding.category) {
      errors.push(`${path}.category must match the deterministic S2 finding category`);
    }
    if (value.severity !== finding.severity) {
      errors.push(`${path}.severity must match the deterministic S2 finding severity`);
    }
    if (
      !Array.isArray(value.evidenceReferences) ||
      value.evidenceReferences.length !== finding.evidenceIds.length ||
      value.evidenceReferences.some(
        (evidenceId, index) => evidenceId !== finding.evidenceIds[index],
      )
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
      requireNonEmpty: true,
    },
  );
}

function addInferenceErrors(
  errors: string[],
  value: unknown,
  path: string,
  context: CreativeBriefValidationContextV1,
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }

  addUnknownKeyErrors(
    errors,
    value,
    ['id', 'source', 'inference', 'evidenceReferences', 'confidence'],
    path,
  );
  if (!isUuidV4(value.id)) {
    errors.push(`${path}.id must be a UUID v4`);
  }
  if (value.source !== 'model') {
    errors.push(`${path}.source must be model`);
  }
  addStringError(errors, value.inference, `${path}.inference`, MAX_TEXT_LENGTH);
  addEnumError(errors, value.confidence, CONFIDENCE_LEVELS, `${path}.confidence`);
  addEvidenceReferenceErrors(
    errors,
    value.evidenceReferences,
    `${path}.evidenceReferences`,
    context.snapshot,
    {
      requireNonEmpty: true,
    },
  );
}

function addAssumptionErrors(
  errors: string[],
  value: unknown,
  path: string,
  context: CreativeBriefValidationContextV1,
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }

  addUnknownKeyErrors(errors, value, ['id', 'text', 'evidenceReferences'], path);
  if (!isUuidV4(value.id)) {
    errors.push(`${path}.id must be a UUID v4`);
  }
  addStringError(errors, value.text, `${path}.text`, MAX_TEXT_LENGTH);
  addEvidenceReferenceErrors(
    errors,
    value.evidenceReferences,
    `${path}.evidenceReferences`,
    context.snapshot,
    {
      requireNonEmpty: false,
    },
  );
}

function addRecommendationErrors(
  errors: string[],
  value: unknown,
  path: string,
  context: CreativeBriefValidationContextV1,
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }

  addUnknownKeyErrors(
    errors,
    value,
    [
      'id',
      'kind',
      'confidence',
      'evidenceReferences',
      'boundedRangeUs',
      'rationale',
      'expectedBenefit',
      'riskClassification',
      'proposedIntent',
    ],
    path,
  );
  if (!isUuidV4(value.id)) {
    errors.push(`${path}.id must be a UUID v4`);
  }
  addEnumError(errors, value.kind, RECOMMENDATION_KINDS, `${path}.kind`);
  addEnumError(errors, value.confidence, CONFIDENCE_LEVELS, `${path}.confidence`);
  addEnumError(
    errors,
    value.riskClassification,
    RISK_CLASSIFICATIONS,
    `${path}.riskClassification`,
  );
  addStringError(errors, value.rationale, `${path}.rationale`, MAX_TEXT_LENGTH);
  addStringError(errors, value.expectedBenefit, `${path}.expectedBenefit`, MAX_SHORT_TEXT_LENGTH);
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

  if (value.proposedIntent !== undefined) {
    if (!isRecord(value.proposedIntent)) {
      errors.push(`${path}.proposedIntent must be an object`);
    } else {
      addUnknownKeyErrors(
        errors,
        value.proposedIntent,
        ['label', 'summary', 'boundedRangeUs'],
        `${path}.proposedIntent`,
      );
      addStringError(
        errors,
        value.proposedIntent.label,
        `${path}.proposedIntent.label`,
        MAX_SHORT_TEXT_LENGTH,
      );
      addStringError(
        errors,
        value.proposedIntent.summary,
        `${path}.proposedIntent.summary`,
        MAX_TEXT_LENGTH,
      );
      if (value.proposedIntent.boundedRangeUs !== undefined) {
        addTimeRangeErrors(
          errors,
          value.proposedIntent.boundedRangeUs,
          `${path}.proposedIntent.boundedRangeUs`,
          true,
        );
      }
    }
  }
}

function addBlockerErrors(
  errors: string[],
  value: unknown,
  path: string,
  context: CreativeBriefValidationContextV1,
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }

  addUnknownKeyErrors(errors, value, ['id', 'reason', 'evidenceReferences'], path);
  if (!isUuidV4(value.id)) {
    errors.push(`${path}.id must be a UUID v4`);
  }
  addStringError(errors, value.reason, `${path}.reason`, MAX_TEXT_LENGTH);
  addEvidenceReferenceErrors(
    errors,
    value.evidenceReferences,
    `${path}.evidenceReferences`,
    context.snapshot,
    {
      requireNonEmpty: false,
    },
  );
}

function addHumanDecisionErrors(
  errors: string[],
  value: unknown,
  path: string,
  context: CreativeBriefValidationContextV1,
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }

  addUnknownKeyErrors(errors, value, ['id', 'question', 'options', 'evidenceReferences'], path);
  if (!isUuidV4(value.id)) {
    errors.push(`${path}.id must be a UUID v4`);
  }
  addStringError(errors, value.question, `${path}.question`, MAX_TEXT_LENGTH);
  addArrayError(errors, value.options, `${path}.options`, 6, (option, index) =>
    addStringError(errors, option, `${path}.options[${index}]`, MAX_SHORT_TEXT_LENGTH),
  );
  addEvidenceReferenceErrors(
    errors,
    value.evidenceReferences,
    `${path}.evidenceReferences`,
    context.snapshot,
    {
      requireNonEmpty: false,
    },
  );
}

export function validateCreativeBriefV1(
  brief: unknown,
  context: CreativeBriefValidationContextV1,
): CreativeBriefValidationResultV1 {
  const errors: string[] = [];

  if (!isRecord(brief)) {
    return { valid: false, errors: ['Model output brief must be an object'], warnings: [] };
  }

  addUnknownKeyErrors(errors, brief, BRIEF_KEYS, 'brief');
  if (brief.snapshotRevision !== context.snapshot.metadata.revision) {
    errors.push('brief snapshotRevision must match S1 snapshot revision');
  }
  if (brief.intelligenceRevision !== context.intelligence.metadata.revision) {
    errors.push('brief intelligenceRevision must match S2 intelligence revision');
  }
  addStringError(errors, brief.requestId, 'brief.requestId', MAX_ID_LENGTH);
  addStringError(errors, brief.interpretedGoal, 'brief.interpretedGoal', MAX_GOAL_LENGTH);
  addStringError(errors, brief.generatedAt, 'brief.generatedAt', MAX_SHORT_TEXT_LENGTH);

  addArrayError(
    errors,
    brief.factualFindings,
    'brief.factualFindings',
    MAX_BRIEF_ITEMS,
    (fact, index) => addFactErrors(errors, fact, `brief.factualFindings[${index}]`, context),
  );
  addArrayError(
    errors,
    brief.modelInferences,
    'brief.modelInferences',
    MAX_BRIEF_ITEMS,
    (inference, index) =>
      addInferenceErrors(errors, inference, `brief.modelInferences[${index}]`, context),
  );
  addArrayError(
    errors,
    brief.assumptions,
    'brief.assumptions',
    MAX_BRIEF_ITEMS,
    (assumption, index) =>
      addAssumptionErrors(errors, assumption, `brief.assumptions[${index}]`, context),
  );
  addArrayError(
    errors,
    brief.recommendations,
    'brief.recommendations',
    MAX_BRIEF_ITEMS,
    (recommendation, index) =>
      addRecommendationErrors(errors, recommendation, `brief.recommendations[${index}]`, context),
  );
  addArrayError(errors, brief.blockers, 'brief.blockers', MAX_BRIEF_ITEMS, (blocker, index) =>
    addBlockerErrors(errors, blocker, `brief.blockers[${index}]`, context),
  );
  addArrayError(
    errors,
    brief.humanDecisions,
    'brief.humanDecisions',
    MAX_BRIEF_ITEMS,
    (decision, index) =>
      addHumanDecisionErrors(errors, decision, `brief.humanDecisions[${index}]`, context),
  );

  if (!isRecord(brief.confidenceSummary)) {
    errors.push('brief.confidenceSummary must be an object');
  } else {
    addUnknownKeyErrors(
      errors,
      brief.confidenceSummary,
      ['overall', 'rationale'],
      'brief.confidenceSummary',
    );
    addEnumError(
      errors,
      brief.confidenceSummary.overall,
      CONFIDENCE_LEVELS,
      'brief.confidenceSummary.overall',
    );
    addStringError(
      errors,
      brief.confidenceSummary.rationale,
      'brief.confidenceSummary.rationale',
      MAX_TEXT_LENGTH,
    );
  }

  addSecurityErrors(errors, brief, 'brief');

  return { valid: errors.length === 0, errors, warnings: [] };
}

export async function createCreativeBrief(
  options: CreateCreativeBriefOptionsV1,
): Promise<CreativeBriefV1> {
  const requestResult = validateRequest(options.request);
  if (!requestResult.valid) {
    throw new CreativeBriefValidationError('Invalid creative brief request', requestResult.errors);
  }

  const request = options.request as CreativeBriefRequestV1;
  const inputResult = validateSnapshotAndIntelligence(
    options.snapshot,
    options.intelligence,
    request,
  );
  if (
    inputResult.errors.length > 0 ||
    inputResult.snapshot === undefined ||
    inputResult.intelligence === undefined
  ) {
    throw new CreativeBriefValidationError(
      'Invalid S1/S2 input for creative brief',
      inputResult.errors,
    );
  }

  const output = await options.modelAdapter.createBrief({
    snapshot: inputResult.snapshot,
    intelligence: inputResult.intelligence,
    request,
  });

  if (!isRecord(output) || !('brief' in output)) {
    throw new CreativeBriefValidationError('Invalid model output', [
      'Model output must contain a brief object',
    ]);
  }

  const briefResult = validateCreativeBriefV1(output.brief, {
    snapshot: inputResult.snapshot,
    intelligence: inputResult.intelligence,
  });

  if (!briefResult.valid) {
    throw new CreativeBriefValidationError('Invalid model output', briefResult.errors);
  }

  return output.brief as CreativeBriefV1;
}
