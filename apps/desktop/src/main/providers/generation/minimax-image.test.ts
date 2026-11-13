import { describe, expect, it } from 'vitest';
import { prepareMiniMaxImage, readMiniMaxImage } from './minimax-image.js';
import { replyFailure } from './minimax-reply.js';

// A 1x1 PNG, and the shapes the master-plan facts P4 and P5 describe. These are documented shapes, not replies recorded
// from a live call (T-C10 records the first live reply).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const KEY = 'sk-cp-test-not-a-real-key';
const INPUT = { baseUrl: 'https://api.minimax.io/v1', apiKey: KEY, prompt: 'a red square' };

describe('MiniMax picture request', () => {
  it('sends the current route to /images/generations with the H3 model and base64 answers', () => {
    const call = prepareMiniMaxImage('current', INPUT);

    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.minimax.io/v1/images/generations');
    expect(JSON.parse(call.body ?? '')).toEqual({
      model: 'MiniMax-H3-Image',
      prompt: 'a red square',
      response_format: 'b64_json',
    });
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.body).not.toContain(KEY);
  });

  it('sends the legacy route to /image_generation with image-01', () => {
    const call = prepareMiniMaxImage('legacy', INPUT);

    expect(call.url).toBe('https://api.minimax.io/v1/image_generation');
    expect(JSON.parse(call.body ?? '')).toMatchObject({
      model: 'image-01',
      prompt: 'a red square',
    });
    expect(call.body).not.toContain(KEY);
  });

  it('uses the China region base when the profile names it', () => {
    const call = prepareMiniMaxImage('current', { ...INPUT, baseUrl: 'https://api.minimax.cn/v1' });

    expect(call.url).toBe('https://api.minimax.cn/v1/images/generations');
  });
});

describe('MiniMax picture reply', () => {
  it('reads a base64 picture from an item list (the H3 shape)', () => {
    const reply = JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] });

    expect(readMiniMaxImage(reply)).toEqual({
      ok: true,
      data: { base64: PNG_BASE64, mimeType: 'image/png' },
    });
  });

  it('reads a base64 picture from a data object (the legacy shape)', () => {
    const reply = JSON.stringify({ data: { image_base64: [PNG_BASE64] } });

    expect(readMiniMaxImage(reply)).toMatchObject({ ok: true, data: { mimeType: 'image/png' } });
  });

  it('refuses a link-only reply, because the link would need a host the pinned transport does not reach', () => {
    const reply = JSON.stringify({ data: [{ url: 'https://cdn.example.test/a.png' }] });

    expect(readMiniMaxImage(reply)).toMatchObject({ ok: false, code: 'RESPONSE_INVALID' });
  });

  it('refuses bytes that are not a picture', () => {
    const notAPicture = Buffer.from('hello, this is text').toString('base64');
    const reply = JSON.stringify({ data: [{ b64_json: notAPicture }] });

    expect(readMiniMaxImage(reply)).toMatchObject({ ok: false, code: 'RESPONSE_INVALID' });
  });

  it('refuses a reply that is not JSON, without echoing it', () => {
    const outcome = readMiniMaxImage('<html>gateway</html>');

    expect(outcome).toMatchObject({ ok: false, code: 'RESPONSE_INVALID' });
    expect(JSON.stringify(outcome)).not.toContain('gateway');
  });
});

describe('MiniMax reply failures', () => {
  it('maps a missing route to ROUTE_MISSING, so the broker tries the legacy route', () => {
    expect(replyFailure(404, '')).toMatchObject({ code: 'ROUTE_MISSING' });
  });

  it('maps HTTP statuses to their codes', () => {
    expect(replyFailure(401, '')).toMatchObject({ code: 'AUTH' });
    expect(replyFailure(403, '')).toMatchObject({ code: 'NOT_ALLOWED' });
    expect(replyFailure(429, '')).toMatchObject({ code: 'QUOTA' });
    expect(replyFailure(500, '')).toMatchObject({ code: 'REJECTED' });
  });

  it('reads base_resp on a 200 reply, where MiniMax sends its errors', () => {
    const quota = JSON.stringify({
      base_resp: { status_code: 1008, status_msg: 'insufficient balance' },
    });
    const badPrompt = JSON.stringify({
      base_resp: { status_code: 2013, status_msg: 'invalid params' },
    });

    expect(replyFailure(200, quota)).toMatchObject({ code: 'QUOTA' });
    expect(replyFailure(200, badPrompt)).toMatchObject({ code: 'BAD_PROMPT' });
  });

  it('keeps the provider text out of an unknown code', () => {
    const unknown = JSON.stringify({
      base_resp: { status_code: 9999, status_msg: `echoed ${KEY}` },
    });
    const failure = replyFailure(200, unknown);

    expect(failure).toMatchObject({
      code: 'REJECTED',
      message: 'The provider refused the request (code 9999).',
    });
    expect(JSON.stringify(failure)).not.toContain(KEY);
  });

  it('treats base_resp status 0 as success', () => {
    expect(replyFailure(200, JSON.stringify({ base_resp: { status_code: 0 } }))).toBeUndefined();
  });
});
