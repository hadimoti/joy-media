import { describe, expect, it } from 'vitest';
import { createProbedSessionToken } from './probed-session-token.js';

function storage(initial: string | undefined) {
  let stored = initial;
  return {
    read: () => stored,
    set: (token: string | undefined) => {
      stored = token;
    },
  };
}

describe('createProbedSessionToken', () => {
  it('reports no token before the owner has been probed', () => {
    const store = storage('token-a');
    const probed = createProbedSessionToken(store.read);

    expect(probed.current()).toBeUndefined();
  });

  it('reports the stored token while it is the one that was probed', () => {
    const store = storage('token-a');
    const probed = createProbedSessionToken(store.read);
    probed.record('token-a');

    expect(probed.current()).toBe('token-a');
  });

  it('refuses a token that another tab stored after the probe, without a new probe', () => {
    const store = storage('token-a');
    const probed = createProbedSessionToken(store.read);
    probed.record('token-a');
    store.set('token-b');

    expect(probed.current()).toBeUndefined();
  });

  it('refuses everything once the stored token is cleared', () => {
    const store = storage('token-a');
    const probed = createProbedSessionToken(store.read);
    probed.record('token-a');
    store.set(undefined);

    expect(probed.current()).toBeUndefined();
  });

  it('accepts the new token once the owner has been probed again', () => {
    const store = storage('token-a');
    const probed = createProbedSessionToken(store.read);
    probed.record('token-a');
    store.set('token-b');
    probed.record('token-b');

    expect(probed.current()).toBe('token-b');
  });
});
