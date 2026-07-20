import type { EditorContext } from './context.js';
import type {
  AgentEditPlan,
  AgentPlanStep,
  ApprovalReason,
  ApprovalRequest,
  Money,
  PrivacyImpact,
} from './plan.js';

export interface ApprovalPolicy {
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

  evaluateStep(step: AgentPlanStep, _context: EditorContext): ApprovalDecision {
    const requiresRemote = step.estimatedCost !== undefined && !step.estimatedCost.localOnly;
    const isReversible = !step.requiresConfirmation;

    if (requiresRemote && this.policy.blockRemoteUploads) {
      return {
        request: this.createRequest(
          step,
          'remote-upload',
          'Remote upload blocked by policy',
          {
            dataLeavesDevice: true,
            dataTypes: ['unknown'],
          },
          isReversible,
        ),
        decision: 'blocked',
        reason: 'Remote uploads are blocked by policy',
      };
    }

    const isVoiceTool =
      step.tool.toLowerCase().includes('voice') || step.tool.toLowerCase().includes('clone');
    if (isVoiceTool && this.policy.blockVoiceCloning) {
      return {
        request: this.createRequest(
          step,
          'voice-cloning',
          'Voice cloning blocked by policy',
          {
            dataLeavesDevice: false,
            dataTypes: ['voice profile'],
          },
          isReversible,
        ),
        decision: 'blocked',
        reason: 'Voice cloning is blocked by policy',
      };
    }

    if (step.requiresConfirmation && this.policy.blockDestructiveEdits) {
      return {
        request: this.createRequest(
          step,
          'destructive-edit',
          'Destructive edit blocked by policy',
          {
            dataLeavesDevice: false,
            dataTypes: [],
          },
          false,
        ),
        decision: 'blocked',
        reason: 'Destructive edits are blocked by policy',
      };
    }

    if (step.estimatedCost?.providerCost) {
      const costAmount = parseFloat(step.estimatedCost.providerCost.amount);
      const limitAmount = this.policy.autoApproveLimit
        ? parseFloat(this.policy.autoApproveLimit.amount)
        : 0;

      if (costAmount > limitAmount) {
        return {
          request: this.createRequest(
            step,
            'paid-generation',
            `Cost exceeds auto-approve limit`,
            { dataLeavesDevice: requiresRemote, dataTypes: [] },
            isReversible,
            step.estimatedCost.providerCost,
          ),
          decision: 'requires-manual',
          reason: `Cost ${costAmount} exceeds auto-approve limit ${limitAmount}`,
        };
      }
    }

    if (step.requiresConfirmation) {
      return {
        request: this.createRequest(
          step,
          'destructive-edit',
          'Step requires confirmation',
          {
            dataLeavesDevice: false,
            dataTypes: [],
          },
          false,
        ),
        decision: 'requires-manual',
        reason: 'Step requires manual confirmation',
      };
    }

    return {
      request: this.createRequest(
        step,
        'unresolved-assumptions',
        'Auto-approved',
        {
          dataLeavesDevice: false,
          dataTypes: [],
        },
        isReversible,
      ),
      decision: 'auto-approved',
      reason: 'Step meets auto-approval criteria',
    };
  }

  evaluatePlan(plan: AgentEditPlan, context: EditorContext): readonly ApprovalDecision[] {
    const decisions: ApprovalDecision[] = [];

    for (const step of plan.steps) {
      decisions.push(this.evaluateStep(step, context));
    }

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
    const pending = plan.requiredApprovals.filter((a) => a.status === 'pending');
    const rejected = plan.requiredApprovals.filter((a) => a.status === 'rejected');
    return pending.length === 0 && rejected.length === 0;
  }

  getPendingApprovals(plan: AgentEditPlan): readonly ApprovalRequest[] {
    return plan.requiredApprovals.filter((a) => a.status === 'pending');
  }

  recordApproval(plan: AgentEditPlan, requestId: string, approved: boolean): AgentEditPlan {
    const updatedApprovals = plan.requiredApprovals.map((a) =>
      a.id === requestId ? { ...a, status: (approved ? 'approved' : 'rejected') as const } : a,
    );
    return { ...plan, requiredApprovals: updatedApprovals };
  }

  getPolicy(): ApprovalPolicy {
    return this.policy;
  }

  private createRequest(
    step: AgentPlanStep,
    reason: ApprovalReason,
    description: string,
    privacyImpact: PrivacyImpact,
    isReversible: boolean,
    estimatedCost?: Money,
  ): ApprovalRequest {
    const base: {
      id: string;
      stepId: string;
      reason: ApprovalReason;
      description: string;
      privacyImpact: PrivacyImpact;
      isReversible: boolean;
      status: 'pending' | 'approved' | 'rejected';
      estimatedCost?: Money;
    } = {
      id: `approval-${step.id}-${Date.now()}`,
      stepId: step.id,
      reason,
      description,
      privacyImpact,
      isReversible,
      status: 'pending',
    };

    if (estimatedCost) {
      base.estimatedCost = estimatedCost;
    }

    return base;
  }
}

export function createDefaultApprovalPolicy(): ApprovalPolicy {
  return {
    autoApproveLimit: { amount: '0.00', currency: 'USD' },
    requireApprovalFor: [
      'paid-generation',
      'remote-upload',
      'voice-cloning',
      'destructive-edit',
      'publish-export',
    ],
    blockRemoteUploads: true,
    blockVoiceCloning: true,
    blockDestructiveEdits: true,
    maxPlanSteps: 50,
    allowUnresolvedAssumptions: false,
  };
}

export function createPermissiveApprovalPolicy(): ApprovalPolicy {
  return {
    autoApproveLimit: { amount: '10.00', currency: 'USD' },
    requireApprovalFor: ['publish-export', 'plugin-install'],
    blockRemoteUploads: false,
    blockVoiceCloning: false,
    blockDestructiveEdits: false,
    maxPlanSteps: 100,
    allowUnresolvedAssumptions: true,
  };
}

export function createStrictApprovalPolicy(): ApprovalPolicy {
  return {
    autoApproveLimit: { amount: '0.00', currency: 'USD' },
    requireApprovalFor: [
      'paid-generation',
      'remote-upload',
      'voice-cloning',
      'destructive-edit',
      'publish-export',
      'plugin-install',
      'project-settings-change',
      'unresolved-assumptions',
      'overwrite-output',
    ],
    blockRemoteUploads: true,
    blockVoiceCloning: true,
    blockDestructiveEdits: true,
    maxPlanSteps: 20,
    allowUnresolvedAssumptions: false,
  };
}
