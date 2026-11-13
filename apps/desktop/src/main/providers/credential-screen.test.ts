import { describe, expect, it } from 'vitest';
import { holdsCredential } from './credential-screen.js';

const KEY = 'sk-cp-test-not-a-real-key';
const PICTURE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('credential screen: generation replies', () => {
  it('finds the key in a picture reply that carries it in a field', () => {
    const reply = JSON.stringify({ data: [{ b64_json: PICTURE, note: KEY }] });

    expect(holdsCredential(reply, KEY)).toBe(true);
  });

  it('finds the key behind a JSON escape in a status message', () => {
    const key = 'sk-cp-abc"def';
    // The quote is escaped in the text, so the plain text does not show the key; the parsed string does.
    const reply = JSON.stringify({ base_resp: { status_code: 0, status_msg: `echo ${key}` } });

    expect(reply.includes(key)).toBe(false);
    expect(holdsCredential(reply, key)).toBe(true);
  });

  it('finds the key inside a string that is itself JSON, such as a nested error body', () => {
    const reply = JSON.stringify({ error: JSON.stringify({ token: KEY }) });

    expect(holdsCredential(reply, KEY)).toBe(true);
  });

  it('finds a key with a backslash, which the reply text escapes', () => {
    const key = 'sk-cp\\x';
    const reply = JSON.stringify({ base_resp: { status_msg: `a ${key} b` } });

    expect(reply.includes(key)).toBe(false);
    expect(holdsCredential(reply, key)).toBe(true);
  });

  it('does not refuse a reply that does not carry the key', () => {
    const reply = JSON.stringify({ data: [{ b64_json: PICTURE }], base_resp: { status_code: 0 } });

    expect(holdsCredential(reply, KEY)).toBe(false);
  });

  it('does not refuse a plain text reply without JSON', () => {
    expect(holdsCredential('the picture is ready', KEY)).toBe(false);
  });
});
