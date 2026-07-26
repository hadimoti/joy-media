import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { ApprovalEngine } from './approval.js';
import {
  createAutoApplyLowRiskPolicy,
  createFullAutoWithinLimitsPolicy,
  createPreviewAndApprovePolicy,
  createSuggestOnlyApprovalPolicy,
} from './approval.js';
import { buildEditorContext } from './context.js';
import { createToolRegistry } from './registry.js';
import type { AgentPlanStep } from './plan.js';
import type { ToolCapability, ToolScope } from './types.js';

const context = buildEditorContext(buildReferenceSpikeProject());

function step(overrides: Partial<AgentPlanStep> = {}): AgentPlanStep {
  return {
    id: 'step-1',
    description: 'Test operation',
    mode: 'command',
    tool: 'trimClip',
    arguments: {},
    dependsOn: [],
    expectedChange: 'A test change',
    preconditions: [],
    requiresConfirmation: false,
    ...overrides,
  };
}

function scope(capabilities: readonly ToolCapability[], isReversible = true): ToolScope {
  return { capabilities, isReversible };
}

describe('fine-grained agent policy modes', () => {
  it('registers query and edit tools with explicit capabilities', () => {
    const registry = createToolRegistry();

    expect(registry.tools.get('getTimelineSummary')?.scope.capabilities).toEqual(['timeline.read']);
    expect(registry.tools.get('trimClip')?.scope.capabilities).toEqual(['timeline.write']);
    expect(registry.tools.get('trimClip')?.scope).not.toHaveProperty('affectsTimeline');
  });

  it('Suggest Only blocks execution, including read-only tools', () => {
    const engine = new ApprovalEngine(createSuggestOnlyApprovalPolicy());

    const decision = engine.evaluateStep(
      step({ mode: 'analysis', tool: 'getTimelineSummary' }),
      context,
      scope(['timeline.read']),
    );

    expect(decision.decision).toBe('blocked');
    expect(decision.reason).toContain('does not execute');
  });

  it('Preview and Approve auto-allows reads but requires approval for writes', () => {
    const engine = new ApprovalEngine(createPreviewAndApprovePolicy());

    const read = engine.evaluateStep(
      step({ mode: 'analysis', tool: 'getTimelineSummary' }),
      context,
      scope(['timeline.read']),
    );
    const write = engine.evaluateStep(step(), context, scope(['timeline.write']));

    expect(read.decision).toBe('auto-approved');
    expect(write.decision).toBe('requires-manual');
    expect(write.request.reason).toBe('project-edit');
  });

  it('Auto-apply Low-Risk allows reversible local timeline writes only', () => {
    const engine = new ApprovalEngine(createAutoApplyLowRiskPolicy());

    const localWrite = engine.evaluateStep(step(), context, scope(['timeline.write']));
    const importAsset = engine.evaluateStep(
      step({ tool: 'importAsset' }),
      context,
      scope(['assets.import']),
    );
    const destructive = engine.evaluateStep(
      step({ requiresConfirmation: true }),
      context,
      scope(['timeline.write'], false),
    );

    expect(localWrite.decision).toBe('auto-approved');
    expect(importAsset.decision).toBe('requires-manual');
    expect(destructive.decision).toBe('requires-manual');
  });

  it.each([
    ['filesystem.write'],
    ['export.write'],
    ['project.overwrite'],
    ['plugin.invoke'],
  ] as const)('Full Auto still requires approval for %s', (capability) => {
    const engine = new ApprovalEngine(createFullAutoWithinLimitsPolicy());

    const decision = engine.evaluateStep(
      step({ tool: `test-${capability}` }),
      context,
      scope([capability]),
    );

    expect(decision.decision).toBe('requires-manual');
  });

  it('Full Auto auto-applies a local reversible timeline write within limits', () => {
    const engine = new ApprovalEngine(createFullAutoWithinLimitsPolicy());

    const decision = engine.evaluateStep(step(), context, scope(['timeline.write']));

    expect(decision.decision).toBe('auto-approved');
  });

  it('Full Auto applies known local provider spend within its explicit limit', () => {
    const engine = new ApprovalEngine(createFullAutoWithinLimitsPolicy());

    const decision = engine.evaluateStep(
      step({
        mode: 'job',
        tool: 'generateLocalImage',
        estimatedCost: {
          localOnly: true,
          providerCost: { amount: '5.00', currency: 'USD' },
        },
      }),
      context,
      scope(['provider.generate', 'provider.spend']),
    );

    expect(decision.decision).toBe('auto-approved');
  });

  it('Full Auto requires approval when provider spend has no cost estimate', () => {
    const engine = new ApprovalEngine(createFullAutoWithinLimitsPolicy());

    const decision = engine.evaluateStep(
      step({ mode: 'job', tool: 'generateLocalImage' }),
      context,
      scope(['provider.generate', 'provider.spend']),
    );

    expect(decision.decision).toBe('requires-manual');
  });

  it('external provider use requires approval even when it has no monetary cost', () => {
    const engine = new ApprovalEngine(createFullAutoWithinLimitsPolicy());

    const decision = engine.evaluateStep(
      step({
        mode: 'job',
        tool: 'generateImage',
        estimatedCost: {
          localOnly: false,
          providerCost: { amount: '0.00', currency: 'USD' },
        },
      }),
      context,
      scope(['provider.generate']),
    );

    expect(decision.decision).toBe('requires-manual');
    expect(decision.request.privacyImpact.dataLeavesDevice).toBe(true);
  });

  it('cost above the explicit Full Auto limit requires approval', () => {
    const engine = new ApprovalEngine(createFullAutoWithinLimitsPolicy());

    const decision = engine.evaluateStep(
      step({
        mode: 'job',
        tool: 'generateImage',
        estimatedCost: {
          localOnly: true,
          providerCost: { amount: '10.01', currency: 'USD' },
        },
      }),
      context,
      scope(['provider.generate', 'provider.spend']),
    );

    expect(decision.decision).toBe('requires-manual');
    expect(decision.reason).toContain('exceeds auto-approve limit');
  });

  it('credential-like tools are blocked in every executable mode', () => {
    const engine = new ApprovalEngine(createFullAutoWithinLimitsPolicy());

    const decision = engine.evaluateStep(
      step({ tool: 'readApiKey' }),
      context,
      scope(['filesystem.read']),
    );

    expect(decision.decision).toBe('blocked');
    expect(decision.reason).toContain('Credential access');
  });

  it('blocks capabilities outside an explicit allow-list', () => {
    const policy = {
      ...createFullAutoWithinLimitsPolicy(),
      allowedCapabilities: ['timeline.read'] as const,
    };
    const engine = new ApprovalEngine(policy);

    const decision = engine.evaluateStep(step(), context, scope(['timeline.write']));

    expect(decision.decision).toBe('blocked');
    expect(decision.reason).toContain('timeline.write');
  });
});
