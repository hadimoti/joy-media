import { describe, expect, it } from 'vitest';
import { MAX_CATALOG_CHARS, replyText } from './http.js';

/** The error a rejected promise or a throwing call raised, or the value it returned as an error. */
async function errorOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

describe('replyText', () => {
  it('returns a token or key reply up to the token bound', async () => {
    const text = 'x'.repeat(64 * 1024);
    await expect(replyText(new Response(text))).resolves.toBe(text);
  });

  it('refuses a token or key reply over the token bound, and keeps its text out of the error', async () => {
    const error = await errorOf(replyText(new Response('secret-'.repeat(12_000))));
    expect(error).toMatchObject({
      code: 'EXCHANGE_FAILED',
      message: 'The provider reply was too large.',
    });
    expect(String(error)).not.toContain('secret-');
  });

  it('reads a model catalog longer than the token bound, up to the catalog bound', async () => {
    const text = 'x'.repeat(200 * 1024);
    await expect(replyText(new Response(text), MAX_CATALOG_CHARS)).resolves.toBe(text);
  });

  it('refuses a model catalog over the catalog bound', async () => {
    const error = await errorOf(
      replyText(new Response('x'.repeat(MAX_CATALOG_CHARS + 1)), MAX_CATALOG_CHARS),
    );
    expect(error).toMatchObject({ code: 'EXCHANGE_FAILED' });
  });
});
