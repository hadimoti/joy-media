import {
  hasEvidence,
  validateSemanticIntelligenceV1,
  validateSemanticSnapshotV1,
  type SemanticIntelligenceV1,
  type SemanticSnapshotV1,
} from '@joy-media/project-schema';
import type { ProjectRevisionId } from './envelope.js';

export const CREATIVE_BRIEF_V2_SCHEMA_VERSION = 2 as const;

const MAX_ID_LENGTH = 256;
const MAX_REVISION_LENGTH = 512;
const MAX_GOAL_LENGTH = 2_000;
const MAX_TEXT_LENGTH = 4_000;
const MAX_EVIDENCE = 20;
const MAX_RECOMMENDATIONS = 20;

export interface CreativeBriefV2Request {
  readonly schemaVersion: typeof CREATIVE_BRIEF_V2_SCHEMA_VERSION;
  readonly requestId: string;
  readonly projectId: string;
  readonly projectRevisionId: ProjectRevisionId;
  readonly goal: string;
  readonly evidenceIds: readonly string[];
  readonly snapshot: SemanticSnapshotV1;
  readonly intelligence: SemanticIntelligenceV1;
}

export type CreativeBriefV2Confidence = 'low' | 'medium' | 'high';

export interface CreativeBriefV2Recommendation {
  readonly id: string;
  readonly summary: string;
  readonly rationale: string;
  readonly confidence: CreativeBriefV2Confidence;
  readonly evidenceIds: readonly string[];
}

export interface CreativeBriefV2Result {
  readonly schemaVersion: typeof CREATIVE_BRIEF_V2_SCHEMA_VERSION;
  readonly requestId: string;
  readonly projectId: string;
  readonly projectRevisionId: ProjectRevisionId;
  readonly summary: string;
  readonly rationale: string;
  readonly evidenceIds: readonly string[];
  readonly recommendations: readonly CreativeBriefV2Recommendation[];
  readonly warnings: readonly string[];
}

export interface CreativeBriefV2ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface CreativeBriefV2RequestValidationContext {
  readonly expectedProjectId?: string;
  readonly expectedProjectRevisionId?: ProjectRevisionId;
}

export function validateCreativeBriefV2Request(
  value: unknown,
  context: CreativeBriefV2RequestValidationContext = {},
): CreativeBriefV2ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return invalid('request must be an object');
  addUnknownFields(errors, value, [
    'schemaVersion',
    'requestId',
    'projectId',
    'projectRevisionId',
    'goal',
    'evidenceIds',
    'snapshot',
    'intelligence',
  ]);
  if (value.schemaVersion !== CREATIVE_BRIEF_V2_SCHEMA_VERSION)
    errors.push('schemaVersion must be 2');
  addIdentifierError(errors, value.requestId, 'requestId');
  addIdentifierError(errors, value.projectId, 'projectId');
  addRevisionError(errors, value.projectRevisionId, 'projectRevisionId');
  addTextError(errors, value.goal, 'goal', MAX_GOAL_LENGTH);

  const snapshotValidation = validateSemanticSnapshotV1(value.snapshot);
  errors.push(...snapshotValidation.errors.map((error) => `snapshot: ${error}`));
  const snapshot = snapshotValidation.valid ? (value.snapshot as SemanticSnapshotV1) : undefined;
  const intelligenceValidation = validateSemanticIntelligenceV1(
    value.intelligence,
    snapshot?.evidenceIds,
  );
  errors.push(...intelligenceValidation.errors.map((error) => `intelligence: ${error}`));
  const intelligence = intelligenceValidation.valid
    ? (value.intelligence as SemanticIntelligenceV1)
    : undefined;

  if (snapshot !== undefined && value.projectId !== snapshot.metadata.projectId)
    errors.push('projectId must match snapshot.metadata.projectId');
  if (intelligence !== undefined && value.projectId !== intelligence.metadata.projectId)
    errors.push('projectId must match intelligence.metadata.projectId');
  if (
    snapshot !== undefined &&
    intelligence !== undefined &&
    intelligence.snapshotRevision !== snapshot.metadata.revision
  )
    errors.push('intelligence snapshot revision must match the supplied snapshot');
  if (context.expectedProjectId !== undefined && value.projectId !== context.expectedProjectId)
    errors.push('projectId does not match the expected project');
  if (
    context.expectedProjectRevisionId !== undefined &&
    value.projectRevisionId !== context.expectedProjectRevisionId
  )
    errors.push('projectRevisionId does not match the expected revision');
  addEvidenceErrors(errors, value.evidenceIds, 'evidenceIds', snapshot);
  addUnsafeContentErrors(errors, value, 'request');
  return { valid: errors.length === 0, errors };
}

export function validateCreativeBriefV2Result(
  value: unknown,
  request: CreativeBriefV2Request,
): CreativeBriefV2ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return invalid('result must be an object');
  addUnknownFields(errors, value, [
    'schemaVersion',
    'requestId',
    'projectId',
    'projectRevisionId',
    'summary',
    'rationale',
    'evidenceIds',
    'recommendations',
    'warnings',
  ]);
  if (value.schemaVersion !== CREATIVE_BRIEF_V2_SCHEMA_VERSION)
    errors.push('schemaVersion must be 2');
  if (value.requestId !== request.requestId) errors.push('requestId must match the request');
  if (value.projectId !== request.projectId) errors.push('projectId must match the request');
  if (value.projectRevisionId !== request.projectRevisionId)
    errors.push('projectRevisionId must match the request');
  addTextError(errors, value.summary, 'summary', MAX_TEXT_LENGTH);
  addTextError(errors, value.rationale, 'rationale', MAX_TEXT_LENGTH);
  addEvidenceErrors(errors, value.evidenceIds, 'evidenceIds', request.snapshot);
  addStringArrayErrors(errors, value.warnings, 'warnings', MAX_RECOMMENDATIONS, false);

  if (!Array.isArray(value.recommendations)) {
    errors.push('recommendations must be an array');
  } else {
    if (value.recommendations.length > MAX_RECOMMENDATIONS)
      errors.push(`recommendations exceeds maximum length ${MAX_RECOMMENDATIONS}`);
    value.recommendations.forEach((recommendation, index) => {
      const path = `recommendations[${index}]`;
      if (!isRecord(recommendation)) {
        errors.push(`${path} must be an object`);
        return;
      }
      addUnknownFields(
        errors,
        recommendation,
        ['id', 'summary', 'rationale', 'confidence', 'evidenceIds'],
        path,
      );
      addIdentifierError(errors, recommendation.id, `${path}.id`);
      addTextError(errors, recommendation.summary, `${path}.summary`, MAX_TEXT_LENGTH);
      addTextError(errors, recommendation.rationale, `${path}.rationale`, MAX_TEXT_LENGTH);
      if (!['low', 'medium', 'high'].includes(String(recommendation.confidence)))
        errors.push(`${path}.confidence must be low, medium, or high`);
      addEvidenceErrors(
        errors,
        recommendation.evidenceIds,
        `${path}.evidenceIds`,
        request.snapshot,
      );
    });
  }
  addUnsafeContentErrors(errors, value, 'result');
  return { valid: errors.length === 0, errors };
}

/** Runtime namespace for the additive v2 contract; it has no transport or mutation authority. */
export const CreativeBriefV2 = {
  schemaVersion: CREATIVE_BRIEF_V2_SCHEMA_VERSION,
  validateRequest: validateCreativeBriefV2Request,
  validateResult: validateCreativeBriefV2Result,
} as const;

function invalid(error: string): CreativeBriefV2ValidationResult {
  return { valid: false, errors: [error] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addUnknownFields(
  errors: string[],
  value: Record<string, unknown>,
  allowed: readonly string[],
  path = 'request',
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path} contains unknown field ${key}`);
  }
}

function addIdentifierError(errors: string[], value: unknown, path: string): void {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    errors.push(`${path} must be a bounded non-empty identifier`);
}

function addRevisionError(errors: string[], value: unknown, path: string): void {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_REVISION_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    errors.push(`${path} must be a bounded non-empty revision`);
}

function addTextError(errors: string[], value: unknown, path: string, max: number): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max)
    errors.push(`${path} must be a bounded non-empty string`);
}

function addStringArrayErrors(
  errors: string[],
  value: unknown,
  path: string,
  max: number,
  requireNonEmpty: boolean,
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (requireNonEmpty && value.length === 0) errors.push(`${path} must not be empty`);
  if (value.length > max) errors.push(`${path} exceeds maximum length ${max}`);
  value.forEach((item, index) => addTextError(errors, item, `${path}[${index}]`, MAX_TEXT_LENGTH));
}

function addEvidenceErrors(
  errors: string[],
  value: unknown,
  path: string,
  snapshot: SemanticSnapshotV1 | undefined,
): void {
  addStringArrayErrors(errors, value, path, MAX_EVIDENCE, true);
  if (!Array.isArray(value) || snapshot === undefined) return;
  for (const evidenceId of value) {
    if (typeof evidenceId === 'string' && !hasEvidence(snapshot, evidenceId))
      errors.push(`${path} references unknown evidence id ${evidenceId}`);
  }
}

const DANGEROUS_KEYS = new Set([
  'command',
  'commands',
  'tool',
  'tools',
  'patch',
  'mutation',
  'operation',
  'operations',
  'execute',
  'executor',
  'write',
  'save',
]);

const UNSAFE_TEXT: readonly [RegExp, string][] = [
  [/\bhttps?:\/\//iu, 'URL'],
  [/\b(?:file|s3):\/\//iu, 'URL'],
  [/\b[A-Za-z]:\\/u, 'private path'],
  [/\b(?:api[_-]?key|secret|token|password)\s*[:=]/iu, 'credential'],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/u, 'credential'],
  [
    /\b(?:execute|apply|dispatch|run)\s+(?:this\s+)?(?:command|tool|patch|mutation)\b/iu,
    'command content',
  ],
];

function addUnsafeContentErrors(errors: string[], value: unknown, path: string): void {
  if (typeof value === 'string') {
    for (const [pattern, label] of UNSAFE_TEXT) {
      if (pattern.test(value)) errors.push(`${path} contains unsafe ${label}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => addUnsafeContentErrors(errors, item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/gu, '');
    if (DANGEROUS_KEYS.has(normalized) || normalized.includes('command'))
      errors.push(`${path}.${key} exposes a command or mutation surface`);
    addUnsafeContentErrors(errors, child, `${path}.${key}`);
  }
}
