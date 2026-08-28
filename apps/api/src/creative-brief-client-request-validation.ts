/**
 * Creative Brief Client Request Validation - WP-37 S4-F10-E3-B
 *
 * Strict browser-to-resolver validation for Creative Brief requests.
 * Validates the minimal client envelope before it reaches the resolver.
 *
 * No HTTP routes, resolver implementation, control plane access,
 * adapter changes, runtime configuration, secrets, environment access,
 * UI, deployment, or GBrain integration.
 */

import type { CreativeBriefRequestV1, CreativeBriefScope } from '@joy-media/agent-tools';
import { CREATIVE_BRIEF_SCOPES } from '@joy-media/agent-tools';

// ============================================================================
// Error Types
// ============================================================================

/** Typed error categories for Creative Brief client request validation */
export type CreativeBriefClientValidationErrorCode =
  | 'invalid-envelope'
  | 'payload-too-large'
  | 'unknown-field'
  | 'forbidden-field'
  | 'project-mismatch'
  | 'revision-mismatch'
  | 'invalid-request';

/** A single typed validation error */
export interface CreativeBriefClientValidationError {
  readonly code: CreativeBriefClientValidationErrorCode;
  readonly message: string;
  readonly path?: string;
}

/** Result of client request validation */
export interface CreativeBriefClientValidationResult {
  readonly valid: boolean;
  readonly errors: readonly CreativeBriefClientValidationError[];
}

// ============================================================================
// Size Limits
// ============================================================================

/** Maximum JSON payload size in bytes for client requests (256 KB) */
export const MAX_CREATIVE_BRIEF_CLIENT_REQUEST_BYTES = 256 * 1024;

// ============================================================================
// Client Request Envelope
// ============================================================================

/**
 * Browser-safe envelope for Creative Brief requests.
 * Contains ONLY the minimal identifiers and validated request.
 * This intentionally CANNOT carry:
 * - snapshot (S1 - server-side state)
 * - intelligence (S2 - server-side state)
 * - asset URLs
 * - paths
 * - credentials
 * - provider data
 * - arbitrary project state
 */
export interface CreativeBriefClientRequestEnvelope {
  /** Project identifier */
  readonly projectId: string;
  /** Snapshot revision identifier */
  readonly snapshotRevisionId: string;
  /** Validated creative brief request */
  readonly request: CreativeBriefRequestV1;
}

// ============================================================================
// Forbidden Top-Level Field Patterns
// ============================================================================

/**
 * Fields that must NEVER appear at the top level of the client envelope.
 * These represent server-side state or sensitive data that the browser must not supply.
 */
const FORBIDDEN_TOP_LEVEL_FIELDS = [
  // Server-side state (S1/S2)
  'snapshot',
  'intelligence',
  // Asset/location data
  'assets',
  'asset',
  'assetUrl',
  'assetURL',
  'urls',
  'url',
  'path',
  'paths',
  'file',
  'files',
  'location',
  'locations',
  // Provider/secret data
  'provider',
  'providers',
  'secret',
  'secrets',
  'apiKey',
  'api_key',
  'apikey',
  'token',
  'tokens',
  'credential',
  'credentials',
  'password',
  'passwords',
  'key',
  'keys',
] as const;

/**
 * Known top-level field names for the client envelope.
 * Any field not in this set is considered unknown and will be rejected.
 */
const KNOWN_TOP_LEVEL_FIELDS = new Set(['projectId', 'snapshotRevisionId', 'request']);

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate the client request envelope structure.
 * Checks for:
 * - Valid JSON object structure
 * - No unknown top-level fields
 * - No forbidden top-level fields
 * - Payload size within bounds
 * - Project/revision parity between outer and nested request
 *
 * @param envelope - The raw client request envelope to validate
 * @returns Validation result with errors if any
 */
export function validateCreativeBriefClientRequest(
  envelope: unknown,
): CreativeBriefClientValidationResult {
  const errors: CreativeBriefClientValidationError[] = [];

  // Check payload size first (before parsing)
  if (envelope !== null && typeof envelope === 'object') {
    try {
      const jsonString = JSON.stringify(envelope);
      if (jsonString.length > MAX_CREATIVE_BRIEF_CLIENT_REQUEST_BYTES) {
        errors.push({
          code: 'payload-too-large',
          message: `Request payload exceeds maximum size of ${MAX_CREATIVE_BRIEF_CLIENT_REQUEST_BYTES} bytes`,
        });
        return { valid: false, errors };
      }
    } catch {
      // If we can't stringify, it's too large or malformed
      errors.push({
        code: 'payload-too-large',
        message: 'Request payload is malformed or too large',
      });
      return { valid: false, errors };
    }
  }

  // Check for null/non-object
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    errors.push({
      code: 'invalid-envelope',
      message: 'Request must be a non-null object',
    });
    return { valid: false, errors };
  }

  const env = envelope as Record<string, unknown>;

  // Check for forbidden top-level fields
  for (const field of FORBIDDEN_TOP_LEVEL_FIELDS) {
    if (field in env) {
      errors.push({
        code: 'forbidden-field',
        message: `Forbidden field '${field}' found at top level`,
        path: field,
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Check for unknown top-level fields
  const allTopLevelFields = Object.keys(env);
  const unknownFields = allTopLevelFields.filter((field) => !KNOWN_TOP_LEVEL_FIELDS.has(field));

  if (unknownFields.length > 0) {
    errors.push({
      code: 'unknown-field',
      message: `Unknown top-level fields: ${unknownFields.join(', ')}`,
    });
  }

  // Check required fields
  if (!('projectId' in env)) {
    errors.push({
      code: 'invalid-envelope',
      message: 'Missing required field: projectId',
      path: 'projectId',
    });
  }

  if (!('snapshotRevisionId' in env)) {
    errors.push({
      code: 'invalid-envelope',
      message: 'Missing required field: snapshotRevisionId',
      path: 'snapshotRevisionId',
    });
  }

  if (!('request' in env)) {
    errors.push({
      code: 'invalid-envelope',
      message: 'Missing required field: request',
      path: 'request',
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Check field types
  const projectId = env.projectId;
  const snapshotRevisionId = env.snapshotRevisionId;
  const request = env.request;

  if (typeof projectId !== 'string' || projectId.trim() === '') {
    errors.push({
      code: 'invalid-envelope',
      message: 'projectId must be a non-empty string',
      path: 'projectId',
    });
  }

  if (typeof snapshotRevisionId !== 'string' || snapshotRevisionId.trim() === '') {
    errors.push({
      code: 'invalid-envelope',
      message: 'snapshotRevisionId must be a non-empty string',
      path: 'snapshotRevisionId',
    });
  }

  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    errors.push({
      code: 'invalid-request',
      message: 'request must be a non-null object',
      path: 'request',
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Validate the nested request using the same validation from agent-tools
  // We re-use the validation logic inline to avoid duplication
  const requestObj = request as Record<string, unknown>;

  // Check that request is a CreativeBriefRequestV1 structure
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

  const actualRequestFields = Object.keys(requestObj);
  const unknownRequestFields = actualRequestFields.filter((f) => !knownRequestFields.has(f));

  if (unknownRequestFields.length > 0) {
    errors.push({
      code: 'invalid-request',
      message: `request contains unknown fields: ${unknownRequestFields.join(', ')}`,
      path: 'request',
    });
  }

  // Check required fields in request
  if (
    requestObj.snapshotRevisionId === undefined ||
    requestObj.projectId === undefined ||
    requestObj.request === undefined ||
    requestObj.scope === undefined
  ) {
    errors.push({
      code: 'invalid-request',
      message: 'request is missing required fields',
      path: 'request',
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Validate request field types
  if (
    typeof requestObj.snapshotRevisionId !== 'string' ||
    requestObj.snapshotRevisionId.trim() === ''
  ) {
    errors.push({
      code: 'invalid-request',
      message: 'request.snapshotRevisionId must be a non-empty string',
      path: 'request.snapshotRevisionId',
    });
  }

  if (typeof requestObj.projectId !== 'string' || requestObj.projectId.trim() === '') {
    errors.push({
      code: 'invalid-request',
      message: 'request.projectId must be a non-empty string',
      path: 'request.projectId',
    });
  }

  if (typeof requestObj.request !== 'string' || requestObj.request.trim() === '') {
    errors.push({
      code: 'invalid-request',
      message: 'request.request must be a non-empty string',
      path: 'request.request',
    });
  }

  // Validate scope against canonical CreativeBriefScope contract
  if (
    requestObj.scope !== undefined &&
    !CREATIVE_BRIEF_SCOPES.includes(requestObj.scope as CreativeBriefScope)
  ) {
    errors.push({
      code: 'invalid-request',
      message: 'request.scope must be a valid CreativeBriefScope',
      path: 'request.scope',
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Validate maxRecommendations
  if (
    requestObj.maxRecommendations !== undefined &&
    (typeof requestObj.maxRecommendations !== 'number' ||
      requestObj.maxRecommendations < 1 ||
      requestObj.maxRecommendations > 20 ||
      !Number.isInteger(requestObj.maxRecommendations))
  ) {
    errors.push({
      code: 'invalid-request',
      message: 'request.maxRecommendations must be an integer between 1 and 20',
      path: 'request.maxRecommendations',
    });
  }

  // Validate durationTargetUs
  if (
    requestObj.durationTargetUs !== undefined &&
    (typeof requestObj.durationTargetUs !== 'number' ||
      requestObj.durationTargetUs < 0 ||
      !Number.isSafeInteger(requestObj.durationTargetUs))
  ) {
    errors.push({
      code: 'invalid-request',
      message: 'request.durationTargetUs must be a non-negative safe integer',
      path: 'request.durationTargetUs',
    });
  }

  // Validate brief
  if (
    requestObj.brief !== undefined &&
    (typeof requestObj.brief !== 'string' || requestObj.brief.length > 1000)
  ) {
    errors.push({
      code: 'invalid-request',
      message: 'request.brief must be a string with maximum length 1000',
      path: 'request.brief',
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Check project/revision parity between outer envelope and nested request
  if (projectId !== requestObj.projectId) {
    errors.push({
      code: 'project-mismatch',
      message: 'Top-level projectId does not match request.projectId',
      path: 'projectId',
    });
  }

  if (snapshotRevisionId !== requestObj.snapshotRevisionId) {
    errors.push({
      code: 'revision-mismatch',
      message: 'Top-level snapshotRevisionId does not match request.snapshotRevisionId',
      path: 'snapshotRevisionId',
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, errors: [] };
}

/**
 * Type guard for valid client request envelope.
 * Only use after successful validation.
 */
export function isValidCreativeBriefClientRequest(
  envelope: unknown,
): envelope is CreativeBriefClientRequestEnvelope {
  return (
    envelope !== null &&
    typeof envelope === 'object' &&
    !Array.isArray(envelope) &&
    'projectId' in envelope &&
    'snapshotRevisionId' in envelope &&
    'request' in envelope
  );
}
