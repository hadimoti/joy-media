import { createHash, randomBytes } from 'node:crypto';

/** A PKCE pair (RFC 7636). Only the S256 method is used (PLAN-v4 §6d). */
export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: 'S256';
}

type RandomBytes = (size: number) => Buffer;

/** A new verifier of 43 characters, and its S256 challenge. */
export function createPkcePair(random: RandomBytes = randomBytes): PkcePair {
  const verifier = random(32).toString('base64url');
  return { verifier, challenge: challengeFor(verifier), method: 'S256' };
}

/** The S256 challenge of a verifier: the base64url SHA-256 digest of the verifier's ASCII bytes. */
export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** An unguessable value for `state` or `nonce`. */
export function randomToken(random: RandomBytes = randomBytes): string {
  return random(32).toString('base64url');
}
