import { describe, expect, it } from 'vitest';
import { challengeFor, createPkcePair, randomToken } from './pkce.js';

describe('PKCE', () => {
  it('matches the S256 example in RFC 7636, appendix B', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('makes a 43-character verifier whose challenge is its S256 digest', () => {
    const pair = createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(challengeFor(pair.verifier));
    expect(pair.method).toBe('S256');
  });

  it('draws each verifier and each token from fresh random bytes', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
    expect(randomToken()).not.toBe(randomToken());
  });
});
