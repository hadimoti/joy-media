import { describe, expect, it } from 'vitest';
import { createLocalSessionStore, isLoopbackApiUrl, workerApiUrl } from './local-session.js';

describe('local session', () => {
  it('serves the per-run token and never persists or clears it', () => {
    const store = createLocalSessionStore('run-token');
    expect(store.loadWorkerSession()).toBe('run-token');
    store.saveWorkerSession('cloud-session');
    store.clearWorkerSession();
    expect(store.loadWorkerSession()).toBe('run-token');
  });

  it('accepts only the plain loopback IPv4 address', () => {
    expect(isLoopbackApiUrl('http://127.0.0.1:4174')).toBe(true);
    expect(isLoopbackApiUrl('https://127.0.0.1:4174')).toBe(false);
    expect(isLoopbackApiUrl('http://localhost:4174')).toBe(false);
    expect(isLoopbackApiUrl('http://192.168.1.10:4174')).toBe(false);
    expect(isLoopbackApiUrl('https://api.joyst.ir')).toBe(false);
    expect(isLoopbackApiUrl('not a url')).toBe(false);
  });

  it('passes an unset API URL and the loopback address, and refuses every other value', () => {
    expect(workerApiUrl(undefined)).toBeUndefined();
    expect(workerApiUrl('http://127.0.0.1:4174')).toBe('http://127.0.0.1:4174');
    expect(() => workerApiUrl('https://api.joyst.ir/api')).toThrow('remote URLs are refused');
    expect(() => workerApiUrl('http://localhost:4174')).toThrow('remote URLs are refused');
    expect(() => workerApiUrl('')).toThrow('remote URLs are refused');
  });

  it('never repeats a refused URL, since it may carry credentials', () => {
    let message = '';
    try {
      workerApiUrl('https://user:secret@api.joyst.ir/api');
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('remote URLs are refused');
    expect(message).not.toContain('secret');
  });
});
