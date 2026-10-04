import { getRemoteApiBaseUrl } from './desktop-client.js';

export type JoyHostedSubscriptionState = 'active' | 'not-subscribed' | 'signed-out' | 'unavailable';

export async function fetchJoyHostedDefaultModel(fetchFn: typeof fetch = fetch): Promise<string> {
  const response = await fetchFn(`${getRemoteApiBaseUrl()}/v1/agent/models`);
  if (!response.ok) throw new Error(`Joy Model catalog request failed (${response.status})`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.models))
    throw new Error('Joy Model catalog response is invalid');
  const models = body.models.filter(
    (item): item is { id: string; isDefault?: boolean } =>
      isRecord(item) && typeof item.id === 'string',
  );
  const model = models.find((item) => item.isDefault)?.id ?? models[0]?.id;
  if (!model) throw new Error('Joy Model catalog is empty');
  return model;
}

export async function fetchJoyHostedSubscriptionState(
  token: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<JoyHostedSubscriptionState> {
  if (!token) return 'signed-out';
  try {
    const response = await fetchFn(`${getRemoteApiBaseUrl()}/v1/account/subscription`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 401) return 'signed-out';
    if (!response.ok) return 'unavailable';
    const body: unknown = await response.json();
    return isRecord(body) && isRecord(body.data) && body.data.status === 'active'
      ? 'active'
      : 'not-subscribed';
  } catch {
    return 'unavailable';
  }
}

export function joyHostedGatewayErrorMessage(message: string): string | undefined {
  if (message.includes('JOY_AGENT_UNCONFIGURED'))
    return 'Joy Model is temporarily unavailable on the server (not configured).';
  if (message.includes('JOY_SUBSCRIPTION_REQUIRED'))
    return 'Joy Model needs an active JOY Pro subscription. Switch to Dual-Brain/BYOK.';
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
