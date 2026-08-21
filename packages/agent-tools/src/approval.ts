import type { EditorContext } from './context.js';
import type {
  AgentEditPlan,
  AgentPlanStep,
  ApprovalReason,
  ApprovalRequest,
  Money,
  PrivacyImpact,
} from './plan.js';
import type { ToolCapability, ToolScope } from './types.js';
import type { ProviderApprovalPreflight } from '@joy-media/provider-sdk';

export type AgentExecutionMode =
  'suggest-only' | 'preview-and-approve' | 'auto-apply-low-risk' | 'full-auto-limited';

export const ALL_TOOL_CAPABILITIES: readonly ToolCapability[] = [
  'timeline.read',
  'timeline.write',
  'assets.read',
  'assets.import',
  'filesystem.read',
  'filesystem.write',
  'provider.generate',
  'provider.spend',
  'render.preview',
  'export.write',
  'project.overwrite',
  'plugin.invoke',
];

const READ_ONLY_CAPABILITIES: readonly ToolCapability[] = [
  'timeline.read',
  'assets.read',
  'filesystem.read',
  'render.preview',
];

const LOW_RISK_CAPABILITIES: readonly ToolCapability[] = [
  ...READ_ONLY_CAPABILITIES,
  'timeline.write',
];

const HIGH_RISK_CAPABILITIES: readonly ToolCapability[] = [
  'assets.import',
  'filesystem.write',
  'provider.generate',
  'provider.spend',
  'export.write',
  'project.overwrite',
  'plugin.invoke',
];

export interface ApprovalPolicy {
  readonly executionMode: AgentExecutionMode;
  readonly allowedCapabilities: readonly ToolCapability[];
  readonly manualApprovalCapabilities: readonly ToolCapability[];
  readonly autoApproveLimit?: Money;
  readonly requireApprovalFor: readonly ApprovalReason[];
  readonly blockRemoteUploads: boolean;
  readonly blockVoiceCloning: boolean;
  readonly blockDestructiveEdits: boolean;
  readonly maxPlanSteps: number;
  readonly allowUnresolvedAssumptions: boolean;
}

export interface ApprovalDecision {
  readonly request: ApprovalRequest;
  readonly decision: 'auto-approved' | 'requires-manual' | 'blocked';
  readonly reason: string;
}

export class ApprovalEngine {
  private readonly policy: ApprovalPolicy;

  constructor(policy: ApprovalPolicy) {
    this.policy = policy;
  }

  evaluateStep(step: AgentPlanStep, _context: EditorContext, scope?: ToolScope): ApprovalDecision {
    const capabilities = resolveCapabilities(step, scope);
    const requiresRemote = step.estimatedCost !== undefined && !step.estimatedCost.localOnly;
    const isReversible = scope?.isReversible ?? !step.requiresConfirmation;

    if (looksLikeCredentialAccess(step.tool)) {
      return this.decision(
        step,
        'project-settings-change',
        'Credential access is never available to agents or plugins',
        'blocked',
        requiresRemote,
        isReversible,
      );
    }

    if (this.policy.executionMode === 'suggest-only') {
      return this.decision(
        step,
        capabilityReason(capabilities),
        'Suggest Only mode does not execute tools',
        'blocked',
        requiresRemote,
        isReversible,
      );
    }

    const denied = capabilities.find(
      (capability) => !this.policy.allowedCapabilities.includes(capability),
    );
    if (denied !== undefined) {
      return this.decision(
        step,
        capabilityReason([denied]),
        `Capability ${denied} is not allowed by policy`,
        'blocked',
        requiresRemote,
        isReversible,
      );
    }

    if (requiresRemote && this.policy.blockRemoteUploads) {
      return this.decision(
        step,
        'remote-upload',
        'Remote uploads are blocked by policy',
        'blocked',
        true,
        isReversible,
      );
    }

    const isVoiceTool =
      step.tool.toLowerCase().includes('voice') || step.tool.toLowerCase().includes('clone');
    if (isVoiceTool && this.policy.blockVoiceCloning) {
      return this.decision(
        step,
        'voice-cloning',
        'Voice cloning is blocked by policy',
        'blocked',
        requiresRemote,
        isReversible,
      );
    }

    if ((!isReversible || step.requiresConfirmation) && this.policy.blockDestructiveEdits) {
      return this.decision(
        step,
        'destructive-edit',
        'Destructive edits are blocked by policy',
        'blocked',
        requiresRemote,
        false,
      );
    }

    const providerCost = step.estimatedCost?.providerCost;
    if (providerCost !== undefined) {
      const costAmount = parseMoney(providerCost);
      const limitAmount = this.policy.autoApproveLimit
        ? parseMoney(this.policy.autoApproveLimit)
        : 0;
      if (costAmount > limitAmount) {
        return this.decision(
          step,
          'paid-generation',
          `Cost ${costAmount} exceeds auto-approve limit ${limitAmount}`,
          'requires-manual',
          requiresRemote,
          isReversible,
          providerCost,
        );
      }
    }

    const reason = capabilityReason(capabilities);
    const modeRequiresApproval =
      (this.policy.executionMode === 'preview-and-approve' &&
        capabilities.some((capability) => !READ_ONLY_CAPABILITIES.includes(capability))) ||
      (this.policy.executionMode === 'auto-apply-low-risk' &&
        capabilities.some((capability) => !LOW_RISK_CAPABILITIES.includes(capability))) ||
      capabilities.some((capability) =>
        this.policy.manualApprovalCapabilities.includes(capability),
      ) ||
      this.policy.requireApprovalFor.includes(reason) ||
      (capabilities.includes('provider.spend') && providerCost === undefined) ||
      requiresRemote ||
      isVoiceTool ||
      step.requiresConfirmation ||
      !isReversible;

    if (modeRequiresApproval) {
      return this.decision(
        step,
        step.requiresConfirmation || !isReversible ? 'destructive-edit' : reason,
        `Manual approval required for ${formatCapabilities(capabilities)}`,
        'requires-manual',
        requiresRemote,
        isReversible,
        providerCost,
      );
    }

    return this.decision(
      step,
      reason,
      'Step meets auto-approval criteria',
      'auto-approved',
      false,
      isReversible,
    );
  }

  evaluatePlan(
    plan: AgentEditPlan,
    context: EditorContext,
    scopeFor?: (toolName: string) => ToolScope | undefined,
  ): readonly ApprovalDecision[] {
    const decisions = plan.steps.map((step) =>
      this.evaluateStep(step, context, scopeFor?.(step.tool)),
    );

    if (plan.assumptions.length > 0 && !this.policy.allowUnresolvedAssumptions) {
      decisions.push({
        request: {
          id: `approval-assumptions-${Date.now()}`,
          stepId: 'plan',
          reason: 'unresolved-assumptions',
          description: `Plan has ${plan.assumptions.length} unresolved assumption(s)`,
          privacyImpact: { dataLeavesDevice: false, dataTypes: [] },
          isReversible: true,
          status: 'pending',
        },
        decision: 'requires-manual',
        reason: 'Plan contains unresolved assumptions',
      });
    }

    if (plan.steps.length > this.policy.maxPlanSteps) {
      decisions.push({
        request: {
          id: `approval-maxsteps-${Date.now()}`,
          stepId: 'plan',
          reason: 'project-settings-change',
          description: `Plan exceeds max steps (${plan.steps.length} > ${this.policy.maxPlanSteps})`,
          privacyImpact: { dataLeavesDevice: false, dataTypes: [] },
          isReversible: true,
          status: 'pending',
        },
        decision: 'blocked',
        reason: `Plan exceeds maximum allowed steps (${this.policy.maxPlanSteps})`,
      });
    }

    return decisions;
  }

  canProceed(plan: AgentEditPlan): boolean {
    const pending = plan.requiredApprovals.filter((approval) => approval.status === 'pending');
    const rejected = plan.requiredApprovals.filter((approval) => approval.status === 'rejected');
    return pending.length === 0 && rejected.length === 0;
  }

  getPendingApprovals(plan: AgentEditPlan): readonly ApprovalRequest[] {
    return plan.requiredApprovals.filter((approval) => approval.status === 'pending');
  }

  recordApproval(plan: AgentEditPlan, requestId: string, approved: boolean): AgentEditPlan {
    const updatedApprovals = plan.requiredApprovals.map((approval) =>
      approval.id === requestId
        ? { ...approval, status: approved ? ('approved' as const) : ('rejected' as const) }
        : approval,
    );
    return { ...plan, requiredApprovals: updatedApprovals };
  }

  getPolicy(): ApprovalPolicy {
    return this.policy;
  }

  private decision(
    step: AgentPlanStep,
    reason: ApprovalReason,
    description: string,
    decision: ApprovalDecision['decision'],
    dataLeavesDevice: boolean,
    isReversible: boolean,
    estimatedCost?: Money,
  ): ApprovalDecision {
    return {
      request: this.createRequest(
        step,
        reason,
        description,
        { dataLeavesDevice, dataTypes: dataLeavesDevice ? ['project media'] : [] },
        isReversible,
        estimatedCost,
      ),
      decision,
      reason: description,
    };
  }

  private createRequest(
    step: AgentPlanStep,
    reason: ApprovalReason,
    description: string,
    privacyImpact: PrivacyImpact,
    isReversible: boolean,
    estimatedCost?: Money,
  ): ApprovalRequest {
    return {
      id: `approval-${step.id}-${Date.now()}`,
      stepId: step.id,
      reason,
      description,
      privacyImpact,
      isReversible,
      status: 'pending',
      ...(estimatedCost !== undefined ? { estimatedCost } : {}),
    };
  }
}

export function approvalRequestFromProviderPreflight(
  preflight: ProviderApprovalPreflight,
  stepId: string,
  options: {
    readonly id?: string;
    readonly description?: string;
  } = {},
): ApprovalRequest {
  const reason: ApprovalReason =
    preflight.estimatedCost !== undefined ? 'paid-generation' : 'remote-upload';
  return {
    id: options.id ?? `approval-provider-${preflight.requestDigest.slice(-16)}`,
    stepId,
    reason,
    description:
      options.description ??
      `Approval required for ${preflight.providerId} ${preflight.capability}`,
    ...(preflight.estimatedCost === undefined ? {} : { estimatedCost: preflight.estimatedCost }),
    privacyImpact: {
      dataLeavesDevice: preflight.dataLeavesDevice,
      providerId: preflight.providerId,
      dataTypes: preflight.dataBeingSent,
      ...(preflight.retentionDisclosure === undefined
        ? {}
        : { retentionDisclosure: preflight.retentionDisclosure }),
    },
    isReversible: true,
    status: 'pending',
  };
}

export function createSuggestOnlyApprovalPolicy(): ApprovalPolicy {
  return {
    ...basePolicy(),
    executionMode: 'suggest-only',
    blockRemoteUploads: true,
    blockVoiceCloning: true,
    blockDestructiveEdits: true,
    maxPlanSteps: 50,
  };
}

export function createPreviewAndApprovePolicy(): ApprovalPolicy {
  return {
    ...basePolicy(),
    executionMode: 'preview-and-approve',
    manualApprovalCapabilities: ALL_TOOL_CAPABILITIES.filter(
      (capability) => !READ_ONLY_CAPABILITIES.includes(capability),
    ),
    requireApprovalFor: [
      'project-edit',
      'paid-generation',
      'remote-upload',
      'voice-cloning',
      'destructive-edit',
      'publish-export',
      'plugin-install',
      'overwrite-output',
    ],
    blockVoiceCloning: true,
    maxPlanSteps: 50,
  };
}

export function createAutoApplyLowRiskPolicy(): ApprovalPolicy {
  return {
    ...basePolicy(),
    executionMode: 'auto-apply-low-risk',
    manualApprovalCapabilities: HIGH_RISK_CAPABILITIES,
    requireApprovalFor: [
      'paid-generation',
      'remote-upload',
      'voice-cloning',
      'destructive-edit',
      'publish-export',
      'plugin-install',
      'overwrite-output',
    ],
    blockVoiceCloning: true,
    maxPlanSteps: 50,
  };
}

export function createFullAutoWithinLimitsPolicy(): ApprovalPolicy {
  return {
    ...basePolicy(),
    executionMode: 'full-auto-limited',
    autoApproveLimit: { amount: '10.00', currency: 'USD' },
    manualApprovalCapabilities: [
      'filesystem.write',
      'export.write',
      'project.overwrite',
      'plugin.invoke',
    ],
    requireApprovalFor: [
      'voice-cloning',
      'destructive-edit',
      'publish-export',
      'plugin-install',
      'overwrite-output',
    ],
    maxPlanSteps: 100,
    allowUnresolvedAssumptions: true,
  };
}

/** Compatibility name. The product default is Preview and Approve. */
export function createDefaultApprovalPolicy(): ApprovalPolicy {
  return createPreviewAndApprovePolicy();
}

/** Compatibility name for existing integrations that opted into broad authority. */
export function createPermissiveApprovalPolicy(): ApprovalPolicy {
  return createFullAutoWithinLimitsPolicy();
}

/** Compatibility name for callers that require a non-executing policy. */
export function createStrictApprovalPolicy(): ApprovalPolicy {
  return {
    ...createSuggestOnlyApprovalPolicy(),
    maxPlanSteps: 20,
    allowUnresolvedAssumptions: false,
  };
}

function basePolicy(): ApprovalPolicy {
  return {
    executionMode: 'preview-and-approve',
    allowedCapabilities: ALL_TOOL_CAPABILITIES,
    manualApprovalCapabilities: [],
    autoApproveLimit: { amount: '0.00', currency: 'USD' },
    requireApprovalFor: [],
    blockRemoteUploads: false,
    blockVoiceCloning: false,
    blockDestructiveEdits: false,
    maxPlanSteps: 50,
    allowUnresolvedAssumptions: false,
  };
}

function resolveCapabilities(
  step: AgentPlanStep,
  scope: ToolScope | undefined,
): readonly ToolCapability[] {
  const capabilities = new Set<ToolCapability>(
    scope?.capabilities ??
      (step.mode === 'analysis' || step.mode === 'decision'
        ? ['timeline.read']
        : step.mode === 'job'
          ? ['provider.generate']
          : ['timeline.write']),
  );
  if (step.estimatedCost !== undefined && !step.estimatedCost.localOnly) {
    capabilities.add('provider.generate');
  }
  if (
    step.estimatedCost?.providerCost !== undefined &&
    parseMoney(step.estimatedCost.providerCost) > 0
  ) {
    capabilities.add('provider.spend');
  }
  return [...capabilities];
}

function capabilityReason(capabilities: readonly ToolCapability[]): ApprovalReason {
  if (capabilities.includes('provider.spend')) return 'paid-generation';
  if (capabilities.includes('provider.generate')) return 'remote-upload';
  if (capabilities.includes('project.overwrite')) return 'overwrite-output';
  if (capabilities.includes('export.write')) return 'publish-export';
  if (capabilities.includes('plugin.invoke')) return 'plugin-install';
  if (capabilities.includes('filesystem.write')) return 'destructive-edit';
  if (capabilities.includes('timeline.write') || capabilities.includes('assets.import')) {
    return 'project-edit';
  }
  return 'unresolved-assumptions';
}

function parseMoney(money: Money): number {
  const parsed = Number.parseFloat(money.amount);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function formatCapabilities(capabilities: readonly ToolCapability[]): string {
  return capabilities.length > 0 ? capabilities.join(', ') : 'this operation';
}

function looksLikeCredentialAccess(toolName: string): boolean {
  return /(credential|secret|api[-_]?key|token)/i.test(toolName);
}
