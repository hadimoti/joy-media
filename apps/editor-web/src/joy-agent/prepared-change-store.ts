import { canonicalJson, sha256Hex } from '@joy-media/workflow-engine';
import type { AgentPolicyPreferences } from '../agent-policy-settings.js';
import type { JoyCodeCompoundDraft, JoyCodeCompoundGroup } from '../joy-code-compound-compiler.js';

export const PREPARED_CHANGE_FORMAT_VERSION = 1;
const MAX_PREPARED_CHANGES = 32;
const LOCAL_EXTERNAL_EFFECTS: readonly string[] = [];
const LOCAL_CONSENT_SCOPES = ['local-project-write'] as const;

/** Session facts that must still match when an approved change is executed. */
export interface PreparedChangeAuthority {
  readonly projectId: string;
  /** Trusted host-minted run identity; model plan IDs never become execution authority. */
  readonly hostRunId: string;
  /** Runtime-only identity for the exact EditorSession that owns this change. */
  readonly sessionIdentity: object;
  readonly sessionEpoch: number;
  readonly revision: string;
  readonly policy: AgentPolicyPreferences;
}

/** Safe display metadata. It deliberately contains no mutable transaction or document. */
export interface PreparedChangeView {
  readonly changeSetId: string;
  readonly executionId: string;
  readonly hostRunId: string;
  readonly planId: string;
  readonly projectId: string;
  readonly sessionEpoch: number;
  readonly baseRevision: string;
  readonly operationDigest: string;
  readonly bindingDigest: string;
  readonly groups: readonly JoyCodeCompoundGroup[];
  readonly warnings: readonly string[];
  readonly externalEffects: readonly string[];
  readonly consentScopes: readonly string[];
}

/** Opaque, store-issued proof that the owner approved one exact prepared change. */
export interface PreparedChangeApprovalHandle {
  readonly approvalId: string;
}

/** The runner receives this only from `resolveApproved`, never from React state. */
export interface ApprovedPreparedChange {
  readonly view: PreparedChangeView;
  readonly draft: JoyCodeCompoundDraft;
}

interface PreparedChangeRecord {
  readonly view: PreparedChangeView;
  readonly sessionIdentity: object;
  readonly draftSerialized: string;
  readonly compiledDigest: string;
  readonly policyDigest: string;
}

interface ApprovalRecord {
  readonly changeSetId: string;
  readonly bindingDigest: string;
}

export interface PreparedChangeStoreOptions {
  /** Deterministic injection is used by tests; production uses opaque local IDs. */
  readonly idFactory?: (kind: 'change-set' | 'approval') => string;
}

/**
 * Ephemeral, session-scoped authority for compiled edits.
 *
 * It owns the canonical serialized payload privately. Views and preview drafts
 * are copies; changing either cannot change what reaches EditorSession.
 * Nothing here is persisted, so a reload never revives an old approval.
 */
export class PreparedChangeStore {
  readonly #changes = new Map<string, PreparedChangeRecord>();
  readonly #approvals = new Map<string, ApprovalRecord>();
  #nextId = 0;

  constructor(private readonly options: PreparedChangeStoreOptions = {}) {}

  prepare(draft: JoyCodeCompoundDraft, authority: PreparedChangeAuthority): PreparedChangeView {
    assertAuthority(authority);
    assertDraftIdentity(draft, authority);
    const draftSerialized = canonicalDraft(draft);
    const compiledDigest = sha256Hex(draftSerialized);
    const policyDigest = digestJoyAgentPolicy(authority.policy);
    // Execution identity intentionally excludes the proposed payload and model
    // plan ID. A second payload under the same host-minted run ID must conflict
    // with the first durable receipt, never turn into a second executable edit.
    const executionId = `execution-${sha256Hex(
      canonicalJson({
        version: PREPARED_CHANGE_FORMAT_VERSION,
        projectId: authority.projectId,
        hostRunId: authority.hostRunId,
      }),
    )}`;
    const changeSetId = this.#createId('change-set');
    const bindingDigest = sha256Hex(
      canonicalJson({
        version: PREPARED_CHANGE_FORMAT_VERSION,
        changeSetId,
        executionId,
        projectId: authority.projectId,
        hostRunId: authority.hostRunId,
        sessionEpoch: authority.sessionEpoch,
        baseRevision: draft.baseRevision,
        operationDigest: draft.operationDigest,
        compiledDigest,
        policyDigest,
        externalEffects: LOCAL_EXTERNAL_EFFECTS,
        consentScopes: LOCAL_CONSENT_SCOPES,
      }),
    );
    const view = freezeView({
      changeSetId,
      executionId,
      hostRunId: authority.hostRunId,
      planId: draft.planId,
      projectId: authority.projectId,
      sessionEpoch: authority.sessionEpoch,
      baseRevision: draft.baseRevision,
      operationDigest: draft.operationDigest,
      bindingDigest,
      groups: cloneGroups(draft.groups),
      warnings: [...draft.warnings],
      externalEffects: [...LOCAL_EXTERNAL_EFFECTS],
      consentScopes: [...LOCAL_CONSENT_SCOPES],
    });
    if (this.#changes.size >= MAX_PREPARED_CHANGES) {
      const oldest = this.#changes.keys().next().value as string | undefined;
      if (oldest !== undefined) this.revoke(oldest);
    }
    this.#changes.set(changeSetId, {
      view,
      sessionIdentity: authority.sessionIdentity,
      draftSerialized,
      compiledDigest,
      policyDigest,
    });
    return cloneView(view);
  }

  getView(changeSetId: string): PreparedChangeView | undefined {
    const record = this.#changes.get(changeSetId);
    return record === undefined ? undefined : cloneView(record.view);
  }

  /** Returns an isolated, frozen preview copy, never the private commit payload. */
  getPreviewDraft(changeSetId: string): JoyCodeCompoundDraft | undefined {
    const record = this.#changes.get(changeSetId);
    return record === undefined ? undefined : deserializeDraft(record.draftSerialized);
  }

  approve(changeSetId: string, authority: PreparedChangeAuthority): PreparedChangeApprovalHandle {
    const record = this.#resolveCurrent(changeSetId, authority);
    const approvalId = this.#createId('approval');
    this.#approvals.set(approvalId, {
      changeSetId,
      bindingDigest: record.view.bindingDigest,
    });
    return Object.freeze({ approvalId });
  }

  /**
   * Resolves only store-issued approval ownership and safe display metadata.
   * The runner uses this to answer an already-durable replay without letting a
   * revision change turn that read-only result into a new write.
   */
  getApprovedView(
    approval: PreparedChangeApprovalHandle,
    authority: PreparedChangeAuthority,
  ): PreparedChangeView {
    assertAuthority(authority);
    const approvalRecord = this.#approvals.get(approval.approvalId);
    if (approvalRecord === undefined)
      throw new Error('JOY_CODE_APPROVAL_HANDLE_INVALID: approval is not owned by this session');
    const record = this.#changes.get(approvalRecord.changeSetId);
    if (record === undefined)
      throw new Error('JOY_CODE_PREPARED_CHANGE_MISSING: prepare the change again before approval');
    if (approvalRecord.bindingDigest !== record.view.bindingDigest)
      throw new Error(
        'JOY_CODE_APPROVAL_MISMATCH: approved binding no longer matches the change set',
      );
    if (record.view.hostRunId !== authority.hostRunId)
      throw new Error('JOY_CODE_PREPARED_CHANGE_STALE_RUN: change belongs to a different host run');
    if (
      record.view.projectId !== authority.projectId ||
      record.view.sessionEpoch !== authority.sessionEpoch ||
      record.sessionIdentity !== authority.sessionIdentity
    )
      throw new Error(
        'JOY_CODE_PREPARED_CHANGE_STALE_SESSION: change belongs to a different session',
      );
    return cloneView(record.view);
  }

  /**
   * Revalidates session, revision, policy, and canonical payload immediately
   * before execution. An object merely shaped like an approval handle cannot
   * resolve unless this store issued and still owns its ID.
   */
  resolveApproved(
    approval: PreparedChangeApprovalHandle,
    authority: PreparedChangeAuthority,
  ): ApprovedPreparedChange {
    const approvalRecord = this.#approvals.get(approval.approvalId);
    if (approvalRecord === undefined)
      throw new Error('JOY_CODE_APPROVAL_HANDLE_INVALID: approval is not owned by this session');
    const record = this.#resolveCurrent(approvalRecord.changeSetId, authority);
    if (approvalRecord.bindingDigest !== record.view.bindingDigest)
      throw new Error(
        'JOY_CODE_APPROVAL_MISMATCH: approved binding no longer matches the change set',
      );
    if (sha256Hex(record.draftSerialized) !== record.compiledDigest)
      throw new Error('JOY_CODE_PREPARED_CHANGE_CORRUPT: canonical compiled payload changed');
    return Object.freeze({
      view: cloneView(record.view),
      draft: deserializeDraft(record.draftSerialized),
    });
  }

  revoke(changeSetId: string): void {
    this.#changes.delete(changeSetId);
    for (const [approvalId, approval] of this.#approvals) {
      if (approval.changeSetId === changeSetId) this.#approvals.delete(approvalId);
    }
  }

  /** Project/session changes are terminal for all old prepared authority. */
  invalidateProject(projectId: string): void {
    for (const [changeSetId, record] of this.#changes) {
      if (record.view.projectId === projectId) this.revoke(changeSetId);
    }
  }

  clear(): void {
    this.#changes.clear();
    this.#approvals.clear();
  }

  #resolveCurrent(changeSetId: string, authority: PreparedChangeAuthority): PreparedChangeRecord {
    assertAuthority(authority);
    const record = this.#changes.get(changeSetId);
    if (record === undefined)
      throw new Error('JOY_CODE_PREPARED_CHANGE_MISSING: prepare the change again before approval');
    if (
      record.view.projectId !== authority.projectId ||
      record.view.hostRunId !== authority.hostRunId ||
      record.view.sessionEpoch !== authority.sessionEpoch
    )
      throw new Error(
        'JOY_CODE_PREPARED_CHANGE_STALE_SESSION: change belongs to a different session',
      );
    if (record.sessionIdentity !== authority.sessionIdentity)
      throw new Error(
        'JOY_CODE_PREPARED_CHANGE_STALE_SESSION: change belongs to a different session',
      );
    if (record.view.baseRevision !== authority.revision)
      throw new Error(
        `JOY_CODE_STALE_REVISION: expected ${record.view.baseRevision}, got ${authority.revision}`,
      );
    if (record.policyDigest !== digestJoyAgentPolicy(authority.policy))
      throw new Error('JOY_CODE_POLICY_CHANGED: prepare a new proposal under the current policy');
    return record;
  }

  #createId(kind: 'change-set' | 'approval'): string {
    const injected = this.options.idFactory?.(kind);
    if (injected !== undefined) return assertOpaqueId(injected, `${kind} id`);
    this.#nextId += 1;
    const randomPart =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${this.#nextId.toString(36)}`;
    return assertOpaqueId(`${kind}-${randomPart}`, `${kind} id`);
  }
}

function assertAuthority(authority: PreparedChangeAuthority): void {
  assertOpaqueId(authority.projectId, 'projectId');
  assertOpaqueId(authority.hostRunId, 'hostRunId');
  if (typeof authority.sessionIdentity !== 'object' || authority.sessionIdentity === null)
    throw new TypeError('sessionIdentity must be an opaque session object');
  assertOpaqueId(authority.revision, 'revision');
  if (!Number.isSafeInteger(authority.sessionEpoch) || authority.sessionEpoch <= 0)
    throw new RangeError('sessionEpoch must be a positive safe integer');
}

function assertDraftIdentity(
  draft: JoyCodeCompoundDraft,
  authority: PreparedChangeAuthority,
): void {
  assertOpaqueId(draft.planId, 'planId');
  if (draft.baseRevision !== authority.revision)
    throw new Error(
      `JOY_CODE_STALE_REVISION: expected ${draft.baseRevision}, got ${authority.revision}`,
    );
  if (!/^[a-f0-9]{64}$/.test(draft.operationDigest))
    throw new RangeError('operationDigest must be a canonical SHA-256 digest');
  if (draft.proposalHash !== `joy-code-proposal-${draft.operationDigest}`)
    throw new Error(
      'JOY_CODE_PROPOSAL_IDENTITY_INVALID: proposal hash is not bound to operation digest',
    );
}

function canonicalDraft(draft: JoyCodeCompoundDraft): string {
  return canonicalJson({
    version: PREPARED_CHANGE_FORMAT_VERSION,
    planId: draft.planId,
    baseRevision: draft.baseRevision,
    operationDigest: draft.operationDigest,
    proposalHash: draft.proposalHash,
    ...(draft.timeline === undefined ? {} : { timeline: draft.timeline }),
    document: draft.document,
    documentChanged: draft.documentChanged,
    // Absent for every non-Look change -> the serialized draft (and therefore
    // compiledDigest / bindingDigest) is byte-identical to before.
    ...(draft.lookInstances === undefined ? {} : { lookInstances: draft.lookInstances }),
    groups: draft.groups,
    warnings: draft.warnings,
    requiresManualApproval: draft.requiresManualApproval,
  });
}

function deserializeDraft(serialized: string): JoyCodeCompoundDraft {
  return deepFreeze(JSON.parse(serialized) as JoyCodeCompoundDraft);
}

/**
 * Canonical non-secret policy fingerprint shared by prepared changes and
 * observation evidence identity. It intentionally excludes credentials,
 * prompts, media bytes and provider response data.
 */
export function digestJoyAgentPolicy(policy: AgentPolicyPreferences): string {
  return sha256Hex(
    canonicalJson({
      version: policy.version,
      executionMode: policy.executionMode,
      allowedCapabilities: [...new Set(policy.allowedCapabilities)].sort(),
      maxCostPerRunUsd: policy.maxCostPerRunUsd,
      privacyMode: policy.privacyMode,
      workerPreference: policy.workerPreference,
      mediaProvider: policy.mediaProvider,
      livePreview: policy.livePreview,
    }),
  );
}

function cloneGroups(groups: readonly JoyCodeCompoundGroup[]): readonly JoyCodeCompoundGroup[] {
  return JSON.parse(canonicalJson(groups)) as readonly JoyCodeCompoundGroup[];
}

function freezeView(view: PreparedChangeView): PreparedChangeView {
  return deepFreeze(view);
}

function cloneView(view: PreparedChangeView): PreparedChangeView {
  return deepFreeze(JSON.parse(canonicalJson(view)) as PreparedChangeView);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function assertOpaqueId(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:=-]{0,255}$/.test(value))
    throw new RangeError(`${label} must be a bounded opaque identifier`);
  return value;
}
