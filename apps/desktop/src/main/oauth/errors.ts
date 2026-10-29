/**
 * A sign-in failure the caller can show. The code is a fixed word, and the message never carries a token, a key, a
 * provider's reply or a callback parameter (PLAN-v4 §6b, §6d).
 */
export type OAuthErrorCode =
  | 'NOT_CONFIGURED'
  | 'REGISTRATION_FAILED'
  | 'LISTEN_FAILED'
  | 'STATE_MISMATCH'
  | 'ACCESS_DENIED'
  | 'CALLBACK_ERROR'
  | 'CALLBACK_INVALID'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'REDIRECT_REFUSED'
  | 'EXCHANGE_FAILED'
  | 'MISSING_SCOPE'
  | 'ID_TOKEN_INVALID'
  | 'SIGN_IN_REQUIRED'
  | 'HOST_ID_INVALID';

export class OAuthFlowError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}
