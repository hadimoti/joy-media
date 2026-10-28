import { describe, expect, it } from 'vitest';
import { ContinuationState } from './continuation-state.js';

const HOUR_MS = 60 * 60 * 1000;

describe('ContinuationState', () => {
  it('keeps the state of a call for its own profile only', () => {
    const state = new ContinuationState();

    state.remember('p1', 'call-1', { sig: 'a' });

    expect(state.recall('p1', 'call-1')).toEqual({ sig: 'a' });
    expect(state.recall('p2', 'call-1')).toBeUndefined();
  });

  it('forgets a call once its lifetime has passed', () => {
    let now = 0;
    const state = new ContinuationState(() => now);
    state.remember('p1', 'call-1', 'kept');

    now = HOUR_MS - 1;
    expect(state.recall('p1', 'call-1')).toBe('kept');

    now = HOUR_MS + 1;
    expect(state.recall('p1', 'call-1')).toBeUndefined();
  });

  it('drops the oldest call when more than 512 are kept', () => {
    const state = new ContinuationState();
    for (let index = 0; index <= 512; index += 1) state.remember('p1', `call-${index}`, index);

    expect(state.recall('p1', 'call-0')).toBeUndefined();
    expect(state.recall('p1', 'call-512')).toBe(512);
  });
});
