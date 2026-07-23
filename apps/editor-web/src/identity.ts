/**
 * JOY identity session for the editor header (shared JOY login, DECIDED Q10).
 *
 * The browser's `web_token` cookie lives on `.joyteam.ir`; the identity
 * issuer mints a five-minute JOY Media assertion for an entitled session.
 * This module only *probes* that state for display — API calls keep using
 * `BrowserControlPlaneClient`'s own assertion flow.
 */

export const JOY_IDENTITY_URL = 'https://joyteam.ir/api/identity/joy-media';
export const JOY_LOGIN_URL = 'https://joyteam.ir/';
export const JOY_LOGOUT_URL = 'https://joyteam.ir/api/auth/logout';

export type JoySessionState =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'no-access'; readonly message: string }
  | { readonly kind: 'ready'; readonly subject: string | undefined };

/** Base64url-decode a JWT payload and return its `sub`, display-only. */
export function decodeJwtSubject(token: string): string | undefined {
  const payload = token.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(normalized)) as Record<string, unknown>;
    return typeof claims.sub === 'string' ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

export async function probeJoySession(
  fetchFn: typeof fetch = fetch,
  identityUrl: string = JOY_IDENTITY_URL,
): Promise<JoySessionState> {
  try {
    const response = await fetchFn(identityUrl, { method: 'POST', credentials: 'include' });
    const text = await response.text();
    if (response.ok) {
      const body = JSON.parse(text) as { access_token?: unknown };
      if (typeof body.access_token === 'string')
        return { kind: 'ready', subject: decodeJwtSubject(body.access_token) };
      return { kind: 'signed-out' };
    }
    if (response.status === 403) {
      let message = 'JOY Media access is not enabled for this account.';
      try {
        const body = JSON.parse(text) as { error?: unknown };
        if (typeof body.error === 'string') message = body.error;
      } catch {
        /* keep default message */
      }
      return { kind: 'no-access', message };
    }
    return { kind: 'signed-out' };
  } catch {
    // Network failure: report unknown rather than falsely claiming signed-out.
    return { kind: 'unknown' };
  }
}

/**
 * Expire the shared JOY session cookie. The logout route sets cookies but
 * sends no CORS headers, so the request runs in no-cors mode: the response
 * is opaque, while the browser still applies its Set-Cookie expirations.
 */
export async function logoutJoySession(
  fetchFn: typeof fetch = fetch,
  logoutUrl: string = JOY_LOGOUT_URL,
): Promise<void> {
  try {
    await fetchFn(logoutUrl, { method: 'POST', mode: 'no-cors', credentials: 'include' });
  } catch {
    /* opaque/no-cors failures are not actionable here; the caller re-probes */
  }
}
