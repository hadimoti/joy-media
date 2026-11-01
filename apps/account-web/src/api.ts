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

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers as Record<string, string>),
    },
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = json?.error?.message || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return json.data !== undefined ? json.data : json;
}

export async function fetchLatestRelease(
  channel: 'stable' | 'beta' = 'stable',
): Promise<ReleaseInfo | null> {
  try {
    const data = await request<ReleaseInfo>(`/v1/releases/${channel}`);
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
