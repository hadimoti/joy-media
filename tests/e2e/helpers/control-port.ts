/**
 * The synthetic-account control port. tooling/e2e-server.ts opens it only in the fixture-only browser lane.
 * Every spec that needs it must go through this module, so a real-services run fails here instead of
 * refusing a connection later. tooling/release detects specs that reach this module, directly or through
 * other imports, and leaves them out of the real-service selection.
 */
export const CONTROL_TOKEN_ENV = 'JOY_MEDIA_E2E_CONTROL_TOKEN';
export const CONTROL_PORT_ENV = 'JOY_MEDIA_E2E_CONTROL_PORT';
const DEFAULT_CONTROL_PORT = '4175';

export interface ControlPortConfig {
  readonly token: string;
  readonly baseUrl: string;
}

/** Reads the control-port settings. Throws in a real-services run, so the port cannot be used there by accident. */
export function controlPortConfig(env: NodeJS.ProcessEnv = process.env): ControlPortConfig {
  if (env.JOY_MEDIA_CI_ACCEPTANCE_PROFILE === 'real-services') {
    throw new Error(
      'The synthetic control port is fixture-only. It must not be used when JOY_MEDIA_CI_ACCEPTANCE_PROFILE=real-services.',
    );
  }
  return {
    token: env[CONTROL_TOKEN_ENV] ?? '',
    baseUrl: `http://127.0.0.1:${env[CONTROL_PORT_ENV] ?? DEFAULT_CONTROL_PORT}`,
  };
}

/** One request to the control port. Every request carries the token in the control header. */
export async function controlRequest<T>(
  path: string,
  body?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number; data: T }> {
  const { token, baseUrl } = controlPortConfig(env);
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-joy-e2e-control': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await response.json()) as { data?: T };
  return { status: response.status, data: parsed.data as T };
}
