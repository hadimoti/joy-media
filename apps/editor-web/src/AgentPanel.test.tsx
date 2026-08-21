import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApprovalDecision } from '@joy-media/agent-tools';
import { ProviderApprovalDetails, selectJoyCodePendingApproval } from './AgentPanel.js';

describe('AgentPanel approval selection', () => {
  it('prefers provider preflight approval over generic manual provider decisions', () => {
    const generic = decision({
      id: 'approval-generic',
      reason: 'Manual approval required for provider.generate',
    });
    const provider = decision({
      id: 'approval-provider-sha256:abc123',
      reason: 'Provider approval required for edge-tts speech.synthesize',
      providerApproval: {
        providerId: 'edge-tts',
        capability: 'speech.synthesize',
        requestDigest: 'sha256:abc123',
      },
    });

    expect(selectJoyCodePendingApproval([generic, provider])).toBe(provider);
  });

  it('keeps blocked and generic approvals intact when no provider preflight is present', () => {
    const generic = decision({ id: 'approval-generic', reason: 'Generic manual approval' });
    const blocked = decision({
      id: 'approval-blocked',
      reason: 'Blocked by policy',
      decision: 'blocked',
    });

    expect(selectJoyCodePendingApproval([generic])).toBe(generic);
    expect(selectJoyCodePendingApproval([generic, blocked])).toBe(blocked);
  });

  it('renders provider approval details for Joy Code review', () => {
    const provider = decision({
      id: 'approval-provider-sha256:abc123',
      reason: 'Provider approval required for edge-tts speech.synthesize',
      providerApproval: {
        providerId: 'edge-tts',
        capability: 'speech.synthesize',
        requestDigest: 'sha256:abc123',
      },
    });

    const html = renderToStaticMarkup(<ProviderApprovalDetails approval={provider} />);

    expect(html).toContain('Provider');
    expect(html).toContain('edge-tts');
    expect(html).toContain('Capability');
    expect(html).toContain('speech.synthesize');
    expect(html).toContain('Cost cap');
    expect(html).toContain('0.00 USD');
    expect(html).toContain('sha256:abc123');
  });
});

function decision(overrides: {
  readonly id: string;
  readonly reason: string;
  readonly decision?: ApprovalDecision['decision'];
  readonly providerApproval?: ApprovalDecision['request']['providerApproval'];
}): ApprovalDecision {
  return {
    decision: overrides.decision ?? 'requires-manual',
    reason: overrides.reason,
    request: {
      id: overrides.id,
      stepId: 'tts-step',
      reason: 'paid-generation',
      description: overrides.reason,
      estimatedCost: { amount: '0.00', currency: 'USD' },
      privacyImpact: {
        dataLeavesDevice: true,
        providerId: 'edge-tts',
        dataTypes: ['text data'],
        retentionDisclosure: 'Text is sent to Microsoft Edge online TTS for synthesis',
      },
      isReversible: true,
      status: 'pending',
      ...(overrides.providerApproval === undefined
        ? {}
        : { providerApproval: overrides.providerApproval }),
    },
  };
}
