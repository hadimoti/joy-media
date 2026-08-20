import { containsForbiddenPattern, deepCheckForbiddenPatterns } from './creative-brief.js';

export const JOY_CODE_PLAN_SCHEMA_VERSION = 1 as const;

export const JOY_CODE_OPERATION_KINDS = [
  'timeline.trimClip',
  'timeline.splitClip',
  'timeline.moveClip',
  'timeline.removeClip',
  'timeline.insertExistingAsset',
  'text.insertTemplate',
  'text.setContent',
  'text.setTemplate',
  'caption.setSegmentText',
  'caption.setSegmentTiming',
  'caption.setTemplate',
  'caption.setBurnIn',
  'transition.addAtJunction',
  'transition.remove',
] as const;

export type JoyCodeOperationKind = (typeof JOY_CODE_OPERATION_KINDS)[number];

export const JOY_CODE_PLACEMENT_PRESETS = [
  'center',
  'top',
  'bottom',
  'lower-third',
] as const;

export type JoyCodePlacementPreset = (typeof JOY_CODE_PLACEMENT_PRESETS)[number];

export const JOY_CODE_PLAN_LIMITS = {
  goal: 1_000,
  summary: 4_000,
  operations: 24,
  operationId: 128,
  dependencyCount: 24,
  assumptions: 10,
  blockedBy: 10,
  humanDecisions: 10,
  contextNote: 1_000,
  textContent: 500,
  genericId: 160,
  planId: 160,
  catalogVersion: 100,
  transitionMinUs: 100_000,
  transitionMaxUs: 1_500_000,
  titleMinDurationUs: 500_000,
  titleMaxDurationUs: 10_000_000,
} as const;

export interface JoyCodePlanValidationError {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export type JoyCodePlanValidationResult<T> =
  | {
      readonly valid: true;
      readonly value: T;
      readonly errors: readonly [];
    }
  | {
      readonly valid: false;
      readonly errors: readonly JoyCodePlanValidationError[];
    };

export interface JoyCodeValidationOptions {
  readonly textTemplateIds: readonly string[];
  readonly captionTemplateIds: readonly string[];
  readonly transitionIds: readonly string[];
  readonly allowedModelIds?: readonly string[];
  readonly consentVersion?: string;
}

interface JoyCodeOperationBase {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly kind: JoyCodeOperationKind;
}

export interface JoyCodeTrimClipOperationV1 extends JoyCodeOperationBase {
  readonly kind: 'timeline.trimClip';
  readonly compositionId: string;
  readonly trackId: string;
  readonly clipId: string;
  readonly newStartUs: number;
  readonly newEndUs: number;
}

export interface JoyCodeSplitClipOperationV1 extends JoyCodeOperationBase {
  readonly kind: 'timeline.splitClip';
  readonly compositionId: string;
  readonly trackId: string;
  readonly clipId: string;
  readonly atUs: number;
}

export interface JoyCodeMoveClipOperationV1 extends JoyCodeOperationBase {
  readonly kind: 'timeline.moveClip';
  readonly compositionId: string;
  readonly sourceTrackId: string;
  readonly targetTrackId: string;
  readonly clipId: string;
  readonly newStartUs: number;
}

export interface JoyCodeRemoveClipOperationV1 extends JoyCodeOperationBase {
  readonly kind: 'timeline.removeClip';
  readonly compositionId: string;
  readonly trackId: string;
  readonly clipId: string;
}

export interface JoyCodeInsertExistingAssetOperationV1 extends JoyCodeOperationBase {
  readonly kind: 'timeline.insertExistingAsset';
  readonly compositionId: string;
  readonly targetTrackId: string;
  readonly assetId: string;
  readonly startUs: number;
  readonly durationUs: number;
}

export interface JoyCodeInsertTemplateOperationV1 extends JoyCodeOperationBase {
  readonly kind: 'text.insertTemplate';
  readonly templateId: string;
  readonly content: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly placementPreset: JoyCodePlacementPreset;
}

export interface JoyCodeSetTextContentOperationV1 extends JoyCodeOperationBase {
  readonly kind: 'text.setContent';
  readonly objectId: string;
  readonly content: string;
}

export interface JoyCodeSetTextTemplateOperationV1 extends JoyCodeOperationBase {
  readonly kind: 'text.setTemplate';
  readonly objectId: string;
  readonly templateId: string;
}

export interface JoyCodeSetCaptionTextOperationV1 extends JoyCodeOperationBase {
  readonly kind: 'caption.setSegmentText';
  readonly captionClipId: string;
  readonly segmentId: string;
  readonly text: string;
}

export interface JoyCodeSetCaptionTimingOperationV1 extends JoyCodeOperationBase {
  readonly kind: 'caption.setSegmentTiming';
  readonly captionClipId: string;
  readonly segmentId: string;
  readonly startUs: number;
  readonly endUs: number;
}

export interface JoyCodeSetCaptionTemplateOperationV1 extends JoyCodeOperationBase {
  readonly kind: 'caption.setTemplate';
  readonly captionClipId: string;
  readonly templateId: string;
}

export interface JoyCodeSetCaptionBurnInOperationV1 extends JoyCodeOperationBase {
  readonly kind: 'caption.setBurnIn';
  readonly enabled: boolean;
}

export interface JoyCodeAddTransitionOperationV1 extends JoyCodeOperationBase {
  readonly kind: 'transition.addAtJunction';
  readonly outgoingClipId: string;
  readonly incomingClipId: string;
  readonly transitionId: string;
  readonly durationUs: number;
}

export interface JoyCodeRemoveTransitionOperationV1 extends JoyCodeOperationBase {
  readonly kind: 'transition.remove';
  readonly transitionId: string;
}

export type JoyCodePlanOperationV1 =
  | JoyCodeTrimClipOperationV1
  | JoyCodeSplitClipOperationV1
  | JoyCodeMoveClipOperationV1
  | JoyCodeRemoveClipOperationV1
  | JoyCodeInsertExistingAssetOperationV1
  | JoyCodeInsertTemplateOperationV1
  | JoyCodeSetTextContentOperationV1
  | JoyCodeSetTextTemplateOperationV1
  | JoyCodeSetCaptionTextOperationV1
  | JoyCodeSetCaptionTimingOperationV1
  | JoyCodeSetCaptionTemplateOperationV1
  | JoyCodeSetCaptionBurnInOperationV1
  | JoyCodeAddTransitionOperationV1
  | JoyCodeRemoveTransitionOperationV1;

export interface JoyCodeModelPlanV1 {
  readonly schemaVersion: typeof JOY_CODE_PLAN_SCHEMA_VERSION;
  readonly goal: string;
  readonly summary: string;
  readonly operations: readonly JoyCodePlanOperationV1[];
  readonly assumptions: readonly string[];
  readonly blockedBy: readonly string[];
  readonly requiresHumanDecision: readonly string[];
}

export interface JoyCodePlanProvenanceV1 {
  readonly actor: 'joy-code-server';
  readonly adapterName: string;
  readonly modelId: string;
}

export interface JoyCodePlanProposalV1 extends JoyCodeModelPlanV1 {
  readonly planId: string;
  readonly projectId: string;
  readonly snapshotRevisionId: string;
  readonly createdAt: string;
  readonly consentVersion: string;
  readonly catalogVersion: string;
  readonly provenance: JoyCodePlanProvenanceV1;
}

type RecordValue = Record<string, unknown>;

const MODEL_KEYS = [
  'schemaVersion',
  'goal',
  'summary',
  'operations',
  'assumptions',
  'blockedBy',
  'requiresHumanDecision',
] as const;

const PROPOSAL_KEYS = [
  ...MODEL_KEYS,
  'planId',
  'projectId',
  'snapshotRevisionId',
  'createdAt',
  'consentVersion',
  'catalogVersion',
  'provenance',
] as const;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function error(
  errors: JoyCodePlanValidationError[],
  code: string,
  message: string,
  path?: string,
): void {
  errors.push({ code, message, ...(path === undefined ? {} : { path }) });
}

function checkKnownKeys(
  value: RecordValue,
  keys: readonly string[],
  errors: JoyCodePlanValidationError[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) error(errors, 'unknown-field', 'Unknown field is not allowed', path + '.' + key);
  }
}

function readNonEmptyString(
  value: RecordValue,
  key: string,
  errors: JoyCodePlanValidationError[],
  path: string,
  maxLength: number,
  tooLongCode = 'string-too-long',
): string | undefined {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    error(errors, 'missing-string', 'Expected a non-empty string', path + '.' + key);
    return undefined;
  }
  if (candidate.length > maxLength) {
    error(errors, tooLongCode, 'String exceeds the bounded length', path + '.' + key);
    return undefined;
  }
  return candidate;
}

function readId(
  value: RecordValue,
  key: string,
  errors: JoyCodePlanValidationError[],
  path: string,
  maxLength: number = JOY_CODE_PLAN_LIMITS.genericId,
): string | undefined {
  const candidate = readNonEmptyString(value, key, errors, path, maxLength);
  if (candidate !== undefined && !/^[A-Za-z0-9._:-]+$/.test(candidate)) {
    error(errors, 'invalid-id', 'ID contains unsupported characters', path + '.' + key);
    return undefined;
  }
  return candidate;
}

function readNonNegativeInteger(
  value: RecordValue,
  key: string,
  errors: JoyCodePlanValidationError[],
  path: string,
): number | undefined {
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0) {
    error(errors, 'invalid-range', 'Expected a non-negative integer', path + '.' + key);
    return undefined;
  }
  return candidate;
}

function readPositiveInteger(
  value: RecordValue,
  key: string,
  errors: JoyCodePlanValidationError[],
  path: string,
): number | undefined {
  const candidate = readNonNegativeInteger(value, key, errors, path);
  if (candidate !== undefined && candidate <= 0) {
    error(errors, 'invalid-range', 'Expected a positive integer', path + '.' + key);
    return undefined;
  }
  return candidate;
}

function readDependencies(
  value: RecordValue,
  errors: JoyCodePlanValidationError[],
  path: string,
): readonly string[] | undefined {
  const candidate = value.dependsOn;
  if (!Array.isArray(candidate)) {
    error(errors, 'invalid-dependencies', 'dependsOn must be an array', path + '.dependsOn');
    return undefined;
  }
  if (candidate.length > JOY_CODE_PLAN_LIMITS.dependencyCount) {
    error(errors, 'too-many-dependencies', 'Too many dependencies', path + '.dependsOn');
  }
  const dependencies: string[] = [];
  for (let index = 0; index < candidate.length; index += 1) {
    const dependency = candidate[index];
    if (typeof dependency !== 'string' || dependency.trim() === '') {
      error(errors, 'invalid-dependency', 'Dependency must be a non-empty string', path + '.dependsOn[' + index + ']');
    } else {
      dependencies.push(dependency);
    }
  }
  return dependencies;
}

function checkForbiddenData(value: unknown, errors: JoyCodePlanValidationError[]): void {
  if (deepCheckForbiddenPatterns(value).length > 0) {
    error(errors, 'forbidden-data', 'Plan contains forbidden path, URL, or secret-shaped data');
  }
}

function readCatalogId(
  value: RecordValue,
  key: string,
  allowed: readonly string[],
  code: 'unknown-template' | 'unknown-transition',
  errors: JoyCodePlanValidationError[],
  path: string,
): string | undefined {
  const candidate = readNonEmptyString(value, key, errors, path, JOY_CODE_PLAN_LIMITS.genericId);
  if (candidate !== undefined && !allowed.includes(candidate)) {
    error(errors, code, 'Identifier is not present in the code-owned catalog', path + '.' + key);
    return undefined;
  }
  return candidate;
}

function parseOperation(
  value: unknown,
  index: number,
  options: JoyCodeValidationOptions,
  errors: JoyCodePlanValidationError[],
): JoyCodePlanOperationV1 | undefined {
  const path = 'operations[' + index + ']';
  if (!isRecord(value)) {
    error(errors, 'invalid-operation', 'Operation must be an object', path);
    return undefined;
  }

  const id = readId(value, 'id', errors, path, JOY_CODE_PLAN_LIMITS.operationId);
  const dependsOn = readDependencies(value, errors, path);
  const kind = value.kind;
  if (typeof kind !== 'string' || !JOY_CODE_OPERATION_KINDS.includes(kind as JoyCodeOperationKind)) {
    error(errors, 'invalid-operation-kind', 'Operation kind is not allowlisted', path + '.kind');
    return undefined;
  }
  if (id === undefined || dependsOn === undefined) return undefined;

  const base = { id, dependsOn, kind };

  if (kind === 'timeline.trimClip') {
    checkKnownKeys(value, ['id', 'dependsOn', 'kind', 'compositionId', 'trackId', 'clipId', 'newStartUs', 'newEndUs'], errors, path);
    const compositionId = readId(value, 'compositionId', errors, path);
    const trackId = readId(value, 'trackId', errors, path);
    const clipId = readId(value, 'clipId', errors, path);
    const newStartUs = readNonNegativeInteger(value, 'newStartUs', errors, path);
    const newEndUs = readPositiveInteger(value, 'newEndUs', errors, path);
    if (newStartUs !== undefined && newEndUs !== undefined && newEndUs <= newStartUs) {
      error(errors, 'invalid-range', 'End must be greater than start', path);
    }
    if (compositionId === undefined || trackId === undefined || clipId === undefined || newStartUs === undefined || newEndUs === undefined) return undefined;
    return { ...base, kind, compositionId, trackId, clipId, newStartUs, newEndUs };
  }

  if (kind === 'timeline.splitClip') {
    checkKnownKeys(value, ['id', 'dependsOn', 'kind', 'compositionId', 'trackId', 'clipId', 'atUs'], errors, path);
    const compositionId = readId(value, 'compositionId', errors, path);
    const trackId = readId(value, 'trackId', errors, path);
    const clipId = readId(value, 'clipId', errors, path);
    const atUs = readPositiveInteger(value, 'atUs', errors, path);
    if (compositionId === undefined || trackId === undefined || clipId === undefined || atUs === undefined) return undefined;
    return { ...base, kind, compositionId, trackId, clipId, atUs };
  }

  if (kind === 'timeline.moveClip') {
    checkKnownKeys(value, ['id', 'dependsOn', 'kind', 'compositionId', 'sourceTrackId', 'targetTrackId', 'clipId', 'newStartUs'], errors, path);
    const compositionId = readId(value, 'compositionId', errors, path);
    const clipId = readId(value, 'clipId', errors, path);
    const sourceTrackId = readId(value, 'sourceTrackId', errors, path);
    const targetTrackId = readId(value, 'targetTrackId', errors, path);
    const newStartUs = readNonNegativeInteger(value, 'newStartUs', errors, path);
    if (compositionId === undefined || sourceTrackId === undefined || targetTrackId === undefined || clipId === undefined || newStartUs === undefined) return undefined;
    return { ...base, kind, compositionId, sourceTrackId, targetTrackId, clipId, newStartUs };
  }

  if (kind === 'timeline.removeClip') {
    checkKnownKeys(value, ['id', 'dependsOn', 'kind', 'compositionId', 'trackId', 'clipId'], errors, path);
    const compositionId = readId(value, 'compositionId', errors, path);
    const trackId = readId(value, 'trackId', errors, path);
    const clipId = readId(value, 'clipId', errors, path);
    if (compositionId === undefined || trackId === undefined || clipId === undefined) return undefined;
    return { ...base, kind, compositionId, trackId, clipId };
  }

  if (kind === 'timeline.insertExistingAsset') {
    checkKnownKeys(value, ['id', 'dependsOn', 'kind', 'compositionId', 'targetTrackId', 'assetId', 'startUs', 'durationUs'], errors, path);
    const compositionId = readId(value, 'compositionId', errors, path);
    const targetTrackId = readId(value, 'targetTrackId', errors, path);
    const assetId = readId(value, 'assetId', errors, path);
    const startUs = readNonNegativeInteger(value, 'startUs', errors, path);
    const durationUs = readPositiveInteger(value, 'durationUs', errors, path);
    if (compositionId === undefined || targetTrackId === undefined || assetId === undefined || startUs === undefined || durationUs === undefined) return undefined;
    return { ...base, kind, compositionId, targetTrackId, assetId, startUs, durationUs };
  }

  if (kind === 'text.insertTemplate') {
    checkKnownKeys(value, ['id', 'dependsOn', 'kind', 'templateId', 'content', 'startUs', 'durationUs', 'placementPreset'], errors, path);
    const templateId = readCatalogId(value, 'templateId', options.textTemplateIds, 'unknown-template', errors, path);
    const content = readNonEmptyString(value, 'content', errors, path, JOY_CODE_PLAN_LIMITS.textContent, 'text-too-long');
    const startUs = readNonNegativeInteger(value, 'startUs', errors, path);
    const durationUs = readPositiveInteger(value, 'durationUs', errors, path);
    const placementPreset = value.placementPreset;
    if (!JOY_CODE_PLACEMENT_PRESETS.includes(placementPreset as JoyCodePlacementPreset)) {
      error(errors, 'invalid-placement', 'Placement is not allowlisted', path + '.placementPreset');
    }
    if (startUs !== undefined && durationUs !== undefined && (durationUs < JOY_CODE_PLAN_LIMITS.titleMinDurationUs || durationUs > JOY_CODE_PLAN_LIMITS.titleMaxDurationUs)) {
      error(errors, 'invalid-range', 'Title duration is outside the safe range', path + '.durationUs');
    }
    if (templateId === undefined || content === undefined || startUs === undefined || durationUs === undefined || !JOY_CODE_PLACEMENT_PRESETS.includes(placementPreset as JoyCodePlacementPreset)) return undefined;
    return { ...base, kind, templateId, content, startUs, durationUs, placementPreset: placementPreset as JoyCodePlacementPreset };
  }

  if (kind === 'text.setContent') {
    checkKnownKeys(value, ['id', 'dependsOn', 'kind', 'objectId', 'content'], errors, path);
    const objectId = readId(value, 'objectId', errors, path);
    const content = readNonEmptyString(value, 'content', errors, path, JOY_CODE_PLAN_LIMITS.textContent, 'text-too-long');
    if (objectId === undefined || content === undefined) return undefined;
    return { ...base, kind, objectId, content };
  }

  if (kind === 'text.setTemplate') {
    checkKnownKeys(value, ['id', 'dependsOn', 'kind', 'objectId', 'templateId'], errors, path);
    const objectId = readId(value, 'objectId', errors, path);
    const templateId = readCatalogId(value, 'templateId', options.textTemplateIds, 'unknown-template', errors, path);
    if (objectId === undefined || templateId === undefined) return undefined;
    return { ...base, kind, objectId, templateId };
  }

  if (kind === 'caption.setSegmentText') {
    checkKnownKeys(value, ['id', 'dependsOn', 'kind', 'captionClipId', 'segmentId', 'text'], errors, path);
    const captionClipId = readId(value, 'captionClipId', errors, path);
    const segmentId = readId(value, 'segmentId', errors, path);
    const text = readNonEmptyString(value, 'text', errors, path, JOY_CODE_PLAN_LIMITS.textContent, 'text-too-long');
    if (captionClipId === undefined || segmentId === undefined || text === undefined) return undefined;
    return { ...base, kind, captionClipId, segmentId, text };
  }

  if (kind === 'caption.setSegmentTiming') {
    checkKnownKeys(value, ['id', 'dependsOn', 'kind', 'captionClipId', 'segmentId', 'startUs', 'endUs'], errors, path);
    const captionClipId = readId(value, 'captionClipId', errors, path);
    const segmentId = readId(value, 'segmentId', errors, path);
    const startUs = readNonNegativeInteger(value, 'startUs', errors, path);
    const endUs = readPositiveInteger(value, 'endUs', errors, path);
    if (startUs !== undefined && endUs !== undefined && endUs <= startUs) error(errors, 'invalid-range', 'End must be greater than start', path);
    if (captionClipId === undefined || segmentId === undefined || startUs === undefined || endUs === undefined) return undefined;
    return { ...base, kind, captionClipId, segmentId, startUs, endUs };
  }

  if (kind === 'caption.setTemplate') {
    checkKnownKeys(value, ['id', 'dependsOn', 'kind', 'captionClipId', 'templateId'], errors, path);
    const captionClipId = readId(value, 'captionClipId', errors, path);
    const templateId = readCatalogId(value, 'templateId', options.captionTemplateIds, 'unknown-template', errors, path);
    if (captionClipId === undefined || templateId === undefined) return undefined;
    return { ...base, kind, captionClipId, templateId };
  }

  if (kind === 'caption.setBurnIn') {
    checkKnownKeys(value, ['id', 'dependsOn', 'kind', 'enabled'], errors, path);
    if (typeof value.enabled !== 'boolean') error(errors, 'invalid-burn-in', 'enabled must be boolean', path + '.enabled');
    if (typeof value.enabled !== 'boolean') return undefined;
    return { ...base, kind, enabled: value.enabled };
  }

  if (kind === 'transition.addAtJunction') {
    checkKnownKeys(value, ['id', 'dependsOn', 'kind', 'outgoingClipId', 'incomingClipId', 'transitionId', 'durationUs'], errors, path);
    const outgoingClipId = readId(value, 'outgoingClipId', errors, path);
    const incomingClipId = readId(value, 'incomingClipId', errors, path);
    const transitionId = readCatalogId(value, 'transitionId', options.transitionIds, 'unknown-transition', errors, path);
    const durationUs = readPositiveInteger(value, 'durationUs', errors, path);
    if (durationUs !== undefined && (durationUs < JOY_CODE_PLAN_LIMITS.transitionMinUs || durationUs > JOY_CODE_PLAN_LIMITS.transitionMaxUs)) {
      error(errors, 'invalid-range', 'Transition duration is outside the safe range', path + '.durationUs');
    }
    if (outgoingClipId === undefined || incomingClipId === undefined || transitionId === undefined || durationUs === undefined) return undefined;
    return { ...base, kind, outgoingClipId, incomingClipId, transitionId, durationUs };
  }

  checkKnownKeys(value, ['id', 'dependsOn', 'kind', 'transitionId'], errors, path);
  const transitionId = readId(value, 'transitionId', errors, path);
  if (transitionId === undefined) return undefined;
  return { ...base, kind: 'transition.remove', transitionId };
}

function checkDependencies(
  operations: readonly JoyCodePlanOperationV1[],
  errors: JoyCodePlanValidationError[],
): void {
  const ids = new Set<string>();
  const graph = new Map<string, readonly string[]>();
  for (const operation of operations) {
    if (ids.has(operation.id)) error(errors, 'duplicate-operation-id', 'Operation IDs must be unique', 'operations');
    ids.add(operation.id);
    graph.set(operation.id, operation.dependsOn);
  }
  for (const operation of operations) {
    for (const dependency of operation.dependsOn) {
      if (!ids.has(dependency)) error(errors, 'unknown-dependency', 'Dependency does not exist', 'operations.' + operation.id);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      error(errors, 'dependency-cycle', 'Operation dependencies must be acyclic', 'operations');
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

function validateModelObject(
  value: unknown,
  options: JoyCodeValidationOptions,
): JoyCodePlanValidationResult<JoyCodeModelPlanV1> {
  const errors: JoyCodePlanValidationError[] = [];
  if (!isRecord(value)) {
    return { valid: false, errors: [{ code: 'invalid-type', message: 'Plan must be an object' }] };
  }
  checkKnownKeys(value, MODEL_KEYS, errors, '');
  if (value.schemaVersion !== JOY_CODE_PLAN_SCHEMA_VERSION) error(errors, 'invalid-schema-version', 'Unsupported Joy Code plan schema version', 'schemaVersion');
  const goal = readNonEmptyString(value, 'goal', errors, '', JOY_CODE_PLAN_LIMITS.goal);
  const summary = readNonEmptyString(value, 'summary', errors, '', JOY_CODE_PLAN_LIMITS.summary);
  if (!Array.isArray(value.operations)) {
    error(errors, 'invalid-operations', 'operations must be an array', 'operations');
  }
  const rawOperations = Array.isArray(value.operations) ? value.operations : [];
  if (rawOperations.length > JOY_CODE_PLAN_LIMITS.operations) error(errors, 'too-many-operations', 'Operation count exceeds the safe limit', 'operations');
  const operations: JoyCodePlanOperationV1[] = [];
  for (let index = 0; index < rawOperations.length; index += 1) {
    const operation = parseOperation(rawOperations[index], index, options, errors);
    if (operation !== undefined) operations.push(operation);
  }
  checkDependencies(operations, errors);

  const arrays: readonly [string, number][] = [
    ['assumptions', JOY_CODE_PLAN_LIMITS.assumptions],
    ['blockedBy', JOY_CODE_PLAN_LIMITS.blockedBy],
    ['requiresHumanDecision', JOY_CODE_PLAN_LIMITS.humanDecisions],
  ];
  const normalizedArrays: Record<string, readonly string[]> = {};
  for (const [key, limit] of arrays) {
    const candidate = value[key];
    if (!Array.isArray(candidate)) {
      error(errors, 'invalid-list', key + ' must be an array', key);
      normalizedArrays[key] = [];
      continue;
    }
    if (candidate.length > limit) error(errors, 'list-too-long', key + ' exceeds its limit', key);
    const entries: string[] = [];
    for (let index = 0; index < candidate.length; index += 1) {
      const entry = candidate[index];
      if (typeof entry !== 'string' || entry.trim() === '') {
        error(errors, 'invalid-list-entry', key + ' entries must be non-empty strings', key + '[' + index + ']');
      } else if (entry.length > JOY_CODE_PLAN_LIMITS.contextNote) {
        error(errors, 'string-too-long', key + ' entry exceeds its limit', key + '[' + index + ']');
      } else {
        entries.push(entry);
      }
    }
    normalizedArrays[key] = entries;
  }
  checkForbiddenData(value, errors);
  if (errors.length > 0 || goal === undefined || summary === undefined || value.schemaVersion !== JOY_CODE_PLAN_SCHEMA_VERSION) {
    return { valid: false, errors };
  }
  return {
    valid: true,
    value: {
      schemaVersion: JOY_CODE_PLAN_SCHEMA_VERSION,
      goal,
      summary,
      operations,
      assumptions: normalizedArrays.assumptions ?? [],
      blockedBy: normalizedArrays.blockedBy ?? [],
      requiresHumanDecision: normalizedArrays.requiresHumanDecision ?? [],
    },
    errors: [],
  };
}

export function validateJoyCodeModelPlan(
  value: unknown,
  options: JoyCodeValidationOptions,
): JoyCodePlanValidationResult<JoyCodeModelPlanV1> {
  return validateModelObject(value, options);
}

export function validateJoyCodePlanProposal(
  value: unknown,
  options: JoyCodeValidationOptions,
): JoyCodePlanValidationResult<JoyCodePlanProposalV1> {
  const errors: JoyCodePlanValidationError[] = [];
  if (!isRecord(value)) {
    return { valid: false, errors: [{ code: 'invalid-type', message: 'Proposal must be an object' }] };
  }
  checkKnownKeys(value, PROPOSAL_KEYS, errors, '');
  const modelInput: RecordValue = {};
  for (const key of MODEL_KEYS) modelInput[key] = value[key];
  const modelResult = validateModelObject(modelInput, options);
  errors.push(...modelResult.errors);

  const planId = readId(value, 'planId', errors, '', JOY_CODE_PLAN_LIMITS.planId);
  const projectId = readId(value, 'projectId', errors, '');
  const snapshotRevisionId = readId(value, 'snapshotRevisionId', errors, '');
  const createdAt = readNonEmptyString(value, 'createdAt', errors, '', 100);
  const consentVersion = readNonEmptyString(value, 'consentVersion', errors, '', JOY_CODE_PLAN_LIMITS.catalogVersion);
  const catalogVersion = readNonEmptyString(value, 'catalogVersion', errors, '', JOY_CODE_PLAN_LIMITS.catalogVersion);
  if (createdAt !== undefined && Number.isNaN(Date.parse(createdAt))) error(errors, 'invalid-created-at', 'createdAt must be an ISO date', 'createdAt');
  if (options.consentVersion !== undefined && consentVersion !== options.consentVersion) {
    error(errors, 'consent-version-mismatch', 'Proposal consent version does not match current policy', 'consentVersion');
  }

  const provenance = value.provenance;
  if (!isRecord(provenance)) {
    error(errors, 'invalid-provenance', 'provenance must be an object', 'provenance');
  } else {
    checkKnownKeys(provenance, ['actor', 'adapterName', 'modelId'], errors, 'provenance');
    if (provenance.actor !== 'joy-code-server') error(errors, 'invalid-actor', 'Only joy-code-server may create a proposal', 'provenance.actor');
    const adapterName = readNonEmptyString(provenance, 'adapterName', errors, 'provenance', JOY_CODE_PLAN_LIMITS.genericId);
    const modelId = readNonEmptyString(provenance, 'modelId', errors, 'provenance', JOY_CODE_PLAN_LIMITS.genericId);
    if (options.allowedModelIds !== undefined && (modelId === undefined || !options.allowedModelIds.includes(modelId))) {
      error(errors, 'model-not-allowed', 'Proposal model is not allowed by policy', 'provenance.modelId');
    }
    if (adapterName === undefined || modelId === undefined) {
      error(errors, 'invalid-provenance', 'Provenance fields are required', 'provenance');
    }
  }

  if (errors.length > 0 || !modelResult.valid || planId === undefined || projectId === undefined || snapshotRevisionId === undefined || createdAt === undefined || consentVersion === undefined || catalogVersion === undefined || !isRecord(provenance)) {
    return { valid: false, errors };
  }
  const adapterName = provenance.adapterName;
  const modelId = provenance.modelId;
  if (typeof adapterName !== 'string' || typeof modelId !== 'string') return { valid: false, errors };
  return {
    valid: true,
    value: {
      ...modelResult.value,
      planId,
      projectId,
      snapshotRevisionId,
      createdAt,
      consentVersion,
      catalogVersion,
      provenance: { actor: 'joy-code-server', adapterName, modelId },
    },
    errors: [],
  };
}

export function containsJoyCodeForbiddenData(value: string): boolean {
  return containsForbiddenPattern(value);
}
