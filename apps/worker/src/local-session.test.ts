import { describe, expect, it } from 'vitest';
import { createLocalSessionStore, isLoopbackApiUrl, workerApiUrl } from './local-session.js';

const REFUSAL = 'JOY_MEDIA_API_URL must be http://127.0.0.1:<port>; remote URLs are refused';

describe('local session', () => {
  it('serves the per-run token and never persists or clears it', () => {
    const store = createLocalSessionStore('run-token');
    expect(store.loadWorkerSession()).toBe('run-token');
    store.clearWorkerSession();
    expect(store.loadWorkerSession()).toBe('run-token');
  });

  it('accepts only plain IPv4 loopback with an explicit port from 1 to 65535', () => {
    expect(isLoopbackApiUrl('http://127.0.0.1:4174')).toBe(true);
    expect(isLoopbackApiUrl('http://127.0.0.1:4174/')).toBe(true);
    expect(isLoopbackApiUrl('http://127.0.0.1:1')).toBe(true);
    expect(isLoopbackApiUrl('http://127.0.0.1:65535')).toBe(true);
    expect(isLoopbackApiUrl('http://127.0.0.1')).toBe(false);
    expect(isLoopbackApiUrl('http://127.0.0.1:0')).toBe(false);
    expect(isLoopbackApiUrl('http://127.0.0.1:65536')).toBe(false);
    expect(isLoopbackApiUrl('http://127.0.0.1:4174/api')).toBe(false);
    expect(isLoopbackApiUrl('http://127.0.0.1:4174?x=1')).toBe(false);
    expect(isLoopbackApiUrl('http://127.0.0.1:4174#x')).toBe(false);
    expect(isLoopbackApiUrl('http://user:secret@127.0.0.1:4174')).toBe(false);
    expect(isLoopbackApiUrl('https://127.0.0.1:4174')).toBe(false);
    expect(isLoopbackApiUrl('http://localhost:4174')).toBe(false);
    expect(isLoopbackApiUrl('http://[::1]:4174')).toBe(false);
    expect(isLoopbackApiUrl('http://192.168.1.10:4174')).toBe(false);
    expect(isLoopbackApiUrl('https://api.joyst.ir')).toBe(false);
    expect(isLoopbackApiUrl('not a url')).toBe(false);
    expect(isLoopbackApiUrl('')).toBe(false);
  });

  it('passes an unset API URL and the loopback address, and refuses every other value', () => {
    expect(workerApiUrl(undefined)).toBeUndefined();
    expect(workerApiUrl('http://127.0.0.1:4174')).toBe('http://127.0.0.1:4174');
    expect(() => workerApiUrl('https://api.joyst.ir/api')).toThrow(REFUSAL);
    expect(() => workerApiUrl('http://localhost:4174')).toThrow(REFUSAL);
    expect(() => workerApiUrl('')).toThrow(REFUSAL);
  });

  it('refuses each remote form with the fixed message, which never repeats the URL', () => {
    const refused = [
      'https://user:secret@api.joyst.ir/api',
      'http://localhost:4174/secret-path',
      'http://127.0.0.1:65536?token=secret',
    ];
    for (const value of refused) {
      let message = '';
      try {
        workerApiUrl(value);
      } catch (error) {
        message = String(error);
      }
      expect(message).toBe(`Error: ${REFUSAL}`);
    }
  });
});
