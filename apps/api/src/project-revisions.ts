import { createHash } from 'node:crypto';
import type { ProjectDocumentV2 } from '@joy-media/project-schema';
import { validateProjectDocumentV2 } from '@joy-media/project-schema';
import { ControlPlaneError, type Actor } from './control-plane.js';

export type { ProjectDocumentV2 };

export interface ProjectOperationV1 {
  readonly kind: 'replace' | 'restore';
  readonly idempotencyKey: string;
  readonly label?: string;
  readonly targetRevision?: number;
}

export interface ProjectRevisionV1 {
  readonly projectId: string;
  readonly revision: number;
  readonly baseRevision: number;
  readonly idempotencyKey: string;
  readonly operation: ProjectOperationV1;
  readonly document: ProjectDocumentV2;
  readonly documentHash: string;
  readonly createdAt: string;
}

export interface ProjectDocumentSnapshotV2 {
  readonly projectId: string;
  readonly revision: number;
  readonly document: ProjectDocumentV2;
  readonly documentHash: string;
  readonly updatedAt: string;
}

export interface AppendProjectRevisionInput {
  readonly baseRevision: number;
  readonly idempotencyKey: string;
  readonly document: ProjectDocumentV2;
  readonly operation?: ProjectOperationV1['kind'];
  readonly label?: string;
  readonly targetRevision?: number;
}

export interface RestoreProjectRevisionInput {
  readonly baseRevision: number;
  readonly revision: number;
  readonly idempotencyKey: string;
  readonly label?: string;
}

export type RecoveredCopyOperation =
  | { readonly kind: 'append'; readonly document: ProjectDocumentV2; readonly label?: string }
  | { readonly kind: 'restore'; readonly targetRevision: number; readonly label?: string };

export interface CreateRecoveredCopyInput {
  readonly baseRevision: number;
  readonly idempotencyKey: string;
  readonly suggestedName: string;
  readonly operation: RecoveredCopyOperation;
}

export interface RecoveredCopyProvenance {
  readonly sourceProjectId: string;
  readonly baseRevision: number;
  readonly sourceHeadRevision: number;
  readonly operation: RecoveredCopyOperation;
  readonly requestedDocumentHash: string;
}

export interface RecoveredCopy {
  readonly kind: 'recovered-copy';
  readonly projectId: string;
  readonly name: string;
  readonly document: ProjectDocumentV2;
  readonly basedOnRevision: number;
  readonly serverRevision: number;
  readonly createdAt: string;
  readonly provenance: RecoveredCopyProvenance;
}

export interface ProjectRevisionStore {
  getProjectDocument(actor: Actor, projectId: string): Promise<ProjectDocumentSnapshotV2>;
  appendProjectRevision(
    actor: Actor,
    projectId: string,
    input: AppendProjectRevisionInput,
  ): Promise<ProjectRevisionV1>;
  getProjectRevision(actor: Actor, projectId: string, revision: number): Promise<ProjectRevisionV1>;
  restoreProjectRevision(
    actor: Actor,
    projectId: string,
    input: RestoreProjectRevisionInput,
  ): Promise<ProjectRevisionV1>;
  createRecoveredCopy(
    actor: Actor,
    sourceProjectId: string,
    input: CreateRecoveredCopyInput,
    recoveredProjectId: string,
  ): Promise<RecoveredCopy>;
}

type AuthorizeProject = (actor: Actor, projectId: string) => void;

/** Test/local adapter with the same optimistic and idempotent semantics as PostgreSQL. */
export class InMemoryProjectRevisionStore implements ProjectRevisionStore {
  readonly #revisions = new Map<string, ProjectRevisionV1[]>();
  readonly #idempotency = new Map<string, Map<string, ProjectRevisionV1>>();
  readonly #recoveredCopies = new Map<string, Map<string, RecoveredCopy>>();

  constructor(private readonly authorizeProject: AuthorizeProject) {}

  async getProjectDocument(actor: Actor, projectId: string): Promise<ProjectDocumentSnapshotV2> {
    this.authorizeProject(actor, projectId);
    const revisions = this.#revisions.get(projectId) ?? [];
    const latest = revisions[revisions.length - 1];
    if (latest === undefined)
      throw new ControlPlaneError(
        'DOCUMENT_NOT_FOUND',
        `project document ${projectId} is not initialized`,
      );
    return snapshotOf(latest);
  }

  async appendProjectRevision(
    actor: Actor,
    projectId: string,
    input: AppendProjectRevisionInput,
  ): Promise<ProjectRevisionV1> {
    this.authorizeProject(actor, projectId);
    validateAppendInput(projectId, input);
    const key = this.idempotencyKey(projectId, input.idempotencyKey);
    const fingerprint = requestFingerprint(
      input.baseRevision,
      input.document,
      input.label,
      input.operation ?? 'replace',
      input.targetRevision,
    );
    const prior = this.#idempotency.get(projectId)?.get(input.idempotencyKey);
    if (prior !== undefined) {
      if (
        requestFingerprint(
          prior.baseRevision,
          prior.document,
          prior.operation.label,
          prior.operation.kind,
          prior.operation.targetRevision,
        ) !== fingerprint
      )
        throw new ControlPlaneError(
          'IDEMPOTENCY_CONFLICT',
          'idempotency key was already used for another revision',
        );
      return cloneRevision(prior);
    }
    const revisions = this.#revisions.get(projectId) ?? [];
    const currentRevision = revisions[revisions.length - 1]?.revision ?? 0;
    if (input.baseRevision !== currentRevision)
      throw revisionConflict(input.baseRevision, currentRevision);
    const revision = makeRevision(
      projectId,
      currentRevision + 1,
      input,
      input.operation ?? 'replace',
    );
    this.#revisions.set(projectId, [...revisions, revision]);
    const keys = this.#idempotency.get(projectId) ?? new Map<string, ProjectRevisionV1>();
    keys.set(input.idempotencyKey, revision);
    this.#idempotency.set(projectId, keys);
    void key;
    return cloneRevision(revision);
  }

  async getProjectRevision(
    actor: Actor,
    projectId: string,
    revision: number,
  ): Promise<ProjectRevisionV1> {
    this.authorizeProject(actor, projectId);
    validateRevisionNumber(revision);
    const result = (this.#revisions.get(projectId) ?? []).find(
      (candidate) => candidate.revision === revision,
    );
    if (result === undefined)
      throw new ControlPlaneError('REVISION_NOT_FOUND', `revision ${revision} was not found`);
    return cloneRevision(result);
  }

  async restoreProjectRevision(
    actor: Actor,
    projectId: string,
    input: RestoreProjectRevisionInput,
  ): Promise<ProjectRevisionV1> {
    this.authorizeProject(actor, projectId);
    validateRevisionNumber(input.revision);
    validateBaseRevision(input.baseRevision);
    validateIdempotencyKey(input.idempotencyKey);
    const source = await this.getProjectRevision(actor, projectId, input.revision);
    return this.appendProjectRevision(actor, projectId, {
      baseRevision: input.baseRevision,
      idempotencyKey: input.idempotencyKey,
      document: source.document,
      operation: 'restore',
      targetRevision: input.revision,
      label: input.label ?? `restore revision ${String(input.revision)}`,
    });
  }

  async createRecoveredCopy(
    actor: Actor,
    sourceProjectId: string,
    input: CreateRecoveredCopyInput,
    recoveredProjectId: string,
  ): Promise<RecoveredCopy> {
    this.authorizeProject(actor, sourceProjectId);
    validateRecoveredCopyInput(input);
    const key = input.idempotencyKey;
    const fingerprint = recoveredCopyFingerprint(input);
    const prior = this.#recoveredCopies.get(sourceProjectId)?.get(key);
    if (prior !== undefined) {
      if (recoveredCopyFingerprintFromResult(prior) !== fingerprint)
        throw new ControlPlaneError(
          'IDEMPOTENCY_CONFLICT',
          'idempotency key was already used for another recovered copy',
        );
      return cloneRecoveredCopy(prior);
    }
    const sourceRevisions = this.#revisions.get(sourceProjectId) ?? [];
    const sourceHeadRevision = sourceRevisions[sourceRevisions.length - 1]?.revision ?? 0;
    if (sourceHeadRevision <= input.baseRevision)
      throw revisionConflict(input.baseRevision, sourceHeadRevision);
    let requestedDocument: ProjectDocumentV2;
    if (input.operation.kind === 'append') {
      validateProjectDocumentEnvelope(input.operation.document);
      requestedDocument = cloneDocument(input.operation.document);
    } else {
      validateRevisionNumber(input.operation.targetRevision);
      const targetRevision = input.operation.targetRevision;
      const target = sourceRevisions.find((candidate) => candidate.revision === targetRevision);
      if (target === undefined)
        throw new ControlPlaneError(
          'REVISION_NOT_FOUND',
          `revision ${String(targetRevision)} was not found`,
        );
      requestedDocument = cloneDocument(target.document);
    }
    const document = rewriteRecoveredDocument(
      requestedDocument,
      recoveredProjectId,
      input.suggestedName,
    );
    const now = new Date().toISOString();
    const provenance: RecoveredCopyProvenance = {
      sourceProjectId,
      baseRevision: input.baseRevision,
      sourceHeadRevision,
      operation: cloneRecoveredOperation(input.operation),
      requestedDocumentHash: documentHash(requestedDocument),
    };
    const result: RecoveredCopy = {
      kind: 'recovered-copy',
      projectId: recoveredProjectId,
      name: input.suggestedName,
      document,
      basedOnRevision: input.baseRevision,
      serverRevision: 1,
      createdAt: now,
      provenance,
    };
    const copyRevisions: ProjectRevisionV1[] = [
      {
        projectId: recoveredProjectId,
        revision: 1,
        baseRevision: 0,
        idempotencyKey: key,
        operation: {
          kind: 'replace',
          idempotencyKey: key,
          label: 'recovered copy',
        },
        document: cloneDocument(document),
        documentHash: documentHash(document),
        createdAt: now,
      },
    ];
    this.#revisions.set(recoveredProjectId, copyRevisions);
    const copies = this.#recoveredCopies.get(sourceProjectId) ?? new Map<string, RecoveredCopy>();
    copies.set(key, result);
    this.#recoveredCopies.set(sourceProjectId, copies);
    return cloneRecoveredCopy(result);
  }

  private idempotencyKey(projectId: string, key: string): string {
    return `${projectId}:${key}`;
  }
}

export function validateProjectDocumentInput(
  projectId: string,
  document: unknown,
): ProjectDocumentV2 {
  const diagnostics = validateProjectDocumentV2(document);
  if (diagnostics.length > 0)
    throw new ControlPlaneError('REQUEST_INVALID', diagnostics[0]!.message);
  const candidate = document as ProjectDocumentV2;
  if (candidate.projectId !== projectId)
    throw new ControlPlaneError(
      'REQUEST_INVALID',
      'document projectId must match the route project',
    );
  return cloneDocument(candidate);
}

export function validateAppendInput(projectId: string, input: AppendProjectRevisionInput): void {
  validateBaseRevision(input.baseRevision);
  validateIdempotencyKey(input.idempotencyKey);
  validateProjectDocumentInput(projectId, input.document);
}

export function validateRecoveredCopyInput(input: CreateRecoveredCopyInput): void {
  validateBaseRevision(input.baseRevision);
  validateIdempotencyKey(input.idempotencyKey);
  if (typeof input.suggestedName !== 'string' || input.suggestedName.trim().length === 0)
    throw new ControlPlaneError('REQUEST_INVALID', 'suggestedName must be a non-empty string');
  if (input.suggestedName.length > 16_384)
    throw new ControlPlaneError('REQUEST_INVALID', 'suggestedName is too long');
  if (input.operation === undefined || typeof input.operation !== 'object')
    throw new ControlPlaneError('REQUEST_INVALID', 'operation is required');
  if (input.operation.kind === 'append') {
    validateProjectDocumentEnvelope(input.operation.document);
    if (input.operation.label !== undefined && typeof input.operation.label !== 'string')
      throw new ControlPlaneError('REQUEST_INVALID', 'operation label must be a string');
  } else if (input.operation.kind === 'restore') {
    validateRevisionNumber(input.operation.targetRevision);
    if (input.operation.label !== undefined && typeof input.operation.label !== 'string')
      throw new ControlPlaneError('REQUEST_INVALID', 'operation label must be a string');
  } else {
    throw new ControlPlaneError('REQUEST_INVALID', 'operation kind must be append or restore');
  }
}

function validateProjectDocumentEnvelope(document: unknown): asserts document is ProjectDocumentV2 {
  const diagnostics = validateProjectDocumentV2(document);
  if (diagnostics.length > 0)
    throw new ControlPlaneError('REQUEST_INVALID', diagnostics[0]!.message);
}

function recoveredCopyFingerprint(input: CreateRecoveredCopyInput): string {
  const operation = input.operation;
  const requestedHash =
    operation.kind === 'append'
      ? documentHash(operation.document)
      : `revision:${String(operation.targetRevision)}`;
  return `${String(input.baseRevision)}:${input.suggestedName}:${operation.kind}:${requestedHash}:${operation.label ?? ''}`;
}

function recoveredCopyFingerprintFromResult(result: RecoveredCopy): string {
  const operation = result.provenance.operation;
  const requestedHash =
    operation.kind === 'append'
      ? documentHash(operation.document)
      : `revision:${String(operation.targetRevision)}`;
  return `${String(result.provenance.baseRevision)}:${result.name}:${operation.kind}:${requestedHash}:${operation.label ?? ''}`;
}

export function rewriteRecoveredDocument(
  source: ProjectDocumentV2,
  projectId: string,
  name: string,
): ProjectDocumentV2 {
  const document = cloneDocument(source) as unknown as Record<string, unknown>;
  document.projectId = projectId;
  document.title = name;
  document.project = rewriteNestedIdentity(document.project, projectId, name, true);
  document.timeline = rewriteNestedIdentity(document.timeline, projectId, name, false);
  return validateProjectDocumentInput(projectId, document);
}

function rewriteNestedIdentity(
  value: unknown,
  projectId: string,
  name: string,
  includeTitle: boolean,
): Record<string, unknown> {
  if (value === undefined) return includeTitle ? { id: projectId, title: name } : { id: projectId };
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ControlPlaneError('REQUEST_INVALID', 'recovered document identity must be an object');
  const result: Record<string, unknown> = { ...(value as Record<string, unknown>), id: projectId };
  if (includeTitle) result.title = name;
  return result;
}

export function validateBaseRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new ControlPlaneError('REQUEST_INVALID', 'baseRevision must be a non-negative integer');
}

export function validateRevisionNumber(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new ControlPlaneError('REQUEST_INVALID', 'revision must be a positive integer');
}

export function validateIdempotencyKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
    throw new ControlPlaneError('REQUEST_INVALID', 'idempotencyKey is invalid');
}

export function revisionConflict(expected: number, current: number): ControlPlaneError {
  return new ControlPlaneError(
    'REVISION_CONFLICT',
    `expected base revision ${String(expected)}, found ${String(current)}`,
    { expectedRevision: expected, currentRevision: current },
  );
}

export function documentHash(document: ProjectDocumentV2): string {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

function makeRevision(
  projectId: string,
  revision: number,
  input: AppendProjectRevisionInput,
  kind: ProjectOperationV1['kind'],
): ProjectRevisionV1 {
  const document = cloneDocument(input.document);
  return {
    projectId,
    revision,
    baseRevision: input.baseRevision,
    idempotencyKey: input.idempotencyKey,
    operation: {
      kind,
      idempotencyKey: input.idempotencyKey,
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.targetRevision === undefined ? {} : { targetRevision: input.targetRevision }),
    },
    document,
    documentHash: documentHash(document),
    createdAt: new Date().toISOString(),
  };
}

function requestFingerprint(
  baseRevision: number,
  document: ProjectDocumentV2,
  label: string | undefined,
  kind: ProjectOperationV1['kind'],
  targetRevision?: number,
): string {
  return `${kind}:${String(targetRevision ?? '')}:${String(baseRevision)}:${documentHash(document)}:${label ?? ''}`;
}

function snapshotOf(revision: ProjectRevisionV1): ProjectDocumentSnapshotV2 {
  return {
    projectId: revision.projectId,
    revision: revision.revision,
    document: cloneDocument(revision.document),
    documentHash: revision.documentHash,
    updatedAt: revision.createdAt,
  };
}

function cloneDocument(document: ProjectDocumentV2): ProjectDocumentV2 {
  return JSON.parse(JSON.stringify(document)) as ProjectDocumentV2;
}

function cloneRevision(revision: ProjectRevisionV1): ProjectRevisionV1 {
  return JSON.parse(JSON.stringify(revision)) as ProjectRevisionV1;
}

function cloneRecoveredOperation(operation: RecoveredCopyOperation): RecoveredCopyOperation {
  return JSON.parse(JSON.stringify(operation)) as RecoveredCopyOperation;
}

function cloneRecoveredCopy(copy: RecoveredCopy): RecoveredCopy {
  return JSON.parse(JSON.stringify(copy)) as RecoveredCopy;
}
