import { describe, expect, it } from 'vitest';
import {
  callFingerprint,
  ContinuationState,
  historyDigests,
  type CallScope,
} from './continuation-state.js';

const HOUR_MS = 60 * 60 * 1000;
const MIB = 1024 * 1024;

function scope(profileId: string, callId: string, history = 'h', call = 'c'): CallScope {
  return { profileId, callId, history, call };
}

describe('ContinuationState', () => {
  it('keeps the state of a call for its own profile only', () => {
    const state = new ContinuationState();

    state.remember(scope('p1', 'call-1'), { sig: 'a' });

    expect(state.recall(scope('p1', 'call-1'))?.value).toEqual({ sig: 'a' });
    expect(state.recall(scope('p2', 'call-1'))).toBeUndefined();
  });

  it('keeps the state of a call for its own conversation only', () => {
    const state = new ContinuationState();

    state.remember(scope('p1', 'call-1', 'conversation-a'), 'a');
    state.remember(scope('p1', 'call-1', 'conversation-b'), 'b');

    expect(state.recall(scope('p1', 'call-1', 'conversation-a'))?.value).toBe('a');
    expect(state.recall(scope('p1', 'call-1', 'conversation-b'))?.value).toBe('b');
    expect(state.recall(scope('p1', 'call-1', 'conversation-c'))).toBeUndefined();
  });

  it('keeps the state of a call for that call only, not for another with the same id', () => {
    const state = new ContinuationState();

    state.remember(scope('p1', 'call-1', 'h', callFingerprint('read_file', '{"a":1}')), 'first');

    expect(
      state.recall(scope('p1', 'call-1', 'h', callFingerprint('read_file', '{"a":1}')))?.value,
    ).toBe('first');
    expect(
      state.recall(scope('p1', 'call-1', 'h', callFingerprint('read_file', '{"a":2}'))),
    ).toBeUndefined();
  });

  it('replaces the state of a call when the same call in the same conversation is remembered again', () => {
    const state = new ContinuationState();

    state.remember(scope('p1', 'call-1'), 'first');
    state.remember(scope('p1', 'call-1'), 'second');

    expect(state.recall(scope('p1', 'call-1'))?.value).toBe('second');
  });

  it('forgets a call once its lifetime has passed', () => {
    let now = 0;
    const state = new ContinuationState(() => now);
    state.remember(scope('p1', 'call-1'), 'kept');

    now = HOUR_MS - 1;
    expect(state.recall(scope('p1', 'call-1'))?.value).toBe('kept');

    now = HOUR_MS + 1;
    expect(state.recall(scope('p1', 'call-1'))).toBeUndefined();
  });

  it('drops the oldest call when more than 512 are kept', () => {
    const state = new ContinuationState();
    for (let index = 0; index <= 512; index += 1) {
      state.remember(scope('p1', `call-${index}`), index);
    }

    expect(state.recall(scope('p1', 'call-0'))).toBeUndefined();
    expect(state.recall(scope('p1', 'call-512'))?.value).toBe(512);
  });

  it('drops the oldest state once the kept bytes pass the budget, however few calls it is', () => {
    const state = new ContinuationState();
    const large = 'x'.repeat(MIB);
    // Forty MiB of state, against a budget of 32 MiB: the oldest entries go first.
    for (let index = 0; index < 40; index += 1) {
      state.remember(scope('p1', `call-${index}`), large);
    }

    expect(state.recall(scope('p1', 'call-0'))).toBeUndefined();
    expect(state.recall(scope('p1', 'call-39'))?.value).toBe(large);
  });

  it('reports the bytes a kept call takes when it is sent back', () => {
    const state = new ContinuationState();

    state.remember(scope('p1', 'call-1'), { sig: 'é' });

    expect(state.recall(scope('p1', 'call-1'))?.bytes).toBe(Buffer.byteLength('{"sig":"é"}'));
  });
});

describe('callFingerprint', () => {
  it('keeps every fingerprint the same size, however large the arguments are', () => {
    expect(callFingerprint('read_file', 'x'.repeat(3 * MIB))).toHaveLength(64);
    expect(callFingerprint('read_file', '{}')).toHaveLength(64);
  });

  it('gives other tool names and other arguments other fingerprints', () => {
    expect(callFingerprint('read_file', '{"a":1}')).not.toBe(
      callFingerprint('read_file', '{"a":2}'),
    );
    expect(callFingerprint('read_file', '{}')).not.toBe(callFingerprint('write_file', '{}'));
  });
});

describe('ContinuationState budget for keys', () => {
  it('charges the key of each kept call to the budget, not only its value', () => {
    const state = new ContinuationState();
    // Each key is a MiB long and each value is one byte, so only the keys can fill the budget.
    for (let index = 0; index < 40; index += 1) {
      state.remember(scope('p1', `call-${index}`, 'h', 'k'.repeat(MIB)), 1);
    }

    expect(state.recall(scope('p1', 'call-0', 'h', 'k'.repeat(MIB)))).toBeUndefined();
    expect(state.recall(scope('p1', 'call-39', 'h', 'k'.repeat(MIB)))?.value).toBe(1);
  });
});

describe('historyDigests', () => {
  it('gives a prefix of a conversation the digest it has on its own', () => {
    const short = [{ role: 'user', content: 'read it' }];
    const long = [...short, { role: 'assistant', content: null }, { role: 'tool', content: 'ok' }];

    expect(historyDigests(long)[1]).toBe(historyDigests(short)[1]);
  });

  it('changes when a message before the call changes', () => {
    const first = historyDigests([{ role: 'user', content: 'a' }, { role: 'assistant' }]);
    const other = historyDigests([{ role: 'user', content: 'b' }, { role: 'assistant' }]);

    expect(first[1]).not.toBe(other[1]);
    expect(first[2]).not.toBe(other[2]);
  });

  it('gives the empty conversation a digest, and one digest per prefix', () => {
    expect(historyDigests([])).toHaveLength(1);
    expect(historyDigests([{ role: 'user', content: 'a' }])).toHaveLength(2);
  });
});
