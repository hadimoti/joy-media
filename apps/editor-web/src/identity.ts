/**
 * JOY Media's own login session for the editor header (ADR-0017).
 *
 * Supersedes the retired shared-JOY-login bridge (see the superseded
 * docs/adr/0016-shared-joy-identity-boundary.md): this module now probes and
 * clears JOY Media's own session token (see media-session.ts for the token
 * itself and the login/OTP calls), issued by this app's own allow-list, not
 * by joyteam.ir. The header account widget kept the same `JoySessionState`
 * shape so the rest of App.tsx didn't need to change.
 */

import { clearStoredMediaToken, getStoredMediaToken, type MediaSessionStorage } from './media-session.js';

export type JoySessionState =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'no-access'; readonly message: string }
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'ready';
      /** Stable actor id (telegram numeric id or gmail) — used for ownership keys. */
      readonly subject: string | undefined;
      /** Human label for the account card (@username or gmail). */
      readonly displayName: string | undefined;
      readonly method: 'gmail' | 'telegram' | undefined;
      readonly avatarAvailable: boolean;
      /** Object URL for the authenticated avatar fetch; revoke on logout. */
      readonly avatarObjectUrl: string | undefined;
    };

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
    const body = (await response.json()) as {
      data?: {
        contact?: unknown;
        method?: unknown;
        displayName?: unknown;
        avatarAvailable?: unknown;
      };
    };
    const contact = body.data?.contact;
    const subject = typeof contact === 'string' ? contact : undefined;
    const displayName =
      typeof body.data?.displayName === 'string' ? body.data.displayName : subject;
    const method =
      body.data?.method === 'gmail' || body.data?.method === 'telegram'
        ? body.data.method
        : undefined;
    const avatarAvailable = body.data?.avatarAvailable === true;
    let avatarObjectUrl: string | undefined;
    if (avatarAvailable) {
      try {
        const avatarResponse = await fetchFn('/api/v1/auth/avatar', {
          headers: { authorization: `Bearer ${token}` },
        });
        if (avatarResponse.ok) {
          const blob = await avatarResponse.blob();
          if (blob.size > 0) avatarObjectUrl = URL.createObjectURL(blob);
        }
      } catch {
        /* letter fallback */
      }
    }
    // #region agent log
    fetch('http://localhost:7725/ingest/231cd602-5e3b-4c10-8c3c-0246bf1a0f92', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'b1ff1d' },
      body: JSON.stringify({
        sessionId: 'b1ff1d',
        runId: 'post-fix',
        hypothesisId: 'A,B,C,D',
        location: 'identity.ts:probeJoySession',
        message: 'session probe enriched payload',
        data: {
          status: response.status,
          contactKind:
            subject === undefined
              ? 'missing'
              : /^[0-9]+$/.test(subject)
                ? 'numeric_id'
                : subject.includes('@')
                  ? 'email'
                  : 'other',
          displayKind:
            displayName === undefined
              ? 'missing'
              : displayName.startsWith('@')
                ? 'telegram_username'
                : displayName.includes('@')
                  ? 'email'
                  : 'other',
          method: method ?? null,
          avatarAvailable,
          hasAvatarObjectUrl: avatarObjectUrl !== undefined,
          dataKeys:
            body.data !== undefined && typeof body.data === 'object' ? Object.keys(body.data) : [],
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    return {
      kind: 'ready',
      subject,
      displayName,
      method,
      avatarAvailable,
      avatarObjectUrl,
    };
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
