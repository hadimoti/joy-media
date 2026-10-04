import { describe, expect, it, vi } from 'vitest';
import {
  fetchJoyHostedDefaultModel,
  fetchJoyHostedSubscriptionState,
  joyHostedGatewayErrorMessage,
} from './joy-hosted.js';

describe('Joy Model hosted API helpers', () => {
  it('uses the default model from the gateway catalog', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            { id: 'deepseek/deepseek-v4-flash', isDefault: false },
            { id: 'bytedance-seed/seed-2.0-lite', isDefault: true },
          ],
        }),
        { status: 200 },
      ),
    );
    await expect(fetchJoyHostedDefaultModel(fetchFn)).resolves.toBe('bytedance-seed/seed-2.0-lite');
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/agent/models');
    expect(fetchFn.mock.calls[0]).toHaveLength(1);
  });

  it('distinguishes signed-out, active, and unsubscribed accounts', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { status: 'active' } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { status: 'none' } }), { status: 200 }),
      );
    await expect(fetchJoyHostedSubscriptionState(undefined, fetchFn)).resolves.toBe('signed-out');
    await expect(fetchJoyHostedSubscriptionState('session-test', fetchFn)).resolves.toBe('active');
    await expect(fetchJoyHostedSubscriptionState('session-test', fetchFn)).resolves.toBe(
      'not-subscribed',
    );
    expect(fetchFn).toHaveBeenLastCalledWith('/api/v1/account/subscription', {
      headers: { authorization: 'Bearer session-test' },
    });
  });

  it('maps gateway setup and subscription errors to user-facing notices', () => {
    expect(joyHostedGatewayErrorMessage('JOY_AGENT_UNCONFIGURED')).toBe(
      'Joy Model is temporarily unavailable on the server (not configured).',
    );
    expect(joyHostedGatewayErrorMessage('JOY_SUBSCRIPTION_REQUIRED')).toBe(
      'Joy Model needs an active JOY Pro subscription. Switch to Dual-Brain/BYOK.',
    );
    expect(joyHostedGatewayErrorMessage('other failure')).toBeUndefined();
  });
});
