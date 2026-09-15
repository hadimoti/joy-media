import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Alchemy webhook signature verification (JOY Media desktop migration, wave 5). Locked owner
 * decision: "webhook signature verification, replay/out-of-order deduplication."
 *
 * Alchemy signs each webhook delivery with HMAC-SHA256 over the *raw* request body, using a
 * per-webhook signing key, sent as a lowercase hex digest in the `X-Alchemy-Signature` header.
 * This module verifies that signature; `usdc-checkout-service.ts` owns turning a verified
 * payload into a confirmation attempt and the replay/dedup guard (the ledger's unique
 * `tx_hash`+`log_index` constraint — see usdc-invoice-ledger.ts).
 *
 * The signing key itself is never handled here: it is read once at startup from the systemd
 * credential directory (same convention as entitlement-signing.ts /
 * stock-video-credentials.ts) and passed in by the caller — this module never reads a
 * credential file itself.
 */

export class AlchemyWebhookError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AlchemyWebhookError';
  }
}

/**
 * Verifies the signature over the exact raw bytes Alchemy sent — the caller must pass the
 * unparsed request body, not a re-serialized `JSON.stringify(parsedBody)` (which is not
 * guaranteed to byte-match what was signed: key order, whitespace, and number formatting can
 * all differ after a parse/re-stringify round trip).
 */
export function verifyAlchemyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  signingKey: string,
): boolean {
  if (signatureHeader === undefined || signatureHeader.length === 0) return false;
  const expected = createHmac('sha256', signingKey).update(rawBody, 'utf8').digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(signatureHeader.trim().toLowerCase(), 'utf8');
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

/**
 * Best-effort normalization of Alchemy's "Address Activity" webhook payload shape into the
 * one field this pipeline actually needs: a candidate transaction hash to fetch a receipt for
 * and verify canonically via usdc-confirmation.ts's `observeTransferFromReceipt`. This is
 * **not** trusted on its own — every field here is re-derived independently from the chain via
 * RPC before an invoice is ever confirmed (see usdc-checkout-service.ts). Treat this function
 * as an untrusted hint extractor, not a source of truth.
 *
 * The exact Alchemy payload shape is not validated against a live webhook in this worktree —
 * this parser follows Alchemy's documented Address Activity schema as of this writing and
 * must be checked against a real delivery before go-live (see the wave 5 progress log entry).
 */
export function extractCandidateTxHashes(payload: unknown): readonly string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const event = (payload as { readonly event?: unknown }).event;
  if (typeof event !== 'object' || event === null) return [];
  const activity = (event as { readonly activity?: unknown }).activity;
  if (!Array.isArray(activity)) return [];
  const hashes = new Set<string>();
  for (const entry of activity) {
    if (typeof entry !== 'object' || entry === null) continue;
    const hash = (entry as { readonly hash?: unknown }).hash;
    if (typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash)) hashes.add(hash);
  }
  return [...hashes];
}
