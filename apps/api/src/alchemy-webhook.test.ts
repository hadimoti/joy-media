import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractCandidateTxHashes, verifyAlchemyWebhookSignature } from './alchemy-webhook.js';

const SIGNING_KEY = 'test-signing-key';

function sign(rawBody: string, key: string = SIGNING_KEY): string {
  return createHmac('sha256', key).update(rawBody, 'utf8').digest('hex');
}

describe('verifyAlchemyWebhookSignature', () => {
  it('accepts a correctly signed body', () => {
    const rawBody = '{"webhookId":"wh_1","event":{}}';
    expect(verifyAlchemyWebhookSignature(rawBody, sign(rawBody), SIGNING_KEY)).toBe(true);
  });

  it('is case-insensitive on the received hex digest', () => {
    const rawBody = '{"a":1}';
    expect(verifyAlchemyWebhookSignature(rawBody, sign(rawBody).toUpperCase(), SIGNING_KEY)).toBe(
      true,
    );
  });

  it('rejects a body that was tampered with after signing', () => {
    const rawBody = '{"a":1}';
    const signature = sign(rawBody);
    expect(verifyAlchemyWebhookSignature('{"a":2}', signature, SIGNING_KEY)).toBe(false);
  });

  it('rejects a signature produced with the wrong key', () => {
    const rawBody = '{"a":1}';
    expect(verifyAlchemyWebhookSignature(rawBody, sign(rawBody, 'wrong-key'), SIGNING_KEY)).toBe(
      false,
    );
  });

  it('rejects a missing signature header', () => {
    expect(verifyAlchemyWebhookSignature('{"a":1}', undefined, SIGNING_KEY)).toBe(false);
  });

  it('rejects an empty signature header', () => {
    expect(verifyAlchemyWebhookSignature('{"a":1}', '', SIGNING_KEY)).toBe(false);
  });

  it('rejects a garbage signature without throwing', () => {
    expect(verifyAlchemyWebhookSignature('{"a":1}', 'not-hex-at-all', SIGNING_KEY)).toBe(false);
  });
});

describe('extractCandidateTxHashes', () => {
  it('extracts hashes from a well-formed Address Activity payload', () => {
    const hash = `0x${'a'.repeat(64)}`;
    const payload = { event: { activity: [{ hash, fromAddress: '0x1', toAddress: '0x2' }] } };
    expect(extractCandidateTxHashes(payload)).toEqual([hash]);
  });

  it('deduplicates repeated hashes', () => {
    const hash = `0x${'b'.repeat(64)}`;
    const payload = { event: { activity: [{ hash }, { hash }] } };
    expect(extractCandidateTxHashes(payload)).toEqual([hash]);
  });

  it('ignores malformed hash values rather than throwing', () => {
    const payload = { event: { activity: [{ hash: 'not-a-hash' }, { hash: 123 }, {}] } };
    expect(extractCandidateTxHashes(payload)).toEqual([]);
  });

  it('returns an empty list for a payload missing the expected shape entirely', () => {
    expect(extractCandidateTxHashes(null)).toEqual([]);
    expect(extractCandidateTxHashes({})).toEqual([]);
    expect(extractCandidateTxHashes({ event: {} })).toEqual([]);
    expect(extractCandidateTxHashes('not an object')).toEqual([]);
  });
});
