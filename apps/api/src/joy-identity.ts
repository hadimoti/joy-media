import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Actor } from './control-plane.js';
import type { ApiAuthentication } from './http-server.js';

export interface JoyIdentityVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly fetch?: typeof fetch;
  readonly nowSeconds?: () => number;
}

interface JsonWebKeySet {
  readonly keys: readonly JsonWebKey[];
}

interface AssertionClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly joymedia_allowed: boolean;
}

const MAX_ASSERTION_LIFETIME_SECONDS = 900;

/**
 * Verifies only short-lived, audience-scoped assertions from the JOY identity
 * owner. It accepts no JOY browser session/cookie and retains no user table.
 */
export class JoyIdentityVerifier implements ApiAuthentication {
  readonly #fetch: typeof fetch;
  readonly #nowSeconds: () => number;
  #keys = new Map<string, JsonWebKey>();
  #keysExpireAt = 0;

  constructor(private readonly options: JoyIdentityVerifierOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
  }

  async authenticate(request: IncomingMessage): Promise<Actor | undefined> {
    const value = request.headers.authorization;
    const token = typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
    if (token.length === 0) return undefined;
    const claims = await this.verifyAssertion(token);
    return claims === undefined ? undefined : { id: claims.sub };
  }

  async verifyAssertion(token: string): Promise<AssertionClaims | undefined> {
    const parsed = parseCompactJwt(token);
    if (
      parsed === undefined ||
      parsed.header.alg !== 'RS256' ||
      typeof parsed.header.kid !== 'string'
    )
      return undefined;
    const claims = parseClaims(parsed.claims);
    if (claims === undefined || !this.claimsAreAllowed(claims)) return undefined;
    const key = await this.keyFor(parsed.header.kid);
    if (key === undefined) return undefined;
    try {
      const publicKey = createPublicKey({ key, format: 'jwk' });
      return verify('RSA-SHA256', parsed.signingInput, publicKey, parsed.signature)
        ? claims
        : undefined;
    } catch {
      return undefined;
    }
  }

  private claimsAreAllowed(claims: AssertionClaims): boolean {
    const now = this.#nowSeconds();
    return (
      claims.iss === this.options.issuer &&
      claims.aud === this.options.audience &&
      claims.joymedia_allowed === true &&
      claims.sub.length > 0 &&
      Number.isSafeInteger(claims.iat) &&
      Number.isSafeInteger(claims.nbf) &&
      Number.isSafeInteger(claims.exp) &&
      claims.iat <= now &&
      claims.nbf >= claims.iat &&
      claims.nbf <= now &&
      claims.exp > claims.iat &&
      claims.exp - claims.iat <= MAX_ASSERTION_LIFETIME_SECONDS &&
      claims.exp > now
    );
  }

  private async keyFor(keyId: string): Promise<JsonWebKey | undefined> {
    if (this.#keysExpireAt <= this.#nowSeconds() || !this.#keys.has(keyId)) {
      try {
        const response = await this.#fetch(this.options.jwksUrl, {
          headers: { accept: 'application/json' },
        });
        if (!response.ok) return undefined;
        const body: unknown = await response.json();
        if (!isJsonWebKeySet(body)) return undefined;
        this.#keys = new Map(body.keys.filter(isRsaSigningKey).map((key) => [key.kid!, key]));
        this.#keysExpireAt = this.#nowSeconds() + 300;
      } catch {
        return undefined;
      }
    }
    return this.#keys.get(keyId);
  }
}

function parseCompactJwt(token: string):
  | {
      readonly header: Record<string, unknown>;
      readonly claims: unknown;
      readonly signingInput: Buffer;
      readonly signature: Buffer;
    }
  | undefined {
  const [headerSegment, claimsSegment, signatureSegment, ...rest] = token.split('.');
  if (
    headerSegment === undefined ||
    claimsSegment === undefined ||
    signatureSegment === undefined ||
    rest.length > 0
  )
    return undefined;
  try {
    const header: unknown = JSON.parse(Buffer.from(headerSegment, 'base64url').toString('utf8'));
    const claims: unknown = JSON.parse(Buffer.from(claimsSegment, 'base64url').toString('utf8'));
    if (!isRecord(header)) return undefined;
    return {
      header,
      claims,
      signingInput: Buffer.from(`${headerSegment}.${claimsSegment}`, 'ascii'),
      signature: Buffer.from(signatureSegment, 'base64url'),
    };
  } catch {
    return undefined;
  }
}

function parseClaims(value: unknown): AssertionClaims | undefined {
  if (!isRecord(value)) return undefined;
  const { iss, sub, aud, iat, nbf, exp, joymedia_allowed: allowed } = value;
  if (
    typeof iss !== 'string' ||
    typeof sub !== 'string' ||
    typeof aud !== 'string' ||
    typeof iat !== 'number' ||
    typeof nbf !== 'number' ||
    typeof exp !== 'number' ||
    typeof allowed !== 'boolean'
  )
    return undefined;
  return { iss, sub, aud, iat, nbf, exp, joymedia_allowed: allowed };
}

function isJsonWebKeySet(value: unknown): value is JsonWebKeySet {
  return isRecord(value) && Array.isArray(value.keys);
}

function isRsaSigningKey(key: JsonWebKey): key is JsonWebKey & { readonly kid: string } {
  return (
    key.kty === 'RSA' && key.use === 'sig' && key.alg === 'RS256' && typeof key['kid'] === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
