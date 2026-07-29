/**
 * JOY Media's own login session for the editor header (ADR-0017).
 *
 * Supersedes the retired shared-JOY-login bridge (see the superseded
 * docs/adr/0016-shared-joy-identity-boundary.md): this module now probes and
 * clears JOY Media's own session token (see media-session.ts for the token
 * itself and the login/OTP calls), issued by this app's own allow-list, not
 * by joyteam.ir. The header "JOY account" widget kept the same
 * `JoySessionState` shape so the rest of App.tsx didn't need to change.
 */

import { clearStoredMediaToken, getStoredMediaToken, type MediaSessionStorage } from './media-session.js';

/** The header's "signed-out" sign-in link is unreachable once LoginGate covers
 *  the app (blurred + pointer-events:none), so this target is never followed. */
export const JOY_LOGIN_URL = '#';

export type JoySessionState =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'no-access'; readonly message: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly subject: string | undefined };

export async function probeJoySession(
  storage: MediaSessionStorage,
  fetchFn: typeof fetch = fetch,
): Promise<JoySessionState> {
  const token = getStoredMediaToken(storage);
  if (token === undefined) return { kind: 'signed-out' };
  try {
    const response = await fetchFn('/api/v1/auth/session', {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 401) {
      clearStoredMediaToken(storage);
      return { kind: 'signed-out' };
    }
    if (!response.ok) return { kind: 'unavailable' };
    const body = (await response.json()) as { data?: { contact?: unknown } };
    const contact = body.data?.contact;
    return { kind: 'ready', subject: typeof contact === 'string' ? contact : undefined };
  } catch {
    // A network outage is not evidence that the session ended.
    return { kind: 'unavailable' };
  }
}

export async function logoutJoySession(
  storage: MediaSessionStorage,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const token = getStoredMediaToken(storage);
  clearStoredMediaToken(storage);
  if (token === undefined) return;
  try {
    await fetchFn('/api/v1/auth/logout', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    /* token is already cleared locally; a failed remote revoke is not actionable here */
  }
}
