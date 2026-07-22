export interface BrowserWorker {
  readonly id: string;
  readonly paired: boolean;
  readonly revoked: boolean;
  readonly capabilities: readonly string[];
  readonly lastSeenAt?: number;
}

export interface BrowserJob {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly state: 'queued' | 'leased' | 'completed' | 'canceled' | 'failed';
  readonly progress: number;
  readonly cancelRequested: boolean;
  readonly error?: string;
  readonly result?: { readonly kind: string; readonly sha256: string; readonly bytes: number };
}

export class BrowserControlPlaneClient {
  #token: string | undefined;
  #tokenExpiresAt = 0;

  constructor(
    private readonly apiUrl = '/api',
    private readonly identityUrl = 'https://joyteam.ir/api/identity/joy-media',
  ) {}

  async workers(): Promise<readonly BrowserWorker[]> {
    return this.get('/v1/workers');
  }
  async jobs(projectId: string): Promise<readonly BrowserJob[]> {
    return this.get(`/v1/projects/${encodeURIComponent(projectId)}/jobs`);
  }
  async createProject(id: string, title: string): Promise<void> {
    await this.post('/v1/projects', { id, title });
  }
  async enqueueFixture(projectId: string, id: string): Promise<BrowserJob> {
    return this.post(`/v1/projects/${encodeURIComponent(projectId)}/jobs`, {
      id,
      type: 'fixture.thumbnail',
    });
  }
  async pairWorker(workerId: string, pairingCode: string): Promise<void> {
    await this.post(`/v1/workers/${encodeURIComponent(workerId)}/pair`, { pairingCode });
  }
  async revokeWorker(workerId: string): Promise<BrowserWorker> {
    return this.post(`/v1/workers/${encodeURIComponent(workerId)}/revoke`, {});
  }
  async cancel(projectId: string, jobId: string): Promise<BrowserJob> {
    return this.post(
      `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/cancel`,
      {},
    );
  }
  async retry(projectId: string, jobId: string): Promise<BrowserJob> {
    return this.post(
      `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/retry`,
      {},
    );
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }
  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.assertion();
    const response = await fetch(`${this.apiUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
    });
    const body = await responseBody(response);
    if (!response.ok) throw new Error(errorMessage(body, response.status));
    if (!isRecord(body) || !('data' in body))
      throw new Error('JOY Media API returned an invalid response');
    return body.data as T;
  }
  private async assertion(): Promise<string> {
    if (this.#token !== undefined && Date.now() < this.#tokenExpiresAt) return this.#token;
    const response = await fetch(this.identityUrl, { method: 'POST', credentials: 'include' });
    const body = await responseBody(response);
    if (!response.ok || !isRecord(body) || typeof body.access_token !== 'string')
      throw new Error(errorMessage(body, response.status));
    this.#token = body.access_token;
    this.#tokenExpiresAt =
      Date.now() + Math.max(30, Number(body.expires_in) || 60) * 1_000 - 15_000;
    return this.#token;
  }
}

function errorMessage(body: unknown, status: number): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    const code = typeof body.error.code === 'string' ? `${body.error.code}: ` : '';
    return `${code}${body.error.message}`;
  }
  if (isRecord(body) && typeof body.error === 'string') return body.error;
  return `JOY Media request failed (${status})`;
}
async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text };
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
