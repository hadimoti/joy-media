import { describe, expect, it } from 'vitest';
import {
  addJoyCodeMessage,
  createJoyCodeThread,
  joyCodeHistoryKey,
  loadJoyCodeThreads,
  matchJoyCodeIntentId,
  saveJoyCodeThreads,
  setJoyCodeThreadStatus,
} from './joy-code-history.js';

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe('Joy Code history', () => {
  it('stores threads per project without storing host credentials', () => {
    const storage = memoryStorage();
    const thread = createJoyCodeThread('thread-1', '2026-07-27T10:00:00.000Z');
    const updated = addJoyCodeMessage([thread], thread.id, {
      id: 'message-1',
      role: 'user',
      body: 'Shorten the intro by two seconds',
      createdAt: '2026-07-27T10:01:00.000Z',
    });

    saveJoyCodeThreads(storage, 'project-a', updated);

    expect(joyCodeHistoryKey('project-a')).toBe('joy-media.joy-code-history.v1:project-a');
    expect(loadJoyCodeThreads(storage, 'project-a')).toEqual([
      expect.objectContaining({
        title: 'Shorten the intro by two seconds',
        messages: [expect.objectContaining({ role: 'user' })],
      }),
    ]);
  });

  it('falls back safely when persisted data is malformed', () => {
    expect(loadJoyCodeThreads(memoryStorage('{broken'), 'project-a')).toEqual([]);
    expect(loadJoyCodeThreads(memoryStorage('[{"id":12}]'), 'project-a')).toEqual([]);
  });

  it('updates run status and keeps the newest task first', () => {
    const first = createJoyCodeThread('first', '2026-07-27T09:00:00.000Z');
    const second = createJoyCodeThread('second', '2026-07-27T10:00:00.000Z');
    const updated = setJoyCodeThreadStatus(
      [second, first],
      'first',
      'completed',
      '2026-07-27T11:00:00.000Z',
    );
    expect(updated.map((thread) => thread.id)).toEqual(['first', 'second']);
    expect(updated[0]?.status).toBe('completed');
  });
});

describe('Joy Code prompt routing', () => {
  it.each([
    ['/split', 'split-at-playhead'],
    ['Please shorten the intro by 2s', 'shorten-intro'],
    ['split and trim this clip', 'recipe-split-trim'],
    ['move the selection to the playhead', 'move-to-playhead'],
    ['delete this clip', 'remove-selected'],
    ['join it with the next clip', 'join-with-next'],
    ['insert a test clip here', 'insert-test-clip'],
  ])('routes %s to %s', (prompt, expected) => {
    expect(matchJoyCodeIntentId(prompt)).toBe(expected);
  });

  it('does not pretend unsupported free-form prompts are executable', () => {
    expect(matchJoyCodeIntentId('make this cinematic')).toBeUndefined();
  });
});
