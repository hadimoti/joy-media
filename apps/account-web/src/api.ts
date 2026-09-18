/**
 * API client for joyst.ir Account Web
 */

export interface ReleaseInfo {
  readonly channel: string;
  readonly version: string;
  readonly downloadUrl: string;
  readonly sha256: string;
  readonly signature?: string;
  readonly publishedAt?: number;
}

export interface UserSession {
  readonly contact: string;
  readonly method: 'gmail' | 'telegram';
  readonly displayName?: string;
  readonly avatarAvailable?: boolean;
}

export interface SubscriptionInfo {
  readonly ownerId: string;
  readonly plan: 'monthly' | 'yearly' | 'none';
  readonly status: 'none' | 'active' | 'expired';
  readonly currentPeriodEnd?: number;
}

export interface DeviceInfo {
  readonly id: string;
  readonly ownerId: string;
  readonly displayName: string;
  readonly createdAt: number;
}

export interface AgentUsageSummary {
  readonly totalRequests: number;
  readonly totalPromptTokens: number;
  readonly totalCompletionTokens: number;
  readonly totalCostUsd: number;
}

const TOKEN_KEY = 'joy-media-session-token';

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable */
  }
}

export function clearSessionToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string | null,
): Promise<T> {
  const authToken = token !== undefined ? token : getSessionToken();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (authToken) {
    headers['authorization'] = `Bearer ${authToken}`;
  }

  const res = await fetch(`/api${path}`, {
    ...options,
    headers,
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = json?.error?.message || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return json.data !== undefined ? json.data : json;
}

export async function requestOtp(contact: string, method: 'gmail' | 'telegram'): Promise<string> {
  const data = await request<{ message?: string }>('/v1/auth/request-otp', {
    method: 'POST',
    body: JSON.stringify({ contact, method }),
  }, null);
  return data?.message || 'Verification code sent.';
}

export async function verifyOtp(
  contact: string,
  method: 'gmail' | 'telegram',
  code: string,
): Promise<string> {
  const data = await request<{ token: string }>('/v1/auth/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ contact, method, code }),
  }, null);
  setSessionToken(data.token);
  return data.token;
}

export async function fetchUserSession(): Promise<UserSession | null> {
  const token = getSessionToken();
  if (!token) return null;
  try {
    const data = await request<UserSession>('/v1/auth/session');
    return data;
  } catch {
    clearSessionToken();
    return null;
  }
}

export async function logoutSession(): Promise<void> {
  try {
    await request('/v1/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  } finally {
    clearSessionToken();
  }
}

export async function fetchLatestRelease(channel: 'stable' | 'beta' = 'stable'): Promise<ReleaseInfo | null> {
  try {
    const data = await request<ReleaseInfo>(`/v1/releases/${channel}`, {}, null);
    return data;
  } catch {
    return {
      channel: 'stable',
      version: '1.0.0',
      downloadUrl: '/releases/joy-media-windows-x64-v1.0.0.zip',
      sha256: '9f2a4f40f317ce53cebfba9a9f2ce5f396414ce53be2df79486c478a1bc1b474',
    };
  }
}

export async function fetchSubscription(): Promise<SubscriptionInfo | null> {
  try {
    const data = await request<SubscriptionInfo>('/v1/account/subscription');
    return data;
  } catch {
    return null;
  }
}

export async function fetchDevices(): Promise<readonly DeviceInfo[]> {
  try {
    const data = await request<readonly DeviceInfo[]>('/v1/devices');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await request(`/v1/devices/${deviceId}/revoke`, { method: 'POST' });
}

export async function fetchAgentUsage(): Promise<AgentUsageSummary | null> {
  try {
    const data = await request<{ usage?: AgentUsageSummary }>('/v1/agent/usage');
    return data?.usage || null;
  } catch {
    return null;
  }
}
