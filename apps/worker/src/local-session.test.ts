import { describe, expect, it } from 'vitest';
import { createLocalSessionStore, isLoopbackApiUrl } from './local-session.js';

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
});
