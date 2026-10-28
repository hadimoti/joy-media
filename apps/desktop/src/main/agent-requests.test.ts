import { describe, expect, it } from 'vitest';
import { AgentRequestRegistry } from './agent-requests.js';

describe('AgentRequestRegistry', () => {
  it('refuses an id that is already in use, rather than sharing it', () => {
    const calls = new AgentRequestRegistry();

    expect(calls.begin('call-1')).toBeInstanceOf(AbortController);
    expect(calls.begin('call-1')).toBeUndefined();
  });

  it('removes only the call it finished, so an older call cannot take a newer one out', () => {
    const calls = new AgentRequestRegistry();
    const older = calls.begin('call-1');
    if (older === undefined) throw new Error('expected the older call');
    calls.finish('call-1', older);
    const newer = calls.begin('call-1');
    if (newer === undefined) throw new Error('expected the newer call');

    // The older call finishes again. It must not remove the newer call.
    calls.finish('call-1', older);

    expect(calls.cancel('call-1')).toBe(true);
    expect(newer.signal.aborted).toBe(true);
  });

  it('cancels a named call, and every call in progress when the page reloads', () => {
    const calls = new AgentRequestRegistry();
    const first = calls.begin('a');
    const second = calls.begin('b');
    if (first === undefined || second === undefined) throw new Error('expected both calls');

    expect(calls.cancel('a')).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);

    calls.cancelAll();

    expect(second.signal.aborted).toBe(true);
    expect(calls.cancel('b')).toBe(false);
  });
});
