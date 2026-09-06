/**
 * Typed verification evidence for the Live Director loop. It intentionally
 * separates structural, rendered, measured, model, and human conclusions so a
 * pleasant model answer can never be displayed as a rendered/export proof.
 */
export const DIRECTOR_VERIFICATION_METHODS = [
  'structural',
  'rendered',
  'audio-measured',
  'model-reviewed',
  'user-approved',
  'encoded-output',
] as const;
export type DirectorVerificationMethod = (typeof DIRECTOR_VERIFICATION_METHODS)[number];

export type DirectorVerificationCheckStatus = 'passed' | 'failed' | 'unavailable';
export type DirectorVerificationOverall = 'verified' | 'incomplete' | 'failed';

export interface DirectorVerificationCheck {
  readonly id: string;
  readonly method: DirectorVerificationMethod;
  readonly status: DirectorVerificationCheckStatus;
  /** Opaque local evidence/receipt IDs; never source URLs, bytes, or prompts. */
  readonly evidenceIds: readonly string[];
  readonly summary: string;
  /** Required for model review and unavailable evidence. */
  readonly uncertainty?: string;
}

export interface DirectorVerificationReport {
  readonly version: 1;
  readonly projectId: string;
  readonly revision: string;
  readonly overall: DirectorVerificationOverall;
  readonly checks: readonly DirectorVerificationCheck[];
}

export interface DirectorVerificationReportInput {
  readonly projectId: string;
  readonly revision: string;
  readonly checks: readonly DirectorVerificationCheck[];
}

export interface DirectorVerificationValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

const METHODS = new Set<string>(DIRECTOR_VERIFICATION_METHODS);
const STATUS = new Set<string>(['passed', 'failed', 'unavailable']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@=-]{0,255}$/;
const UNSAFE_TEXT =
  /(?:https?:\/\/|(?:^|[^a-z])(?:file|blob|data):|\b(?:api[ _-]?key|authorization|bearer|password|secret|credential)\b|\b[A-Za-z]:[\\/])/i;
const REQUIRED_DELIVERABLE_METHODS: readonly DirectorVerificationMethod[] = [
  'structural',
  'rendered',
  'audio-measured',
  'encoded-output',
];

/** Create a frozen report with a conservative overall result. */
export function createDirectorVerificationReport(
  input: DirectorVerificationReportInput,
): DirectorVerificationReport {
  const preliminary: DirectorVerificationReport = {
    version: 1,
    projectId: input.projectId,
    revision: input.revision,
    overall: 'incomplete',
    checks: input.checks,
  };
  const validation = validateReportShape(preliminary, false);
  if (!validation.valid)
    throw new TypeError(`JOY_DIRECTOR_VERIFICATION_INVALID:${validation.errors[0]}`);
  const checks = Object.freeze(input.checks.map(cloneCheck));
  return Object.freeze({
    version: 1,
    projectId: input.projectId,
    revision: input.revision,
    overall: deriveOverall(checks),
    checks,
  });
}

/** Validate an untrusted/imported verification report without accepting its claim blindly. */
export function validateDirectorVerificationReport(
  value: unknown,
): DirectorVerificationValidationResult {
  return validateReportShape(value, true);
}

function validateReportShape(
  value: unknown,
  requireCorrectOverall: boolean,
): DirectorVerificationValidationResult {
  const errors: string[] = [];
  if (!isPlainRecord(value)) return invalid('invalid-report-shape');
  if (!hasExactKeys(value, ['version', 'projectId', 'revision', 'overall', 'checks']))
    return invalid('invalid-report-fields');
  if (value.version !== 1) errors.push('unsupported-version');
  if (!isSafeId(value.projectId)) errors.push('invalid-project');
  if (!isSafeId(value.revision)) errors.push('invalid-revision');
  if (!['verified', 'incomplete', 'failed'].includes(value.overall as string))
    errors.push('invalid-overall');
  const checks = value.checks;
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > 32) {
    errors.push('invalid-checks');
  } else {
    const ids = new Set<string>();
    for (const check of checks) {
      const checkErrors = validateCheck(check);
      errors.push(...checkErrors);
      if (isPlainRecord(check) && typeof check.id === 'string') {
        if (ids.has(check.id)) errors.push('duplicate-check-id');
        ids.add(check.id);
      }
    }
    if (requireCorrectOverall && errors.length === 0) {
      const expected = deriveOverall(checks as readonly DirectorVerificationCheck[]);
      if (value.overall !== expected) errors.push('overall-does-not-match-evidence');
    }
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze([...new Set(errors)]) });
}

function validateCheck(value: unknown): readonly string[] {
  if (!isPlainRecord(value)) return ['invalid-check'];
  const optionalUncertainty = value.uncertainty === undefined ? [] : ['uncertainty'];
  if (
    !hasExactKeys(value, [
      'id',
      'method',
      'status',
      'evidenceIds',
      'summary',
      ...optionalUncertainty,
    ])
  )
    return ['invalid-check-fields'];
  const errors: string[] = [];
  if (!isSafeId(value.id)) errors.push('invalid-check-id');
  if (typeof value.method !== 'string' || !METHODS.has(value.method)) errors.push('invalid-method');
  if (typeof value.status !== 'string' || !STATUS.has(value.status)) errors.push('invalid-status');
  if (!isSafeText(value.summary, 512)) errors.push('unsafe-summary');
  if (!isEvidenceIds(value.evidenceIds)) errors.push('invalid-evidence-ids');
  if (value.uncertainty !== undefined && !isSafeText(value.uncertainty, 512))
    errors.push('unsafe-uncertainty');
  const method = value.method as DirectorVerificationMethod | undefined;
  const status = value.status as DirectorVerificationCheckStatus | undefined;
  if (status === 'passed' && (!Array.isArray(value.evidenceIds) || value.evidenceIds.length === 0))
    errors.push('passed-check-requires-evidence');
  if (
    (status === 'unavailable' || method === 'model-reviewed') &&
    !isSafeText(value.uncertainty, 512)
  )
    errors.push('uncertainty-required');
  return errors;
}

function deriveOverall(checks: readonly DirectorVerificationCheck[]): DirectorVerificationOverall {
  if (checks.some((check) => check.status === 'failed')) return 'failed';
  const complete = REQUIRED_DELIVERABLE_METHODS.every((method) =>
    checks.some((check) => check.method === method && check.status === 'passed'),
  );
  return complete ? 'verified' : 'incomplete';
}

function cloneCheck(check: DirectorVerificationCheck): DirectorVerificationCheck {
  return Object.freeze({
    id: check.id,
    method: check.method,
    status: check.status,
    evidenceIds: Object.freeze([...check.evidenceIds]),
    summary: check.summary,
    ...(check.uncertainty === undefined ? {} : { uncertainty: check.uncertainty }),
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function isSafeText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !UNSAFE_TEXT.test(value)
  );
}

function isEvidenceIds(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 512 &&
    value.every((item) => isSafeId(item)) &&
    new Set(value).size === value.length
  );
}

function invalid(error: string): DirectorVerificationValidationResult {
  return Object.freeze({ valid: false, errors: Object.freeze([error]) });
}
