import { generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { JoyIdentityVerifier } from './joy-identity.js';

const NOW = 1_700_000_000;

describe('JOY identity verifier', () => {
  it('accepts an allowed JOY Media assertion using a fetched JWKS', async () => {
    const fixture = createFixture();
    const verifier = createVerifier(fixture);
    const result = await verifier.authenticate(requestWith(fixture.token()));

    expect(result).toEqual({ id: 'joy-user-1' });
  });

  it.each([
    ['wrong audience', { aud: 'another-service' }],
    ['expired', { exp: NOW }],
    ['disabled', { joymedia_allowed: false }],
    ['overlong', { exp: NOW + 901 }],
  ])('rejects a %s assertion before it creates an actor', async (_label, changes) => {
    const fixture = createFixture();
    const verifier = createVerifier(fixture);

    await expect(
      verifier.authenticate(requestWith(fixture.token(changes))),
    ).resolves.toBeUndefined();
  });

  it('rejects a token whose payload was changed after signing', async () => {
    const fixture = createFixture();
    const verifier = createVerifier(fixture);
    const token = fixture.token();
    const [header, , signature] = token.split('.');
    const alteredClaims = base64url({
      iss: 'https://joyteam.ir',
      sub: 'joy-user-2',
      aud: 'joy-media',
      iat: NOW - 1,
      nbf: NOW - 1,
      exp: NOW + 300,
      joymedia_allowed: true,
    });

    await expect(
      verifier.authenticate(requestWith(`${header}.${alteredClaims}.${signature}`)),
    ).resolves.toBeUndefined();
  });
});

function createFixture(): {
  readonly jwks: JsonWebKey;
  readonly token: (changes?: Record<string, unknown>) => string;
} {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKey = pair.privateKey;
  const publicJwk = pair.publicKey.export({ format: 'jwk' }) as JsonWebKey;
  const jwks = { ...publicJwk, use: 'sig', alg: 'RS256', kid: 'joy-key-1' };
  return {
    jwks,
    token(changes = {}) {
      const header = base64url({ alg: 'RS256', kid: jwks.kid, typ: 'JWT' });
      const claims = base64url({
        iss: 'https://joyteam.ir',
        sub: 'joy-user-1',
        aud: 'joy-media',
        iat: NOW - 1,
        nbf: NOW - 1,
        exp: NOW + 300,
        joymedia_allowed: true,
        ...changes,
      });
      const signingInput = `${header}.${claims}`;
      return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')}`;
    },
  };
}

function createVerifier(fixture: { readonly jwks: JsonWebKey }): JoyIdentityVerifier {
  return new JoyIdentityVerifier({
    issuer: 'https://joyteam.ir',
    audience: 'joy-media',
    jwksUrl: 'https://joyteam.ir/api/identity/jwks.json',
    nowSeconds: () => NOW,
    fetch: async () => new Response(JSON.stringify({ keys: [fixture.jwks] }), { status: 200 }),
  });
}

function requestWith(token: string): IncomingMessage {
  return { headers: { authorization: `Bearer ${token}` } } as IncomingMessage;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
