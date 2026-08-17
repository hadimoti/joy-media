/**
 * Creative Brief Server Request Validation - WP-37 S4-F3
 *
 * Strict server-side validation for Creative Brief API requests.
 * Validates envelope structure, project/revision parity, size bounds,
 * and forbids any command, job, approval, provider, or secret data.
 */

import type {
  SemanticProjectSnapshotV1,
  ProjectRevisionId,
} from '@joy-media/project-schema';
import type {
  BrandReadinessV1,
  SceneCoverageV1,
  ProjectReadinessV1,
  IntelligenceRuleV1,
} from '@joy-media/project-schema';
import type {
  CreativeBriefRequestV1,
  CreativeBriefScope,
  DestinationPreset,
} from '@joy-media/agent-tools';
import { MAX_LENGTHS as AGENT_TOOLS_MAX_LENGTHS, FORBIDDEN_PATTERNS } from '@joy-media/agent-tools';

// ============================================================================
// Error Types
// ============================================================================

/** Typed error categories for Creative Brief request validation */
export type CreativeBriefValidationErrorCode =
  | 'invalid-request'
  | 'project-mismatch'
  | 'revision-mismatch'
  | 'payload-too-large'
  | 'forbidden-data';

export interface CreativeBriefValidationError {
  readonly code: CreativeBriefValidationErrorCode;
  readonly message: string;
  readonly path?: string;
}

export interface CreativeBriefValidationResult {
  readonly valid: boolean;
  readonly errors: readonly CreativeBriefValidationError[];
}

// ============================================================================
// Size Limits
// ============================================================================

/** Maximum JSON payload size in bytes (2 MB) */
export const MAX_CREATIVE_BRIEF_REQUEST_BYTES = 2 * 1024 * 1024;

/** Maximum S1 snapshot JSON size in bytes (1 MB) */
export const MAX_SNAPSHOT_BYTES = 1 * 1024 * 1024;

/** Maximum S2 intelligence JSON size in bytes (512 KB) */
export const MAX_INTELLIGENCE_BYTES = 512 * 1024;

/** Maximum request string length in UTF-16 code units */
export const MAX_REQUEST_LENGTH = 512;

/** Maximum brief string length in UTF-16 code units */
export const MAX_BRIEF_LENGTH = 1000;

// ============================================================================
// Forbidden Field Names
// ============================================================================

/** Fields that must never appear in a read-only Creative Brief request */
const FORBIDDEN_FIELD_PATTERNS = [
  // Command execution
  /^command[s]?$/i,
  /^action[s]?$/i,
  /^execute/i,
  /^apply/i,
  /^run/i,
  // Job/approval system
  /^job[s]?$/i,
  /^approval[s]?$/i,
  /^plan[s]?$/i,
  /^step[s]?$/i,
  // Provider/model configuration
  /^provider[s]?$/i,
  /^model[s]?$/i,
  /^adapter[s]?$/i,
  /^api[i]?Key/i,
  /^secret[s]?$/i,
  /^token[s]?$/i,
  /^credential[s]?$/i,
  /^password[s]?$/i,
  // Persistence/mutation
  /^write/i,
  /^mutate/i,
  /^update/i,
  /^delete/i,
  /^create/i,
  /^persist/i,
  /^cache/i,
  // Network/remote
  /^url[s]?$/i,
  /^uri[s]?$/i,
  /^endpoint[s]?$/i,
  /^host[i]?$/i,
  /^path[s]?$/i,
  /^file[i]?$/i,
] as const;

// ============================================================================
// Server Request Envelope
// ============================================================================

/**
 * Validated server-side request envelope for Creative Brief generation.
 * This is the bounded input that the future route handler will accept.
 */
export interface CreativeBriefServerRequest {
  /** Route-level project ID from URL path */
  readonly projectId: string;
  
  /** Snapshot revision ID from URL path or query */
  readonly snapshotRevisionId: ProjectRevisionId;
  
  /** Bounded S1 semantic project snapshot */
  readonly snapshot: SemanticProjectSnapshotV1;
  
  /** Bounded S2 intelligence data */
  readonly intelligence: {
    readonly brandReadiness: BrandReadinessV1;
    readonly sceneCoverages: readonly SceneCoverageV1[];
    readonly projectReadiness: ProjectReadinessV1;
    readonly rules: readonly IntelligenceRuleV1[];
  };
  
  /** Bounded CreativeBriefRequestV1 from user */
  readonly request: CreativeBriefRequestV1;
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Check if a string field contains forbidden credential/secret patterns.
 * Uses the same FORBIDDEN_PATTERNS from agent-tools for consistency.
 */
function containsForbiddenPattern(value: string): boolean {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if an object contains any forbidden field names.
 */
function hasForbiddenFields(obj: Record<string, unknown>): string[] {
  const forbidden: string[] = [];
  const allKeys = Object.keys(obj);
  
  for (const key of allKeys) {
    for (const pattern of FORBIDDEN_FIELD_PATTERNS) {
      if (pattern.test(key)) {
        forbidden.push(key);
        break;
      }
    }
  }
  
  return forbidden;
}

/**
 * Recursively check an object for forbidden string patterns in all string values.
 */
function deepCheckForbiddenPatterns(obj: unknown, path: string = ''): string[] {
  const violations: string[] = [];
  
  if (obj === null || typeof obj !== 'object') {
    return violations;
  }
  
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      violations.push(...deepCheckForbiddenPatterns(obj[i], `${path}[${i}]`));
    }
    return violations;
  }
  
  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    const currentPath = path ? `${path}.${key}` : key;
    
    if (typeof value === 'string') {
      if (containsForbiddenPattern(value)) {
        violations.push(currentPath);
      }
    } else {
      violations.push(...deepCheckForbiddenPatterns(value, currentPath));
    }
  }
  
  return violations;
}

/**
 * Validate a string value against length bounds and forbidden patterns.
 */
function validateStringField(
  value: unknown,
  fieldName: string,
  maxLength: number,
  errors: CreativeBriefValidationError[],
): void {
  if (typeof value !== 'string') {
    errors.push({
      code: 'invalid-request',
      message: `${fieldName} must be a string`,
      path: fieldName,
    });
    return;
  }
  
  if (value.length === 0) {
    errors.push({
      code: 'invalid-request',
      message: `${fieldName} must be a non-empty string`,
      path: fieldName,
    });
    return;
  }
  
  if (value.length > maxLength) {
    errors.push({
      code: 'payload-too-large',
      message: `${fieldName} must be <= ${maxLength} characters, got ${value.length}`,
      path: fieldName,
    });
  }
  
  if (containsForbiddenPattern(value)) {
    errors.push({
      code: 'forbidden-data',
      message: `${fieldName} contains forbidden pattern (potential secret or path)`,
      path: fieldName,
    });
  }
}

/**
 * Validate that a value is a valid CreativeBriefScope.
 */
function validateScope(value: unknown, path: string, errors: CreativeBriefValidationError[]): void {
  const validScopes: readonly CreativeBriefScope[] = [
    'pacing',
    'caption-coverage',
    'visual-coverage',
    'brand-alignment',
    'audio-quality',
    'structure',
    'general',
  ] as const;
  
  if (typeof value !== 'string') {
    errors.push({
      code: 'invalid-request',
      message: `${path} must be a string`,
      path,
    });
    return;
  }
  
  if (!validScopes.includes(value as CreativeBriefScope)) {
    errors.push({
      code: 'invalid-request',
      message: `${path} must be one of: ${validScopes.join(', ')}`,
      path,
    });
  }
}

/**
 * Validate that a value is a valid DestinationPreset.
 */
function validateDestinationPreset(
  value: unknown,
  path: string,
  errors: CreativeBriefValidationError[],
): void {
  const validPresets: readonly DestinationPreset[] = [
    'instagram-reel',
    'instagram-story',
    'tiktok',
    'youtube-short',
    'youtube-video',
    'twitter-x',
    'facebook-reel',
    'linkedin-video',
    'custom',
  ] as const;
  
  if (value === undefined) return;
  
  if (typeof value !== 'string') {
    errors.push({
      code: 'invalid-request',
      message: `${path} must be a string if provided`,
      path,
    });
    return;
  }
  
  if (!validPresets.includes(value as DestinationPreset)) {
    errors.push({
      code: 'invalid-request',
      message: `${path} must be one of: ${validPresets.join(', ')}`,
      path,
    });
  }
}

/**
 * Validate that a value is a non-negative integer.
 */
function validateNonNegativeInteger(
  value: unknown,
  fieldName: string,
  errors: CreativeBriefValidationError[],
): void {
  if (value === undefined) return;
  
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    errors.push({
      code: 'invalid-request',
      message: `${fieldName} must be a non-negative number if provided`,
      path: fieldName,
    });
  }
}

/**
 * Validate that a value is a positive integer (>= 1).
 */
function validatePositiveInteger(
  value: unknown,
  fieldName: string,
  errors: CreativeBriefValidationError[],
  maxValue?: number,
): void {
  if (value === undefined) return;
  
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    errors.push({
      code: 'invalid-request',
      message: `${fieldName} must be a positive integer${maxValue ? ` between 1 and ${maxValue}` : ''} if provided`,
      path: fieldName,
    });
    return;
  }
  
  if (maxValue !== undefined && value > maxValue) {
    errors.push({
      code: 'invalid-request',
      message: `${fieldName} must be between 1 and ${maxValue}`,
      path: fieldName,
    });
  }
}

/**
 * Validate that an array value has a maximum length.
 */
function validateArrayLength(
  value: unknown,
  fieldName: string,
  maxLength: number,
  errors: CreativeBriefValidationError[],
): void {
  if (value === undefined) return;
  
  if (!Array.isArray(value)) {
    errors.push({
      code: 'invalid-request',
      message: `${fieldName} must be an array if provided`,
      path: fieldName,
    });
    return;
  }
  
  if (value.length > maxLength) {
    errors.push({
      code: 'payload-too-large',
      message: `${fieldName} must have <= ${maxLength} items, got ${value.length}`,
      path: fieldName,
    });
  }
}

/**
 * Validate CreativeBriefRequestV1 structure and content.
 */
function validateCreativeBriefRequestV1(
  request: unknown,
  path: string,
  errors: CreativeBriefValidationError[],
): void {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    errors.push({
      code: 'invalid-request',
      message: `${path} must be a non-null object`,
      path,
    });
    return;
  }
  
  const r = request as Record<string, unknown>;
  
  // Check for forbidden field names
  const forbiddenFields = hasForbiddenFields(r);
  if (forbiddenFields.length > 0) {
    errors.push({
      code: 'forbidden-data',
      message: `${path} contains forbidden field names: ${forbiddenFields.join(', ')}`,
      path,
    });
    return; // Don't continue validating if forbidden fields exist
  }
  
  // Check for unknown fields - CreativeBriefRequestV1 has specific known fields
  const knownRequestFields = new Set([
    'snapshotRevisionId',
    'projectId',
    'request',
    'scope',
    'maxRecommendations',
    'allowedRecommendationKinds',
    'destination',
    'durationTargetUs',
    'brief',
  ]);
  const actualRequestFields = Object.keys(r);
  const unknownRequestFields = actualRequestFields.filter(f => !knownRequestFields.has(f));
  
  if (unknownRequestFields.length > 0) {
    errors.push({
      code: 'invalid-request',
      message: `${path} contains unknown fields: ${unknownRequestFields.join(', ')}`,
      path,
    });
    return; // Don't continue validating if unknown fields exist
  }
  
  // Required fields
  validateStringField(r.snapshotRevisionId, `${path}.snapshotRevisionId`, 256, errors);
  validateStringField(r.projectId, `${path}.projectId`, 256, errors);
  validateStringField(r.request, `${path}.request`, MAX_REQUEST_LENGTH, errors);
  validateScope(r.scope, `${path}.scope`, errors);
  
  // Optional fields - only validate if present
  if (r.brief !== undefined) {
    validateStringField(r.brief, `${path}.brief`, MAX_BRIEF_LENGTH, errors);
  }
  validateDestinationPreset(r.destination, `${path}.destination`, errors);
  validateNonNegativeInteger(r.durationTargetUs, `${path}.durationTargetUs`, errors);
  validatePositiveInteger(r.maxRecommendations, `${path}.maxRecommendations`, errors, AGENT_TOOLS_MAX_LENGTHS.recommendationCount);
  
  // Validate allowedRecommendationKinds
  if (r.allowedRecommendationKinds !== undefined) {
    validateArrayLength(r.allowedRecommendationKinds, `${path}.allowedRecommendationKinds`, 20, errors);
  }
  
  // Deep check for forbidden patterns in all string fields
  const patternViolations = deepCheckForbiddenPatterns(request, path);
  if (patternViolations.length > 0) {
    errors.push({
      code: 'forbidden-data',
      message: `Forbidden patterns found in: ${patternViolations.join(', ')}`,
      path,
    });
  }
}

/**
 * Estimate the size of a JSON-serializable object in bytes.
 */
function estimateJsonSize(obj: unknown): number {
  try {
    return JSON.stringify(obj).length;
  } catch {
    return Infinity;
  }
}

/**
 * Validate the size of the S1 snapshot.
 */
function validateSnapshotSize(
  snapshot: unknown,
  errors: CreativeBriefValidationError[],
): void {
  const size = estimateJsonSize(snapshot);
  if (size > MAX_SNAPSHOT_BYTES) {
    errors.push({
      code: 'payload-too-large',
      message: `snapshot must be <= ${MAX_SNAPSHOT_BYTES} bytes, estimated ${size}`,
      path: 'snapshot',
    });
  }
}

/**
 * Validate the size of the S2 intelligence data.
 */
function validateIntelligenceSize(
  intelligence: unknown,
  errors: CreativeBriefValidationError[],
): void {
  const size = estimateJsonSize(intelligence);
  if (size > MAX_INTELLIGENCE_BYTES) {
    errors.push({
      code: 'payload-too-large',
      message: `intelligence must be <= ${MAX_INTELLIGENCE_BYTES} bytes, estimated ${size}`,
      path: 'intelligence',
    });
  }
}

// ============================================================================
// Main Validation Function
// ============================================================================

/**
 * Validate a server-side Creative Brief request envelope.
 * 
 * Checks:
 * - Route projectId matches envelope projectId
 * - Route projectId matches snapshot.projectId
 * - Route snapshotRevisionId matches request.snapshotRevisionId
 * - Route snapshotRevisionId matches snapshot.revisionId
 * - No forbidden field names or patterns
 * - No command/job/approval/provider/secret data
 * - Size bounds for all components
 * - Valid scope, destination, and numeric fields
 * - Input is not mutated
 * 
 * @param envelope - The raw request envelope from the route handler
 * @param routeProjectId - The projectId extracted from the URL path
 * @param routeSnapshotRevisionId - The snapshotRevisionId extracted from the URL path
 * @returns Validation result with errors if any
 */
export function validateCreativeBriefServerRequest(
  envelope: unknown,
  routeProjectId: string,
  routeSnapshotRevisionId: ProjectRevisionId,
): CreativeBriefValidationResult {
  const errors: CreativeBriefValidationError[] = [];
  
  // Must be an object
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return {
      valid: false,
      errors: [{
        code: 'invalid-request',
        message: 'Request envelope must be a non-null object',
      }],
    };
  }
  
  const env = envelope as Record<string, unknown>;
  
  // Check for forbidden field names at the top level
  const forbiddenFields = hasForbiddenFields(env);
  if (forbiddenFields.length > 0) {
    errors.push({
      code: 'forbidden-data',
      message: `Request envelope contains forbidden field names: ${forbiddenFields.join(', ')}`,
    });
    return { valid: false, errors };
  }
  
  // Check for unknown fields at the top level
  const expectedTopLevelFields = new Set([
    'projectId',
    'snapshotRevisionId',
    'snapshot',
    'intelligence',
    'request',
  ]);
  const actualFields = Object.keys(env);
  const unknownFields = actualFields.filter(f => !expectedTopLevelFields.has(f));
  
  if (unknownFields.length > 0) {
    errors.push({
      code: 'invalid-request',
      message: `Unknown fields in request envelope: ${unknownFields.join(', ')}`,
    });
  }
  
  // Validate projectId
  if (typeof env.projectId !== 'string' || env.projectId.length === 0) {
    errors.push({
      code: 'invalid-request',
      message: 'envelope.projectId is required and must be a non-empty string',
      path: 'envelope.projectId',
    });
  } else {
    // Check for forbidden patterns
    if (containsForbiddenPattern(env.projectId)) {
      errors.push({
        code: 'forbidden-data',
        message: 'envelope.projectId contains forbidden pattern',
        path: 'envelope.projectId',
      });
    }
  }
  
  // Validate snapshotRevisionId
  if (typeof env.snapshotRevisionId !== 'string' || env.snapshotRevisionId.length === 0) {
    errors.push({
      code: 'invalid-request',
      message: 'envelope.snapshotRevisionId is required and must be a non-empty string',
      path: 'envelope.snapshotRevisionId',
    });
  } else {
    // Check for forbidden patterns
    if (containsForbiddenPattern(env.snapshotRevisionId)) {
      errors.push({
        code: 'forbidden-data',
        message: 'envelope.snapshotRevisionId contains forbidden pattern',
        path: 'envelope.snapshotRevisionId',
      });
    }
  }
  
  // Validate snapshot exists and has correct structure
  if (env.snapshot === undefined) {
    errors.push({
      code: 'invalid-request',
      message: 'envelope.snapshot is required',
      path: 'envelope.snapshot',
    });
  } else {
    validateSnapshotSize(env.snapshot, errors);
  }
  
  // Validate intelligence exists and has correct structure
  if (env.intelligence === undefined) {
    errors.push({
      code: 'invalid-request',
      message: 'envelope.intelligence is required',
      path: 'envelope.intelligence',
    });
  } else {
    validateIntelligenceSize(env.intelligence, errors);
  }
  
  // Validate request
  if (env.request === undefined) {
    errors.push({
      code: 'invalid-request',
      message: 'envelope.request is required',
      path: 'envelope.request',
    });
  } else {
    validateCreativeBriefRequestV1(env.request, 'envelope.request', errors);
  }
  
  // If we have structural errors (missing required fields), return early
  // This prevents cascading errors when basic structure is invalid
  const structuralErrors = errors.filter(e => e.code === 'invalid-request');
  if (structuralErrors.length > 0) {
    return { valid: false, errors };
  }
  
  // Now check project/revision parity
  // We need to check that all project IDs match
  const envelopeProjectId = env.projectId as string | undefined;
  const envelopeSnapshotRevisionId = env.snapshotRevisionId as string | undefined;
  const snapshot = env.snapshot as SemanticProjectSnapshotV1 | undefined;
  const request = env.request as CreativeBriefRequestV1 | undefined;
  
  // Check route projectId matches envelope projectId
  if (envelopeProjectId && envelopeProjectId !== routeProjectId) {
    errors.push({
      code: 'project-mismatch',
      message: `Route projectId (${routeProjectId}) does not match envelope projectId (${envelopeProjectId})`,
      path: 'projectId',
    });
  }
  
  // Check envelope projectId matches snapshot.projectId
  if (envelopeProjectId && snapshot && snapshot.projectId !== envelopeProjectId) {
    errors.push({
      code: 'project-mismatch',
      message: `Envelope projectId (${envelopeProjectId}) does not match snapshot.projectId (${snapshot.projectId})`,
      path: 'snapshot.projectId',
    });
  }
  
  // Check envelope projectId matches request.projectId
  if (envelopeProjectId && request && request.projectId !== envelopeProjectId) {
    errors.push({
      code: 'project-mismatch',
      message: `Envelope projectId (${envelopeProjectId}) does not match request.projectId (${request.projectId})`,
      path: 'request.projectId',
    });
  }
  
  // Check route snapshotRevisionId matches envelope snapshotRevisionId
  if (envelopeSnapshotRevisionId && envelopeSnapshotRevisionId !== routeSnapshotRevisionId) {
    errors.push({
      code: 'revision-mismatch',
      message: `Route snapshotRevisionId (${routeSnapshotRevisionId}) does not match envelope snapshotRevisionId (${envelopeSnapshotRevisionId})`,
      path: 'snapshotRevisionId',
    });
  }
  
  // Check envelope snapshotRevisionId matches snapshot.revisionId
  if (envelopeSnapshotRevisionId && snapshot && snapshot.revisionId !== envelopeSnapshotRevisionId) {
    errors.push({
      code: 'revision-mismatch',
      message: `Envelope snapshotRevisionId (${envelopeSnapshotRevisionId}) does not match snapshot.revisionId (${snapshot.revisionId})`,
      path: 'snapshot.revisionId',
    });
  }
  
  // Check envelope snapshotRevisionId matches request.snapshotRevisionId
  if (envelopeSnapshotRevisionId && request && request.snapshotRevisionId !== envelopeSnapshotRevisionId) {
    errors.push({
      code: 'revision-mismatch',
      message: `Envelope snapshotRevisionId (${envelopeSnapshotRevisionId}) does not match request.snapshotRevisionId (${request.snapshotRevisionId})`,
      path: 'request.snapshotRevisionId',
    });
  }
  
  const valid = errors.length === 0;
  return { valid, errors: Object.freeze(errors.slice()) };
}
