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

describe('Joy Code message parts', () => {
  const OLD_HISTORY = JSON.stringify([
    {
      id: 'old-thread',
      title: 'Shorten the intro',
      createdAt: '2026-07-27T10:00:00.000Z',
      updatedAt: '2026-07-27T10:02:00.000Z',
      status: 'completed',
      messages: [
        {
          id: 'm1',
          role: 'user',
          body: 'Shorten the intro',
          createdAt: '2026-07-27T10:01:00.000Z',
        },
        {
          id: 'm2',
          role: 'assistant',
          body: 'Done.',
          createdAt: '2026-07-27T10:02:00.000Z',
          failureKey: 'unexpected-failure',
        },
      ],
    },
  ]);

  it('loads a history written before parts existed, unchanged', () => {
    const [thread] = loadJoyCodeThreads(memoryStorage(OLD_HISTORY), 'project-a');
    expect(thread?.messages).toHaveLength(2);
    expect(thread?.messages[0]).toEqual({
      id: 'm1',
      role: 'user',
      body: 'Shorten the intro',
      createdAt: '2026-07-27T10:01:00.000Z',
    });
    expect(thread?.messages[0]).not.toHaveProperty('parts');
    expect(thread?.messages[1]?.failureKey).toBe('unexpected-failure');
  });

  it('an old history gains a message with parts and saves and loads it back', () => {
    const storage = memoryStorage(OLD_HISTORY);
    const loaded = loadJoyCodeThreads(storage, 'project-a');
    const updated = addJoyCodeMessage(loaded, 'old-thread', {
      id: 'm3',
      role: 'assistant',
      body: 'Picture ready',
      createdAt: '2026-07-27T10:03:00.000Z',
      parts: [
        { kind: 'text', text: 'Picture ready' },
        { kind: 'image', jobId: 'job-1', label: 'Sunset' },
        { kind: 'video', jobId: 'job-2' },
        {
          kind: 'job',
          jobId: 'job-3',
          mediaKind: 'video',
          state: 'running',
          startedAt: '2026-07-27T10:03:00.000Z',
        },
      ],
    });
    saveJoyCodeThreads(storage, 'project-a', updated);

    const reloaded = loadJoyCodeThreads(storage, 'project-a')[0];
    expect(reloaded?.messages).toHaveLength(3);
    expect(reloaded?.messages[2]?.parts).toHaveLength(4);
    expect(reloaded?.messages[0]).not.toHaveProperty('parts');
  });

  it.each([
    ['an unknown part kind', [{ kind: 'sound', jobId: 'a' }]],
    ['a picture without a job id', [{ kind: 'image' }]],
    [
      'a job in an unknown state',
      [{ kind: 'job', jobId: 'a', mediaKind: 'image', state: 'sleeping', startedAt: 'x' }],
    ],
    ['a part list that is not a list', 'image'],
    ['too many parts', Array.from({ length: 17 }, () => ({ kind: 'text', text: 'x' }))],
  ])('refuses a history with %s', (_name, parts) => {
    const raw = JSON.stringify([
      {
        id: 't',
        title: 'x',
        createdAt: 'a',
        updatedAt: 'a',
        status: 'draft',
        messages: [{ id: 'm', role: 'assistant', body: '', createdAt: 'a', parts }],
      },
    ]);
    expect(loadJoyCodeThreads(memoryStorage(raw), 'project-a')).toEqual([]);
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
